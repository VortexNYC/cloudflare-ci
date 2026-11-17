import type { CiBindings, CiSandbox } from "@cloudflare/ci/worker";
import type { ChecksSandbox } from "./checks-sandbox";
import type { CiScheduler } from "./scheduler";

export type Bindings = CiBindings & {
  CI_METRICS?: AnalyticsEngineDataset;
  NPM_TOKEN: string;
  // D1-scoped token for the migrate step; CF_TOKEN stays workers+containers.
  CF_TOKEN_MIGRATE?: string;
  // Seal sourcemap upload (apps/web vite closeBundle → posthog-cli).
  POSTHOG_CLI_API_KEY?: string;
  // Engineering signal connector — pipeline events land in PostHog.
  POSTHOG_CI_API_KEY?: string;
  POSTHOG_CI_HOST?: string;
  // Non-secret PlanetScale lane coordinates — scheduled branch/backup jobs
  // interpolate these into repo commands; secrets stay in `secrets`.
  PLANETSCALE_ORG?: string;
  PLANETSCALE_DATABASE?: string;
  PLANETSCALE_BASE_BRANCH?: string;
  // Scheduled ops secrets — named here so reviewers see the fail-closed set;
  // values are injected per-check by resolveCheckSecrets, never logged.
  DATABASE_URL?: string;
  PLANETSCALE_SERVICE_TOKEN_ID?: string;
  PLANETSCALE_SERVICE_TOKEN?: string;
  VORTEX_OPS_ALERT_WEBHOOK_URL?: string;
  ADMIN_TOKEN?: string;
  SANDBOX_LITE: DurableObjectNamespace<CiSandbox>;
  SANDBOX_HEAVY: DurableObjectNamespace<CiSandbox>;
  CI_SCHEDULER: DurableObjectNamespace<CiScheduler>;
  // sandbox-sdk 1.0 checks pool — each named DO owns its container.
  CHECKS_SANDBOX: DurableObjectNamespace<ChecksSandbox>;
  // Checks-in-pipeline — the workflow that runs repo checks in the lite
  // pool and reports them back to GitHub via the Checks API.
  CHECKS_WORKFLOW: Workflow;
  // push→Artifacts mirror (replaces artifacts-sync.yml): clones the pushed
  // branch and force-pushes it, firing cf.artifacts.repo.pushed downstream.
  MIRROR_WORKFLOW: Workflow;
  CANARY_WORKFLOW: Workflow;
  RELEASE_WORKFLOW: Workflow;
  // Artifacts token minting + remote URL. ARTIFACTS_API_TOKEN is the
  // Artifacts:Write-scoped CF API token (repo tokens minted per-push are
  // TTL'd — a stored push token expires silently).
  ARTIFACTS_ACCOUNT_ID?: string;
  ARTIFACTS_API_TOKEN?: string;
  /** Long-TTL repo-scoped push token — used directly when set; otherwise the
   *  mirror mints a 15-min token per push via ARTIFACTS_API_TOKEN. */
  ARTIFACTS_PUSH_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_TOKEN?: string;
  // VOR-275 — worker-money-paths-regression (vortex): injected into that
  // check's isolated sandbox by name. CLOUDFLARE_CI_BASE_URL is the
  // workers.dev origin of vortex-payments-ci (its hostname label is what
  // the per-PR preview-alias substitution anchors on).
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_CI_BASE_URL?: string;
  FINIX_SANDBOX_USERNAME?: string;
  FINIX_SANDBOX_PASSWORD?: string;
  // Optional smoke seeds — the repo's provisioner self-heals when absent.
  VORTEX_SMOKE_API_KEY?: string;
  VORTEX_SMOKE_CUSTOMER_ID?: string;
  VORTEX_SMOKE_PAYMENT_METHOD_ID?: string;
  FINIX_SMOKE_MERCHANT_ID?: string;
  FINIX_SMOKE_PAYMENT_INSTRUMENT_ID?: string;
  // GitHub-side auth for the checks path. CHECKS_GITHUB_TOKEN mints
  // check-runs + reads PRs; GITHUB_WEBHOOK_SECRET verifies inbound
  // webhook signatures.
  CHECKS_GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // GitHub App creds — installation tokens mint check-runs (OAuth user
  // tokens can't call the Checks API).
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Failure self-report — errored claims file a Pile issue and send a native Cloudflare email alert. */
  PILE_BASE_URL?: string;
  PILE_API_KEY?: string;
  PILE_WORKSPACE?: string;
  EMAIL?: { send(msg: unknown): Promise<void> };
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  CI_PUBLIC_URL?: string;
  // VOR-321 — Linear webhook relay (POST /webhook/linear). Linear can't send
  // custom headers, so this worker verifies Linear-Signature and forwards to
  // the Cursor automation endpoint with the bearer key. All three are
  // secrets (the URL path is the routine's address).
  LINEAR_WEBHOOK_SECRET?: string;
  CURSOR_AUTOMATION_URL?: string;
  CURSOR_AUTOMATION_KEY?: string;
};

/**
 * Fail-loud contract for the Linear relay, scoped to its route: a missing
 * value 503s /webhook/linear with the missing names instead of taking the
 * whole CI worker down via the global validateEnv.
 */
export function missingLinearRelayEnv(env: Bindings): string[] {
  const missing: string[] = [];
  if (!env.LINEAR_WEBHOOK_SECRET) missing.push("LINEAR_WEBHOOK_SECRET");
  if (!env.CURSOR_AUTOMATION_KEY) missing.push("CURSOR_AUTOMATION_KEY");
  if (!env.CURSOR_AUTOMATION_URL) missing.push("CURSOR_AUTOMATION_URL");
  else if (!/^https:\/\//.test(env.CURSOR_AUTOMATION_URL))
    missing.push("CURSOR_AUTOMATION_URL (must be https)");
  return missing;
}
