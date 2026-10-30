# cloudflare-ci — Agent Operating Notes

Vortex's shared CI/CD worker. One Cloudflare Worker + one Workflow +
three container pools serving every onboarded repo. **All pipeline
behavior, caching, dedupe, capacity, and deploy logic lives here — never
work around CI in a consumer repo.** If a repo needs different behavior,
change this repo or its entry in `src/repos.ts`.

## Architecture

- Push to `*.artifacts.cloudflare.net/git/vortex/<repo>.git` fires
  `cf.artifacts.repo.pushed` → `CI` workflow (`src/ci.ts`) → repo config
  lookup (`src/repos.ts`).
- Pipeline shape is deliberately minimal: `deps → build → preview/deploy`.
  Checks and tests are **not** CI's job — they gate locally via `vp`
  pre-push hooks in each repo. CI produces deployable artifacts and ships
  them; nothing else belongs in a billable container.
- `CiScheduler` DO (`src/scheduler.ts`, binding `CI_SCHEDULER`) owns:
 - **Admission ledger** — every sandbox spawn calls `admit()` first;
 per-pool caps (`POOL_LIMITS`: `SANDBOX`/`LITE`/`HEAVY` match `max_instances` in
 wrangler.jsonc; `CHECKS`/`AUX` ledger caps are 12/8 on the 1.0 checks
 containers — mirror/release/canary use `AUX`, PR checks use `CHECKS`) deny
 oversubscription. Runner retries with backoff up
    to 10 min. Reservations older than 60 min are reaped (destroyed)
    inline on admit, by the hourly cron, and by `POST /admin/sandbox/sweep`.
  - **Run claims** — `claim(repo, branch, instanceId, sha)` is atomic
    newest-wins dedupe. A `completed` same-sha claim rejects late
    duplicate events (they arrive minutes late) before any container
    spawns. `completeClaim` marks the winner done at pipeline end.
    All scheduler calls from the workflow body run as `dedupe-*`
    `step.do` steps — a DO isolate recycled mid-RPC reports
    "this Durable Object instance is no longer active", and an
    unprotected body call kills the whole run on the first blip.
    `reapStale` bounds each teardown (30s) and the pass overall (90s):
    a wedged `destroy()` must not stall the ledger.
- Snapshots: each non-terminal step squashfs-archives `/workspace` to R2
  (`backups/<id>/`). Restores download over HTTP from
  `GET /admin/backup/:id` (Range-supported, parallel-part curl) — never
  stream archives through the DO isolate (it OOMs ~1GB).
- `pnpm` store lives at `/workspace/.pnpm-store` so it rides snapshots;
  downstream steps relink with `--config.trustLockfile=true` (deps does
  the real lockfile verification once).
- Checks run on `ChecksSandbox` (`src/checks-sandbox.ts`, binding
  `CHECKS_SANDBOX`) — sandbox-sdk 1.0 under `scheduling_policy:
  "durable_object"`, package aliased as `sandbox-1` because
  `@cloudflare/ci` still pins sandbox 0.12 for the deploy pools. Each
  named DO starts its own container from `Dockerfile.checks` and caches
  the pnpm store via `DirectoryBackup` on the `BACKUP_BUCKET` binding
  (`cache-store/` objects + `cache-idx/` records, keyed by lockfile
  hash — no S3 credentials anywhere). **Never move an existing container
  class to `durable_object` scheduling — that deploy is one-way. A 1.0
  migration is always a new class + new binding alongside the old.**

## The consumer contract

A repo in `src/repos.ts` must:

- `buildCommand` produces everything deploy uploads: `dist/` **and**
  `.wrangler/deploy/config.json` for Astro/Vite apps (the redirect that
  points wrangler at the generated config — deleting it makes wrangler
  bundle `src/` and crash on `virtual:*` modules).
- `deployCommand`/`previewCommand` are wrangler calls only — no rebuilds,
  no installs beyond the provided relink.
- `installEnv` sets `VP_GIT_HOOKS=0` so `prepare` doesn't wire hooks in
  throwaway containers.
- Diff-based checks measure against `refs/ci/base`, pinned by the checkout
  script: PR events check out `pull/N/merge` when it's fresh (so the base is
  the base-branch tip, not the tip commit's parent), `merge_group` events pin
  `base_sha` from the payload. `usesPrBody` checks re-run on PR body edits —
  that's the `No tests:` escape hatch.
- Containers expose `pnpm`, `vp`, `wrangler`, `curl`, `unsquashfs` on PATH
  (see `Dockerfile`). The 1.0 checks image (`Dockerfile.checks`) adds
  `zstd` for DirectoryBackup and `sandbox-shim` — its tag must match the
  installed `sandbox-1` version.

**Do not** add GitHub Actions workflows, re-add `simple-git-hooks`, or
hand-edit consumer configs to work around CI behavior. The pipeline shape
is intentional; fix the platform here.

## Patched packages — read before `pnpm update`

`patches/` carries surgical fixes on published packages. Upgrading either
package without re-reviewing these will silently reintroduce the bugs:

- `@cloudflare/ci@0.2.0` (`patches/@cloudflare__ci@0.2.0.patch`):
  `SOURCE_TIMEOUT_MS` 5m→15m + per-phase logs; `CiScheduler` admission
  before `getSandbox` + `release` on destroy; `instanceId` threaded to the
  runner; log-stream watchdog/drain deadline; upload backpressure;
  `admit` retries transient DO teardowns inside the admission budget;
  `destroySandbox` bounds `destroy()` at 60s.
- `@cloudflare/sandbox@0.12.10` (`patches/@cloudflare__sandbox@0.12.10.patch`,
  dist-level): local-bucket restore downloads the archive over HTTP from
  `BACKUP_DOWNLOAD_BASE_URL` with parallel ranged `curl` parts, verifies
  size, falls back to the old DO stream if unset; `asyncIterableToSSEStream`
  and the backup-create `sseDecoded` stream use `pull()` so consumers apply
  backpressure instead of draining the source eagerly. `@cloudflare/ci`
  pins `0.12.1` internally, so `pnpm-workspace.yaml` carries an
  `overrides` entry forcing every resolution to the patched 0.12.10 —
  without it the DO code keeps running unpatched 0.12.1.

Workflow: `pnpm patch <pkg>` → edit → `pnpm patch-commit <dir>` →
`pnpm install` → deploy. Long-term these belong upstream; file them
against cloudflare's repo when there's bandwidth.

## Ops runbook

- `GET /admin/backup/:id` — streams `backups/<id>/data.sqsh` from R2,
  Range-aware (used by container restores).
- `GET|PUT /admin/cache/:key` — the old checks store-cache endpoint. The
  1.0 checks path moves store archives through `DirectoryBackup` on the
  R2 binding instead and no longer needs `CI_TOKEN`; the route stays for
  rollback.
- `POST /admin/sandbox/kill` `{name}` — destroy one sandbox on all pools.
- `POST /admin/sandbox/sweep` — reap reservations >60min; returns the live
  ledger. Runs unattended hourly via cron (`17 * * * *`).
- All admin routes: `Authorization: Bearer $ADMIN_TOKEN`, timing-safe.
- **`ARTIFACTS_ACCOUNT_ID` secret** must match `CLOUDFLARE_ACCOUNT_ID`
  (`953346ce…`). A stale Vortex-old value mirrors into a dead namespace while
  GitHub pushes look fine — `validateEnv` refuses to serve on mismatch.
- **Busy CI day:** `POST /admin/sandbox/sweep` → read `reservations` (CHECKS
  at 10/10 = saturated). Tail logs for `ci.checks.pool_wait_started` /
  `ci.mirror.pool_wait_started`. Stuck run: terminate workflow instance, sweep
  again.
- Deploys reset live sandbox DO isolates — `pnpm deploy` refuses while a
  run is in flight. `DRAIN=1 pnpm deploy` terminates in-flight runs
  deliberately and lets the ledger refire dead claims (VTX-627) — the
  recovery contract, not an accident.
- The OAuth token sees two accounts (Vortex NYC `953346ce…` = prod,
  Vortex-old `31bfc2c…` = stale) and wrangler defaults to the wrong one.
  Prefix every wrangler call — including `pnpm deploy` — with
  `CLOUDFLARE_ACCOUNT_ID=953346ce1b4f27fa04a76d83aeccab28`. A wrong-account
  deploy uploads the worker, then dies at the container step with
  "application … associated with a different durable object namespace".
- `wrangler.jsonc` has one `triggers` block holding BOTH `events` and
  `crons` — duplicate keys silently drop the push trigger.
- Stuck run: `wrangler workflows instances terminate cloudflare-ci <id>`,
  then `/admin/sandbox/sweep` to release its reservation.

## Deployment maturity model (VTX-587)

Every onboarded repo sits on a stage; the config keys in `src/repos.ts`
move it forward:

- **Stage 0 — checks only.** No `buildCommand`; the checks pool runs the
  repo's checks (`checks[]` + platform `baselineChecks`, merged by name).
- **Stage 1 — deploy.** `buildCommand`/`deployCommand` ship `main`; every
  command is GNU-timeout-bounded inside the container.
- **Stage 2 — gated.** `verifyCommand` probes prod post-deploy;
  `rollbackCommand` (`wrangler rollback`) restores the previous deployment
  on failure.
- **Stage 3 — staged.** `previewCommand` + `stagingVerifyCommand` add a
  staging bake before prod; `rolloutUpload/Promote/Steps` ship via
  `wrangler versions` in traffic stages instead of a 0→100 cut.
- **Stage 4 — watched.** `watchCommand` polls a repo-owned error/SLO
  probe post-rollout; a breach triggers rollback automatically.
- **Secrets at every stage:** `buildSecrets`, `verifySecrets`,
  `deploySecrets` inject named worker secrets into the right step only.

pile is Stage 4: staging bake + staged rollout + verify + watch + rollback.

## Hard rules

- pnpm only. No `any`, no `eslint-disable`. `npx tsc --noEmit -p .` before
  every deploy.
- No AI attribution in commits.
- New repos onboard via `src/repos.ts` only.
