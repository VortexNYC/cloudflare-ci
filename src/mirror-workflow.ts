// MirrorWorkflow — push-event handler that replaces artifacts-sync.yml.
// Receives a GitHub push webhook target, clones the branch inside a
// ChecksSandbox, mints a short-lived repo-scoped Artifacts token, and
// force-pushes. The artifacts push fires cf.artifacts.repo.pushed, so the
// downstream CI pipeline is identical to the GHA job it replaced.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import {
  completeCheckRun,
  getInstallationToken,
  getOrCreateCheckRun,
} from "./checks";
import type { Bindings } from "./env";
import {
  AUX_ADMIT_ATTEMPTS,
  auxAdmitRetryDelayMs,
} from "./pool-admit";
import { logCiEvent } from "./observability";

type MirrorParams = { repo: string; branch: string; sha: string };
type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

const MINUTE = 60 * 1000;
const MIRROR_CHECK_NAME = "Push to Cloudflare Artifacts";

const ARTIFACTS_NS = "vortex";

export async function resolveArtifactsToken(
  env: Bindings,
  repo: string
): Promise<string> {
  // The ARTIFACTS binding is the control plane — get() returns null for a
  // repo that was never pushed, so create() first (the initial token also
  // comes back free). Tokens are repo-scoped and minted per push (15 min)
  // — the old REST mint path produced tokens the git endpoint rejected.
  const repoName = repo.split("/")[1] ?? repo;
  let handle: ArtifactsRepo | null = null;
  try {
    handle = await env.ARTIFACTS.get(repoName);
  } catch {
    handle = null;
  }
  if (!handle) {
    const created = await env.ARTIFACTS.create(repoName, {
      description: `${repo} — mirrored by cloudflare-ci`,
    });
    if (created.token) return created.token;
    handle = await env.ARTIFACTS.get(repoName);
  }
  const minted = await handle.createToken("write", 900);
  return minted.plaintext;
}

export class MirrorWorkflow extends WorkflowEntrypoint<Bindings, MirrorParams> {
  async run(event: WorkflowEvent<MirrorParams>, step: WorkflowStep) {
    const { repo, branch, sha } = event.payload;
    const repoName = repo.split("/")[1] ?? repo;
    const githubToken = await step.do("github-token", async () => {
      if (this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY) {
        return getInstallationToken(
          this.env.GITHUB_APP_ID,
          this.env.GITHUB_APP_PRIVATE_KEY,
          repo
        ).catch(() => this.env.CHECKS_GITHUB_TOKEN ?? "");
      }
      return this.env.CHECKS_GITHUB_TOKEN ?? "";
    });
    if (!githubToken) {
      throw new Error("mirror: no GitHub token — cannot post required check run");
    }

    const checkRunId = await step.do("open-mirror-check", () =>
      getOrCreateCheckRun(githubToken, repo, sha, MIRROR_CHECK_NAME)
    );

    const scheduler = () =>
      this.env.CI_SCHEDULER.get(this.env.CI_SCHEDULER.idFromName("global"));
    const withScheduler = <T extends Rpc.Serializable<T>>(
      name: string,
      fn: (stub: SchedulerStub) => Promise<T>
    ): Promise<T> =>
      step.do(
        name,
        { retries: { limit: 5, delay: 5_000, backoff: "linear" }, timeout: 60_000 },
        () => fn(scheduler())
      );

    await withScheduler("track-aux-wf", (stub) =>
      stub.trackAuxWorkflow({
        kind: "mirror",
        repo,
        sha,
        branch,
        instanceId: event.instanceId,
        params: event.payload,
      })
    );

    const sandboxId = `mirror-${repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${sha.slice(0, 10)}`;

    const attemptAdmit = async (): Promise<
      { ok: true } | { ok: false; reason: string }
    > => {
      const res = await scheduler().admit({
        pool: "AUX",
        name: sandboxId,
        instanceId: event.instanceId,
      });
      return res.ok
        ? { ok: true }
        : { ok: false, reason: "reason" in res ? res.reason : "AUX at capacity" };
    };

    try {
      const first = await withScheduler("admit", () => attemptAdmit());
      if (!first.ok) {
        await logCiEvent(this.env, "ci.mirror.pool_wait_started", {
          repo,
          branch,
          sha,
          reason: first.reason,
        });
        await step.do(
          "admit-wait",
          {
            retries: {
              limit: AUX_ADMIT_ATTEMPTS,
              delay: ({ ctx }) => auxAdmitRetryDelayMs(ctx.attempt),
            },
            timeout: 35 * MINUTE,
          },
          async () => {
            const outcome = await attemptAdmit();
            if (!outcome.ok) throw new Error(outcome.reason);
          }
        );
        await logCiEvent(this.env, "ci.mirror.pool_wait_done", {
          repo,
          branch,
          sha,
        });
      }

      const artifactsToken = await step.do("resolve artifacts token", () =>
        resolveArtifactsToken(this.env, repo)
      );
      await step.do("push to artifacts", async () => {
        const sandbox = this.env.CHECKS_SANDBOX.getByName(sandboxId);
        const clone = [
          "set -euo pipefail",
          "git init -q --bare /workspace && cd /workspace",
          'git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" 2>/dev/null || git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"',
          'git fetch -q origin "$SHA"',
        ].join(" && ");
        const push = [
          "cd /workspace && git -c http.extraHeader=\"Authorization: Bearer $ARTIFACTS_TOKEN\"" +
            ' push --force "$REMOTE" "FETCH_HEAD:refs/heads/$BRANCH"',
        ].join(" && ");
        const result = await sandbox.runCheck({
          checkoutScript: clone,
          script: push,
          env: {
            GITHUB_TOKEN: githubToken,
            ARTIFACTS_TOKEN: artifactsToken,
            REPO: repo,
            BRANCH: branch,
            SHA: sha,
            REMOTE: `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/${ARTIFACTS_NS}/${repoName}.git`,
            CI: "true",
          },
          timeoutSec: 300,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `mirror push failed (${result.exitCode}): ${result.stderr.slice(-2000)}`
          );
        }
      });

      await step.do("complete-mirror-check", () =>
        completeCheckRun(githubToken, repo, checkRunId, {
          conclusion: "success",
          title: "Mirrored to Cloudflare Artifacts",
          summary: `Branch ${branch} @ ${sha.slice(0, 7)} force-pushed to Artifacts.`,
        })
      );
      await withScheduler("complete-aux-wf", (stub) =>
        stub.completeAuxWorkflow("mirror", repo, sha, event.instanceId, branch)
      );
    } catch (err: unknown) {
      const summary = String(err).slice(-4000);
      await step
        .do("fail-mirror-check", () =>
          completeCheckRun(githubToken, repo, checkRunId, {
            conclusion: "failure",
            title: "Artifacts mirror failed",
            summary,
          })
        )
        .catch(() => {});
      await withScheduler("complete-aux-wf", (stub) =>
        stub.completeAuxWorkflow("mirror", repo, sha, event.instanceId, branch)
      ).catch(() => {});
      throw err;
    } finally {
      await withScheduler("release", (stub) => stub.release(sandboxId)).catch(
        () => {}
      );
      await this.env.CHECKS_SANDBOX.getByName(sandboxId)
        .destroy()
        .catch(() => {});
    }
  }
}
