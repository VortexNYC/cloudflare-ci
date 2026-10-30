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
        pool: "AUX",
        name: sandboxId,
        instanceId: event.instanceId,
      });
      return { ok: res.ok, reason: "reason" in res ? res.reason : undefined };
    });
    if (!admission.ok) {
      throw new Error(`release: ${admission.reason ?? "AUX pool at capacity"}`);
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
        // The releaseCommand may upload directly to GitHub now — when
        // nothing staged into R2, the publish step is a verify-only no-op.
        if (assets.length === 0) {
          console.log(
            `[release] ${repo} ${tag} — no staged assets; container published directly`
          );
          return;
        }
        const ghHeaders = {
          Authorization: `Bearer ${this.env.CHECKS_GITHUB_TOKEN}`,
          "User-Agent": "cloudflare-ci",
        };
        // Idempotent across retries: a partially-published release (the
        // earlier attempt's 422 already_exists) resumes rather than fails.
        const existing = await fetch(
          `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
          { headers: ghHeaders }
        );
        let id: number;
        let uploaded = new Set<string>();
        if (!existing.ok && existing.status !== 404) {
          await existing.arrayBuffer();
        }
        if (existing.ok) {
          const rel = (await existing.json()) as {
            id: number;
            assets: { name: string }[];
          };
          id = rel.id;
          uploaded = new Set(rel.assets.map((a) => a.name));
        } else {
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
            throw new Error(
              `release create ${rel.status}: ${await rel.text()}`
            );
          }
          id = ((await rel.json()) as { id: number }).id;
        }
        for (const asset of assets) {
          const obj = await this.env.BACKUP_BUCKET.get(asset.key);
          if (!obj) throw new Error(`release: ${asset.key} missing`);
          const name = asset.key.split("/").pop()!;
          if (uploaded.has(name)) continue;
          // R2 rejects streams of unknown length, and a ~100MB
          // arrayBuffer OOMs the isolate. The gzip trailer's last 4 bytes
          // carry the uncompressed size — wrap the decompression in a
          // FixedLengthStream and pipe it straight into the upload.
          // Ship the .gz asset — a ~108MB raw binary as a fetch body
          // OOMs the isolate (hard ~100MB cap); the gzip (~35MB) streams
          // fine. Asset keeps the .gz suffix; consumers gunzip.
          const up = await fetch(
            `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${name}`,
            {
              method: "POST",
              headers: {
                ...ghHeaders,
                "Content-Type": "application/gzip",
                "Content-Length": String(asset.size),
              },
              body: obj.body,
              // @ts-expect-error Workers fetch supports duplex for streams
              duplex: "half",
            }
          );
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
