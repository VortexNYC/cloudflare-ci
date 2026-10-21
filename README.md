# cloudflare-ci

A self-contained CI/CD platform built entirely on Cloudflare primitives — Workers, Workflows, Durable Objects, Cloudflare Containers, R2, and Cloudflare Artifacts. One worker + one workflow + three container pools run build, preview, deploy, check, mirror, and release pipelines for a fleet of repos. **No GitHub-hosted runners, no third-party CI service.**

This is the deployment we run at Vortex. `src/repos.ts` carries our repo configs as a reference implementation — replace it with your own.

## Architecture

```
GitHub webhook ──→ cloudflare-ci Worker
                     ├─ push ──────────→ MirrorWorkflow  → clones + force-pushes to Artifacts
                     │                                          │
                     │                    cf.artifacts.repo.pushed
                     │                                          ↓
                     │                                   CI Workflow
                     │                          deps → build → preview
                     │                          deps → build → migrate
                     │                                   → staged deploy
                     │                                   → verify → watch
                     │                                   → auto-rollback
                     ├─ tag push ───────→ ReleaseWorkflow → build binaries
                     │                                           → GitHub release
                     └─ PR/check events → ChecksWorkflow → per-check containers
                                                              → Checks API
```

- **`CI_SCHEDULER` Durable Object** — admission ledger + run claims. Per-pool capacity caps, atomic newest-wins dedupe, stale-reservation reaping.
- **Three container pools** — `CiSandbox` (build/deploy), `CiSandboxLite` (verify/watch), `ChecksSandbox` (checks on Sandbox SDK 1.0 with `DirectoryBackup` pnpm-store caching).
- **Workspace snapshots** — each step squashfs-archives `/workspace` to R2; downstream steps restore over HTTP ranged downloads.
- **Mirroring** — replaces artifacts-sync GitHub Actions: push webhooks clone the branch in a container and force-push to Cloudflare Artifacts, minting a 15-minute repo-scoped token via the `ARTIFACTS` binding.

## Onboarding a repo

Add an entry to `src/repos.ts`:

```ts
myrepo: {
  name: "myrepo",
  installEnv: { HOME: "/tmp", CI: "true", VP_GIT_HOOKS: "0" },
  buildCommand: "pnpm exec vp run build:all",
  deployCommand: "(cd apps/api && pnpm exec wrangler deploy -e production)",
  previewCommand:
    '(cd apps/api && pnpm exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS")',
  verifyCommand: "curl -fsS --max-time 15 https://api.example.com/health",
  checks: [{ name: "ci", command: "pnpm exec vp check" }],
},
```

Wire a GitHub webhook on the repo: `POST https://<your-worker>/webhook/github`, events `check_run, check_suite, merge_group, pull_request, push`, secret `GITHUB_WEBHOOK_SECRET`.

## Secrets

Nothing is committed. Required worker secrets (set with `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | HMAC verification on incoming webhooks |
| `CHECKS_GITHUB_TOKEN` | Posts check-run results to the Checks API |
| `CF_TOKEN` | `wrangler deploy`/`versions` calls inside containers |
| `NPM_TOKEN` | Private-registry installs |
| `ADMIN_TOKEN` | `/admin/*` ops routes (sweep, kill, backup) |
| `PILE_*`, `POSTHOG_CLI_API_KEY` | Optional repo-specific extras |

`wrangler.jsonc` carries non-secret config — account ID, worker URLs, pool sizes. Update them to yours.

## Patched packages

`patches/` carries surgical fixes on `@cloudflare/ci` and `@cloudflare/sandbox` (snapshot restore over HTTP, admission/backpressure handling, bounded teardown). `pnpm-workspace.yaml` overrides keep resolutions pinned to the patched versions — re-review before bumping.

## Ops

- `POST /admin/sandbox/sweep` — reap stale reservations (also hourly cron).
- `POST /admin/sandbox/kill {name}` — destroy one sandbox.
- Deploy resets live isolates — never deploy while a run is in flight.

## License

MIT
