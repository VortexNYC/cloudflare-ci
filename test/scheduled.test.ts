import { test } from "node:test";
import assert from "node:assert/strict";
import { getScheduledJobsForCron } from "../src/repos.ts";
import {
  isWorkflowAlreadyExists,
  notConfiguredAlertKey,
  scheduledScopeFor,
  scheduledWorkflowId,
} from "../src/scheduled.ts";
import {
  ChecksWorkflow,
  resolveCheckSecrets,
} from "../src/checks-workflow.ts";

function vortexJob(checkNames: string[]) {
  return { repo: "VortexNYC/vortex", checkNames };
}

test("getScheduledJobsForCron groups vortex scheduled checks by cron", () => {
  const daily = getScheduledJobsForCron("0 6 * * *").find(
    (job) => job.repo === "VortexNYC/vortex"
  );
  assert.deepEqual(daily?.checkNames, ["planetscale-branch-tests"]);

  const weekly = getScheduledJobsForCron("0 9 * * 1").find(
    (job) => job.repo === "VortexNYC/vortex"
  );
  assert.deepEqual(weekly?.checkNames, [
    "production-readiness",
    "production-readiness-prc",
  ]);

  const drift = getScheduledJobsForCron("7 * * * *").find(
    (job) => job.repo === "VortexNYC/vortex"
  );
  assert.deepEqual(drift?.checkNames, ["money-path-drift"]);

  assert.equal(getScheduledJobsForCron("0 0 31 2 *").length, 0);
});

test("scheduledScopeFor is deterministic per cron tick and sanitizes names", () => {
  const job = vortexJob(["planetscale-branch-tests"]);
  const first = scheduledScopeFor(job, 1763335200000);
  assert.equal(first, scheduledScopeFor(job, 1763335200000));
  assert.notEqual(first, scheduledScopeFor(job, 1763335201000));
  assert.match(first, /^scheduled-1763335200000-vortexnyc-vortex-/);
  assert.equal(scheduledWorkflowId(first), first);
});

test("isWorkflowAlreadyExists treats duplicate dispatch as success", () => {
  assert.equal(
    isWorkflowAlreadyExists(new Error("Workflow instance already exists")),
    true
  );
  assert.equal(isWorkflowAlreadyExists("instance already_exists"), true);
  assert.equal(isWorkflowAlreadyExists(new Error("capacity")), false);
});

test("notConfiguredAlertKey is stable per repo + missing secret set", () => {
  assert.equal(
    notConfiguredAlertKey("VortexNYC/vortex", ["PLANETSCALE_SERVICE_TOKEN", "DATABASE_URL"]),
    notConfiguredAlertKey("VortexNYC/vortex", ["DATABASE_URL", "PLANETSCALE_SERVICE_TOKEN"])
  );
  assert.match(
    notConfiguredAlertKey("VortexNYC/vortex", ["DATABASE_URL"]),
    /scheduled-not-configured\/vortexnyc-vortex\/database-url$/
  );
});

test("resolveCheckSecrets fails closed on required secrets and keeps optional out when unset", () => {
  const env = {
    DATABASE_URL: "postgres://example",
    PLANETSCALE_SERVICE_TOKEN: "token",
    VORTEX_OPS_ALERT_WEBHOOK_URL: "https://hooks.example/ops",
  } as never;
  const resolved = resolveCheckSecrets(env, [
    {
      secrets: ["DATABASE_URL", "PLANETSCALE_SERVICE_TOKEN", "MISSING_REQUIRED"],
      optionalSecrets: ["MISSING_OPTIONAL", "VORTEX_OPS_ALERT_WEBHOOK_URL"],
    },
  ]);
  assert.deepEqual(resolved.missing, ["MISSING_REQUIRED"]);
  assert.equal(resolved.values.DATABASE_URL, "postgres://example");
  assert.equal(resolved.values.PLANETSCALE_SERVICE_TOKEN, "token");
  assert.equal(
    resolved.values.VORTEX_OPS_ALERT_WEBHOOK_URL,
    "https://hooks.example/ops"
  );
  assert.equal(resolved.values.MISSING_OPTIONAL, undefined);
});

function makeStep() {
  const names: string[] = [];
  const results = new Map<string, unknown>();
  const step = {
    async do(...args: unknown[]) {
      const name = String(args[0]);
      names.push(name);
      const fn = args[args.length - 1] as () => Promise<unknown>;
      const result = await fn();
      results.set(name, result);
      return result;
    },
  };
  return { step, names, results };
}

function makeScheduledEnv(input: {
  stdout: string;
  scheduler: Record<string, unknown>;
}) {
  const sandboxNames: string[] = [];
  const runCheckCalls: unknown[] = [];
  const sandbox = {
    runCheck: async (opts: unknown) => {
      runCheckCalls.push(opts);
      return { exitCode: 0, stdout: input.stdout, stderr: "" };
    },
    destroy: async () => {},
  };
  const env = {
    CHECKS_GITHUB_TOKEN: "github-token",
    CI_SCHEDULER: {
      idFromName: () => "global",
      get: () => input.scheduler,
    },
    CHECKS_SANDBOX: {
      getByName: (name: string) => {
        sandboxNames.push(name);
        return sandbox;
      },
    },
  } as never;
  return { env, sandboxNames, runCheckCalls };
}

function makeSchedulerStub() {
  const calls = {
    track: [] as unknown[],
    admit: [] as Array<{ name?: string }>,
    release: [] as string[],
    complete: [] as unknown[][],
    alertDue: [] as Array<{ key: string; windowMs: number }>,
  };
  const stub = {
    trackAuxWorkflow: async (input: unknown) => {
      calls.track.push(input);
    },
    admit: async (input: { name?: string }) => {
      calls.admit.push(input);
      return { ok: true };
    },
    release: async (name: string) => {
      calls.release.push(name);
    },
    completeAuxWorkflow: async (...args: unknown[]) => {
      calls.complete.push(args);
    },
    alertDue: async (key: string, windowMs: number) => {
      calls.alertDue.push({ key, windowMs });
      return true;
    },
    getCheckClaim: async () => null,
  };
  return { stub, calls };
}

function passingRunOutput(checkName: string): string {
  return [
    "===CI:CHECKOUT:RC=0===",
    "===CI:INSTALL:RC=0===",
    `===CHECK:${checkName}:START===`,
    "ok",
    `===CHECK:${checkName}:RC=0===`,
  ].join("\n");
}

test("scheduled runs skip GitHub check-runs and scope sandbox names by scheduledKey", async () => {
  const scheduler = makeSchedulerStub();
  const { env, sandboxNames } = makeScheduledEnv({
    stdout: passingRunOutput("synthetic-monitor"),
    scheduler: scheduler.stub,
  });
  const { step, names, results } = makeStep();
  const scheduledKey = "scheduled-1763335200000-vortexnyc-vortex-synthetic-monitor";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("scheduled checks must not call the GitHub API");
  };
  try {
    const workflow = new ChecksWorkflow({}, env);
    await workflow.run(
      {
        payload: {
          repo: "VortexNYC/vortex",
          sha: "abcdef1234567890",
          scheduled: true,
          scheduledKey,
          checkNames: ["synthetic-monitor"],
        },
        instanceId: "wf-scheduled-1",
        timestamp: new Date("2026-11-17T00:00:00Z"),
      } as never,
      step as never
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(results.get("create-check-runs"), {});
  assert.equal(names.some((name) => name.startsWith("report-")), false);
  assert.equal(sandboxNames.length, 1);
  assert.ok(sandboxNames[0]!.includes(scheduledKey));
  assert.ok(scheduler.calls.admit.some((call) => call.name === sandboxNames[0]));
  assert.ok(scheduler.calls.release.includes(sandboxNames[0]!));
  assert.equal(
    (scheduler.calls.track[0] as { scope?: string }).scope,
    scheduledKey
  );
  assert.equal(
    (scheduler.calls.complete[0] as unknown[])[5],
    scheduledKey
  );
});

test("scheduled checks missing required secrets report not-configured and skip check-runs", async () => {
  const scheduler = makeSchedulerStub();
  const { env, sandboxNames } = makeScheduledEnv({
    stdout: "",
    scheduler: scheduler.stub,
  });
  const { step, names, results } = makeStep();
  const scheduledKey = "scheduled-1763335200000-vortexnyc-vortex-money-path-drift";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("not-configured scheduled checks must not call the GitHub API");
  };
  try {
    const workflow = new ChecksWorkflow({}, env);
    await workflow.run(
      {
        payload: {
          repo: "VortexNYC/vortex",
          sha: "abcdef1234567890",
          scheduled: true,
          scheduledKey,
          checkNames: ["money-path-drift"],
        },
        instanceId: "wf-scheduled-2",
        timestamp: new Date("2026-11-17T00:07:00Z"),
      } as never,
      step as never
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(results.get("not-configured-alert"), true);
  assert.equal(names.includes("create-check-runs"), false);
  assert.equal(names.includes("track-aux-wf"), false);
  assert.equal(sandboxNames.length, 0);
  assert.deepEqual(scheduler.calls.alertDue, [
    {
      key: "scheduled-not-configured/vortexnyc-vortex/database-url",
      windowMs: Number.MAX_SAFE_INTEGER,
    },
  ]);
});
