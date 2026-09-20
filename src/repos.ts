import { z } from "zod";

const repoConfigSchema = z.object({
  name: z.string(),
  buildEnv: z.record(z.string()).default({}),
  installEnv: z.record(z.string()).default({}),
  buildCommand: z.string(),
  proofCommand: z.string(),
  // Runs concurrently with proof off the deps snapshot (persist: false —
  // nothing chains off it). Omit to fold tests into proofCommand instead.
  testCommand: z.string().optional(),
  deployCommand: z.string(),
  previewCommand: z.string().optional(),
  d1Database: z.string().optional(),
  d1MigrationsCwd: z.string().default("."),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

const buildCommand = "pnpm exec vp run build:all";

const repoConfigs: Record<string, RepoConfig> = {
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
    },
    installEnv: {
      HOME: "/tmp",
      CI: "true",
    },
    buildCommand,
    proofCommand: `${buildCommand} && pnpm exec vp check`,
    testCommand: "pnpm test",
    deployCommand:
      "(cd apps/anydoc-worker && pnpm exec wrangler deploy -e production) && " +
      "(cd apps/convert-worker && pnpm exec wrangler deploy -e production) && " +
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
    d1Database: "seal-global",
    d1MigrationsCwd: "apps/api",
  },
  pile: {
    name: "pile",
    buildEnv: {},
    installEnv: {
      HOME: "/tmp",
      CI: "true",
    },
    buildCommand: "pnpm exec vp run typecheck",
    // contract:check needs git; GitHub ci.yml owns it. knip is GitHub-only,
    // same split as seal.
    proofCommand: "pnpm exec vp run typecheck && pnpm exec vp check",
    testCommand: "pnpm test",
    deployCommand: "pnpm exec wrangler deploy -e production",
    d1Database: "issuetracker-global",
    d1MigrationsCwd: ".",
  },
};

const repoNameSchema = z.enum(["seal", "pile"]);

export function getRepoConfig(repoName: unknown): RepoConfig | undefined {
  const parsed = repoNameSchema.safeParse(repoName);
  if (!parsed.success) {
    return undefined;
  }
  const config = repoConfigs[parsed.data];
  return config ? repoConfigSchema.parse(config) : undefined;
}
