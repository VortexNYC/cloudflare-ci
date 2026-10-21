// ReleaseWorkflow — tag-push handler that replaces cli-binary.yml.
// On refs/tags/* for a repo with releaseCommand, a ChecksSandbox clones the
// tag, builds release artifacts (cross-compiled bun binaries for all
// targets), and publishes the GitHub release — the last GHA dependency
// (VTX-603).
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";

type ReleaseParams = { repo: string; tag: string; sha: string };
type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

export class ReleaseWorkflow extends WorkflowEntrypoint<Bindings, ReleaseParams> {
  async run(event: WorkflowEvent<ReleaseParams>, step: WorkflowStep) {
    const { repo, tag, sha } = event.payload;
    const config = getRepoConfig(repo.split("/")[1] ?? repo);
    if (!config?.releaseCommand) {
      console.log(`[release] ${repo} has no releaseCommand — skipping`);
      return;
    }
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

    const sandboxId = `release-${repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${tag.replace(/[^a-z0-9-]/g, "-")}`;
    const admission = await withScheduler("admit", async (stub) => {
      const res = await stub.admit({
        pool: "CHECKS",
        name: sandboxId,
        instanceId: event.instanceId,
      });
      return { ok: res.ok, reason: "reason" in res ? res.reason : undefined };
    });
    if (!admission.ok) {
      throw new Error(`release: ${admission.reason ?? "checks pool at capacity"}`);
    }
    try {
      const tail = await step.do("build + publish release", async () => {
        const sandbox = this.env.CHECKS_SANDBOX.getByName(sandboxId);
        // Tokens ride the container env — never argv (process listings).
        const clone = [
          "set -euo pipefail",
          "git init -q /workspace && cd /workspace",
          // Retry re-runs the checkout — remote add must not fail on retry.
          '(git remote get-url origin >/dev/null 2>&1 || ' +
            'git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git")',
          'git fetch -q origin "$SHA"',
          "git checkout -q FETCH_HEAD",
        ].join(" && ");
        const result = await sandbox.runCheck({
          checkoutScript: clone,
          script: `cd /workspace && ${config.releaseCommand}`,
          env: {
            GITHUB_TOKEN: this.env.CHECKS_GITHUB_TOKEN ?? "",
            NPM_TOKEN: this.env.NPM_TOKEN ?? "",
            REPO: repo,
            TAG: tag,
            SHA: sha,
            CI: "true",
          },
          timeoutSec: 20 * 60,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `release failed (${result.exitCode}): ${result.stderr.slice(-2000)}`
          );
        }
        // Return the stdout tail — step output is inspectable via
        // `wrangler workflows instances describe` after the run.
        return result.stdout.slice(-2400);
      });
      console.log(`[release] ${repo} ${tag} ok — tail: ${tail}`);
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
