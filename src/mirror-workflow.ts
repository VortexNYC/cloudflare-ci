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

const ARTIFACTS_NS = "vortex";

async function mintArtifactsToken(
  env: Bindings,
  repo: string
): Promise<string> {
  const apiToken = env.ARTIFACTS_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("no artifacts/api token configured");
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
    const token = await step.do("mint artifacts token", async () =>
      mintArtifactsToken(this.env, repo)
    );
    await step.do("push to artifacts", async () => {
      const sandbox = this.env.CHECKS_SANDBOX.getByName(`mirror-${sha.slice(0, 10)}`);
      const remote = `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/${ARTIFACTS_NS}/${repo.split("/")[1]}.git`;
      // Clone the pushed ref from GitHub, then force-push it to Artifacts —
      // rebased/rewritten branches must still sync, same as the old job.
      const script = [
        "set -euo pipefail",
        "rm -rf /tmp/mirror && git clone --bare --single-branch --branch " +
          JSON.stringify(branch) +
          ` https://x-access-token:${this.env.CHECKS_GITHUB_TOKEN}@github.com/${repo}.git /tmp/mirror`,
        `cd /tmp/mirror && git -c http.extraHeader="Authorization: Bearer ${token}" push --force ${JSON.stringify(remote)} HEAD:refs/heads/${JSON.stringify(branch)}`,
      ].join(" && ");
      const result = await sandbox.runCheck({
        checkoutScript: "true",
        script,
        env: {},
        timeoutSec: 300,
      });
      if (result.exitCode !== 0) {
        throw new Error(`mirror push failed (${result.exitCode}): ${result.stderr}`);
      }
    });
  }
}
