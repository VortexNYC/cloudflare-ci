import { z } from "zod";

const checkSchema = z.object({
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
  // Named worker secrets injected into the check process env — never into
  // the script text. Missing required names fail the check closed.
  secrets: z.array(z.string()).default([]),
  optionalSecrets: z.array(z.string()).default([]),
  // True runs the check in its own ChecksSandbox even when the repo is
  // `serial` — a long live gate must not serialize behind the fast suite.
  isolated: z.boolean().default(false),
  // PR gates carrying secrets must never execute fork code: the workflow
  // verifies the PR's head repo before any sandbox spawns and skips the
  // check entirely on a mismatch (same contract as the old GHA `if:` guard).
  sameRepoOnly: z.boolean().default(false),
  // Draft PRs run only `fast` checks (format, lint, secret scan) — the
  // rest report neutral and fire for real on ready_for_review (and on
  // merge_group, which never carries a draft flag).
  fast: z.boolean().default(false),
  // Scheduled ops lanes stay off the PR CHECKS pool so a daily regression
  // can't starve merge checks; webhook checks default to CHECKS.
  pool: z.enum(["CHECKS", "AUX"]).default("CHECKS"),
  // Scheduled-only failure alert cadence (deduped through the scheduler DO).
  alertEveryMs: z.number().int().positive().optional(),
  // Check pushes to GitHub (ops tags, branches) — the dispatch workflow
  // mints a contents:write installation token for it instead of the
  // checks:write read-only default.
  gitWrite: z.boolean().default(false),
});

const scheduledCheckSchema = checkSchema.extend({
  // Wrangler cron expression this check answers — index.ts dispatches on it.
  cron: z.string(),
});

const dispatchInputSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  required: z.boolean().default(false),
  choices: z.array(z.string()).optional(),
});

// workflow_dispatch replacements: named operator runs triggered through
// POST /admin/dispatch (Bearer ADMIN_TOKEN). Inputs are declared up front —
// the endpoint rejects undeclared names, missing required values, and
// values outside `choices`, then the workflow exposes each as INPUT_<NAME>
// in the check's env (same shape as GitHub's inputs.* context).
const dispatchCheckSchema = checkSchema.extend({
  inputs: z.array(dispatchInputSchema).default([]),
});

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
  // Main-only promotion gate. This is deliberately separate from
  // previewCommand: a PR may preview, but it must never run a sandbox or
  // production deploy.
  preDeployCommand: z.string().optional(),
  preDeploySecrets: z.array(z.string()).default([]),
  preDeployVerifyCommand: z.string().optional(),
  preDeployVerifySecrets: z.array(z.string()).default([]),
  // Automated migrations for non-D1 databases (e.g. vortex PlanetScale) —
  // runs on the build snapshot so drizzle-kit resolves from node_modules.
  // Secrets arrive via migrateSecrets; interpolate them into env, not argv.
  // Promotion can be shipped independently while the migration lane is gated.
  migrateOnPromotion: z.boolean().default(true),
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
  checks: z.array(checkSchema).default([]),
  // Cron replacements for former GitHub Actions schedules. These are not
  // merge checks: dispatch resolves the default-branch sha and runs the
  // named suite as GitHub check runs on that commit.
  scheduledChecks: z.array(scheduledCheckSchema).default([]),
  // Operator workflow_dispatch lanes — triggered via POST /admin/dispatch
  // on main's head sha. Same log+alert path as scheduledChecks: no GitHub
  // check-runs, deduped ops alerts on failure.
  dispatchChecks: z.array(dispatchCheckSchema).default([]),
  // Per-repo install run once before checks (pnpm install, go mod download).
  checksInstallCommand: z.string().optional(),
  // When true (default), each check gets its own container — lowest wall clock.
  // `serial` runs one CHECKS slot for the whole suite (gitleaks → prc → ci…).
  checksExecution: z.enum(["parallel", "serial"]).default("parallel"),
  previewCommand: z.string().optional(),
  // Post-ship probe on the lite pool, run after deploy on main only.
  // Non-zero exit fails the run — a deploy that uploads but does not serve
  // is a failed deploy. Keep it curl-level: no workspace restore, no installs.
  verifyCommand: z.string().optional(),
  verifyEnv: z.record(z.string()).default({}),
  // Named worker secrets injected into the verify step env (authed probes).
  verifySecrets: z.array(z.string()).default([]),
  // Non-gating smoke/probe step after verify. Failures are logged without
  // rolling back a deployment that already passed the health gate.
  postDeployCommand: z.string().optional(),
  postDeploySecrets: z.array(z.string()).default([]),
  // Extra secrets injected into the build step alongside NPM_TOKEN
  // (e.g. PostHog sourcemap upload for Seal).
  buildSecrets: z.array(z.string()).default([]),
  // Main-only release bookkeeping and publication. These run after deploy
  // verification, never on PR/preview runs.
  releaseRecordCommand: z.string().optional(),
  releaseRecordSecrets: z.array(z.string()).default([]),
  publishCommands: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        secrets: z.array(z.string()).default([]),
      })
    )
    .default([]),
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
    checksExecution: "serial",
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
        fast: true,
        command: "pnpm run scan:secrets",
      },
      {
        // VTX-590: seal's `ci` gate — lint + typecheck. `vp check` includes
        // format and the repo has 233 files of pre-existing drift — gate
        // narrowing is intentional until that drift gets a cleanup pass.
        name: "ci",
        fast: true,
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
        fast: true,
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
    checksExecution: "serial",
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      VP_GIT_HOOKS: "0",
    },
    // sdk:build + entrypoints (root `build`), then the apps whose deploys
    // read dist/ — dashboard/landing/docs static bundles + cde's hosted pkg.
    // Current sandbox images still have Node 22.23.2 until the Dockerfile
    // rebuild rolls out. Astro 7.4 exits on that. Install 24.22.2 beside it.
    buildCommand:
      "node -e 'const [M,m,p]=process.versions.node.split(\".\").map(Number); process.exit(M>22||(M===22&&(m>23||(m===23&&p>=4)))?0:1)' || " +
      "{ mkdir -p \"$HOME/.local\" && curl -fsSL \"https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/').tar.gz\" | tar -xz -C \"$HOME/.local\" --strip-components=1; } && " +
      "export PATH=\"$HOME/.local/bin:$PATH\" && node -v && " +
      "pnpm exec vp run build && " +
      "pnpm exec vp run -F ./apps/dashboard build && " +
      "pnpm exec vp run -F ./apps/landing build && " +
      "pnpm exec vp run -F ./apps/docs build && " +
      "pnpm exec vp run -F @vortex/hosted build",
    // Sandbox promotion is deploy-only for now. Database migrations stay on
    // the production migration step until Sandbox connectivity is proven.
    preDeployCommand:
      "bash scripts/deploy-worker.sh sandbox && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include OpsRelaySandbox) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include AuthSandbox --include EdgeRateLimit) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include CdeSandbox) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include DashboardSandbox) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include LandingSandbox) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage sandbox --no-input --yes --include ElementCdnSandbox)",
    preDeployVerifyCommand:
      "pnpm exec vp exec tsx scripts/gate-post-deploy-smoke.cli.ts --base https://api.sandbox.vortex.nyc && " +
      "pnpm exec vp exec tsx scripts/gate-post-deploy-smoke.cli.ts --base https://app.sandbox.vortex.nyc --spa",
    migrateCommand:
      'DATABASE_URL="$VORTEX_MIGRATE_URL" pnpm --filter @vortexnyc/money-kernel db:migrate',
    migrateSecrets: ["VORTEX_MIGRATE_URL"],
    migrateOnPromotion: false,
    // Every worker in the monorepo ships on main after the sandbox gate.
    // PlanetScale migration remains a separately gated lane for now.
    deployCommand:
      "SKIP_MIGRATE=1 bash scripts/deploy-worker.sh && " +
      "(cd packages/global && pnpm exec vp exec wrangler deploy) && " +
      "(vp exec alchemy deploy scripts/alchemy/run.ts --stage production --no-input --yes --include Dashboard) && " +
      "(cd apps/landing && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/docs && pnpm exec vp exec wrangler deploy --config dist/server/wrangler.json) && " +
      "(cd apps/element-cdn && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/ops-relay && pnpm exec vp exec wrangler deploy) && " +
      "(cd apps/anydoc-worker && pnpm exec vp exec wrangler deploy -e production) && " +
      "(cd packages/cde-worker && pnpm exec vp exec wrangler deploy)",
    previewCommand:
      '(cd packages/worker && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/dashboard && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/landing && pnpm exec vp exec wrangler versions upload --preview-alias "$CI_PREVIEW_ALIAS") && ' +
      '(cd apps/docs && pnpm exec vp exec wrangler versions upload --config dist/server/wrangler.json --preview-alias "$CI_PREVIEW_ALIAS")',
    // api.vortex.nyc serves /health even during maintenance windows — a 200
    // right after deploy proves the upload serves, not just uploads.
    verifyCommand: "curl -fsS --max-time 15 https://api.vortex.nyc/health",
    postDeployCommand:
      "pnpm exec vp exec tsx scripts/gate-post-deploy-smoke.cli.ts --base https://api.vortex.nyc && " +
      "pnpm exec vp exec tsx scripts/gate-post-deploy-smoke.cli.ts --base https://app.vortex.nyc --spa",
    releaseRecordCommand:
      "pnpm exec vp exec tsx scripts/release-record.ts record " +
      "--out /tmp/release-record.json " +
      "--evidence \"cloudflare-ci deploy\" " +
      "--ci-run-url \"${CI_RUN_URL:-cloudflare-ci}\"" +
      " && printf '%s\\n' 'CLOUDFLARE_CI_RELEASE_RECORD_BEGIN' " +
      " && cat /tmp/release-record.json " +
      " && printf '%s\\n' 'CLOUDFLARE_CI_RELEASE_RECORD_END'",
    releaseRecordSecrets: [],
    publishCommands: [
      {
        name: "publish-typescript-sdk",
        command:
          "service postgresql start && " +
          "su postgres -c \"psql -c \\\"ALTER USER postgres WITH PASSWORD 'postgres'\\\"; createdb vortex_dev\" || true; " +
          "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/vortex_dev " +
          "pnpm run ci:publish-sdk",
        secrets: ["NPM_TOKEN"],
      },
      {
        name: "publish-python-sdk",
        command: "pnpm run ci:publish-python-sdk",
        secrets: ["PYPI_TOKEN"],
      },
      {
        name: "publish-go-sdk",
        // The Workflow injects a short-lived GitHub App token as
        // GITHUB_TOKEN only for this step. The script's existing variable
        // name is a compatibility alias, not a Worker secret binding.
        command:
          'GO_SDK_PUSH_TOKEN="$GITHUB_TOKEN" pnpm run ci:publish-go-sdk',
        secrets: [],
      },
    ],
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
        fast: true,
        command:
          "trufflehog git file://. --results=verified --fail --no-update " +
          "--exclude-globs='node_modules/**,pnpm-lock.yaml'",
      },
      {
        // The GHA verify job: sdk:build + check + openapi:verify +
        // contract:check + lint:hazards + oxlint plugin + landing.
        // sdk:build must stay before check — the typecheck resolves
        // @vortex-api/vortex types from the generated SDK.
        // check = lint:effect (effect-tsgo oxlint) + vp check (Vite+ fmt/lint/typecheck).
        // Cloudflare checks runner relaxes vm.overcommit_memory for oxc JS plugins.
        name: "ci",
        command:
          // overcommit is relaxed platform-wide by the checks runner —
          // see buildRunScript in checks-workflow.ts.
          "pnpm exec vp run sdk:build && pnpm run check && " +
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
      {
        // VOR-275 — the Blacksmith worker-money-paths-regression job moved
        // here under the same check name so it can take over the required
        // context. Deploys the PR's payments Worker with the same alchemy
        // apply (`--stage ci --include PaymentsCi`), then uploads a
        // non-promoted version under a per-PR --preview-alias: the health
        // poll and the four billing proofs run against that isolated
        // origin, so a concurrent PR's apply can never rewrite the code
        // under test. The shared `vortex-payments-ci` script keeps its
        // secret bindings — a fresh-name deploy would lose every one.
        // Own ChecksSandbox: a ~40min live gate must not serialize into
        // ci/trufflehog/prc. Secrets arrive by name; same-repo PRs only.
        name: "worker-money-paths-regression",
        isolated: true,
        sameRepoOnly: true,
        timeoutMs: 40 * 60 * 1000,
        env: { FINIX_SMOKE_ENV: "sandbox" },
        secrets: [
          // CF_TOKEN is the Worker's deploy token — the command exports
          // it as CLOUDFLARE_API_TOKEN for alchemy/wrangler, same as
          // ci.ts does for its own deploy calls.
          "CF_TOKEN",
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_CI_BASE_URL",
          "FINIX_SANDBOX_USERNAME",
          "FINIX_SANDBOX_PASSWORD",
          // Optional smoke seeds — the provisioner self-heals when absent.
          "VORTEX_SMOKE_API_KEY",
          "VORTEX_SMOKE_CUSTOMER_ID",
          "VORTEX_SMOKE_PAYMENT_METHOD_ID",
          "FINIX_SMOKE_MERCHANT_ID",
          "FINIX_SMOKE_PAYMENT_INSTRUMENT_ID",
        ],
        command: `set -euo pipefail
# Sandbox image can still be Node 22 — same 24.22.2 shim as buildCommand.
node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); process.exit(M>22||(M===22&&(m>23||(m===23&&p>=4)))?0:1)' || \\
  { mkdir -p "\$HOME/.local" && curl -fsSL "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-\$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/').tar.gz" | tar -xz -C "\$HOME/.local" --strip-components=1; }
export PATH="\$HOME/.local/bin:\$PATH"
# Guard — fail closed when a required name is unbound on the Worker.
missing=0
for name in CF_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_CI_BASE_URL FINIX_SANDBOX_USERNAME FINIX_SANDBOX_PASSWORD; do
  [ -z "\${!name:-}" ] && { echo "::error::\$name missing on the cloudflare-ci Worker"; missing=1; }
done
[ "\$missing" = 0 ] || exit 1
# alchemy + wrangler authenticate via CLOUDFLARE_API_TOKEN.
export CLOUDFLARE_API_TOKEN="\$CF_TOKEN"
# PaymentsCi only — production and sandbox stay on deploy-worker.sh.
pnpm exec vp exec alchemy deploy scripts/alchemy/run.ts --stage ci --no-input --yes --include PaymentsCi
# Per-PR origin: a preview-alias version serves THIS checkout at
# <alias>-vortex-payments-ci.<subdomain>.workers.dev while the live
# deployment is left alone.
ALIAS="ci-pr-\${PR_NUMBER:-manual}-\$(git rev-parse --short HEAD 2>/dev/null || echo x)"
ALIAS=\$(echo "\$ALIAS" | tr -cd 'a-z0-9-' | cut -c1-40)
(cd packages/worker && pnpm exec vp exec wrangler versions upload -e ci --preview-alias "\$ALIAS")
CI_ORIGIN="\${CLOUDFLARE_CI_BASE_URL/vortex-payments-ci/\${ALIAS}-vortex-payments-ci}"
echo "isolated origin: \$CI_ORIGIN"
code=000
for i in 1 2 3 4 5 6 7 8 9 10; do
  code=\$(curl -sf -o /dev/null -w '%{http_code}' "\$CI_ORIGIN/health" || echo 000)
  [ "\$code" = 200 ] && break
  sleep 10
done
[ "\$code" = 200 ] || { echo "::error::CI Worker preview did not become healthy"; exit 1; }
# Self-healing smoke fixtures — emits KEY=value on stdout (logs on
# stderr): static seeds pass through when healthy, a disposable org +
# merchant gets provisioned when rotted or absent.
VORTEX_WORKER_ORIGIN="\$CI_ORIGIN" pnpm exec vp exec tsx scripts/ops-provision-smoke-org.ts > /tmp/money-env.out
grep -E '^[A-Z0-9_]+=' /tmp/money-env.out > /tmp/money.env
set -a; . /tmp/money.env; set +a
# All four paths run even when an early one fails — one run surfaces
# every broken leg (PAY-53 rail contract).
set +e
fail=0
export VORTEX_API_BASE_URL="\$CI_ORIGIN"
for proof in \\
  scripts/smoke-taxable-document-payment-worker.ts \\
  scripts/smoke-finix-payment-request-loop.ts \\
  packages/payments-provider/scripts/finix-certification-proof-suite.ts \\
  packages/payments-provider/scripts/finix-smoke-settlement-reconcile.ts; do
  pnpm exec vp exec tsx "\$proof" || fail=1
done
[ "\$fail" = 0 ] || { echo "::error::One or more money paths failed on the PR Worker"; exit 1; }`,
      },
    ],
    scheduledChecks: [
      {
        // synthetic-monitor.yml — between-deploys probe of the prod API.
        name: "synthetic-monitor",
        cron: "*/15 * * * *",
        command:
          "pnpm exec vp exec tsx scripts/gate-post-deploy-smoke.cli.ts --base https://api.vortex.nyc",
        timeoutMs: 5 * 60 * 1000,
        pool: "AUX",
        alertEveryMs: 30 * 60 * 1000,
      },
      {
        // drift-check.yml — money-path leading indicators against prod.
        name: "money-path-drift",
        cron: "7 * * * *",
        command:
          "pnpm exec vp exec tsx scripts/money-path-drift-check.cli.ts",
        secrets: ["DATABASE_URL"],
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // planetscale-backup.yml — newest successful main backup must be fresh.
        name: "planetscale-backup",
        cron: "0 */6 * * *",
        command: `set -eo pipefail
if [ -z "$PLANETSCALE_SERVICE_TOKEN" ] || [ -z "$PLANETSCALE_SERVICE_TOKEN_ID" ]; then
  echo "Missing PLANETSCALE_SERVICE_TOKEN or PLANETSCALE_SERVICE_TOKEN_ID worker secret."
  exit 1
fi
set +e
pscale backup list "$PLANETSCALE_DATABASE" "$PLANETSCALE_BASE_BRANCH" --org "$PLANETSCALE_ORG" --format json > /tmp/planetscale-backups.json 2> /tmp/planetscale-backups-stderr.txt
pscale_status=$?
set -e
if [ "$pscale_status" -ne 0 ]; then
  cat /tmp/planetscale-backups-stderr.txt >&2 || true
  cat /tmp/planetscale-backups.json >&2 || true
  printf '{"ok":false,"reason":"pscale backup list exited %s"}\\n' "$pscale_status" > /tmp/planetscale-backup-proof.json
  status=1
else
  if pnpm exec vp exec tsx scripts/gate-planetscale-backup.ts /tmp/planetscale-backups.json > /tmp/planetscale-backup-proof.json 2>&1; then
    status=0
  else
    status=$?
  fi
  cat /tmp/planetscale-backup-proof.json
fi
if [ "$status" -ne 0 ] && [ -n "$VORTEX_OPS_ALERT_WEBHOOK_URL" ]; then
  curl --fail --show-error --silent -H "content-type: application/json" --data-binary @/tmp/planetscale-backup-proof.json "$VORTEX_OPS_ALERT_WEBHOOK_URL" || true
fi
exit "$status"`,
        secrets: ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"],
        optionalSecrets: ["VORTEX_OPS_ALERT_WEBHOOK_URL"],
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // production-readiness.yml job 1 — chuanjin pr scan, weekly.
        name: "production-readiness",
        cron: "0 9 * * 1",
        command: "bash production-readiness/run.sh",
        needsInstall: false,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // production-readiness.yml job 2 — MarinJursic prc scan, weekly.
        // Distinct name from the PR check so a scheduled run never reopens
        // the merge-gate check run on the same sha.
        name: "production-readiness-prc",
        cron: "0 9 * * 1",
        command: "bash production-readiness/prc.sh",
        needsInstall: false,
        timeoutMs: 15 * 60 * 1000,
        pool: "AUX",
      },
      {
        // ci-planetscale.yml schedule — ephemeral branch smoke, daily.
        name: "planetscale-branch-tests",
        cron: "0 6 * * *",
        command: `set -euo pipefail
if [ -z "$PLANETSCALE_SERVICE_TOKEN" ] || [ -z "$PLANETSCALE_SERVICE_TOKEN_ID" ]; then
  echo "Missing PLANETSCALE_SERVICE_TOKEN or PLANETSCALE_SERVICE_TOKEN_ID worker secret."
  exit 1
fi
RUN_KEY=$(printf '%s' "$CI_RUN_KEY" | tr -cd 'a-zA-Z0-9-' | cut -c1-24)
BRANCH_NAME="ci-$RUN_KEY"
ROLE_NAME="ci-runner-$RUN_KEY"
ROLE_ID=""
cleanup() {
  rc=$?
  trap - EXIT
  if [ -n "$ROLE_ID" ]; then
    pscale role delete "$PLANETSCALE_DATABASE" "$BRANCH_NAME" "$ROLE_ID" --successor postgres --force --org "$PLANETSCALE_ORG" >/dev/null 2>&1 || true
  fi
  if [ -n "$BRANCH_NAME" ]; then
    pscale branch delete "$PLANETSCALE_DATABASE" "$BRANCH_NAME" --org "$PLANETSCALE_ORG" --force >/dev/null 2>&1 || true
  fi
  exit $rc
}
trap cleanup EXIT
pscale branch create "$PLANETSCALE_DATABASE" "$BRANCH_NAME" --from "$PLANETSCALE_BASE_BRANCH" --org "$PLANETSCALE_ORG" --wait
pscale role create "$PLANETSCALE_DATABASE" "$BRANCH_NAME" "$ROLE_NAME" --inherited-roles postgres --ttl 1h --org "$PLANETSCALE_ORG" --format json > /tmp/role.json
ROLE_ID=$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/role.json","utf8")); process.stdout.write(String(j.id ?? ""))')
CONNECTION_STRING=$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/role.json","utf8")); process.stdout.write(String(j.database_url ?? ""))')
if [ -z "$CONNECTION_STRING" ]; then
  echo "pscale role create returned no database_url"
  exit 1
fi
export TEST_DATABASE_URL="$CONNECTION_STRING" DATABASE_URL="$CONNECTION_STRING" PAYMENTS_STORAGE_RETAIN_TEST_SCHEMAS=1 PAYMENTS_STORAGE_ALLOW_REMOTE=1
pnpm exec vp run sdk:build
pnpm run check
pnpm exec vp run -F @vortexnyc/payments-storage test test/billing-catalog.test.ts test/billing-coupons.test.ts test/billing-dunning-campaigns.test.ts test/merchants-customers.test.ts test/money-path.test.ts test/onboarding-states.test.ts test/settlement-approvals.test.ts --no-file-parallelism --test-timeout=30000
pnpm exec vp run -F @vortexnyc/worker test test/merchant-payments.test.ts test/settlement-reconcile-apply.test.ts --test-timeout=30000`,
        secrets: ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"],
        timeoutMs: 50 * 60 * 1000,
        pool: "AUX",
      },
      {
        // launch-regression.yml — broader daily wall on an ephemeral branch.
        name: "launch-regression",
        cron: "0 15 * * *",
        command: `set -euo pipefail
if [ -z "$PLANETSCALE_SERVICE_TOKEN" ] || [ -z "$PLANETSCALE_SERVICE_TOKEN_ID" ]; then
  echo "Missing PLANETSCALE_SERVICE_TOKEN or PLANETSCALE_SERVICE_TOKEN_ID worker secret."
  exit 1
fi
RUN_KEY=$(printf '%s' "$CI_RUN_KEY" | tr -cd 'a-zA-Z0-9-' | cut -c1-24)
BRANCH_NAME="lr-$RUN_KEY"
ROLE_NAME="lr-runner-$RUN_KEY"
ROLE_ID=""
cleanup() {
  rc=$?
  trap - EXIT
  if [ -n "$ROLE_ID" ]; then
    pscale role delete "$PLANETSCALE_DATABASE" "$BRANCH_NAME" "$ROLE_ID" --successor postgres --force --org "$PLANETSCALE_ORG" >/dev/null 2>&1 || true
  fi
  if [ -n "$BRANCH_NAME" ]; then
    pscale branch delete "$PLANETSCALE_DATABASE" "$BRANCH_NAME" --org "$PLANETSCALE_ORG" --force >/dev/null 2>&1 || true
  fi
  exit $rc
}
trap cleanup EXIT
pscale branch create "$PLANETSCALE_DATABASE" "$BRANCH_NAME" --from "$PLANETSCALE_BASE_BRANCH" --org "$PLANETSCALE_ORG" --wait
pscale role create "$PLANETSCALE_DATABASE" "$BRANCH_NAME" "$ROLE_NAME" --inherited-roles postgres --ttl 2h --org "$PLANETSCALE_ORG" --format json > /tmp/role.json
ROLE_ID=$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/role.json","utf8")); process.stdout.write(String(j.id ?? ""))')
CONNECTION_STRING=$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/role.json","utf8")); process.stdout.write(String(j.database_url ?? ""))')
if [ -z "$CONNECTION_STRING" ]; then
  echo "pscale role create returned no database_url"
  exit 1
fi
export TEST_DATABASE_URL="$CONNECTION_STRING" DATABASE_URL="$CONNECTION_STRING" PAYMENTS_STORAGE_RETAIN_TEST_SCHEMAS=1 PAYMENTS_STORAGE_ALLOW_REMOTE=1
pnpm run check
pnpm run openapi:http-api:verify
pnpm run spec-mirror:verify
python3 scripts/verify-query-coverage.py
python3 scripts/verify-payload-coverage.py && python3 scripts/verify-payload-strictness.py
pnpm run openapi:http-api
git diff --exit-code docs/openapi/vortex-http-api.generated.json
pnpm exec vp run -F @vortexnyc/payments-storage test --no-file-parallelism --test-timeout=30000
pnpm exec vp run -F @vortexnyc/worker test --no-file-parallelism --test-timeout=30000`,
        secrets: ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"],
        timeoutMs: 60 * 60 * 1000,
        pool: "AUX",
      },
    ],
    // VOR-278 — the manual workflow_dispatch operator lanes. Commands are
    // the GHA bodies verbatim; `environment` inputs map to the GitHub
    // environment-scoped jobs they replaced ("all" runs both sequentially).
    dispatchChecks: [
      {
        // deploy-lock.yml — stamps ops/deploy-locked-<env> annotated tags.
        name: "deploy-lock",
        gitWrite: true,
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
          { name: "reason", required: true },
        ],
        command: `set -euo pipefail
git fetch --force origin "refs/tags/ops/*:refs/tags/ops/*" || true
git config user.name "cloudflare-ci[bot]"
git config user.email "cloudflare-ci[bot]@users.noreply.github.com"
pnpm exec vp exec tsx scripts/gate-stamp-deploy-lock.cli.ts \\
  --environment "$INPUT_ENVIRONMENT" \\
  --reason "$INPUT_REASON"`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // deploy-unlock.yml — deletes ops/deploy-locked-<env> tags.
        name: "deploy-unlock",
        gitWrite: true,
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
        ],
        command: `set -euo pipefail
git fetch --force origin "refs/tags/ops/*:refs/tags/ops/*" || true
git config user.name "cloudflare-ci[bot]"
git config user.email "cloudflare-ci[bot]@users.noreply.github.com"
pnpm exec vp exec tsx scripts/gate-stamp-deploy-lock.cli.ts \\
  --environment "$INPUT_ENVIRONMENT" \\
  --unlock`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // disable-charging.yml — sets AUTH_KV payments:charging_disabled.
        name: "disable-charging",
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
for E in production sandbox; do
  case "$INPUT_ENVIRONMENT" in "$E"|all)
    pnpm exec vp exec tsx scripts/set-charging-mode.cli.ts \\
      --environment "$E" --enable ;;
  esac
done`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // enable-charging.yml — clears payments:charging_disabled.
        name: "enable-charging",
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
for E in production sandbox; do
  case "$INPUT_ENVIRONMENT" in "$E"|all)
    pnpm exec vp exec tsx scripts/set-charging-mode.cli.ts \\
      --environment "$E" --disable ;;
  esac
done`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // disable-maintenance.yml — clears AUTH_KV payments:maintenance.
        name: "disable-maintenance",
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
for E in production sandbox; do
  case "$INPUT_ENVIRONMENT" in "$E"|all)
    pnpm exec vp exec tsx scripts/set-maintenance-mode.cli.ts \\
      --environment "$E" --disable ;;
  esac
done`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // enable-maintenance.yml — sets AUTH_KV payments:maintenance.
        name: "enable-maintenance",
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
for E in production sandbox; do
  case "$INPUT_ENVIRONMENT" in "$E"|all)
    pnpm exec vp exec tsx scripts/set-maintenance-mode.cli.ts \\
      --environment "$E" --enable ;;
  esac
done`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // feature-flag.yml — flips a registry flag over AUTH_KV.
        name: "feature-flag",
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox", "all"] },
          { name: "flag", required: true, choices: ["split_transfers", "platform_buyer_reuse"] },
          { name: "state", required: true, choices: ["on", "off"] },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
for E in production sandbox; do
  case "$INPUT_ENVIRONMENT" in "$E"|all)
    pnpm exec vp exec tsx scripts/set-feature-flag.cli.ts \\
      --environment "$E" \\
      --flag "$INPUT_FLAG" \\
      --"$INPUT_STATE" ;;
  esac
done`,
        timeoutMs: 10 * 60 * 1000,
        pool: "AUX",
      },
      {
        // rollback-worker.yml — wrangler rollback promotes a previous
        // version; no Alchemy reconcile, no tag moves. Image wrangler is
        // used directly, so no repo install.
        name: "rollback-worker",
        needsInstall: false,
        inputs: [
          { name: "environment", required: true, choices: ["production", "sandbox"] },
          { name: "version_id", required: false },
          { name: "message", required: false },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
case "$INPUT_ENVIRONMENT" in
  sandbox) WORKER_NAME=vortex-sandbox ;;
  *) WORKER_NAME=vortex ;;
esac
MESSAGE="\${INPUT_MESSAGE:-Emergency rollback via cloudflare-ci}"
echo "=== deployments status (before) ==="
wrangler --name "$WORKER_NAME" deployments status
echo "=== recent deployments ==="
wrangler --name "$WORKER_NAME" deployments list
if [ -n "\${INPUT_VERSION_ID:-}" ]; then
  wrangler --name "$WORKER_NAME" rollback "$INPUT_VERSION_ID" --yes --message "$MESSAGE"
else
  wrangler --name "$WORKER_NAME" rollback --yes --message "$MESSAGE"
fi
echo "=== deployments status (after) ==="
wrangler --name "$WORKER_NAME" deployments status`,
        timeoutMs: 15 * 60 * 1000,
        pool: "AUX",
      },
      {
        // seed-alchemy-state.yml — one --adopt per stage. `environment`
        // selected the GitHub env holding the token; the Worker's CF_TOKEN
        // is the single credential now, so only the stage matters.
        name: "seed-alchemy-state",
        inputs: [
          { name: "stage", required: true, choices: ["ci", "sandbox", "production"] },
          { name: "include", required: true },
        ],
        secrets: ["CF_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        command: `set -euo pipefail
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
ADOPT="--adopt"
if [ "$INPUT_INCLUDE" = "CiToken" ]; then
  ADOPT=""
fi
pnpm exec vp exec alchemy deploy scripts/alchemy/run.ts \\
  --stage "$INPUT_STAGE" \\
  --no-input \\
  --yes \\
  $ADOPT \\
  --include "$INPUT_INCLUDE"`,
        timeoutMs: 30 * 60 * 1000,
        pool: "AUX",
      },
      {
        // finix-microdeposit-proof.yml — live sandbox microdeposit
        // lifecycle proof; the JSON record lands in the run log (the GHA
        // artifact upload has no CI equivalent).
        name: "finix-microdeposit-proof",
        env: { FINIX_SMOKE_ENV: "sandbox" },
        secrets: ["FINIX_SANDBOX_USERNAME", "FINIX_SANDBOX_PASSWORD"],
        command:
          "pnpm exec vp exec tsx scripts/smoke-finix-microdeposit.ts",
        timeoutMs: 25 * 60 * 1000,
        pool: "AUX",
      },
      {
        // finix-sandbox-proofs.yml — certification suite + settlement
        // reconcile against real Finix sandbox, accumulator not fail-fast.
        name: "finix-sandbox-proofs",
        env: {
          FINIX_SMOKE_ENV: "sandbox",
          FINIX_CERT_PROOF_ONBOARDING: "false",
          FINIX_CERT_PROOF_FEE_PROFILE: "false",
          FINIX_CERT_PROOF_MERCHANT_FEE_PROFILE_ASSIGNMENT: "true",
          FINIX_CERT_PROOF_PLATFORM_FEE: "true",
          FINIX_CERT_PROOF_PAYOUT: "false",
          FINIX_CERT_PROOF_DISPUTE_TRIGGER: "false",
        },
        secrets: [
          "FINIX_SANDBOX_USERNAME",
          "FINIX_SANDBOX_PASSWORD",
          "FINIX_SMOKE_MERCHANT_ID",
          "FINIX_SMOKE_PAYMENT_INSTRUMENT_ID",
        ],
        command: `set -uo pipefail
fail=0
pnpm exec vp exec tsx packages/payments-provider/scripts/finix-certification-proof-suite.ts || fail=1
pnpm exec vp exec tsx packages/payments-provider/scripts/finix-smoke-settlement-reconcile.ts || fail=1
if [ "$fail" != 0 ]; then
  echo "::error::One or more live sandbox proofs failed"
  exit 1
fi`,
        timeoutMs: 40 * 60 * 1000,
        pool: "AUX",
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
    // Secret scan is fast-lane — drafts still get it.
    fast: true,
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

export interface ScheduledJobGroup {
  repo: string;
  checkNames: string[];
}

/** Cron → repo check suite. One workflow per repo+cron keeps weekly jobs
 *  (production-readiness has two scans) in a single dispatch. */
export function getScheduledJobsForCron(cron: string): ScheduledJobGroup[] {
  const jobs: ScheduledJobGroup[] = [];
  for (const repoName of repoNameSchema.options) {
    const config = getRepoConfig(repoName);
    const checkNames = (config?.scheduledChecks ?? [])
      .filter((check) => check.cron === cron)
      .map((check) => check.name);
    if (checkNames.length > 0) {
      jobs.push({ repo: `VortexNYC/${repoName}`, checkNames });
    }
  }
  return jobs;
}
