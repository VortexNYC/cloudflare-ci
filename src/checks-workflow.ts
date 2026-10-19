import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getSandbox, type ExecResult } from "@cloudflare/sandbox";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";
import {
  completeCheckRun,
  createCheckRun,
  fetchPrBody,
  getInstallationToken,
  type CheckTarget,
} from "./checks";

const MINUTE = 60 * 1000;

export interface ChecksParams extends CheckTarget {
  /** Optional subset of checks to run — defaults to all configured. */
  checkNames?: string[];
}

type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

export class ChecksWorkflow extends WorkflowEntrypoint<Bindings, ChecksParams> {
  override async run(event: WorkflowEvent<ChecksParams>, step: WorkflowStep) {
    const { repo, sha, prNumber } = event.payload;
    const config = getRepoConfig(repo.split("/")[1] ?? repo);
    const token = this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY
      ? await getInstallationToken(
          this.env.GITHUB_APP_ID,
          this.env.GITHUB_APP_PRIVATE_KEY,
          repo
        ).catch(() => this.env.CHECKS_GITHUB_TOKEN)
      : this.env.CHECKS_GITHUB_TOKEN;
    if (!config || !token) {
      console.log(`[checks] skipping ${repo}: no config or no GITHUB token`);
      return;
    }
    const checks = (config.checks ?? []).filter(
      (c) => !event.payload.checkNames || event.payload.checkNames.includes(c.name)
    );
    if (checks.length === 0) return;

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

    const sandboxId = `checks-${repo.replace("/", "-")}-${sha.slice(0, 10)}`;
    // One check run id per check — created up front so GitHub shows
    // pending checks while the container provisions.
    const runIds = await step.do("create-check-runs", async () => {
      const ids: Record<string, number> = {};
      for (const c of checks) {
        ids[c.name] = await createCheckRun(token, repo, sha, c.name);
      }
      return ids;
    });

    const failAll = async (title: string, summary: string) => {
      await Promise.all(
        checks.map((c) =>
          completeCheckRun(token, repo, runIds[c.name]!, {
            conclusion: "failure",
            title,
            summary,
          }).catch(() => {})
        )
      );
    };

    try {
      // Admission — the lite pool shares the fleet ledger.
      const admitted = await step.do(
        "admit",
        { retries: { limit: 5, delay: 5_000, backoff: "linear" }, timeout: 60_000 },
        async () => {
          const r = await scheduler().admit({
            pool: "SANDBOX_LITE",
            name: sandboxId,
            instanceId: event.instanceId,
          });
          return { ok: r.ok, reason: r.ok ? "" : r.reason };
        }
      );
      if (!admitted.ok) {
        await failAll("CI capacity", "The checks pool is at capacity; retry shortly.");
        return;
      }

      const sandbox = getSandbox(this.env.SANDBOX_LITE, sandboxId);

      // PR body for checks that honor the "No tests:" escape hatch.
      const prBody = prNumber
        ? await step.do("fetch-pr-body", () =>
            fetchPrBody(token, repo, prNumber).catch(() => "")
          )
        : "";

      // Checkout: real git history (depth 50) — diff-coverage compares
      // HEAD^1 so a tarball won't do. Fetches the head ref when known
      // (PR branch / gh-readonly-queue ref), else the SHA itself.
      const checkout = await step.do("checkout", async () => {
        const ref = event.payload.headRef ?? sha;
        const res = await sandbox.exec(
          `cd /workspace && git init -q . && ` +
            `git remote add origin https://x-access-token:$GITHUB_TOKEN@github.com/${repo}.git && ` +
            `git fetch -q --depth 50 origin ${ref} ${ref === sha ? "" : sha} && ` +
            `git checkout -q FETCH_HEAD`,
          {
            env: { GITHUB_TOKEN: token },
            timeout: 3 * MINUTE,
          }
        );
        return res;
      });
      if (checkout.exitCode !== 0) {
        await failAll("Checkout failed", tail(checkout));
        return;
      }

      // Install — pnpm repos relink from the in-workspace store; the
      // command is per-repo in config so Go repos bring their own.
      if (config.checksInstallCommand) {
        const install = await step.do("install", () =>
          sandbox.exec(config.checksInstallCommand!, {
            cwd: "/workspace",
            env: { NPM_TOKEN: this.env.NPM_TOKEN },
            timeout: 10 * MINUTE,
          })
        );
        if (install.exitCode !== 0) {
          await failAll("Install failed", tail(install));
          return;
        }
      }

      // Each check gets its own step — a flaky one retries alone.
      for (const check of checks) {
        const result = await step.do(`check-${check.name}`, async () => {
          const env: Record<string, string> = { ...check.env };
          if (prBody) env.PR_BODY = prBody;
          if (this.env.NPM_TOKEN) env.NPM_TOKEN = this.env.NPM_TOKEN;
          const res = await sandbox.exec(check.command, {
            cwd: "/workspace",
            env,
            timeout: check.timeoutMs ?? 10 * MINUTE,
          });
          const ok = res.exitCode === 0;
          await completeCheckRun(token, repo, runIds[check.name]!, {
            conclusion: ok ? "success" : "failure",
            title: ok ? `${check.name} passed` : `${check.name} failed`,
            summary: tail(res),
          });
          return ok;
        });
        if (!result) {
          // mark remaining checks skipped rather than leave them pending
          const idx = checks.indexOf(check);
          for (const rest of checks.slice(idx + 1)) {
            await completeCheckRun(token, repo, runIds[rest.name]!, {
              conclusion: "neutral",
              title: `${rest.name} skipped`,
              summary: "An earlier check failed; skipped.",
            }).catch(() => {});
          }
          break;
        }
      }
    } finally {
      await withScheduler("release", (stub) => stub.release(sandboxId)).catch(() => {});
    }
  }
}

/** Last ~4KB of combined output — fits comfortably in a check summary. */
function tail(res: ExecResult): string {
  const out = [res.stdout, res.stderr].filter(Boolean).join("\n");
  return out.slice(-4000) || `(no output — exit ${res.exitCode})`;
}
