import {
  CIWorkflow,
  type CiContext,
  type CiParams,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";
import { capturePostHog } from "./posthog";

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

// The runner's waitForExit only arms its timeout after the log stream
// connects — a dead stream (wedged sandbox DO, recycled isolate) leaves the
// process running invisibly inside the container and the step hangs past its
// bound, pinning a pool reservation for hours (the 2026-10-20 wedges). GNU
// timeout inside the container kills the process itself: dead stream or not,
// the step ends when the command does.
const bound = (command: string, timeoutMs: number) =>
  `timeout --signal=KILL --kill-after=30s ${Math.ceil(timeoutMs / 1000)} ` +
  `bash -o pipefail -c '${command.replace(/'/g, "'\\''")}'`;

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
    const started = Date.now();
    const base = {
      repo: String(_event.payload.repo),
      branch: String(_event.payload.branch),
      sha: String(_event.payload.sha ?? ""),
      instanceId: _event.instanceId,
    };
    await capturePostHog(this.env, "ci.run.started", base);
    try {
      await this.pipelineBody(_event, step, ci);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await capturePostHog(this.env, "ci.run.errored", {
        ...base,
        durationMs: Date.now() - started,
        error: message,
        step: /CiRunnerFailure: ([a-z0-9-]+) failed/i.exec(message)?.[1],
      });
      throw err;
    }
    await capturePostHog(this.env, "ci.run.completed", {
      ...base,
      durationMs: Date.now() - started,
    });
  }

  private async pipelineBody(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext
  ): Promise<void> {
    const repo = _event.payload.repo;
    const branch = _event.payload.branch;
    const config = getRepoConfig(repo);

    // Checks-only repos (no build/deploy yet) ride the checks workflow —
    // nothing to ship here. A repo with migrateCommand but no buildCommand
    // still runs its migration on the deps snapshot — automate-first, the
    // deploy path can onboard later.
    if (config && !config.buildCommand && !config.migrateCommand) {
      console.log(`[cloudflare-ci] ${String(repo)} is checks-only — skipping deploy pipeline`);
      return;
    }
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
      stub.claim(
        String(repo),
        branchKey,
        _event.instanceId,
        _event.payload.sha,
        _event.payload
      )
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
      command: bound(`${npmrcCommand} && ${installCommand} && ` + cleanupCommand, DEPS_COMMAND_TIMEOUT_MS),
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
    // dist/ to preview/deploy. Migrate-only repos (no buildCommand) skip
    // straight to the deps snapshot for their migrate step.
    const buildResult = config.buildCommand
      ? await depsResult.runner({
          name: "build",
          command: bound(buildOnlyCommand, BUILD_COMMAND_TIMEOUT_MS),
          secrets: ["NPM_TOKEN", ...config.buildSecrets],
          env: baseEnv,
          config: {
            timeout: BUILD_STEP_TIMEOUT_MS,
            commandTimeoutMs: BUILD_COMMAND_TIMEOUT_MS,
          },
        })
      : depsResult;

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
          command: bound(previewCommand, DEPLOY_COMMAND_TIMEOUT_MS),
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

    if (config.migrateCommand) {
      // Non-D1 migrations (PlanetScale etc.) run on the build snapshot —
      // the migrate tool resolves from node_modules. Migrate-only repos
      // fall back to the deps snapshot.
      await buildResult.runner({
        name: "migrate",
        command: bound(
          `${npmrcCommand} && ${relinkCommand} && ${config.migrateCommand}`,
          MIGRATE_COMMAND_TIMEOUT_MS
        ),
        secrets: ["NPM_TOKEN", ...config.migrateSecrets],
        persist: false,
        cloudflareCredentials: {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        },
        env: baseEnv,
        config: {
          timeout: MIGRATE_STEP_TIMEOUT_MS,
          commandTimeoutMs: MIGRATE_COMMAND_TIMEOUT_MS,
        },
      });
    } else if (config.d1Database) {
      await ci.runner({
        name: "migrate",
        // One wrangler CLI call on a fresh checkout — no restore, no install,
        // no snapshot. Cheapest possible shape on the lite pool.
        // The deploy token (CF_TOKEN) is containers+workers scoped; D1 query
        // perms live on CF_TOKEN_MIGRATE so each secret stays least-privilege.
        sandbox: "SANDBOX_LITE",
        persist: false,
        command: bound(`CLOUDFLARE_API_TOKEN="$CF_TOKEN_MIGRATE" wrangler d1 migrations apply ${config.d1Database} --env production --remote`, MIGRATE_COMMAND_TIMEOUT_MS),
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

    // Staging bake (VTX-584/591): ship the staging env, let it serve, probe
    // it — the prod rollout only starts on a green staging verify. Previews
    // already target this env, so the deploy shape is the preview shape.
    if (config.previewCommand && config.stagingVerifyCommand) {
      const stagingCommand =
        `${npmrcCommand} && ` +
        `${relinkCommand} && ` +
        `${config.previewCommand}`;
      await buildResult.runner({
        name: "staging",
        command: bound(stagingCommand, DEPLOY_COMMAND_TIMEOUT_MS),
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
      await ci.runner({
        name: "staging-verify",
        sandbox: "SANDBOX_LITE",
        persist: false,
        command:
          `sleep ${config.stagingBakeSec} && ` +
          bound(config.stagingVerifyCommand, VERIFY_COMMAND_TIMEOUT_MS),
        secrets: config.verifySecrets,
        cloudflareCredentials: {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        },
        env: baseEnv,
        config: {
          timeout: VERIFY_STEP_TIMEOUT_MS + config.stagingBakeSec * 1000,
          commandTimeoutMs:
            VERIFY_COMMAND_TIMEOUT_MS + config.stagingBakeSec * 1000,
        },
      });
    }

    // Same shape as preview: build's snapshot already carries dist/, so
    // deploy is install + wrangler deploy only. With a rollout configured
    // (VTX-582) the worker ships via versions upload + staged promote —
    // traffic percentages in order — and deployCommand covers only the
    // non-versioned extras.
    const deployCommand =
      `${npmrcCommand} && ` +
      `${relinkCommand} && ` +
      (config.rolloutUploadCommand && config.rolloutPromoteCommand
        ? `VID_OUT=$(${config.rolloutUploadCommand} 2>&1); VID_RC=$?; echo "$VID_OUT"; ` +
          `if [ $VID_RC -ne 0 ] && echo "$VID_OUT" | grep -q "pending Durable Object migration"; then ` +
          `MIG_OUT=$(echo ${JSON.stringify(config.rolloutUploadCommand)} | sed 's/versions upload/deploy/' | sh 2>&1); MRC=$?; ` +
          `echo "$MIG_OUT"; [ $MRC -eq 0 ] || exit 1; ` +
          `VID=$(echo "$MIG_OUT" | grep -oE 'Current Version ID: [0-9a-f-]+' | head -1 | sed 's/.*: //'); ` +
          `else ` +
          `[ $VID_RC -eq 0 ] || exit 1; ` +
          `VID=$(echo "$VID_OUT" | grep -oE 'Worker Version ID: [0-9a-f-]+' | head -1 | sed 's/.*: //'); ` +
          `fi; ` +
          `([ -n "$VID" ] || { echo "no Worker Version ID in deploy output" >&2; exit 1; }) && ` +
          // Rollback is inline, not a workflow step: it only exists past the
          // VID guard, so a failure before any version took traffic can never
          // roll prod back for nothing.
          (config.rollbackCommand
            ? `ROLLBACK(){ ${config.rollbackCommand}; }; `
            : `ROLLBACK(){ :; }; `) +
          // versions deploy needs specs totalling 100% — a lone vid@10%
          // throws "must total exactly 100%". The current version carries
          // the remainder (omitted percentage), so promote in pairs.
          `CUR=$(pnpm exec wrangler deployments list -e production 2>/dev/null | grep -oE '[0-9a-f-]{36}' | grep -vxF "$VID" | head -1); ` +
          `PROMOTE(){ ${config.rolloutPromoteCommand} "$@"; }; ` +
          `if [ -z "$MIG_OUT" ]; then for PCT in ${(config.rolloutSteps ?? [10, 50, 100]).join(" ")}; do ` +
          `if [ -n "$CUR" ] && [ "$PCT" -lt 100 ]; then PROMOTE "$CUR"; else PROMOTE; fi && ` +
          `sleep ${config.rolloutSettleSec} || { ROLLBACK; exit 1; }; done; fi && ` +
          `${config.deployCommand} || { ROLLBACK; exit 1; }`
        : `${config.deployCommand}`);

    // VTX-583: a failed gate (deploy promote, verify, or the post-rollout
    // watch below) runs rollbackCommand instead of leaving the bad deploy
    // serving. A failed rollback is logged but never masks the gate
    // failure that caused it.
    const rollback = async (gate: string): Promise<void> => {
      if (!config.rollbackCommand) return;
      console.error(`[cloudflare-ci] ${gate} failed for ${String(repo)} — rolling back`);
      await ci
        .runner({
          name: "rollback",
          sandbox: "SANDBOX_LITE",
          persist: false,
          command: bound(config.rollbackCommand, MIGRATE_COMMAND_TIMEOUT_MS),
          secrets: ["CF_TOKEN"],
          cloudflareCredentials: {
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          },
          env: baseEnv,
          config: {
            timeout: MIGRATE_STEP_TIMEOUT_MS,
            commandTimeoutMs: MIGRATE_COMMAND_TIMEOUT_MS,
          },
        })
        .catch((rollbackError) => {
          console.error("[cloudflare-ci] rollback failed", rollbackError);
        });
    };

    // Codex: a mid-rollout promote failure would leave the traffic split
    // live — deploy failures roll back the same way verify/watch do.
    try {
      await buildResult.runner({
        name: "deploy",
        command: bound(deployCommand, DEPLOY_COMMAND_TIMEOUT_MS),
        secrets: ["NPM_TOKEN", ...config.deploySecrets],
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
    } catch (deployError) {
      // Rollback is inline in the deploy command — it only exists past the
      // VID guard, so a failure before any version took traffic can never
      // roll prod back for nothing.
      throw deployError;
    }

    // Post-deploy proof, same lite-pool shape as migrate: self-contained
    // command, no workspace restore. A non-zero exit fails the run — a
    // deploy that uploads but does not serve is a failed deploy.
    if (config.verifyCommand) {
      try {
        await ci.runner({
          name: "verify",
          sandbox: "SANDBOX_LITE",
          persist: false,
          command: bound(config.verifyCommand, VERIFY_COMMAND_TIMEOUT_MS),
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
      } catch (verifyError) {
        await rollback("verify");
        throw verifyError;
      }
    }

    // VTX-585: post-rollout error watch — the repo's own probe (error-rate
    // check, SLO query) polls for watchSec; a breach rolls prod back.
    if (config.watchCommand && config.rollbackCommand) {
      try {
        await ci.runner({
          name: "watch",
          sandbox: "SANDBOX_LITE",
          persist: false,
          command: bound(
            `END=$((SECONDS + ${config.watchSec})); ` +
              `while [ $SECONDS -lt $END ]; do ` +
              `${config.watchCommand} || exit 1; ` +
              `sleep ${config.watchIntervalSec}; done`,
            config.watchSec * 1000 + VERIFY_COMMAND_TIMEOUT_MS
          ),
          secrets: config.verifySecrets,
          cloudflareCredentials: {
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          },
          env: baseEnv,
          config: {
            timeout: (config.watchSec + 2 * 60) * 1000,
            commandTimeoutMs: config.watchSec * 1000 + 30_000,
          },
        });
      } catch (watchError) {
        await rollback("watch");
        throw watchError;
      }
    }
    await withScheduler("dedupe-complete", async (stub) => {
      await stub.completeClaim(String(repo), branchKey, _event.instanceId);
      return null;
    });
  }
}
