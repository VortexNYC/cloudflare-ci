import type { CiBindings, CiSandbox } from "@cloudflare/ci/worker";
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
};
