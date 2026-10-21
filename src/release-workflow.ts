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
            ADMIN_TOKEN: this.env.ADMIN_TOKEN ?? "",
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
        return result.stdout.slice(-2400);
      });
      console.log(`[release] ${repo} ${tag} build ok — tail: ${tail}`);

      // The container can't reach api.github.com (egress is git-only) —
      // binaries were PUT to the worker; the release publishes from here.
      await step.do("publish github release", async () => {
        const listed = await this.env.BACKUP_BUCKET.list({
          prefix: `releases/${tag}/`,
        });
        const assets = listed.objects.filter((o) => o.size > 0);
        if (assets.length === 0) {
          throw new Error("release: no assets uploaded by the build");
        }
        const ghHeaders = {
          Authorization: `Bearer ${this.env.CHECKS_GITHUB_TOKEN}`,
          "User-Agent": "cloudflare-ci",
        };
        const rel = await fetch(
          `https://api.github.com/repos/${repo}/releases`,
          {
            method: "POST",
            headers: { ...ghHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              tag_name: tag,
              generate_release_notes: true,
            }),
          }
        );
        if (!rel.ok) {
          throw new Error(`release create ${rel.status}: ${await rel.text()}`);
        }
        const { id } = (await rel.json()) as { id: number };
        for (const asset of assets) {
          const obj = await this.env.BACKUP_BUCKET.get(asset.key);
          if (!obj) continue;
          const name = asset.key.split("/").pop()!;
          const up = await fetch(
            `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${name}`,
            {
              method: "POST",
              headers: {
                ...ghHeaders,
                "Content-Type": "application/octet-stream",
              },
              body: obj.body,
            }
          );
          if (!up.ok) {
            throw new Error(
              `asset ${name} upload ${up.status}: ${await up.text()}`
            );
          }
          await this.env.BACKUP_BUCKET.delete(asset.key);
        }
        return id;
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
