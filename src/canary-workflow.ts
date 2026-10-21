import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import type { Bindings } from "./env";
import { resolveArtifactsToken } from "./mirror-workflow";

type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

// Canary — every */30 cron tick bumps a commit into the canary artifacts repo.
// The push fires cf.artifacts.repo.pushed → a real CI run on a non-main branch
// (deps → build → preview → curl verify), proving the platform end-to-end on a
// schedule instead of on a real repo's failure. Each tick needs a new sha —
// the CI claim dedupes completed same-sha events.
export class CanaryWorkflow extends WorkflowEntrypoint<Bindings, { drill?: boolean }> {
  async run(event: WorkflowEvent<{ drill?: boolean }>, step: WorkflowStep) {
    const drill = event.payload?.drill === true;
    const repoName = drill ? "drill" : "canary";
    const branch = drill ? "main" : "canary";
    const scheduler = () =>
      this.env.CI_SCHEDULER.get(this.env.CI_SCHEDULER.idFromName("global"));
    const sandboxId = `canary-${event.instanceId.slice(0, 10)}`;

    const admission = await step.do(
      "admit",
      { retries: { limit: 5, delay: 5_000, backoff: "linear" }, timeout: 60_000 },
      async () => {
        const res = await scheduler().admit({
          pool: "CHECKS",
          name: sandboxId,
          instanceId: event.instanceId,
        });
        return { ok: res.ok, reason: "reason" in res ? res.reason : undefined };
      }
    );
    if (!admission.ok) {
      throw new Error(`canary: ${admission.reason ?? "checks pool at capacity"}`);
    }

    try {
      const handle = await step.do("resolve artifacts repo", () =>
        resolveArtifactsToken(this.env, `vortex/${repoName}`)
      );

      await step.do("bump-and-push", async () => {
        const sandbox = this.env.CHECKS_SANDBOX.getByName(sandboxId);
        const result = await sandbox.runCheck({
          checkoutScript: [
            "set -euo pipefail",
            "mkdir -p /workspace && cd /workspace",
            `git clone --depth 1 --branch "$BRANCH" "$REMOTE" . 2>/dev/null || ` +
              '(git init -q && git checkout -q -b "$BRANCH")',
            "git config user.email ci@cloudflare-ci.internal && git config user.name cloudflare-ci",
          ].join(" && "),
          script: [
            "cd /workspace",
            "mkdir -p src",
            `printf '%s\\n' '{"name":"canary","private":true,"version":"0.0.0"}' > package.json`,
            `printf 'lockfileVersion: "9.0"\\nimporters:\\n  .: {}\\npackages: {}\\nsnapshots: {}\\n' > pnpm-lock.yaml`,
            `printf "name = \\"$WORKER_NAME\\"\\nmain = \\"src/index.js\\"\\ncompatibility_date = \\"2026-07-30\\"\\n" > wrangler.toml`,
            `printf '%s\\n' 'export default { async fetch(r) { return new URL(r.url).pathname === "/health" ? Response.json({ok:true,canary:true}) : new Response("canary"); } };' > src/index.js`,
            'date +%s > TICK',
            'git add -A && git commit -qm "tick $(cat TICK)" --no-verify',
            'git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" push -f "$REMOTE" "$BRANCH"',
          ].join(" && "),
          env: {
            ARTIFACTS_TOKEN: handle,
            REMOTE: `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/vortex/${repoName}.git`,
            BRANCH: branch,
            WORKER_NAME: drill ? "cloudflare-ci-drill" : "cloudflare-ci-canary",
            CI: "true",
          },
          timeoutSec: 120,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `canary push failed (${result.exitCode}): ${result.stderr.slice(-2000)}`
          );
        }
      });
    } finally {
      await step
        .do("release", () => scheduler().release(sandboxId))
        .catch(() => {});
      await this.env.CHECKS_SANDBOX.getByName(sandboxId)
        .destroy()
        .catch(() => {});
    }
  }
}
