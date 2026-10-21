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
export class CanaryWorkflow extends WorkflowEntrypoint<
  Bindings,
  Record<string, never>
> {
  async run(event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
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
      const repoName = "canary";
      const handle = await step.do("resolve artifacts repo", () =>
        resolveArtifactsToken(this.env, `vortex/${repoName}`)
      );

      await step.do("bump-and-push", async () => {
        const sandbox = this.env.CHECKS_SANDBOX.getByName(sandboxId);
        const seed = [
          "mkdir -p /work/src",
          'cat > /work/package.json <<\'EOF\'\n{"name":"canary","private":true,"version":"0.0.0"}\nEOF',
          "printf 'lockfileVersion: \"9.0\"\\n' > /work/pnpm-lock.yaml",
          'printf \'name = "cloudflare-ci-canary"\\nmain = "src/index.js"\\ncompatibility_date = "2026-07-30"\\n\' > /work/wrangler.toml',
          'cat > /work/src/index.js <<\'EOF\'\nexport default { async fetch(r) { return new URL(r.url).pathname === "/health" ? Response.json({ok:true,canary:true}) : new Response("canary"); } };\nEOF',
        ].join(" && ");
        const result = await sandbox.runCheck({
          checkoutScript: [
            "set -euo pipefail",
            "mkdir -p /workspace /work && cd /workspace",
            `git clone --depth 1 --branch canary "$REMOTE" . 2>/dev/null || ` +
              "(git init -q && git checkout -q -b canary)",
            "git config user.email ci@cloudflare-ci.internal && git config user.name cloudflare-ci",
            "cd /work && " + seed,
            "cp -a /work/. /workspace/",
          ].join(" && "),
          script: [
            "cd /workspace",
            'date +%s > TICK',
            'git add -A && git commit -qm "tick $(cat TICK)" --no-verify',
            'git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" push -f "$REMOTE" canary',
          ].join(" && "),
          env: {
            ARTIFACTS_TOKEN: handle,
            REMOTE: `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/vortex/${repoName}.git`,
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
