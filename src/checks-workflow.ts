import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ChecksRunResult } from "./checks-sandbox";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";
import {
  completeCheckRun,
  getOrCreateCheckRun,
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

interface CheckRunOut {
  name: string;
  rc: number;
  output: string;
}

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
      console.log(`[checks] skipping ${repo}: no config or no GitHub creds`);
      return;
    }
    const checks = config.checks.filter(
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

    const sandboxId = `checks-${repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${sha.slice(0, 10)}`;
    // Reuse existing runs on refire — a refired webhook must not mint a
    // duplicate context per check name.
    const runIds = await step.do("create-check-runs", async () => {
      const ids: Record<string, number> = {};
      for (const c of checks) {
        ids[c.name] = await getOrCreateCheckRun(token, repo, sha, c.name);
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
      // PR body for checks that honor the "No tests:" escape hatch.
      const prBody = prNumber
        ? await step.do("fetch-pr-body", () =>
            fetchPrBody(token, repo, prNumber).catch(() => "")
          )
        : "";

      // One sandbox + one step per check, run in parallel — wall clock is
      // the longest check, not the sum. Each does checkout + install +
      // its own check; the R2 pnpm-store cache (mounted via S3Mount) keeps
      // per-sandbox installs ~60s warm instead of ~5min cold. Runtime
      // updates that interrupt an exec are retried — the script is
      // idempotent.
      interface CheckResult {
        name: string;
        ok?: boolean;
        output?: string;
        error?: string;
      }
      const results: CheckResult[] = await Promise.all(
        checks.map((check): Promise<CheckResult> =>
          step
            .do(
              `run-${check.name}`,
              {
                retries: { limit: 2, delay: 15_000 },
                timeout: 80 * MINUTE,
              },
              async () => {
                const checkSandboxId = `${sandboxId}-${check.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
                const admission = await scheduler().admit({
                  pool: "CHECKS",
                  name: checkSandboxId,
                  instanceId: event.instanceId,
                });
                if (!admission.ok) {
                  return {
                    name: check.name,
                    error: "CI capacity — checks pool at capacity",
                  };
                }
                const sandbox = this.env.CHECKS_SANDBOX.getByName(checkSandboxId);
                try {
                  // Flat 75min bound on install+check; check.timeoutMs bounds
                  // the check command itself inside the script — a cold
                  // install can't eat its budget. The store cache (a
                  // DirectoryBackup on the R2 binding) keys off the lockfile
                  // hash — the DO computes it after checkout.
                  const run = await sandbox.runCheck({
                    checkoutScript: buildCheckoutScript(event.payload),
                    script: buildRunScript(config, [check]),
                    env: {
                      GITHUB_TOKEN: token,
                      NPM_TOKEN: this.env.NPM_TOKEN ?? "",
                      PR_BODY: prBody,
                      CI: "true",
                    },
                    timeoutSec: 75 * 60,
                    cacheRepo: config.checksInstallCommand
                      ? repo.split("/")[1]
                      : undefined,
                  });
                  const parsed = parseRunOutput(run);
                  if (parsed.checkoutRc !== 0) {
                    return {
                      name: check.name,
                      error: `Checkout failed: ${parsed.output.slice(-2000)}`,
                    };
                  }
                  if (parsed.installRc !== 0) {
                    return {
                      name: check.name,
                      error: `Install failed: ${parsed.output.slice(-2000)}`,
                    };
                  }
                  const out = parsed.checks[check.name];
                  return {
                    name: check.name,
                    ok: out?.rc === 0,
                    output: (out?.output ?? "(no output)").slice(-4000),
                  };
                } finally {
                  // Destroy while the reservation is still held — a wedged
                  // teardown keeps the slot on the ledger for the sweep to
                  // retry, instead of leaking an unaccounted container.
                  await sandbox.destroy().catch(() => {});
                  await scheduler()
                    .release(checkSandboxId)
                    .catch(() => {});
                }
              }
            )
            .catch((err: unknown) => ({
              name: check.name,
              error: `Check run error: ${String(err)}`,
            }))
        )
      );

      for (const r of results) {
        await step.do(`report-${r.name}`, () => {
          const errored = r.error !== undefined;
          return completeCheckRun(token, repo, runIds[r.name]!, {
            conclusion: errored || !r.ok ? "failure" : "success",
            title: errored
              ? r.error!.split(":")[0]
              : r.ok
                ? `${r.name} passed`
                : `${r.name} failed`,
            summary: errored ? r.error! : (r.output ?? "(no output)"),
          });
        });
      }
    } finally {
      for (const check of checks) {
        await withScheduler(`release-${check.name}`, (stub) =>
          stub.release(
            `${sandboxId}-${check.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`
          )
        ).catch(() => {});
      }
    }
  }
}

interface RepoConfigShape {
  checksInstallCommand?: string;
}

export function buildCheckoutScript(payload: {
  repo: string;
  sha: string;
  headRef?: string;
  prNumber?: number;
  baseSha?: string;
}): string {
  // Diff-based checks (diff-coverage) measure against refs/ci/base, pinned
  // here to the true diff base: the merge's base parent for merge commits,
  // merge_group.base_sha for queue groups (a chain of merges makes HEAD^1
  // point at the previous PR's merge, not the base tip).
  const pinBase = (expr: string) =>
    `[ "$rc" = 0 ] && { git update-ref refs/ci/base ${expr} 2>/dev/null || ` +
    "git update-ref refs/ci/base HEAD^1 2>/dev/null || true; }";
  const lines = [
    "set +e",
    "mkdir -p /workspace && cd /workspace",
    "git init -q .",
    `git remote add origin https://x-access-token:\$GITHUB_TOKEN@github.com/${payload.repo}.git 2>/dev/null || ` +
      `git remote set-url origin https://x-access-token:\$GITHUB_TOKEN@github.com/${payload.repo}.git`,
    "rc=0",
  ];
  if (payload.headRef?.includes("gh-readonly-queue/")) {
    // Merge-queue SHAs are synthetic merges on the queue branch — unreachable
    // from pull/N/head, so the queue ref itself must be fetched.
    lines.push(
      `git fetch -q --depth 50 origin ${shellQuote(payload.headRef)} && git checkout -q ${payload.sha} || rc=$?`,
      pinBase(payload.baseSha ?? "HEAD^1")
    );
  } else if (payload.prNumber) {
    // Prefer the PR merge ref (what GHA checked out): its first parent is the
    // base tip, so ci/base covers the whole PR instead of just the tip commit.
    // GitHub rebuilds the merge ref lazily — a stale one (second parent ≠ this
    // head sha) or a missing one (conflicts) falls back to the head fetch,
    // where ci/base degrades to the tip's parent.
    lines.push(
      `if git fetch -q --depth 50 origin pull/${payload.prNumber}/merge 2>/dev/null && ` +
        `[ "$(git rev-parse 'FETCH_HEAD^2' 2>/dev/null)" = "${payload.sha}" ]; then`,
      `  echo "checkout: pull/${payload.prNumber}/merge"`,
      `  git checkout -q FETCH_HEAD || rc=$?`,
      `else`,
      `  echo "checkout: pull/${payload.prNumber}/head (merge ref stale or absent)"`,
      `  git fetch -q --depth 50 origin pull/${payload.prNumber}/head && git checkout -q ${payload.sha} || rc=$?`,
      `fi`,
      pinBase("HEAD^1")
    );
  } else {
    const fetchRef = payload.headRef ?? payload.sha;
    lines.push(
      `git fetch -q --depth 50 origin ${shellQuote(fetchRef)} && git checkout -q ${payload.sha} || rc=$?`,
      pinBase("HEAD^1")
    );
  }
  lines.push("echo ===CI:CHECKOUT:RC=$rc===");
  return lines.join("\n");
}

export function buildRunScript(
  config: RepoConfigShape,
  checks: Array<{
    name: string;
    command: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }>
): string {
  const lines: string[] = ["set +e"];
  if (config.checksInstallCommand) {
    lines.push(
      // Install into the (possibly restored) store at /tmp/.pnpm-store.
      // The sentinel tells ChecksSandbox the store is worth backing up —
      // seed/upload themselves live in the DO, not the script.
      'mkdir -p /tmp/.pnpm-store',
      `{ ${config.checksInstallCommand}; } > /tmp/install.out 2>&1`,
      "rc=$?",
      "tail -c 3500 /tmp/install.out",
      "echo ===CI:INSTALL:RC=$rc===",
      '[ "$rc" = "0" ] && touch /tmp/.install-ok'
    );
  } else {
    lines.push("echo ===CI:INSTALL:RC=0===");
  }
  for (const check of checks) {
    const exports = Object.entries(check.env ?? {})
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("; ");
    const outFile = `/tmp/check-${check.name}.out`;
    // check.timeoutMs bounds just the command — GNU timeout kills the
    // process group (exit 124), so a hung check can't stall the step and
    // a slow install doesn't burn the check's budget.
    const body = `${exports ? exports + "; " : ""}${check.command}`;
    const invocation = check.timeoutMs
      ? `timeout --kill-after=10 ${Math.floor(check.timeoutMs / 1000)} bash -c ${shellQuote(body)}`
      : `bash -c ${shellQuote(body)}`;
    // Check output goes to a file — the exec response caps buffered
    // stdout and verbose suites (go test) eat the whole budget. Emit a
    // bounded tail between markers instead.
    lines.push(
      `${invocation} > ${outFile} 2>&1`,
      `rc=$?; echo ===CHECK:${check.name}:START===`,
      `tail -c 3500 ${outFile}`,
      `echo ===CHECK:${check.name}:RC=$rc===`
    );
  }
  return lines.join("\n");
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

interface ParsedRun {
  checkoutRc: number;
  installRc: number;
  checks: Record<string, CheckRunOut>;
  output: string;
}

function parseRunOutput(res: ChecksRunResult): ParsedRun {
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n");
  const parsed: ParsedRun = { checkoutRc: 1, installRc: 1, checks: {}, output: text };
  let lastCheck = "";
  const buckets: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const ci = line.match(/^===CI:(CHECKOUT|INSTALL):RC=(\d+)===?$/);
    if (ci) {
      if (ci[1] === "CHECKOUT") parsed.checkoutRc = Number(ci[2]);
      else parsed.installRc = Number(ci[2]);
      continue;
    }
    const cm = line.match(/^===CHECK:([^:]+):(START|RC=(\d+))===$/);
    if (cm) {
      if (cm[2] === "START") {
        lastCheck = cm[1]!;
        parsed.checks[lastCheck] = { name: lastCheck, rc: 1, output: "" };
        buckets[lastCheck] = [];
      } else if (lastCheck && parsed.checks[lastCheck]) {
        parsed.checks[lastCheck]!.rc = Number(cm[3]);
        parsed.checks[lastCheck]!.output = buckets[lastCheck]!.join("\n");
      }
      continue;
    }
    if (lastCheck) buckets[lastCheck]?.push(line);
  }
    return parsed;
}
