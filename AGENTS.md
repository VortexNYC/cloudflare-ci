# cloudflare-ci — Agent Operating Notes

Vortex's shared CI/CD worker. One Cloudflare Worker + one Workflow + two
container pools serving every onboarded repo. **All pipeline behavior,
caching, dedupe, capacity, and deploy logic lives here — never work around
CI in a consumer repo.** If a repo needs different behavior, change this
repo or its entry in `src/repos.ts`.

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
    per-pool caps (`POOL_LIMITS`, must match `max_instances` in
    wrangler.jsonc) deny oversubscription. Runner retries with backoff up
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
- Containers expose `pnpm`, `vp`, `wrangler`, `curl`, `unsquashfs` on PATH
  (see `Dockerfile`).

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
- `@cloudflare/sandbox@0.12.1` (`patches/@cloudflare__sandbox.patch`,
  dist-level): local-bucket restore downloads the archive over HTTP from
  `BACKUP_DOWNLOAD_BASE_URL` with parallel ranged `curl` parts, verifies
  size, falls back to the old DO stream if unset.

Workflow: `pnpm patch <pkg>` → edit → `pnpm patch-commit <dir>` →
`pnpm install` → deploy. Long-term these belong upstream; file them
against cloudflare's repo when there's bandwidth.

## Ops runbook

- `GET /admin/backup/:id` — streams `backups/<id>/data.sqsh` from R2,
  Range-aware (used by container restores).
- `POST /admin/sandbox/kill` `{name}` — destroy one sandbox on both pools.
- `POST /admin/sandbox/sweep` — reap reservations >60min; returns the live
  ledger. Runs unattended hourly via cron (`17 * * * *`).
- All admin routes: `Authorization: Bearer $ADMIN_TOKEN`, timing-safe.
- Deploys reset live sandbox DO isolates — **never deploy while a run is
  in flight**; check `wrangler workflows instances list cloudflare-ci`.
- `wrangler.jsonc` has one `triggers` block holding BOTH `events` and
  `crons` — duplicate keys silently drop the push trigger.
- Stuck run: `wrangler workflows instances terminate cloudflare-ci <id>`,
  then `/admin/sandbox/sweep` to release its reservation.

## Hard rules

- pnpm only. No `any`, no `eslint-disable`. `npx tsc --noEmit -p .` before
  every deploy.
- No AI attribution in commits.
- New repos onboard via `src/repos.ts` only.
