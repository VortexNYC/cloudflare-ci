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

import type { Bindings } from "./env";

type MirrorParams = { repo: string; branch: string; sha: string };
type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

const ARTIFACTS_NS = "vortex";

async function resolveArtifactsToken(
  env: Bindings,
  repo: string
): Promise<string> {
  // Mint a fresh 15-min repo-scoped token whenever a minting credential
  // exists — Artifacts tokens are repo-scoped, so the stored push token
  // only covers the repo it was minted for (it was minted for pile; other
  // repos got "Invalid or expired token"). The static token stays as
  // fallback for when the mint API is unreachable.
  const apiToken =
    env.ARTIFACTS_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? env.CF_TOKEN;
  if (!apiToken || !env.ARTIFACTS_ACCOUNT_ID) {
    if (env.ARTIFACTS_PUSH_TOKEN) return env.ARTIFACTS_PUSH_TOKEN;
    throw new Error("artifacts mirror: no mint token, push token, or ACCOUNT_ID");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.ARTIFACTS_ACCOUNT_ID}/artifacts/namespaces/${ARTIFACTS_NS}/tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: repo.split("/")[1],
        scope: "write",
        ttl: 900,
      }),
    }
  );
  if (!res.ok) {
    if (env.ARTIFACTS_PUSH_TOKEN) {
      console.log(
        `artifacts token mint ${res.status} — falling back to stored push token`
      );
      return env.ARTIFACTS_PUSH_TOKEN;
    }
    const text = await res.text();
    throw new Error(`artifacts token mint ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { plaintext?: string };
  if (!body.plaintext) throw new Error("artifacts token mint: no plaintext");
  return body.plaintext;
}

export class MirrorWorkflow extends WorkflowEntrypoint<Bindings, MirrorParams> {
  async run(event: WorkflowEvent<MirrorParams>, step: WorkflowStep) {
    const { repo, branch, sha } = event.payload;
    const repoName = repo.split("/")[1] ?? repo;
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

    const sandboxId = `mirror-${repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${sha.slice(0, 10)}`;
    const admission = await withScheduler("admit", async (stub) => {
      const res = await stub.admit({
        pool: "CHECKS",
        name: sandboxId,
        instanceId: event.instanceId,
      });
      return { ok: res.ok, reason: "reason" in res ? res.reason : undefined };
    });
    if (!admission.ok) {
      throw new Error(`mirror: ${admission.reason ?? "checks pool at capacity"}`);
    }
    try {
      const token = await step.do("resolve artifacts token", () =>
        resolveArtifactsToken(this.env, repo)
      );
      await step.do("push to artifacts", async () => {
        const sandbox = this.env.CHECKS_SANDBOX.getByName(sandboxId);
        // Tokens ride the container env (GITHUB_TOKEN / ARTIFACTS_TOKEN) —
        // never interpolated into argv, where they'd land in process listings.
        const clone = [
          "set -euo pipefail",
          "git init -q --bare /workspace && cd /workspace",
          // Retries re-enter the same sandbox — the remote may already exist.
          'git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" 2>/dev/null || git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"',
          // Fetch the event's SHA, not the branch tip — two overlapping
          // pushes would otherwise let an older workflow mirror a stale tip
          // over the newer one. GitHub permits fetching reachable SHAs.
          // No depth bound — a shallow FETCH_HEAD can't be pushed.
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
            GITHUB_TOKEN: this.env.CHECKS_GITHUB_TOKEN ?? "",
            ARTIFACTS_TOKEN: token,
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
