import type { CiBindings, CiSandbox } from "@cloudflare/ci/worker";
import type { ChecksSandbox } from "./checks-sandbox";
import type { CiScheduler } from "./scheduler";

export type Bindings = CiBindings & {
  NPM_TOKEN: string;
  // D1-scoped token for the migrate step; CF_TOKEN stays workers+containers.
  CF_TOKEN_MIGRATE?: string;
  // Seal sourcemap upload (apps/web vite closeBundle → posthog-cli).
  POSTHOG_CLI_API_KEY?: string;
  ADMIN_TOKEN?: string;
  SANDBOX_LITE: DurableObjectNamespace<CiSandbox>;
  CI_SCHEDULER: DurableObjectNamespace<CiScheduler>;
  // sandbox-sdk 1.0 checks pool — each named DO owns its container.
  CHECKS_SANDBOX: DurableObjectNamespace<ChecksSandbox>;
  // Checks-in-pipeline — the workflow that runs repo checks in the lite
  // pool and reports them back to GitHub via the Checks API.
  CHECKS_WORKFLOW: Workflow;
  // GitHub-side auth for the checks path. CHECKS_GITHUB_TOKEN mints
  // check-runs + reads PRs; GITHUB_WEBHOOK_SECRET verifies inbound
  // webhook signatures.
  CHECKS_GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // GitHub App creds — installation tokens mint check-runs (OAuth user
  // tokens can't call the Checks API).
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Failure self-report — errored claims file a Pile issue. Optional. */
  PILE_BASE_URL?: string;
  PILE_API_KEY?: string;
  PILE_WORKSPACE?: string;
};
