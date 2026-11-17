# CI cost and feedback-time audit

**Ticket:** VOR-279  
**Scope:** `VortexNYC/cloudflare-ci` and the remaining GitHub Actions workflows in `VortexNYC/vortex`  
**Audit window:** 2026-11-03 through 2026-11-17 (approximately two weeks)  
**Status:** baseline/proposal; this PR changes documentation only

## Executive summary

The highest-value opportunity is not copying OpenClaw's Blacksmith-specific runner tuning. Vortex is moving to one Cloudflare CI runner, so the safe order is: establish phase-level telemetry, remove duplicate PR work through newest-wins dedupe, preserve one required check context per gate, then make affected-test selection conservative and measurable. If a selector cannot prove its affected set, the full suite remains mandatory.

The current platform already has several useful foundations: a dedicated checks pool, lockfile-keyed pnpm-store backups, serial execution for Vortex, queue admission, newest-wins claims, bounded retries, and required platform checks (`ci`, `gitleaks`, `trufflehog`, `prc`). The main measurement gap is that Workflow instances do not yet expose a stable queue/setup/run/cost record that can be aggregated without reading raw logs.

## Baseline from repository and GitHub data

### Activity and check shape

| Measure | Observed baseline | Evidence/interpretation |
| --- | ---: | --- |
| Vortex commits on `main` in window | 299 | Local full-history checkout, 2026-11-03 onward |
| Merge commits in local `main` history | 0 | PR merges are squash/rebase-style in the observed history |
| Squash-style merged PRs identifiable from commit subjects | 21 | Subjects ending in `(#N)` in the window; a lower bound, not a GitHub run count |
| Active Vortex GitHub workflow files | 22 | `.github/workflows`; most are manual, scheduled, deploy, or operational workflows |
| Legacy runner declarations | 39 | Remaining workflows still declare Blacksmith runners; these are migration inventory, not Cloudflare CI cost |
| Cloudflare CI required platform checks | 2 | `gitleaks` and `prc` are merged into every repo config |
| Vortex repo-specific checks | 3 | `trufflehog`, `ci`, and the platform checks; `ci` is serial with the other Vortex checks |
| Vortex check execution | Serial | `checksExecution: "serial"`; one standard-2 checks container per PR run |
| Checks pool cap | 12 | `CiScheduler` CHECKS ledger cap |

The 21 PR lower bound must not be treated as “21 workflow runs”: pushes, PR body edits, reruns, merge queue events, and check refires can all add runs. The authoritative runs-per-merged-PR metric should be computed from Workflow payloads and GitHub CheckRun creation timestamps after telemetry is installed.

### Cloudflare CI compute configuration (observed, not billed usage)

| Pool/class | Instance size | Max instances | Role |
| --- | --- | ---: | --- |
| `CiSandbox` | `standard-2` | 10 | deps/build/deploy steps |
| `CiSandboxLite` | `basic` | 10 | small migrations, probes, rollout steps |
| `CiSandboxHeavy` | `standard-3` | 4 | workloads such as Pile builds |
| `ChecksSandbox` | `standard-2` | platform-managed durable-object pool | PR checks |

Cloudflare CI uses `ChecksSandbox` with `standard-2`, Internet access, and `Dockerfile.checks`. Its image includes Node 24, pnpm, Wrangler, PostgreSQL 16, Go 1.27, gitleaks, trufflehog, zstd, and the sandbox shim. A check with a dependency install restores/saves a pnpm-store backup keyed by repository plus lockfile SHA-256. Cache restore/save is best-effort; an absent or failed restore runs cold and does not fail the check.

### Queue/setup/run split

A reliable numeric split is **not available from the current retained data**. The implementation currently records queue transitions (`pool_wait_started`, `pool_wait_done`, and `pool_saturated`) but does not persist timestamps for:

1. Workflow event received → admission attempt (queue).
2. Admission → container ready, checkout complete, cache restore complete, and install complete (setup).
3. First check command start → last check command end (run).

The existing `===CI:CHECKOUT`, `===CI:INSTALL`, and `===CHECK` markers carry exit status and bounded output, not start/end timestamps. Therefore this audit does not invent wall-time, container-minute, cache-hit, or per-check figures. Adding the telemetry slice below is the prerequisite for the requested real-data dashboard.

### Remaining GitHub Actions history

The checked-in workflow inventory shows operational and release workflows still using Blacksmith labels, including `worker-money-paths-regression.yml`, `production-readiness.yml`, `publish-sdk.yml`, deploy workflows, scheduled backups, and scheduled/dispatch-only operational jobs. The PR-facing `worker-money-paths-regression` workflow is triggered by every pull request and uses a 4-vCPU Blacksmith runner. The production-readiness workflow uses 2-vCPU runners and is scheduled/dispatch-only. These are migration inventory and should be reconciled with VOR-268; they are not counted as Cloudflare CI Workflow instances.

GitHub job API access in this audit environment returned no job-log payload for the observed job IDs, so exact historical GitHub wall times and runner minutes are unavailable here. The documented baseline is intentionally separated into measured repository activity and unavailable provider telemetry rather than presenting estimates as measurements.

## Measurement contract for the next baseline

Implement this as the first follow-up PR, before tuning compute:

- Emit one structured event per Workflow instance with `instance_id`, repo, SHA, PR number, event kind, check name, pool, instance size, queue start/end, setup phase start/end, run start/end, terminal result, retry/refire count, and cache outcome (`disabled`, `miss`, `hit`, `restore_failed`, `save_failed`).
- Use monotonic elapsed milliseconds for durations and UTC timestamps for joins.
- Emit container start and destroy timestamps so container minutes are `destroy - start`, rounded only in reporting.
- Record the configured Cloudflare pool/instance size in the event; do not infer it from a check name.
- Join Workflow instances to GitHub PRs by repo/SHA/PR number. Report total runs, non-superseded runs, refires, and runs per merged PR separately.
- Publish p50/p90/p95 for queue, setup, run, and end-to-end check completion. Report cache hit rate as hits / eligible restores, excluding disabled caches.
- Keep payloads free of secrets, tokens, PR bodies, source, and command output.

## Ranked proposal

Savings are directional hypotheses, not promises. Validate each change against the measurement contract and compare equivalent workloads.

| Rank | Change | Expected feedback-time effect | Expected compute effect | Risk and required-check preservation | OpenClaw fit |
| ---: | --- | --- | --- | --- | --- |
| 1 | Add phase/cost telemetry and a weekly report | Makes queue/setup/run regressions visible; no direct speed gain | Prevents optimizing the wrong phase; enables real container-minute accounting | Low. Telemetry is additive and must never gate a check. Required contexts remain unchanged. | **Adopt, adapted.** OpenClaw's runner-hour accounting is useful, but Cloudflare Workflows, DO admission, and R2 cache events need first-party fields. |
| 2 | Make newest-wins cancellation the default for queued and running PR work | Eliminates stale-push wait and container time; improves latest-commit feedback | Potentially large on bursty branches; exact saving depends on superseded-run rate | Medium: only cancel a run after the newer SHA has a durable claim; leave merge-queue groups immutable; post a terminal neutral/superseded result without replacing required contexts. | **Adopt, adapted.** This is the closest fit to “do not pay twice”; Blacksmith/GitHub cancellation semantics cannot be copied into Workflow claims. |
| 3 | Finish one-runner migration and remove duplicate GitHub PR gates | Removes duplicate setup and parallel runner minutes | High where the same check still runs in GitHub Actions and Cloudflare CI | High during migration. Keep exact required check names (`ci`, `gitleaks`, `trufflehog`, `prc` as applicable), verify branch protection, and only delete a legacy workflow after equivalent Cloudflare conclusions are observed. | **Adopt, adapted.** “Run checks at the right stage” fits; OpenClaw's GitHub job graph does not transfer to the single Worker. |
| 4 | Improve pnpm-store cache instrumentation and reuse | Reduces install setup; lowers first-result latency when warm | Reduces repeated download/container minutes; measure restore/save overhead too | Medium: lockfile+repo keys avoid unsafe cross-repo reuse; cache failures must fall back cold; never make cache correctness part of the gate. | **Adopt, adapted.** OpenClaw's reuse principle fits; the implementation must use R2 `DirectoryBackup`, not an assumed hosted-runner cache action. |
| 5 | Conservative affected-test selection for `ci` | Faster for clearly local changes | Reduces test/build minutes on safe subsets | High. A selector must classify uncertainty and run the full suite when uncertain. Required static/security checks always run. Add periodic full-suite canaries and compare defect escape rate. | **Adopt, adapted.** “Test what changed” fits only with a fail-closed selector; OpenClaw's TypeScript graph/tooling is not evidence it works for Vortex's Effect/Worker/monorepo contracts. |
| 6 | Pack and balance independent checks only after phase data | Could shorten wall time if queue capacity is available | May increase compute through repeated setup; savings are workload-dependent | Medium. Preserve required check conclusions and avoid increasing CHECKS saturation. Vortex currently serializes its checks deliberately; change only with paired measurements. | **Conditional.** OpenClaw's packing/balancing lesson applies, but Cloudflare pool caps and one-container-per-check semantics make naive parallelism risky. |
| 7 | Right-size pools after paired workload measurements | Can reduce queue or run time | May reduce container-minute cost, or increase it if slower | Medium. Keep money-path and resource-heavy checks on proven sizes; rollback on p95 regression or failure-rate increase. | **Conditional.** OpenClaw's 16-vCPU vs 32-vCPU comparison is a useful method, not a transferable price/result. |
| 8 | Test-suite cleanup and growth ratchet | Usually neutral initially; may reduce review noise | Reduces long-term test minutes only when redundant tests are removed | High: deletion needs contract-level evidence, full suite, and review; never remove a required check. | **Adopt cautiously.** The “make every test earn its place” rule is portable, but requires Vortex-specific ownership and proof. |

## Correctness and required-check guardrails

- The required check names are an API. Do not rename or silently skip `ci`, `gitleaks`, `trufflehog`, `prc`, or the money-path check while migration is in progress.
- A check selector may narrow execution only when its dependency graph and affected set are proven. Any parse failure, unknown package mapping, generated-file ambiguity, cross-package change, or selector error runs the full suite.
- Security checks remain diff/repository checks independent of test selection.
- A cache miss, restore error, or save error falls back to a cold install and never produces a false green.
- Superseded runs must be observable and must not leave a required GitHub CheckRun queued forever.
- Every optimization PR must report p50/p95 feedback time, container minutes, cache hit rate, failure/refire rate, and a correctness comparison against the pre-change window.

## Follow-up implementation tickets (one reviewable PR each)

1. **VOR-269 refinement — CI phase/cost telemetry.** Add the event schema, queue/setup/run timestamps, per-check wall time, container minutes, instance size, cache outcome, retries, and a report query. No behavior change.
2. **VOR-270 refinement — less work per push.** Complete newest-wins cancellation for queued/running PR checks and dedupe late webhook/refire events; preserve merge-queue semantics and required contexts.
3. **VOR-271 refinement — catch-up runs.** After a superseded or capacity-delayed run, guarantee the newest SHA gets one authoritative run without requiring an empty commit; add tests for delivery gaps and infra death.
4. **VOR-272 refinement — cache correctness and hit-rate reporting.** Measure R2 DirectoryBackup restore/save outcomes, bound cache overhead, and retain cold-install fallback; do not broaden cache keys without proof.
5. **VOR-273 refinement — cores/pool sizing.** Run paired standard-2/standard-3 experiments on representative checks; adopt only a measured p95 or container-minute win with no failure regression.
6. **VOR-274 refinement — flaky-test policy and guardrails.** Define retry/refire classification, quarantine rules, and a required full-suite fallback for uncertain affected-test selection; no retry may turn a real test failure into green.
7. **One-runner migration follow-up (feeds VOR-268).** Migrate remaining PR-facing GitHub Actions checks to Cloudflare CI, verify branch-protection contexts, then delete duplicate jobs in a separate PR.
8. **Money-path check follow-up (coordinates with VOR-275).** Add the money-path check without replacing existing required checks; record its independent timing and compute metrics.
9. **Affected-test selector (after telemetry).** Add a fail-closed selector with explicit “uncertain → full suite,” generated-code and cross-package coverage, periodic full-suite sampling, and rollback thresholds.

Each ticket is independently reviewable and must include tests for its failure/uncertain path. Full suite is mandatory whenever affected-test selection is uncertain.

## Validation plan

For each implementation PR, compare a pre/post window with similar PR volume:

- Correctness: required-check conclusion parity, test-failure/refire rate, and sampled full-suite agreement.
- Feedback: queue, setup, run, and end-to-end p50/p95; latest-commit time, not stale-commit time.
- Compute: eligible container minutes by pool/instance size, cache bytes transferred, cache hit rate, and superseded work avoided.
- Safety: no secret-bearing fields in telemetry; no credential rotation or external spend; no merge until required checks and review are green.
