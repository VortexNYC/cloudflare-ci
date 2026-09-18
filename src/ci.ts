import {
  CIWorkflow,
  type CiContext,
  type CiParams,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";

const MINUTE = 60 * 1000;

// Workflow steps must stay within Cloudflare's 30-minute ceiling and still
// leave the sandbox time to snapshot /workspace before the step timeout fires.
// Source: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
const PROOF_STEP_TIMEOUT_MS = 25 * MINUTE;
const PROOF_COMMAND_TIMEOUT_MS = 20 * MINUTE;
const DEPS_STEP_TIMEOUT_MS = 10 * MINUTE;
const DEPS_COMMAND_TIMEOUT_MS = 8 * MINUTE;
const MIGRATE_STEP_TIMEOUT_MS = 10 * MINUTE;
const MIGRATE_COMMAND_TIMEOUT_MS = 3 * MINUTE;
const DEPLOY_STEP_TIMEOUT_MS = 30 * MINUTE;
const DEPLOY_COMMAND_TIMEOUT_MS = 25 * MINUTE;

// The sandbox runs every command as a wrapped subshell, so we only need the
// shell string itself. We deliberately keep the workspace free of node_modules
// and build artifacts before the snapshot is taken, otherwise each backup
// becomes a multi-gigabyte squashfs upload that exhausts the step margin and
// triggers RPCTransportError / internal Workflow failures.
const npmrcCommand =
  '{ cp .npmrc ~/.npmrc 2>/dev/null || printf "@vortexnyc:registry=https://npm.pkg.github.com\\n" > ~/.npmrc; } && ' +
  'printf "//npm.pkg.github.com/:_authToken=%s\\n" "$NPM_TOKEN" >> ~/.npmrc';

// pnpm does not honor store-dir in the user-level ~/.npmrc, so it goes on the
// command line. Keeping the store inside /workspace means it survives the
// cleanup + snapshot while node_modules is pruned: later installs on a
// restored workspace relink instead of re-downloading the dependency graph.
const installCommand =
  "pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store";

const cleanupCommand =
  'find . -type d \\( -name node_modules -o -name dist -o -name .cache -o -name .wrangler \\) -prune -exec rm -rf {} + 2>/dev/null';

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const repo = _event.payload.repo;
    const branch = _event.payload.branch;
    const config = getRepoConfig(repo);

    if (!config) {
      console.log(`[vortex-ci] skipping unsupported repo: ${String(repo)}`);
      return;
    }

    const baseEnv = {
      ...config.installEnv,
      ...config.buildEnv,
    };

    const proofCommand =
      `${npmrcCommand} && ` +
      `${installCommand} && ` +
      `${config.proofCommand} && ` +
      cleanupCommand;

    // Dependency install isolated as its own step so the snapshot cache can
    // reuse it: key is the lockfile/workspace manifests, so an unchanged
    // dependency set skips the step entirely (no container spawn) and hands
    // downstream steps a workspace whose .pnpm-store already covers install.
    const depsResult = await ci.runner({
      name: "deps",
      command: `${npmrcCommand} && ${installCommand} && ` + cleanupCommand,
      secrets: ["NPM_TOKEN"],
      env: config.installEnv,
      cache: {
        inputs: ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"],
      },
      config: {
        timeout: DEPS_STEP_TIMEOUT_MS,
        commandTimeoutMs: DEPS_COMMAND_TIMEOUT_MS,
      },
    });

    const proofResult = await depsResult.runner({
      name: "proof",
      command: proofCommand,
      secrets: ["NPM_TOKEN"],
      env: baseEnv,
      config: {
        timeout: PROOF_STEP_TIMEOUT_MS,
        commandTimeoutMs: PROOF_COMMAND_TIMEOUT_MS,
      },
    });

    if (branch !== "main") {
      if (config.previewCommand) {
        // Stable per-branch preview alias, e.g. fix-foo-seal-web.<sub>.workers.dev.
        const previewAlias = (branch ?? "preview")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40);
        const previewEnv = { ...baseEnv, CI_PREVIEW_ALIAS: previewAlias };

        const previewCommand =
          `${npmrcCommand} && ` +
          `${installCommand} && ` +
          `${config.buildCommand} && ` +
          `${config.previewCommand} && ` +
          cleanupCommand;

        await proofResult.runner({
          name: "preview",
          command: previewCommand,
          secrets: ["NPM_TOKEN"],
          cloudflareCredentials: {
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          },
          env: previewEnv,
          config: {
            timeout: DEPLOY_STEP_TIMEOUT_MS,
            commandTimeoutMs: DEPLOY_COMMAND_TIMEOUT_MS,
          },
        });
      }
      return;
    }

    let deployInput = proofResult;

    if (config.d1Database) {
      const migrateResult = await proofResult.runner({
        name: "migrate",
        // Runs a single wrangler CLI call — no install or build — so it goes
        // on the quarter-vCPU lite pool instead of the standard sandbox.
        sandbox: "SANDBOX_LITE",
        command: `wrangler d1 migrations apply ${config.d1Database} --env production --remote`,
        cwd: config.d1MigrationsCwd,
        cloudflareCredentials: {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        },
        env: baseEnv,
        config: {
          timeout: MIGRATE_STEP_TIMEOUT_MS,
          commandTimeoutMs: MIGRATE_COMMAND_TIMEOUT_MS,
        },
      });
      deployInput = migrateResult;
    }

    const deployCommand =
      `${npmrcCommand} && ` +
      `${installCommand} && ` +
      `${config.buildCommand} && ` +
      `${config.deployCommand} && ` +
      cleanupCommand;

    await deployInput.runner({
      name: "deploy",
      command: deployCommand,
      secrets: ["NPM_TOKEN"],
      cloudflareCredentials: {
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      },
      env: baseEnv,
      config: {
        timeout: DEPLOY_STEP_TIMEOUT_MS,
        commandTimeoutMs: DEPLOY_COMMAND_TIMEOUT_MS,
      },
    });
  }
}
