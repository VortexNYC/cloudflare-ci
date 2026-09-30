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
// Step timeouts must cover command + the end-of-step snapshot upload, which
// streams ~1GB through the sandbox DO. Terminal steps set persist: false and
// skip that upload, so their step timeout is just the command plus margin.
const BUILD_STEP_TIMEOUT_MS = 30 * MINUTE;
const BUILD_COMMAND_TIMEOUT_MS = 25 * MINUTE;
const DEPS_STEP_TIMEOUT_MS = 15 * MINUTE;
const DEPS_COMMAND_TIMEOUT_MS = 10 * MINUTE;
const MIGRATE_STEP_TIMEOUT_MS = 10 * MINUTE;
const MIGRATE_COMMAND_TIMEOUT_MS = 3 * MINUTE;
const DEPLOY_STEP_TIMEOUT_MS = 28 * MINUTE;
const DEPLOY_COMMAND_TIMEOUT_MS = 25 * MINUTE;
// Verify probes are curl-level on the lite pool — a hung endpoint must fail
// fast, not hold the run open.
const VERIFY_STEP_TIMEOUT_MS = 6 * MINUTE;
const VERIFY_COMMAND_TIMEOUT_MS = 5 * MINUTE;

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

// pnpm>=12 re-verifies every lockfile entry against the registry on install
// (~2.3k packument fetches for seal — minutes of registry stalls per step).
// deps runs the real verification; every downstream install re-checks the
// identical lockfile, so relink with trustLockfile instead.
const relinkCommand = `${installCommand} --config.trustLockfile=true`;

// node_modules is pruned (relinked from the in-workspace store on restore);
// dist is KEPT so preview/deploy never rebuild — they just wrangler-upload.
// Deps keeps .pnpm-store in its snapshot (that's what downstream installs
// relink from); build keeps it too — restores download the archive over
// HTTP straight to the container, so a ~1GB store no longer OOMs the DO,
// and preview/deploy relink warm instead of cold-installing on lite.
const cleanupCommand =
  'find . -type d \\( -name node_modules -o -name .cache -o -name .wrangler \\) -prune -exec rm -rf {} + 2>/dev/null';
// Build's snapshot additionally preserves .wrangler/deploy: vite/astro
// builds write a redirect there that points wrangler at the generated
// dist config — without it terminal steps bundle src/ and crash on
// framework virtual modules (virtual:emdash/*, astro:content).
const buildCleanupCommand =
  'find . -type d \\( -name node_modules -o -name .cache \\) -prune -exec rm -rf {} + 2>/dev/null && ' +
  "find . -path '*/.wrangler/*' ! -path '*/.wrangler/deploy*' -delete 2>/dev/null";

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const repo = _event.payload.repo;
    const branch = _event.payload.branch;
    const config = getRepoConfig(repo);

    if (!config) {
      console.log(`[cloudflare-ci] skipping unsupported repo: ${String(repo)}`);
      return;
    }

    // Platform push events can fan out duplicate workflow instances for one
    // push — each one would spawn its own billable containers. Keep only the
    // newest run per repo+branch: the scheduler DO serializes claims, so the
    // last claim wins atomically and losers exit before spending a
    // container-minute. Re-checked between steps so a newer push also stops
    // a stale run already past the gate.
    // Scheduler calls in the workflow body must ride step.do: a bare RPC that
    // lands while the DO's isolate is being recycled fails with "this Durable
    // Object instance is no longer active" and — outside a step — kills the
    // whole run on the spot. As named steps they retry like the runners do and
    // their verdict is persisted, so hibernation/replay stays consistent.
    // A fresh stub per attempt reconnects instead of reusing the dead session.
    const scheduler = () =>
      this.env.CI_SCHEDULER.get(this.env.CI_SCHEDULER.idFromName("global"));
    const withScheduler = <T extends Rpc.Serializable<T>>(
      name: string,
      fn: (stub: ReturnType<typeof scheduler>) => Promise<T>
    ): Promise<T> =>
      step.do(
        name,
        {
          retries: { limit: 5, delay: 5_000, backoff: "linear" },
          timeout: 60_000,
        },
        () => fn(scheduler())
      );
    const branchKey = String(branch ?? _event.payload.sha ?? "detached");
    const supersededBy = (name: string): Promise<string | null> =>
      withScheduler(name, async (stub) => {
        const claim = await stub.getClaim(String(repo), branchKey);
        return claim && claim.instanceId !== _event.instanceId
          ? claim.instanceId
          : null;
      });
    const claimed = await withScheduler("dedupe-claim", (stub) =>
      stub.claim(String(repo), branchKey, _event.instanceId, _event.payload.sha)
    );
    if (!claimed) {
      console.log(
        `[cloudflare-ci] ${String(repo)}@${branchKey} ${_event.payload.sha} already completed — duplicate event, exiting`
      );
      return;
    }
    // Duplicate events fan out over seconds — let a tight burst settle so a
    // slightly-later claim can supersede before we spawn anything.
    await step.sleep("dedupe-settle", 2_000);
    let winner = await supersededBy("dedupe-check");
    if (winner) {
      console.log(
        `[cloudflare-ci] superseded by ${winner} for ${String(repo)}@${branchKey} — exiting before any container spawn`
      );
      return;
    }

    const baseEnv = {
      ...config.installEnv,
      ...config.buildEnv,
    };

    const buildOnlyCommand =
      `${npmrcCommand} && ` +
      `${relinkCommand} && ` +
      `${config.buildCommand} && ` +
      buildCleanupCommand;

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

    // CI exists to produce and ship deployable artifacts — everything that
    // can gate locally (check/test via pre-push hooks) stays out of billable
    // containers. build is the only persisted step: its snapshot carries
    // dist/ to preview/deploy.
    const buildResult = await depsResult.runner({
      name: "build",
      command: buildOnlyCommand,
      secrets: ["NPM_TOKEN", ...config.buildSecrets],
      env: baseEnv,
      config: {
        timeout: BUILD_STEP_TIMEOUT_MS,
        commandTimeoutMs: BUILD_COMMAND_TIMEOUT_MS,
      },
    });

    winner = await supersededBy("dedupe-recheck");
    if (winner) {
      console.log(`[cloudflare-ci] superseded by ${winner} after build — skipping terminal steps`);
      return;
    }

    if (branch !== "main") {
      if (config.previewCommand) {
        // Stable per-branch preview alias, e.g. fix-foo-seal-web.<sub>.workers.dev.
        const previewAlias = (branch ?? "preview")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40);
        const previewEnv = { ...baseEnv, CI_PREVIEW_ALIAS: previewAlias };

        // dist/ + .pnpm-store ride build's snapshot, so preview is warm
        // relink + wrangler versions upload. Standard pool — the lite tier's
        // disk can't hold the ~1GB archive plus its extraction.
        const previewCommand =
          `${npmrcCommand} && ` +
          `${relinkCommand} && ` +
          `${config.previewCommand}`;

        await buildResult.runner({
          name: "preview",
          command: previewCommand,
          secrets: ["NPM_TOKEN"],
          persist: false,
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
      await withScheduler("dedupe-complete", async (stub) => {
        await stub.completeClaim(String(repo), branchKey, _event.instanceId);
        return null;
      });
      return;
    }

    if (config.d1Database) {
      await ci.runner({
        name: "migrate",
        // One wrangler CLI call on a fresh checkout — no restore, no install,
        // no snapshot. Cheapest possible shape on the lite pool.
        // The deploy token (CF_TOKEN) is containers+workers scoped; D1 query
        // perms live on CF_TOKEN_MIGRATE so each secret stays least-privilege.
        sandbox: "SANDBOX_LITE",
        persist: false,
        command: `CLOUDFLARE_API_TOKEN="$CF_TOKEN_MIGRATE" wrangler d1 migrations apply ${config.d1Database} --env production --remote`,
        cwd: config.d1MigrationsCwd,
        secrets: ["CF_TOKEN_MIGRATE"],
        cloudflareCredentials: {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        },
        env: baseEnv,
        config: {
          timeout: MIGRATE_STEP_TIMEOUT_MS,
          commandTimeoutMs: MIGRATE_COMMAND_TIMEOUT_MS,
        },
      });
    }

    // Same shape as preview: build's snapshot already carries dist/, so
    // deploy is install + wrangler deploy only.
    const deployCommand =
      `${npmrcCommand} && ` +
      `${relinkCommand} && ` +
      `${config.deployCommand}`;

    await buildResult.runner({
      name: "deploy",
      command: deployCommand,
      secrets: ["NPM_TOKEN"],
      persist: false,
      cloudflareCredentials: {
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      },
      env: baseEnv,
      config: {
        timeout: DEPLOY_STEP_TIMEOUT_MS,
        commandTimeoutMs: DEPLOY_COMMAND_TIMEOUT_MS,
      },
    });

    // Post-deploy proof, same lite-pool shape as migrate: self-contained
    // command, no workspace restore. A non-zero exit fails the run — a
    // deploy that uploads but does not serve is a failed deploy.
    if (config.verifyCommand) {
      await ci.runner({
        name: "verify",
        sandbox: "SANDBOX_LITE",
        persist: false,
        command: config.verifyCommand,
        secrets: config.verifySecrets,
        cloudflareCredentials: {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        },
        env: { ...baseEnv, ...config.verifyEnv },
        config: {
          timeout: VERIFY_STEP_TIMEOUT_MS,
          commandTimeoutMs: VERIFY_COMMAND_TIMEOUT_MS,
        },
      });
    }
    await withScheduler("dedupe-complete", async (stub) => {
      await stub.completeClaim(String(repo), branchKey, _event.instanceId);
      return null;
    });
  }
}
