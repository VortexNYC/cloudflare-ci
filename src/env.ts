import type { CiBindings, CiSandbox } from "@cloudflare/ci/worker";

export type Bindings = CiBindings & {
  NPM_TOKEN: string;
  ADMIN_TOKEN?: string;
  SANDBOX_LITE: DurableObjectNamespace<CiSandbox>;
};
