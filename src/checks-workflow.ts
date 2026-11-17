import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ChecksRunResult } from "./checks-sandbox";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";
import { logCiEvent } from "./observability";
import {
  completeCheckRun,
  getOrCreateCheckRun,
  updateCheckRunStatus,
  fetchPrBody,
  fetchPrHeadRepoName,
  getChecksGitHubToken,
  getInstallationToken,
  type CheckTarget,
} from "./checks";
import { sendOpsAlert } from "./alerts";
import { notConfiguredAlertKey } from "./scheduled";

const MINUTE = 60 * 1000;

// Queued admission polling when the checks pool is saturated: fast early
// retries settle the common case (a slot frees within seconds), the 60s
// cap keeps a deep queue cheap. 45 attempts of 5s→60s capped exponential
// tops out near a ~40min wait — past that the check fails honestly
// instead of sitting "queued" forever.
const QUEUE_ADMIT_ATTEMPTS = 45;
const QUEUE_ADMIT_MIN_DELAY_MS = 5_000;
const QUEUE_ADMIT_MAX_DELAY_MS = 60_000;
const SCHEDULED_ALERT_DEDUPE_MS = 6 * 60 * 60_000;
// How often an in-flight check re-reads its newest-wins claim. Short
// enough that a superseded run wastes seconds, long enough that the DO
// read load is trivial. Tests override via CHECKS_SUPERSEDE_POLL_MS.
const SUPERSEDE_POLL_MS = 15_000;

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

/** Named worker secrets → process env. Required names fail closed; optional
 *  names are passed only when configured. Values never enter script text. */
export function resolveCheckSecrets(
  env: Bindings,
  checks: Array<{ secrets?: string[]; optionalSecrets?: string[] }>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing = new Set<string>();
  const read = (name: string): string | undefined => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  for (const check of checks) {
    for (const name of check.secrets ?? []) {
      const value = read(name);
      if (value === undefined) missing.add(name);
      else values[name] = value;
    }
    for (const name of check.optionalSecrets ?? []) {
      const value = read(name);
      if (value !== undefined) values[name] = value;
    }
  }
  return { values, missing: [...missing] };
}

export interface CheckMetric {
  repo: string;
  sha: string;
  job: string;
  waitMs: number;
  setupMs: number;
  runMs: number;
  result: "success" | "failure" | "cancelled" | "superseded";
  prNumber?: number;
  ref?: string;
}

function writeCheckMetric(env: Bindings, metric: CheckMetric): void {
  env.CI_METRICS?.writeDataPoint({
    indexes: ["check", metric.repo, metric.job, metric.result, metric.ref ?? "unknown"],
    doubles: [metric.waitMs, metric.setupMs, metric.runMs, metric.prNumber ?? 0],
    blobs: [metric.sha],
  });
}

export class ChecksWorkflow extends WorkflowEntrypoint<Bindings, ChecksParams> {
  override async run(event: WorkflowEvent<ChecksParams>, step: WorkflowStep) {
    const { repo, sha, prNumber, headRef } = event.payload;
    const config = getRepoConfig(repo.split("/")[1] ?? repo);
    const token = await getChecksGitHubToken(this.env, repo);
    if (!config || !token) {
      console.log(`[checks] skipping ${repo}: no config or no GitHub creds`);
      return;
    }
    // Dispatch runs ride the scheduled lane: no GitHub check-runs, the
    // same aux tracking / pool accounting, and deduped ops alerts on
    // failure — the only difference is which check list they select.
    const isDispatch = event.payload.dispatch === true;
    const logOnly = event.payload.scheduled === true || isDispatch;
    const sourceChecks = isDispatch
      ? config.dispatchChecks
      : event.payload.scheduled
        ? config.scheduledChecks
        : config.checks;
    const checks = sourceChecks.filter(
      (c) => !event.payload.checkNames || event.payload.checkNames.includes(c.name)
    );
    if (checks.length === 0) return;
    const scheduledScope = logOnly
      ? (event.payload.scheduledKey ?? `scheduled-${repo}-${sha.slice(0, 10)}`)
      : undefined;

    // Secret-bearing PR gates must never execute fork code in a sandbox —
    // the fork's install scripts would see the injected env. Verify the
    // PR's head repo before any check-run or sandbox exists. The fetch is
    // not caught: a transient GitHub error retries via step.do rather than
    // silently looking like a fork.
    let sameRepoPr = true;
    if (prNumber !== undefined && checks.some((c) => c.sameRepoOnly)) {
      sameRepoPr = await step.do(
        "verify-pr-origin",
        {
          retries: { limit: 5, delay: 5_000, backoff: "linear" },
          timeout: 60_000,
        },
        async () =>
          (await fetchPrHeadRepoName(token, repo, prNumber)) === repo
      );
    }
    // Draft PRs run the fast lane only (format, lint, secret scan). The
    // rest of the suite still gets a check-run completed neutral — a
    // required context left unposted hangs the merge, and a fake green
    // would hide real work. Marking ready_for_review refires the
    // pull_request event with draft unset, which runs everything.
    const draftPr = event.payload.draft === true;
    const draftSkipped = draftPr ? checks.filter((c) => !c.fast) : [];
    const runnable = checks.filter(
      (c) => (!c.sameRepoOnly || sameRepoPr) && (!draftPr || c.fast)
    );
    // Confirmed fork: these checks still need a check-run completed as
    // neutral — a required context left unposted hangs the merge.
    const forkSkipped = checks.filter((c) => c.sameRepoOnly && !sameRepoPr);

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

    if (logOnly) {
      const secretResolution = resolveCheckSecrets(this.env, checks);
      if (secretResolution.missing.length > 0) {
        const missing = secretResolution.missing;
        const alerted = await withScheduler("not-configured-alert", (stub) =>
          stub.alertDue(
            notConfiguredAlertKey(repo, missing),
            Number.MAX_SAFE_INTEGER
          )
        ).catch(() => false);
        if (alerted) {
          await logCiEvent(this.env, "ci.scheduled.not_configured", {
            repo,
            checks: checks.map((c) => c.name),
            missing,
          });
          await sendOpsAlert(
            this.env,
            "Scheduled checks not configured",
            [
              `cloudflare-ci ${isDispatch ? "dispatch" : "scheduled"} checks are not configured on this Worker.`,
              `- repo: ${repo}`,
              `- checks: ${checks.map((c) => c.name).join(", ")}`,
              `- missing secrets: ${missing.join(", ")}`,
            ].join("\n")
          ).catch(() => {});
        }
        return;
      }
    }

    // Dispatch checks that push to GitHub (ops/deploy-locked-* tags) need
    // contents:write — the checks token only carries contents:read. Mint a
    // scoped installation token when the App creds exist; otherwise the
    // run keeps CHECKS_GITHUB_TOKEN (a PAT deploy may have write anyway).
    let gitToken = token;
    if (isDispatch && checks.some((c) => c.gitWrite)) {
      gitToken = await step
        .do(
          "mint-write-token",
          {
            retries: { limit: 3, delay: 5_000, backoff: "linear" },
            timeout: 60_000,
          },
          async () => {
            if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) {
              return token;
            }
            return await getInstallationToken(
              this.env.GITHUB_APP_ID,
              this.env.GITHUB_APP_PRIVATE_KEY,
              repo,
              {
                permissions: {
                  checks: "write",
                  contents: "write",
                  pull_requests: "read",
                },
              }
            );
          }
        )
        .catch(() => token);
    }

    // Declared operator inputs → INPUT_<NAME> env in the check process,
    // the same surface GitHub's inputs.* context gave the old workflows.
    const inputEnv: Record<string, string> = {};
    if (isDispatch) {
      for (const c of config.dispatchChecks) {
        if (!checks.includes(c)) continue;
        for (const input of c.inputs) {
          const key = `INPUT_${input.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
          inputEnv[key] = event.payload.inputs?.[input.name] ?? "";
        }
      }
    }

    await withScheduler("track-aux-wf", (stub) =>
      stub.trackAuxWorkflow({
        kind: "checks",
        repo,
        sha,
        instanceId: event.instanceId,
        scope: scheduledScope,
        params: event.payload,
      })
    );

    const sandboxScope = scheduledScope
      ? `-${scheduledScope.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`
      : "";
    const sandboxId = `checks-${repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${sha.slice(0, 10)}${sandboxScope}`;
    // Reuse existing runs on refire — a refired webhook must not mint a
    // duplicate context per check name.
    const appId = Number(this.env.GITHUB_APP_ID);
    const runIds = await step.do("create-check-runs", async () => {
      const ids: Record<string, number> = {};
      // Scheduled + dispatch lanes are log+alert only — never mint check-runs on main.
      if (logOnly) return ids;
      for (const c of checks) {
        // One bad check-run create/PATCH (e.g. a foreign-app run we may
        // not reuse, or a token without checks:write) must not kill the
        // Workflow — the other checks still run and report.
        try {
          ids[c.name] = await getOrCreateCheckRun(
            token,
            repo,
            sha,
            c.name,
            Number.isFinite(appId) ? appId : undefined
          );
        } catch (err) {
          console.error(`[checks] check-run for ${repo} ${c.name}: ${String(err)}`);
        }
      }
      return ids;
    });

    for (const c of forkSkipped) {
      const runId = runIds[c.name];
      if (runId === undefined) continue;
      await step.do(`skip-fork-${c.name}`, () =>
        completeCheckRun(token, repo, runId, {
          conclusion: "neutral",
          title: `${c.name} skipped`,
          summary:
            "Fork pull request — this check injects Worker secrets into " +
            "its sandbox and only runs on same-repo branches.",
        })
      );
    }
    for (const c of draftSkipped) {
      if (forkSkipped.includes(c)) continue;
      const runId = runIds[c.name];
      if (runId === undefined) continue;
      await step.do(`skip-draft-${c.name}`, () =>
        completeCheckRun(token, repo, runId, {
          conclusion: "neutral",
          title: `${c.name} skipped (draft)`,
          summary:
            "Draft pull request — only the fast checks (format, lint, " +
            "secret scan) run on drafts. This check runs when the PR is " +
            "marked ready for review or enters the merge queue.",
        })
      );
    }
    if (runnable.length === 0) {
      await withScheduler("complete-aux-wf", (stub) =>
        stub.completeAuxWorkflow("checks", repo, sha, event.instanceId)
      );
      return;
    }

    // Merge-queue refs are per-group and immutable — superseding only
    // makes sense on real PR branch refs (pull_request / check_suite).
    // Never on main: a rerequested suite there must run to completion.
    const queueKey =
      headRef && !headRef.includes("gh-readonly-queue/") && headRef !== "main"
        ? headRef
        : null;

    // Newest-wins claim on (repo, ref): a check run that ends up queued
    // for a pool slot reads this back and cancels itself when a newer
    // push took the branch — a stale run that kept polling would burn a
    // container on a dead commit. The same claim also feeds the
    // in-flight supersede watch below.
    if (queueKey) {
      await withScheduler("dedupe-checkclaim", (stub) =>
        stub.claimCheck(
          repo,
          queueKey,
          event.instanceId,
          sha,
          event.timestamp.getTime()
        )
      );
    }

    // In-flight supersede watch: the claim check during admission only
    // covers runs still queued for a slot — a running check on a stale
    // sha used to burn its container to completion. While a sandbox runs,
    // re-read the claim on a poll; a newer push on the same PR ref makes
    // the run report superseded and the `finally` destroys the sandbox,
    // which is the actual cancellation. Unarmed on main, merge-queue
    // refs, and the scheduled/dispatch lanes (queueKey is null for all
    // of them) — those runs always finish.
    const supersedePollMs =
      Number(
        (this.env as unknown as Record<string, unknown>)
          .CHECKS_SUPERSEDE_POLL_MS
      ) || SUPERSEDE_POLL_MS;
    const runWithSupersedeWatch = async (
      run: () => Promise<ChecksRunResult>
    ): Promise<ChecksRunResult | "superseded"> => {
      if (!queueKey) return await run();
      let finished = false;
      const runPromise = run();
      // The superseded path returns without awaiting runPromise — never
      // let its late rejection go unhandled.
      runPromise.catch(() => {});
      const watched = await Promise.race([
        runPromise.then(() => ({ kind: "result" as const })),
        (async () => {
          while (!finished) {
            await new Promise((r) => setTimeout(r, supersedePollMs));
            if (finished) return { kind: "poll-ended" as const };
            const claim = await scheduler()
              .getCheckClaim(repo, queueKey)
              .catch(() => null);
            if (claim && claim.sha !== sha) {
              return { kind: "superseded" as const };
            }
          }
          return { kind: "poll-ended" as const };
        })(),
      ]);
      finished = true;
      if (watched.kind === "superseded") return "superseded";
      return await runPromise;
    };

    // `isolated` checks always take their own ChecksSandbox — a long live
    // gate (worker-money-paths-regression) must never sit inside the
    // serial suite's one slot, and a secret-bearing run keeps its env out
    // of the shared sandbox.
    const serialChecks = runnable.filter((c) => !c.isolated);
    const isolatedChecks = runnable.filter((c) => c.isolated);

    const useSerial =
      config.checksExecution === "serial" &&
      serialChecks.length > 1 &&
      !event.payload.checkNames?.length;

    try {
      // PR body for checks that honor the "No tests:" escape hatch.
      const prBody = prNumber
        ? await step.do("fetch-pr-body", () =>
            fetchPrBody(token, repo, prNumber).catch(() => "")
          )
        : "";

      // Checkout gets only non-secret env; install+check additionally gets
      // the named worker secrets (DATABASE_URL, PlanetScale tokens). The
      // stable run key names ephemeral PlanetScale branches deterministically.
      const checkoutEnv = {
        GITHUB_TOKEN: gitToken,
        NPM_TOKEN: this.env.NPM_TOKEN ?? "",
        PR_BODY: prBody,
        CI: "true",
        CI_RUN_KEY: event.payload.scheduledKey ?? event.instanceId,
        PLANETSCALE_ORG: this.env.PLANETSCALE_ORG ?? "",
        PLANETSCALE_DATABASE: this.env.PLANETSCALE_DATABASE ?? "",
        PLANETSCALE_BASE_BRANCH: this.env.PLANETSCALE_BASE_BRANCH ?? "",
      };
      const serialPool = checks[0]?.pool ?? "CHECKS";

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
        /** Cancelled while queued — a newer sha claimed the ref. */
        superseded?: boolean;
        metric?: CheckMetric;
      }

      const recordMetric = (result: CheckResult): Promise<void> =>
        result.metric
          ? step.do(`metric-${result.name}`, async () => {
              writeCheckMetric(this.env, result.metric!);
            })
          : Promise.resolve();

      let results!: CheckResult[];

      if (useSerial) {
        const slotName = `${sandboxId}-all`;
        const attemptAdmit = async (): Promise<
          | { state: "admitted" }
          | { state: "superseded" }
          | { state: "denied"; reason: string }
        > => {
          if (queueKey) {
            const claim = await scheduler().getCheckClaim(repo, queueKey);
            if (claim && claim.sha !== sha) return { state: "superseded" };
          }
          const admission = await scheduler().admit({
            pool: serialPool,
            name: slotName,
            instanceId: event.instanceId,
          });
          return admission.ok
            ? { state: "admitted" }
            : { state: "denied", reason: admission.reason };
        };

        const first = await step.do(
          "admit-serial",
          {
            retries: { limit: 5, delay: 5_000, backoff: "linear" },
            timeout: 60_000,
          },
          async () => {
            const waitStartedAt = Date.now();
            const outcome = await attemptAdmit();
            return { outcome, waitStartedAt, admittedAt: Date.now() };
          }
        );

        if (first.outcome.state === "superseded") {
          results = serialChecks.map((c) => ({
            name: c.name,
            superseded: true,
            metric: {
              repo, sha, job: c.name, waitMs: 0, setupMs: 0, runMs: 0,
              result: "superseded", prNumber, ref: headRef,
            },
          }));
        } else if (first.outcome.state === "denied") {
          const queueReason = first.outcome.reason;
          await logCiEvent(this.env, "ci.checks.pool_wait_started", {
            repo,
            sha,
            mode: "serial",
            reason: queueReason,
          });
          for (const c of serialChecks) {
            await step.do(`queued-${c.name}`, () =>
              logOnly
                ? Promise.resolve()
                : updateCheckRunStatus(token, repo, runIds[c.name]!, "queued", {
                    title: `${c.name} queued`,
                    summary: `${queueReason} — waiting for a checks slot.`,
                  }).catch(() => {})


            );
          }
          const waited = await step
            .do(
              "admit-wait-serial",
              {
                retries: {
                  limit: QUEUE_ADMIT_ATTEMPTS,
                  delay: ({ ctx }) =>
                    Math.min(
                      QUEUE_ADMIT_MAX_DELAY_MS,
                      QUEUE_ADMIT_MIN_DELAY_MS * 2 ** (ctx.attempt - 1)
                    ),
                },
                timeout: 60 * MINUTE,
              },
              async (): Promise<{ state: "admitted" | "superseded"; admittedAt: number }> => {
                const outcome = await attemptAdmit();
                if (outcome.state === "denied") throw new Error(outcome.reason);
                return { state: outcome.state, admittedAt: Date.now() };
              }
            )
            .catch((): { state: "capacity" } => ({ state: "capacity" }));
          const serialWaitMs =
            waited.state === "capacity" ? 0 : waited.admittedAt - first.waitStartedAt;
          if (waited.state === "superseded") {
            results = serialChecks.map((c) => ({
              name: c.name,
              superseded: true,
              metric: {
                repo, sha, job: c.name, waitMs: serialWaitMs, setupMs: 0, runMs: 0,
                result: "superseded", prNumber, ref: headRef,
              },
            }));
          } else if (waited.state === "capacity") {
            await logCiEvent(this.env, "ci.checks.pool_saturated", {
              repo,
              sha,
              mode: "serial",
            });
            results = serialChecks.map((c) => ({
              name: c.name,
              error:
                "CI capacity — waited ~40m for a checks slot and the pool never freed",
              metric: {
                repo, sha, job: c.name, waitMs: serialWaitMs, setupMs: 0, runMs: 0,
                result: "failure", prNumber, ref: headRef,
              },
            }));
          } else {
            await logCiEvent(this.env, "ci.checks.pool_wait_done", {
              repo,
              sha,
              mode: "serial",
            });
            results = await step.do(
              "run-serial-checks",
              {
                retries: { limit: 2, delay: 15_000 },
                timeout: 90 * MINUTE,
              },
              async (): Promise<CheckResult[]> => {
                if (!logOnly) {
                  for (const c of serialChecks) {
                    await updateCheckRunStatus(
                      token,
                      repo,
                      runIds[c.name]!,
                      "in_progress"
                    ).catch(() => {});
                  }
                }
                const sandbox = this.env.CHECKS_SANDBOX.getByName(slotName);
                try {
                  const run = await runWithSupersedeWatch(() =>
                    sandbox.runCheck({
                    checkoutScript: buildCheckoutScript(event.payload),
                    script: buildRunScript(config, serialChecks),
                    env: {
                      GITHUB_TOKEN: token,
                      NPM_TOKEN: this.env.NPM_TOKEN ?? "",
                      PR_BODY: prBody,
                      CI: "true",
                    },
                    timeoutSec: 85 * 60,
                    cacheRepo: config.checksInstallCommand
                      ? repo.split("/")[1]
                      : undefined,
                    })
                  );
                  if (run === "superseded") {
                    return serialChecks.map((c) => ({
                      name: c.name,
                      superseded: true,
                      metric: {
                        repo, sha, job: c.name, waitMs: serialWaitMs,
                        setupMs: 0, runMs: 0,
                        result: "superseded" as const, prNumber, ref: headRef,
                      },
                    }));
                  }
                  const parsed = parseRunOutput(run);
                  const setupMs = run.checkoutMs + run.restoreMs + run.installMs;
                  const metricFor = (check: (typeof serialChecks)[number]): CheckMetric => ({
                    repo, sha, job: check.name, waitMs: serialWaitMs, setupMs,
                    runMs: run.checkMs[check.name] ?? 0,
                    result: parsed.checkoutRc !== 0 || parsed.installRc !== 0
                      ? "failure" : parsed.checks[check.name]?.rc === 0 ? "success" : "failure",
                    prNumber, ref: headRef,
                  });
                  warnIfOvercommitDenied(parsed, repo);
                  if (parsed.checkoutRc !== 0) {
                    const err = `Checkout failed: ${parsed.output.slice(-2000)}`;
                    return serialChecks.map((c) => ({ name: c.name, error: err, metric: metricFor(c) }));
                  }
                  if (parsed.installRc !== 0) {
                    const err = `Install failed: ${parsed.output.slice(-2000)}`;
                    return serialChecks.map((c) => ({ name: c.name, error: err, metric: metricFor(c) }));
                  }
                  return serialChecks.map((c) => {
                    const out = parsed.checks[c.name];
                    return {
                      name: c.name,
                      ok: out?.rc === 0,
                      output: (out?.output ?? "(no output)").slice(-4000),
                      metric: metricFor(c),
                    };
                  });
                } finally {
                  await sandbox.destroy().catch(() => {});
                  await scheduler().release(slotName).catch(() => {});
                }
              }
            );
          }
        } else {
          const serialWaitMs = first.admittedAt - first.waitStartedAt;
          for (const c of serialChecks) {
            await step.do(`start-${c.name}`, () =>
              logOnly
                ? Promise.resolve()
                : updateCheckRunStatus(
                    token,
                    repo,
                    runIds[c.name]!,
                    "in_progress"
                  ).catch(() => {})
            );
          }
          results = await step.do(
            "run-serial-checks",
            {
              retries: { limit: 2, delay: 15_000 },
              timeout: 90 * MINUTE,
            },
            async (): Promise<CheckResult[]> => {
              const sandbox = this.env.CHECKS_SANDBOX.getByName(slotName);
              try {
                const run = await runWithSupersedeWatch(() =>
                  sandbox.runCheck({
                    checkoutScript: buildCheckoutScript(event.payload),
                    script: buildRunScript(config, serialChecks),
                    env: {
                      GITHUB_TOKEN: token,
                      NPM_TOKEN: this.env.NPM_TOKEN ?? "",
                      PR_BODY: prBody,
                      CI: "true",
                    },
                    timeoutSec: 85 * 60,
                    cacheRepo: config.checksInstallCommand
                      ? repo.split("/")[1]
                      : undefined,
                  })
                );
                if (run === "superseded") {
                  return serialChecks.map((c) => ({
                    name: c.name,
                    superseded: true,
                    metric: {
                      repo, sha, job: c.name, waitMs: serialWaitMs,
                      setupMs: 0, runMs: 0,
                      result: "superseded" as const, prNumber, ref: headRef,
                    },
                  }));
                }
                const parsed = parseRunOutput(run);
                const setupMs = run.checkoutMs + run.restoreMs + run.installMs;
                const metricFor = (check: (typeof serialChecks)[number]): CheckMetric => ({
                  repo, sha, job: check.name, waitMs: serialWaitMs, setupMs,
                runMs: run.checkMs?.[check.name] ?? 0,
                  result: parsed.checkoutRc !== 0 || parsed.installRc !== 0
                    ? "failure" : parsed.checks[check.name]?.rc === 0 ? "success" : "failure",
                  prNumber, ref: headRef,
                });
                warnIfOvercommitDenied(parsed, repo);
                if (parsed.checkoutRc !== 0) {
                  const err = `Checkout failed: ${parsed.output.slice(-2000)}`;
                  return serialChecks.map((c) => ({ name: c.name, error: err, metric: metricFor(c) }));
                }
                if (parsed.installRc !== 0) {
                  const err = `Install failed: ${parsed.output.slice(-2000)}`;
                  return serialChecks.map((c) => ({ name: c.name, error: err, metric: metricFor(c) }));
                }
                return serialChecks.map((c) => {
                  const out = parsed.checks[c.name];
                  return {
                    name: c.name,
                    ok: out?.rc === 0,
                    output: (out?.output ?? "(no output)").slice(-4000),
                    metric: metricFor(c),
                  };
                });
              } finally {
                await sandbox.destroy().catch(() => {});
                await scheduler().release(slotName).catch(() => {});
              }
            }
          );
        }
      }

      // Parallel lane: every check on the repo runs here when execution
      // isn't serial; under serial it hosts only `isolated` checks (each
      // still gets its own ChecksSandbox + claim).
      const parallelTargets = useSerial ? isolatedChecks : runnable;

      const runOneCheck = async (
        check: (typeof runnable)[number]
      ): Promise<CheckResult> => {
        const checkSandboxId = `${sandboxId}-${check.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
        const attemptAdmit = async (): Promise<
          | { state: "admitted" }
          | { state: "superseded" }
          | { state: "denied"; reason: string }
        > => {
          if (queueKey) {
            const claim = await scheduler().getCheckClaim(repo, queueKey);
            if (claim && claim.sha !== sha) return { state: "superseded" };
          }
          const admission = await scheduler().admit({
            pool: check.pool,
            name: checkSandboxId,
            instanceId: event.instanceId,
          });
          return admission.ok
            ? { state: "admitted" }
            : { state: "denied", reason: admission.reason };
        };

        const first = await step.do(
          `admit-${check.name}`,
          {
            retries: { limit: 5, delay: 5_000, backoff: "linear" },
            timeout: 60_000,
          },
          async () => {
            const waitStartedAt = Date.now();
            const outcome = await attemptAdmit();
            return { outcome, waitStartedAt, admittedAt: Date.now() };
          }
        );
        if (first.outcome.state === "superseded") {
          return {
            name: check.name,
            superseded: true,
            metric: {
              repo, sha, job: check.name, waitMs: 0, setupMs: 0, runMs: 0,
              result: "superseded", prNumber, ref: headRef,
            },
          };
        }
        let waitMs: number;
        if (first.outcome.state === "denied") {
          const queueReason = first.outcome.reason;
          await logCiEvent(this.env, "ci.checks.pool_wait_started", {
            repo,
            sha,
            check: check.name,
            reason: queueReason,
          });
          // The pool is saturated — keep the check run "queued" and poll
          // for a slot inside the workflow instead of failing the check
          // (an author used to have to push an empty commit to retrigger).
          await step.do(`queued-${check.name}`, () =>
            logOnly
              ? Promise.resolve()
              : updateCheckRunStatus(token, repo, runIds[check.name]!, "queued", {
                  title: `${check.name} queued`,
                  summary: `${queueReason} — waiting for a checks slot to free up.`,
                }).catch(() => {})


          );
          const waited = await step
            .do(
              `admit-wait-${check.name}`,
              {
                retries: {
                  limit: QUEUE_ADMIT_ATTEMPTS,
                  delay: ({ ctx }) =>
                    Math.min(
                      QUEUE_ADMIT_MAX_DELAY_MS,
                      QUEUE_ADMIT_MIN_DELAY_MS * 2 ** (ctx.attempt - 1)
                    ),
                },
                timeout: 60 * MINUTE,
              },
              async (): Promise<{ state: "admitted" | "superseded"; admittedAt: number }> => {
                const outcome = await attemptAdmit();
                if (outcome.state === "denied")
                  throw new Error(outcome.reason);
                return { state: outcome.state, admittedAt: Date.now() };
              }
            )
            // Retries exhausted (still saturated) or a persistent
            // scheduler failure — the queue bound ends in an honest
            // failure, not a check stuck queued forever.
            .catch((): { state: "capacity" } => ({ state: "capacity" }));
          const queuedWaitMs =
            waited.state === "capacity"
              ? 0
              : waited.admittedAt - first.waitStartedAt;
          if (waited.state === "superseded") {
            return {
              name: check.name,
              superseded: true,
              metric: {
                repo, sha, job: check.name, waitMs: queuedWaitMs,
                setupMs: 0, runMs: 0, result: "superseded", prNumber, ref: headRef,
              },
            };
          }
          if (waited.state === "capacity") {
            await logCiEvent(this.env, "ci.checks.pool_saturated", {
              repo,
              sha,
              check: check.name,
            });
            return {
              name: check.name,
              error:
                "CI capacity — waited ~40m for a checks slot and the " +
                `pool never freed (${queueReason})`,
              metric: {
                repo, sha, job: check.name, waitMs: queuedWaitMs,
                setupMs: 0, runMs: 0, result: "failure", prNumber, ref: headRef,
              },
            };
          }
          await logCiEvent(this.env, "ci.checks.pool_wait_done", {
            repo,
            sha,
            check: check.name,
          });
          await step.do(`start-${check.name}`, () =>
            logOnly
              ? Promise.resolve()
              : updateCheckRunStatus(
                  token,
                  repo,
                  runIds[check.name]!,
                  "in_progress"
                ).catch(() => {})
          );
          waitMs = queuedWaitMs;
        } else {
          waitMs = first.admittedAt - first.waitStartedAt;
        }

        // Check-declared secrets: names are looked up on this Worker's
        // env and injected into the sandbox — an unbound name lands as
        // "" so the check's own guard fails closed and reports the name.
        const checkSecrets = checkSecretsOf(this.env, check);
        // GHA masked secret values; check output lands in GitHub
        // check-run summaries and logs, so every non-empty injected value
        // is scrubbed before it leaves.
        const scrub = (text: string) => redactSecrets(text, checkSecrets);

        return step.do(
          `run-${check.name}`,
          {
            retries: { limit: 2, delay: 15_000 },
            timeout: 80 * MINUTE,
          },
          async (): Promise<CheckResult> => {
            const sandbox = this.env.CHECKS_SANDBOX.getByName(checkSandboxId);
            try {
              // Flat 75min bound on install+check; check.timeoutMs bounds
              // the check command itself inside the script — a cold
              // install can't eat its budget. The store cache (a
              // DirectoryBackup on the R2 binding) keys off the lockfile
              // hash — the DO computes it after checkout.
              const run = await runWithSupersedeWatch(() =>
                sandbox.runCheck({
                checkoutScript: buildCheckoutScript(event.payload),
                script: buildRunScript(config, [check]),
                env: logOnly
                  ? {
                      ...checkoutEnv,
                      PR_NUMBER: String(prNumber ?? ""),
                      REPO: repo,
                      ...inputEnv,
                      ...checkSecrets,
                    }
                  : {
                      GITHUB_TOKEN: token,
                      NPM_TOKEN: this.env.NPM_TOKEN ?? "",
                      PR_BODY: prBody,
                      PR_NUMBER: String(prNumber ?? ""),
                      REPO: repo,
                      CI: "true",
                      ...checkSecrets,
                    },
                checkoutEnv: logOnly ? checkoutEnv : undefined,
                timeoutSec: 75 * 60,
                cacheRepo:
                  config.checksInstallCommand && check.needsInstall !== false
                    ? repo.split("/")[1]
                    : undefined,
                })
              );
              if (run === "superseded") {
                return {
                  name: check.name,
                  superseded: true,
                  metric: {
                    repo, sha, job: check.name, waitMs,
                    setupMs: 0, runMs: 0,
                    result: "superseded", prNumber, ref: headRef,
                  },
                };
              }
              const parsed = parseRunOutput(run);
              const setupMs = run.checkoutMs + run.restoreMs + run.installMs;
              const metricFor = (result: CheckMetric["result"]): CheckMetric => ({
                repo, sha, job: check.name, waitMs, setupMs,
                  runMs: run.checkMs?.[check.name] ?? 0,
                result, prNumber, ref: headRef,
              });
              warnIfOvercommitDenied(parsed, repo);
              if (parsed.checkoutRc !== 0) {
                return {
                  name: check.name,
                  error: `Checkout failed: ${scrub(parsed.output).slice(-2000)}`,
                  metric: metricFor("failure"),
                };
              }
              if (parsed.installRc !== 0) {
                return {
                  name: check.name,
                  error: `Install failed: ${scrub(parsed.output).slice(-2000)}`,
                  metric: metricFor("failure"),
                };
              }
              const out = parsed.checks[check.name];
              return {
                name: check.name,
                ok: out?.rc === 0,
                output: scrub(out?.output ?? "(no output)").slice(-4000),
                metric: metricFor(out?.rc === 0 ? "success" : "failure"),
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
        );
      };

      const parallelResults = await Promise.all(
        parallelTargets.map((check): Promise<CheckResult> =>
          runOneCheck(check).catch((err: unknown) => ({
            name: check.name,
            error: `Check run error: ${redactSecrets(String(err), checkSecretsOf(this.env, check))}`,
          }))
        )
      );
      results = [...(results ?? []), ...parallelResults];

      for (const r of results) {
        if (logOnly) continue;
        // No check-run was opened for this name (its create/PATCH
        // failed) — the check still ran; nothing to report against.
        const runId = runIds[r.name];
        if (runId === undefined) continue;
        await step.do(`report-${r.name}`, () => {
          if (r.superseded) {
            return completeCheckRun(token, repo, runId, {
              conclusion: "cancelled",
              title: `${r.name} superseded`,
              summary:
                "A newer commit on this ref superseded this run while " +
                "it was queued — running it would have tested a stale " +
                "checkout.",
            });
          }
          const errored = r.error !== undefined;
          return completeCheckRun(token, repo, runId, {
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

      if (logOnly) {
        const runKind = isDispatch ? "Dispatch" : "Scheduled";
        const failed = results.filter(
          (r) => !r.superseded && (r.error !== undefined || r.ok !== true)
        );
        for (const r of failed) {
          const check = checks.find((c) => c.name === r.name);
          await step
            .do(`alert-${r.name}`, async () => {
              const due = await scheduler().alertDue(
                `scheduled/${repo}/${r.name}`,
                check?.alertEveryMs ?? SCHEDULED_ALERT_DEDUPE_MS
              );
              if (!due) return { sent: false };
              const detail = (r.error ?? r.output ?? "(no output)").slice(-3500);
              await sendOpsAlert(
                this.env,
                `${runKind} ${r.name} failed`,
                [
                  `cloudflare-ci ${runKind.toLowerCase()} check failed`,
                  `- repo: ${repo}`,
                  `- sha: ${sha}`,
                  `- check: ${r.name}`,
                  "",
                  detail,
                ].join("\n")
              );
              return { sent: true };
            })
            .catch(() => {});
        }
      }

      await withScheduler("complete-aux-wf", (stub) =>
        stub.completeAuxWorkflow(
          "checks",
          repo,
          sha,
          event.instanceId,
          undefined,
          scheduledScope
        )
      );
    } finally {
      if (useSerial) {
        await withScheduler("release-serial", (stub) =>
          stub.release(`${sandboxId}-all`)
        ).catch(() => {});
      } else {
      for (const check of runnable) {
        await withScheduler(`release-${check.name}`, (stub) =>
          stub.release(
            `${sandboxId}-${check.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`
          )
        ).catch(() => {});
      }
      }
    }
  }
}

interface RepoConfigShape {
  checksInstallCommand?: string;
}

interface CheckShape {
  name: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  needsInstall?: boolean;
  secrets?: string[];
  optionalSecrets?: string[];
  isolated?: boolean;
  sameRepoOnly?: boolean;
  fast?: boolean;
}

function checkSecretsOf(env: Bindings, check: CheckShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of check.secrets ?? []) {
    const value = (env as Record<string, unknown>)[name];
    out[name] = typeof value === "string" ? value : "";
  }
  for (const name of check.optionalSecrets ?? []) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

/** Replace every non-empty secret value in `text` with `***` — check
 *  output is posted to GitHub check-run summaries and logs, and GitHub
 *  Actions masked these values before this check moved here. Longest
 *  first so overlapping values can't leak a shorter secret's tail. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  const values = Object.values(secrets)
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join("***");
  }
  return out;
}

export function buildCheckoutScript(payload: {
  repo: string;
  sha: string;
  headRef?: string;
  prNumber?: number;
  baseSha?: string;
  baseRef?: string;
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
      // Base = merge-base against the PR's target branch when we have it.
      // HEAD^1 is wrong for anything but a single-commit tip: a branch that
      // merged main mid-flight (or a long-lived PR) re-scans all of that
      // history under gitleaks/diff-coverage.
      ...(payload.baseRef
        ? [
            `git fetch -q --depth 50 origin ${shellQuote(payload.baseRef)} 2>/dev/null || true`,
            pinBase(
              `$(git merge-base HEAD FETCH_HEAD 2>/dev/null || echo HEAD^1)`
            ),
          ]
        : [pinBase("HEAD^1")])
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
    needsInstall?: boolean;
  }>
): string {
  const lines: string[] = ["set +e"];
  // oxlint's JS-plugin fixed-size pool reserves ~4-6 GiB of virtual memory
  // in one mapping; strict overcommit (CommitLimit ≈ RAM/2 on standard-2)
  // hard-refuses it — the oxc_allocator panic. The checks microVM has its
  // own kernel, so relaxing overcommit grants the reservation. No-op where
  // sysctl is unavailable. Platform-wide: any repo running `vp check` with
  // JS plugins needs this, not just vortex.
  lines.push(
    "sysctl -w vm.overcommit_memory=1 > /dev/null 2>&1; oc_rc=$?",
    "echo ===CI:OVERCOMMIT:RC=$oc_rc===",
    '[ "$oc_rc" != "0" ] && echo "warning: vm.overcommit_memory sysctl denied — oxc fixed-size pool may panic under strict overcommit"'
  );
  if (config.checksInstallCommand && checks.some((c) => c.needsInstall !== false)) {
    lines.push(
      // Install into the (possibly restored) store at /tmp/.pnpm-store.
      // The sentinel tells ChecksSandbox the store is worth backing up —
      // seed/upload themselves live in the DO, not the script.
      'mkdir -p /tmp/.pnpm-store',
      "install_started=$(date +%s%3N)",
      `{ ${config.checksInstallCommand}; } > /tmp/install.out 2>&1`,
      "rc=$?",
      "tail -c 3500 /tmp/install.out",
      "install_ms=$(( $(date +%s%3N) - install_started ))",
      "echo ===CI:INSTALL:MS=$install_ms===",
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
      "check_started=$(date +%s%3N)",
      `${invocation} > ${outFile} 2>&1`,
      "rc=$?",
      `check_ms=$(( $(date +%s%3N) - check_started )); echo ===CHECK:${check.name}:MS=$check_ms===`,
      `echo ===CHECK:${check.name}:START===`,
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
  overcommitRc: number;
  checks: Record<string, CheckRunOut>;
  output: string;
}

function parseRunOutput(res: ChecksRunResult): ParsedRun {
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n");
  const parsed: ParsedRun = {
    checkoutRc: 1,
    installRc: 1,
    overcommitRc: 0,
    checks: {},
    output: text,
  };
  let lastCheck = "";
  const buckets: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const ci = line.match(/^===CI:(CHECKOUT|INSTALL|OVERCOMMIT):RC=(\d+)===?$/);
    if (ci) {
      if (ci[1] === "CHECKOUT") parsed.checkoutRc = Number(ci[2]);
      else if (ci[1] === "INSTALL") parsed.installRc = Number(ci[2]);
      else parsed.overcommitRc = Number(ci[2]);
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

function warnIfOvercommitDenied(parsed: ParsedRun, repo: string): void {
  if (parsed.overcommitRc !== 0) {
    console.warn(
      `ci.checks.overcommit_denied repo=${repo} — vm.overcommit_memory sysctl ` +
        `refused in the checks container; oxc fixed-size pool panics may return`
    );
  }
}
