import { z } from "zod";

const repoConfigSchema = z.object({
  name: z.string(),
  buildEnv: z.record(z.string()).default({}),
  installEnv: z.record(z.string()).default({}),
  // Per-workload pool routing (VTX-622): deps+build run on the heavy pool
  // when a repo's install/build exceeds the standard-2 shape. The platform
  // has no per-call resource knob — pool selection is the CF equivalent of
  // Open-Inspect's cpuCores/memoryMib per launch.
  buildPool: z.enum(["SANDBOX", "SANDBOX_HEAVY"]).default("SANDBOX"),
  // The only step whose snapshot persists — must produce whatever dist/
  // preview and deploy upload. Checks/tests gate locally via pre-push
  // hooks, not in billable containers.
  // Optional for checks-only repos (veil flips before its deploy path).
  buildCommand: z.string().optional(),
  deployCommand: z.string().optional(),
  // Automated migrations for non-D1 databases (e.g. vortex PlanetScale) —
  // runs on the build snapshot so drizzle-kit resolves from node_modules.
  // Secrets arrive via migrateSecrets; interpolate them into env, not argv.
  // VTX-603: tag-push releases — refs/tags/* on a repo with releaseCommand
  // dispatches ReleaseWorkflow (build + publish inside a ChecksSandbox).
  releaseCommand: z.string().optional(),
  migrateCommand: z.string().optional(),
  migrateSecrets: z.array(z.string()).default([]),
  // VTX-583: a failed verify rolls prod back to the previous deployment —
  // typically `wrangler rollback -e production`. Absent disables rollback.
  rollbackCommand: z.string().optional(),
  // VTX-582: gradual rollout — when set, the worker ships via
  // `versions upload` (no traffic) then staged `versions deploy <id>@<pct>`
  // instead of deployCommand's wrangler call. deployCommand still runs after
  // for non-versioned extras (docs deploy); rollout steps then take traffic
  // percentages in order, ending at 100.
  rolloutUploadCommand: z.string().optional(),
  /** Shell snippet run per percentage — must consume $VID (uploaded version
   *  id) and $PCT (step's traffic percent). */
  rolloutPromoteCommand: z.string().optional(),
  rolloutSteps: z
    .array(z.number().int().min(1).max(100))
    .optional()
    .refine(
      (s) => !s || s[s.length - 1] === 100,
      "rollout steps must end at 100"
    ),
  rolloutSettleSec: z.number().int().min(0).default(60),
  // VTX-584/591: staging bake on main — when set, the pipeline deploys the
  // staging env (previewCommand's target) and probes this command before
  // the prod rollout starts. A failed staging verify stops the run.
  stagingVerifyCommand: z.string().optional(),
  /** Settle time between staging deploy and its verify probe. */
  stagingBakeSec: z.number().default(30),
  // Extended staging bake: runs inside the staging step (restored
  // workspace, relinked node_modules, NPM_TOKEN, 25-min bound) right
  // after previewCommand ships the staging env. staging-verify can't
  // host it — that's a fresh lite-pool checkout with a 5-minute curl
  // budget and no install. A non-zero exit fails the staging step
  // before the prod rollout starts.
  stagingE2eCommand: z.string().optional(),
  // VTX-586: named worker secrets injected into the deploy step env —
  // same mechanism as buildSecrets/verifySecrets, for deploy-time creds.
  deploySecrets: z.array(z.string()).default([]),
  // VTX-585: post-rollout error watch — polls this command for watchSec
  // after a successful verify; any failure → rollbackCommand. The command
  // is a repo-owned probe (error-rate check, SLO query, etc.).
  watchCommand: z.string().optional(),
  watchIntervalSec: z.number().default(30),
  watchSec: z.number().default(300),
  // Checks-in-pipeline: GitHub webhook events run these inside the lite
  // pool and report back via the Checks API. `command` runs in /workspace
  // after `checksInstallCommand`; env carries per-check vars (e.g.
  // DIFF_COVERAGE_BASE). Check `name` is the check-run name branch
  // protection expects.
  checks: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        env: z.record(z.string()).default({}),
        timeoutMs: z.number().optional(),
        // Check consumes PR_BODY (e.g. the "No tests:" escape hatch) —
        // pull_request.edited events re-run only these, not the whole set.
        usesPrBody: z.boolean().default(false),
        // False for checks that run image binaries or plain shell (gitleaks,
        // prc) — skips checksInstallCommand so the sandbox goes straight to
        // the check instead of a full monorepo install (VTX-809).
        needsInstall: z.boolean().default(true),
      })
    )
    .default([]),
  // Per-repo install run once before checks (pnpm install, go mod download).
  checksInstallCommand: z.string().optional(),
  previewCommand: z.string().optional(),
  // Post-ship probe on the lite pool, run after deploy on main only.
  // Non-zero exit fails the run — a deploy that uploads but does not serve
  // is a failed deploy. Keep it curl-level: no workspace restore, no installs.
  verifyCommand: z.string().optional(),
  verifyEnv: z.record(z.string()).default({}),
  // Named worker secrets injected into the verify step env (authed probes).
  verifySecrets: z.array(z.string()).default([]),
  // Extra secrets injected into the build step alongside NPM_TOKEN
  // (e.g. PostHog sourcemap upload for Seal).
  buildSecrets: z.array(z.string()).default([]),
  d1Database: z.string().optional(),
  d1MigrationsCwd: z.string().default("."),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

const buildCommand = "pnpm exec vp run build:all";

// Input-typed so schema defaults apply at getRepoConfig's parse — config
// literals only set fields they care about.
const repoConfigs: Record<string, z.input<typeof repoConfigSchema>> = {
  "seal": {
    name: "seal",
    buildEnv: {
      VITE_API_URL: "https://api.seal.nyc",
      VITE_BETTER_AUTH_URL: "https://api.seal.nyc",
      VITE_APP_URL: "https://app.seal.nyc",
      // apps/site: @astrojs/cloudflare resolves wrangler env at build time;
      // without this the generated config ships dev bindings to production.
      CLOUDFLARE_ENV: "production",
      HOME: "/tmp",
      // Public PostHog project id — pairs with POSTHOG_CLI_API_KEY secret.
      POSTHOG_CLI_PROJECT_ID: "280403",
      POSTHOG_CLI_HOST: "https://us.i.posthog.com",
    },
    // Seal web build uploads hidden source maps when this secret is present.
    buildSecrets: ["POSTHOG_CLI_API_KEY"],
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      // prepare runs `vp config` on install — no hooks in ephemeral containers.
      VP_GIT_HOOKS: "0",
    },
    buildCommand,
    deployCommand:
      "(cd apps/anydoc-worker && pnpm exec wrangler deploy -e production) && " +
      // PATCH /containers/applications rejects API tokens (workers-sdk#14741).
      // Worker code still ships; image rollouts stay a local `wrangler deploy`.
      "(cd apps/convert-worker && pnpm exec wrangler deploy -e production --containers-rollout=none) && " +
      "(cd apps/api && pnpm exec wrangler deploy -e production) && " +
      "(cd apps/mcp-worker && pnpm exec wrangler deploy -e production) && " +
      "(cd apps/web && pnpm exec wrangler deploy -e production) && " +
      "(cd apps/site && pnpm exec wrangler deploy -e production) && " +
      "(cd apps/docs && pnpm exec wrangler deploy -e production)",
    previewCommand:
      '(cd apps/api && pnpm exec wrangler versions upload -e production --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/mcp-worker && pnpm exec wrangler versions upload -e production --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/web && pnpm exec wrangler versions upload -e production --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/site && pnpm exec wrangler versions upload -e production --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/docs && pnpm exec wrangler versions upload -e production --preview-alias "$CI_PREVIEW_ALIAS")',
    // api.seal.nyc is the worker the product's traffic depends on; a 200 on
    // /health right after deploy proves the upload serves, not just uploads.
    verifyCommand: 'curl -fsS --max-time 15 https://api.seal.nyc/health',
    d1Database: "seal-global",
    d1MigrationsCwd: "apps/api",
    checksInstallCommand:
      "pnpm install --frozen-lockfile --store-dir /tmp/.pnpm-store",
    checks: [
      {
        // Must stay `secretlint` — seal's branch protection still requires
        // the retired GHA job's context name.
        name: "secretlint",
        command: "pnpm run scan:secrets",
      },
      {
        // VTX-590: seal's `ci` gate — lint + typecheck. `vp check` includes
        // format and the repo has 233 files of pre-existing drift — gate
        // narrowing is intentional until that drift gets a cleanup pass.
        name: "ci",
        command: "pnpm exec vp lint && pnpm run typecheck",
        timeoutMs: 15 * 60 * 1000,
      },
    ],
  },
  pile: {
    name: "pile",
    buildEnv: {
      // PostHog project key — client-public by design (phc_ prefix), baked
      // into the SPA bundle by Vite at build time.
      VITE_POSTHOG_KEY: "phc_ts2JiKlSqvEC0Cjt68HFUkg3mZnY6CG57QkguxWmn5Y",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
      // The build box auto-detects a tiny heap and mark-compacts itself to
      // death on pnpm relink/vite — pin old-space to what standard-2 has.
      NODE_OPTIONS: "--max-old-space-size=3072",
    },
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      VP_GIT_HOOKS: "0",
      NODE_OPTIONS: "--max-old-space-size=3072",
    },
    // typecheck + web/docs builds OOMed the standard-2 shape even with the
    // heap pin — run deps+build on the heavy pool.
    buildPool: "SANDBOX_HEAVY",
    // blume's githubReleases source needs a repo-read token at build time —
    // GITHUB_TOKEN on this worker is the read:packages PAT (releases are
    // readable with it; verified against the pile releases API).
    buildSecrets: ["GITHUB_TOKEN"],
    // typecheck here is a build-input gate for deploy, not a test — vitest
    // runs in the pre-push hook locally. The wrangler.toml assets.directory
    // (apps/web/dist — PILE-332 member console) must exist before deploy.
    // docs.pile.nyc rides the same pipeline — blume builds the API reference
    // from src/mcp/openapi.json, so it must redeploy whenever routes change.
    // Build output (packages/docs/dist) persists in the step snapshot; the
    // deploy step runs the worker deploy first so docs never lead prod.
    buildCommand:
      "pnpm exec vp run typecheck && pnpm -C apps/web run build && pnpm -C packages/docs run build",
    // With rollout configured the worker ships via versions upload + staged
    // promote; deployCommand carries only the non-versioned extras (docs).
    deployCommand: "pnpm -C packages/docs run deploy",
    rollbackCommand: "pnpm exec wrangler rollback -e production",
    // cli-v* tag pushes: cross-compile all targets from Linux (no macOS)
    // and publish the GitHub release — replaces cli-binary.yml.
    releaseCommand:
      // Direct upload — the probe shows api.github.com + uploads.github.com
      // are reachable from the container, so the raw ~100MB binaries go
      // straight to GitHub (no worker relay, no gzip, no body cap).
      "cd packages/cli && pnpm install --frozen-lockfile > /tmp/install.log 2>&1 && " +
      "pnpm add -D @opentui/core-darwin-arm64 @opentui/core-darwin-x64 >> /tmp/install.log 2>&1 && " +
      'for T in linux-x64 darwin-arm64 darwin-x64; do pnpm dlx bun build --compile --minify --target=bun-$T src/index.ts --outfile "dist/pile-$T" >> /tmp/build.log 2>&1 || exit 1; done && ' +
      'ls -la dist/ && ' +
      "printf '{\"tag_name\":\"%s\",\"generate_release_notes\":true}' \"$TAG\" > /tmp/rel-payload.json && " +
      'CODE=$(curl -s -o /tmp/rel.json -w "%{http_code}" -X POST -H "Authorization: Bearer $GITHUB_TOKEN" ' +
      '-H "Content-Type: application/json" "https://api.github.com/repos/$REPO/releases" -d "@/tmp/rel-payload.json") && ' +
      'echo "create: $CODE" >&2 && ' +
      'if [ "$CODE" = "422" ]; then RID=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" ' +
      '"https://api.github.com/repos/$REPO/releases/tags/$TAG" | tr -d " \\n\\"" | grep -oE "id:[0-9]+" | head -1 | cut -d: -f2); ' +
      'else [ "$CODE" = "201" ] || { cat /tmp/rel.json >&2; exit 1; } && ' +
      'RID=$(tr -d " \\n\\"" < /tmp/rel.json | grep -oE "id:[0-9]+" | head -1 | cut -d: -f2); fi && ' +
      'echo "RID=$RID" >&2 && [ -n "$RID" ] || { echo "no RID" >&2; exit 1; } && ' +
      'for F in dist/pile-*; do ' +
      'CODE=$(curl -s -o /tmp/up.json -w "%{http_code}" -X POST -H "Authorization: Bearer $GITHUB_TOKEN" ' +
      '-H "Content-Type: application/octet-stream" --data-binary "@$F" ' +
      '"https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$(basename $F)") && ' +
      'echo "$(basename $F): $CODE" >&2 && [ "$CODE" = "201" ] || { cat /tmp/up.json >&2; exit 1; }; done && ' +
      'echo "release complete"',
rolloutUploadCommand: "pnpm exec wrangler versions upload -e production",
    rolloutPromoteCommand:
      'pnpm exec wrangler versions deploy "$VID@$PCT%" -e production -y',
    rolloutSteps: [10, 50, 100],
    rolloutSettleSec: 90,
    // Staging bake: previewCommand already ships -e staging; this probes it
    // before prod traffic moves (VTX-584/591).
    stagingVerifyCommand:
      "curl -fsS --max-time 15 https://staging.pile.nyc/health",
    stagingBakeSec: 45,
    // apps/web Playwright bake against the just-deployed staging worker
    // (PLAYWRIGHT_BASE_URL skips the local dev server — specs hit
    // staging.pile.nyc directly). --with-deps apt-installs chromium's OS
    // libs at runtime — the sandbox runs as root, so no image change is
    // needed; bake the dep list into ./Dockerfile if it ever flakes.
    // WARNING: env.staging shares prod D1/DO bindings (see previewCommand)
    // — these specs sign up real users whose rows land in the production
    // database. Acceptable today because staging is already prod-adjacent,
    // but the suite must stay additive-only (sign up, then touch only its
    // own workspace) until staging gets a dedicated data plane.
    stagingE2eCommand:
      "pnpm -C apps/web exec playwright install --with-deps chromium && " +
      "PLAYWRIGHT_BASE_URL=https://staging.pile.nyc pnpm -C apps/web run test:e2e",
    // Version URLs aren't generated for DO workers, so previews are a real
    // second worker: staging.pile.nyc. env.staging shares prod data
    // bindings but has no queue consumer, no cron, no EMAIL — last branch
    // pushed wins. Pinned container digests mean no Docker needed.
    previewCommand: "pnpm exec wrangler deploy -e staging",
    verifyCommand: 'curl -fsS --max-time 15 https://pile.nyc/health',
    d1Database: "pile-global",
    d1MigrationsCwd: ".",
    // Checks-in-pipeline: replaces the Blacksmith GHA gates. Names are what
    // branch protection requires — keep them stable across the flip.
    checksInstallCommand:
      "echo INSTALL-START; pwd; ls | head -20; " +
      '{ cp .npmrc ~/.npmrc 2>/dev/null || printf "@vortexnyc:registry=https://npm.pkg.github.com\\n" > ~/.npmrc; } && ' +
      'printf "//npm.pkg.github.com/:_authToken=%s\\n" "$NPM_TOKEN" >> ~/.npmrc && ' +
      "pnpm install --frozen-lockfile --store-dir /tmp/.pnpm-store",
    checks: [
      {
        // VTX-592: the tool is secretlint (pnpm scan:secrets); the check
        // name now says so. pile's required contexts list is empty, so the
        // rename doesn't wedge any PR.
        name: "secretlint",
        command: "pnpm scan:secrets",
      },
      {
        name: "diff-coverage",
        // The checkout pins refs/ci/base to the true diff base (merge
        // parent / merge_group.base_sha); PR_BODY is injected by the
        // workflow when the event carries a PR number.
        command: "pnpm exec vp run diff-coverage",
        env: { DIFF_COVERAGE_BASE: "refs/ci/base" },
        timeoutMs: 10 * 60 * 1000,
        usesPrBody: true,
      },
      {
        // packages/capture's Playwright suite is self-contained — it
        // vite-builds the IIFE and stands up a mock ingest server, so no
        // stack is needed (~1s of tests). --with-deps apt-installs
        // chromium's OS libs each run; the checks container runs as root
        // so no Dockerfile.checks change is required. If apt-at-runtime
        // ever flakes, bake the dep list into Dockerfile.checks instead.
        name: "e2e-capture",
        command:
          "pnpm -C packages/capture exec playwright install --with-deps chromium && " +
          "pnpm run test:e2e:capture",
        timeoutMs: 10 * 60 * 1000,
      },
      // gitleaks rides the platform baseline — .gitleaks.toml is
      // auto-detected by the baseline command.
    ],
  },
  canary: {
    name: "canary",
    installEnv: { HOME: "/tmp", CI: "true", VP_GIT_HOOKS: "0" },
    buildCommand: "echo canary",
    previewCommand: "pnpm exec wrangler deploy --name cloudflare-ci-canary && curl -fsS --max-time 15 https://cloudflare-ci-canary.vortex-nyc.workers.dev/health",
  },
  // Drill — main-branch push against throwaway workers so deploy → watch →
  // rollback exercises end-to-end. Manual trigger only (the canary workflow's
  // drill param); every run errors on purpose, which also proves the alert.
  drill: {
    name: "drill",
    installEnv: { HOME: "/tmp", CI: "true", VP_GIT_HOOKS: "0" },
    buildCommand: "echo drill",
    previewCommand: "pnpm exec wrangler deploy --name cloudflare-ci-drill-staging",
    stagingVerifyCommand: "curl -fsS --max-time 15 https://cloudflare-ci-drill-staging.vortex-nyc.workers.dev/health",
    stagingBakeSec: 15,
    deployCommand: "pnpm exec wrangler deploy --name cloudflare-ci-drill",
    verifyCommand: "curl -fsS --max-time 15 https://cloudflare-ci-drill.vortex-nyc.workers.dev/health",
    watchCommand: "exit 1",
    watchSec: 10,
    rollbackCommand: "pnpm exec wrangler rollback --name cloudflare-ci-drill",
  },

  vortex: {
    name: "vortex",
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      VP_GIT_HOOKS: "0",
    },
    // sdk:build + entrypoints (root `build`), then the apps whose deploys
    // read dist/ — dashboard/landing/docs static bundles + cde's hosted pkg.
    buildCommand:
      "pnpm exec vp run build && " +
      "pnpm exec vp run -F ./apps/dashboard build && " +
      "pnpm exec vp run -F ./apps/landing build && " +
      "pnpm exec vp run -F ./apps/docs build && " +
      "pnpm exec vp run -F @vortex/hosted build",
    // Automated PlanetScale migrations (replaces the manual `pscale role
    // reset` + `db:migrate` runbook): the migrate step runs off the deps
    // snapshot — the deploy below then skips re-migrating (SKIP_MIGRATE=1).
    migrateCommand:
      'DATABASE_URL="$VORTEX_MIGRATE_URL" pnpm --filter @vortexnyc/money-kernel db:migrate',
    migrateSecrets: ["VORTEX_MIGRATE_URL"],
    // Every worker in the monorepo ships on main — same all-apps model as
    // seal. deploy-worker.sh gates on migrations; the pipeline's migrate
    // step already ran them, so SKIP_MIGRATE=1 keeps ordering in CI.
    deployCommand:
      "SKIP_MIGRATE=1 bash scripts/deploy-worker.sh && " +
      "(cd packages/global && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/dashboard && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/landing && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/docs && pnpm exec vp exec wrangler deploy --config dist/server/wrangler.json) && " +
      "(cd apps/element-cdn && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/ops-relay && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/anydoc-worker && pnpm exec vp exec wrangler deploy -e production) && " +
      "(cd packages/cde-worker && pnpm exec vp exec wrangler deploy) && " +
      // ci-worker declares a container image; the sandbox has no Docker CLI —
      // upload the worker without rolling its containers (they deploy out of band).
      "(cd packages/ci-worker && pnpm exec vp exec wrangler deploy --containers-rollout=none)",
    previewCommand:
      '(cd packages/worker && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/dashboard && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/landing && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/docs && pnpm exec vp exec wrangler versions upload --config dist/server/wrangler.json --preview-alias "$CI_PREVIEW_ALIAS")',
    // api.vortex.nyc serves /health even during maintenance windows — a 200
    // right after deploy proves the upload serves, not just uploads.
    verifyCommand: "curl -fsS --max-time 15 https://api.vortex.nyc/health",
    checksInstallCommand:
      '{ cp .npmrc ~/.npmrc 2>/dev/null || printf "@vortexnyc:registry=https://npm.pkg.github.com\\n" > ~/.npmrc; } && ' +
      'printf "//npm.pkg.github.com/:_authToken=%s\\n" "$NPM_TOKEN" >> ~/.npmrc && ' +
      'service postgresql start && ' +
      `su postgres -c "psql -c \\"ALTER USER postgres WITH PASSWORD 'postgres'\\"; createdb vortex_dev" || true; ` +
      "pnpm install --frozen-lockfile --store-dir /tmp/.pnpm-store",
    checks: [
      {
        // scan:secrets = vp exec trufflehog … — vp exec only resolves
        // node_modules/.bin; call the image binary directly, same args.
        name: "trufflehog",
        command:
          "trufflehog git file://. --results=verified --fail --no-update " +
          "--exclude-globs='node_modules/**,pnpm-lock.yaml'",
      },
      {
        // The GHA verify job: sdk:build + check + openapi:verify +
        // contract:check + lint:hazards + oxlint plugin + landing.
        name: "ci",
        command:
          "pnpm exec vp run sdk:build && pnpm exec vp check && " +
          "pnpm exec vp run openapi:verify && pnpm exec vp run contract:check && " +
          "pnpm exec vp run lint:hazards && pnpm exec vp run test:oxlint-plugin && " +
          "pnpm exec vp run landing:typecheck && pnpm exec vp run landing:build && " +
          "pnpm exec vp run -F ./apps/landing test",
        timeoutMs: 20 * 60 * 1000,
      },
      {
        // production-readiness.yml: MarinJursic prc scan — clones the pinned
        // rev and builds with Go; image carries go1.27.
        name: "prc",
        command: "bash production-readiness/prc.sh",
        timeoutMs: 15 * 60 * 1000,
      },
    ],
  },
  veil: {
    name: "veil",
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      VP_GIT_HOOKS: "0",
    },
    // Vault SPA + login + docs are the surfaces that build dist/; mail,
    // site, and backup-ingest deploy straight from source.
    buildCommand:
      "pnpm --filter veil-vault run build && " +
      "pnpm --filter identity-login run build && " +
      "pnpm --filter @vortex-api/veil-docs run build",
    // Origin (Go API) stays on Railway — this ships only the Cloudflare
    // surface: app.veil.nyc, login.veil.nyc, veil.nyc, mail relay, docs,
    // and the backup WAL ingest worker.
    deployCommand:
      "(cd apps/vault && pnpm exec wrangler deploy) && " +
      "(cd identity/login && pnpm exec wrangler deploy) && " +
      "(cd apps/mail && pnpm exec wrangler deploy) && " +
      "(cd apps/site && pnpm exec wrangler deploy) && " +
      "(cd apps/docs && pnpm exec wrangler deploy --config dist/server/wrangler.json) && " +
      "(cd apps/backup-ingest && pnpm exec wrangler deploy)",
    previewCommand:
      '(cd apps/vault && pnpm exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd identity/login && pnpm exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/site && pnpm exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS")',
    // app.veil.nyc is the surface customers land on — 200 after deploy.
    verifyCommand: "curl -fsS --max-time 15 https://app.veil.nyc",
    // `make ci` gate — needs postgres booted first (PG_TEST_DSN below).
    checksInstallCommand:
      "service postgresql start >/dev/null 2>&1 || " +
      "(pg_ctlcluster 16 main start) && " +
      "su postgres -c 'psql -c \"CREATE DATABASE veil_test;\"' >/dev/null 2>&1; " +
      "pnpm install --frozen-lockfile --store-dir /tmp/.pnpm-store",
    checks: [
      {
        name: "secret-scan",
        command: "pnpm run scan:secrets",
      },
      {
        // The merge gate is the fast contract — sdk-fresh drift + vet +
        // lint + typecheck. The heavy suite (go test -race, govulncheck,
        // veil-vault vitest, docs build) gates locally via pre-push,
        // matching pile/seal's doctrine.
        name: "ci",
        command:
          "make sdk-fresh vet && pnpm exec vp lint && pnpm run typecheck",
        timeoutMs: 15 * 60 * 1000,
      },
    ],
  },
};

const repoNameSchema = z.enum(["seal", "pile", "veil", "vortex", "canary", "drill"]);

// Platform baseline (VTX-580): gates every repo inherits regardless of its
// own `checks` — merged by name so a repo entry overrides the baseline, and
// the merged list is the single source for required contexts (VTX-581).
// gitleaks scans every repo's diff with the repo's .gitleaks.toml when it
// exists, defaults otherwise — one check name, one binary, every repo.
type CheckEntry = NonNullable<
  z.input<typeof repoConfigSchema>["checks"]
>[number];

const baselineChecks: CheckEntry[] = [
  {
    // VTX-593: prc joins the baseline — runs where the repo ships the
    // script (vortex), skips cleanly elsewhere. The gate propagates.
    name: "prc",
    // Skip only when the repo lacks the script; a real gate failure must
    // still fail the check (Codex: `|| echo` was swallowing it).
    command:
      '[ -f production-readiness/prc.sh ] || { echo "prc: no script — skipped"; exit 0; }; bash production-readiness/prc.sh',
    timeoutMs: 15 * 60 * 1000,
    needsInstall: false,
  },
  {
    name: "gitleaks",
    command:
      'CFG=""; [ -f .gitleaks.toml ] && CFG="--config .gitleaks.toml"; ' +
      'gitleaks git $CFG --redact --log-opts "refs/ci/base..HEAD" --verbose .',
    timeoutMs: 5 * 60 * 1000,
    needsInstall: false,
  },
];

export function getRepoConfig(repoName: unknown): RepoConfig | undefined {
  const parsed = repoNameSchema.safeParse(repoName);
  if (!parsed.success) {
    return undefined;
  }
  const config = repoConfigs[parsed.data];
  if (!config) return undefined;
  const merged = { ...config };
  const byName = new Map<string, CheckEntry>();
  for (const check of baselineChecks) byName.set(check.name, check);
  for (const check of merged.checks ?? []) byName.set(check.name, check);
  merged.checks = [...byName.values()];
  return repoConfigSchema.parse(merged);
}
