import { z } from "zod";

const repoConfigSchema = z.object({
  name: z.string(),
  buildEnv: z.record(z.string()).default({}),
  installEnv: z.record(z.string()).default({}),
  // The only step whose snapshot persists — must produce whatever dist/
  // preview and deploy upload. Checks/tests gate locally via pre-push
  // hooks, not in billable containers.
  // Optional for checks-only repos (veil flips before its deploy path).
  buildCommand: z.string().optional(),
  deployCommand: z.string().optional(),
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
  },
  pile: {
    name: "pile",
    buildEnv: {
      // PostHog project key — client-public by design (phc_ prefix), baked
      // into the SPA bundle by Vite at build time.
      VITE_POSTHOG_KEY: "phc_v5HaYTE3N9siA53wtYmkFHSm28mBATJJsdDjeaobHxC8",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    },
    installEnv: {
      HOME: "/tmp",
      CI: "true",
      VP_GIT_HOOKS: "0",
    },
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
    deployCommand:
      "pnpm exec wrangler deploy -e production && pnpm -C packages/docs run deploy",
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
        name: "trufflehog",
        // The repo's own scan gate (secretlint) — same rules as the
        // pre-push hook; cheaper than fetching a trufflehog binary.
        command: "pnpm scan:secrets",
      },
      {
        name: "diff-coverage",
        // HEAD^1 is the base parent of the PR merge commit; PR_BODY is
        // injected by the workflow when the event carries a PR number.
        command: "pnpm exec vp run diff-coverage",
        env: { DIFF_COVERAGE_BASE: "HEAD^1" },
        timeoutMs: 10 * 60 * 1000,
      },
    ],
  },
  veil: {
    name: "veil",
    // Flip-2 config: secret-scan runs the repo's own scan; ci is the full
    // `make ci` gate — needs postgres booted first (PG_TEST_DSN below).
    checksInstallCommand:
      "service postgresql start >/dev/null 2>&1 || " +
      "(pg_ctlcluster 16 main start) && " +
      "su postgres -c 'psql -c \"CREATE DATABASE veil_test;\"' >/dev/null 2>&1; " +
      "pnpm install --frozen-lockfile",
    checks: [
      {
        name: "secret-scan",
        command: "pnpm run scan:secrets",
      },
      {
        name: "ci",
        command: "make ci",
        env: {
          PG_TEST_DSN:
            "postgres://postgres:postgres@localhost:5432/veil_test?sslmode=disable",
        },
        timeoutMs: 20 * 60 * 1000,
      },
    ],
  },
};

const repoNameSchema = z.enum(["seal", "pile", "veil"]);

export function getRepoConfig(repoName: unknown): RepoConfig | undefined {
  const parsed = repoNameSchema.safeParse(repoName);
  if (!parsed.success) {
    return undefined;
  }
  const config = repoConfigs[parsed.data];
  return config ? repoConfigSchema.parse(config) : undefined;
}
