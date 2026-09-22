import type { CiBindings, CiSandbox } from "@cloudflare/ci/worker";
import type { CiScheduler } from "./scheduler";

export type Bindings = CiBindings & {
  NPM_TOKEN: string;
  ADMIN_TOKEN?: string;
  SANDBOX_LITE: DurableObjectNamespace<CiSandbox>;
  CI_SCHEDULER: DurableObjectNamespace<CiScheduler>;
};
