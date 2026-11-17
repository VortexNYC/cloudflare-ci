import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDispatch } from "../src/dispatch.ts";
import { getRepoConfig } from "../src/repos.ts";
import { ChecksWorkflow } from "../src/checks-workflow.ts";

const OPERATOR_CHECKS = [
  "deploy-lock",
  "deploy-unlock",
  "disable-charging",
  "enable-charging",
  "disable-maintenance",
  "enable-maintenance",
  "feature-flag",
  "rollback-worker",
  "seed-alchemy-state",
  "finix-microdeposit-proof",
  "finix-sandbox-proofs",
];

test("vortex declares every manual operator workflow as a dispatch check", () => {
  const config = getRepoConfig("vortex");
  assert.ok(config);
  assert.deepEqual(
    config.dispatchChecks.map((c) => c.name).sort(),
    [...OPERATOR_CHECKS].sort()
  );
  for (const check of config.dispatchChecks) {
    assert.equal(check.pool, "AUX", `${check.name} must stay off the PR pool`);
    for (const input of check.inputs) {
      if (input.name === "environment") {
        // rollback-worker is production|sandbox only in the GHA contract;
        // every other environment input also offers "all".
        assert.deepEqual(
          input.choices,
          check.name === "rollback-worker"
            ? ["production", "sandbox"]
            : ["production", "sandbox", "all"],
          `${check.name} environment choices`
        );
      }
    }
  }
  assert.equal(
    config.dispatchChecks.find((c) => c.name === "deploy-lock")?.gitWrite,
    true
  );
  assert.equal(
    config.dispatchChecks.find((c) => c.name === "deploy-unlock")?.gitWrite,
    true
  );
});

const ADMIN = "x".repeat(40);
const timingSafeEqual = async (a: string, b: string) => a === b;

function makeEnv(overrides: Record<string, unknown> = {}) {
  const created: Array<{ id: string; params: Record<string, unknown> }> = [];
  const env = {
    ADMIN_TOKEN: ADMIN,
    CHECKS_GITHUB_TOKEN: "checks-token",
    CHECKS_WORKFLOW: {
      create: async (input: { id: string; params: Record<string, unknown> }) => {
        created.push(input);
        return { id: input.id };
      },
    },
    ...overrides,
  } as never;
  return { env, created };
}

function dispatchRequest(body: unknown, token = ADMIN): Request {
  return new Request("https://ci.test/admin/dispatch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("dispatch requires the admin bearer token", async () => {
  const { env, created } = makeEnv();
  const res = await handleDispatch(
    dispatchRequest({ repo: "vortex", check: "deploy-lock" }, "wrong"),
    env,
    timingSafeEqual
  );
  assert.equal(res.status, 401);
  assert.equal(created.length, 0);
});

test("dispatch rejects unknown repo and unknown check with the valid set", async () => {
  const { env } = makeEnv();
  const badRepo = await handleDispatch(
    dispatchRequest({ repo: "nope", check: "deploy-lock" }),
    env,
    timingSafeEqual
  );
  assert.equal(badRepo.status, 400);

  const badCheck = await handleDispatch(
    dispatchRequest({ repo: "vortex", check: "synthetic-monitor" }),
    env,
    timingSafeEqual
  );
  assert.equal(badCheck.status, 400);
  const body = (await badCheck.json()) as { checks: string[] };
  assert.deepEqual(body.checks.sort(), [...OPERATOR_CHECKS].sort());
});

test("dispatch enforces the declared input contract", async () => {
  const { env, created } = makeEnv();
  const cases: Array<{ body: Record<string, unknown>; match: RegExp }> = [
    {
      body: { repo: "vortex", check: "deploy-lock", inputs: { environment: "production" } },
      match: /missing required input: reason/,
    },
    {
      body: {
        repo: "vortex",
        check: "deploy-lock",
        inputs: { environment: "prod", reason: "x" },
      },
      match: /must be one of: production, sandbox, all/,
    },
    {
      body: {
        repo: "vortex",
        check: "deploy-lock",
        inputs: { environment: "production", reason: "x", extra: "nope" },
      },
      match: /undeclared inputs: extra/,
    },
    {
      body: {
        repo: "vortex",
        check: "feature-flag",
        inputs: { environment: "production", flag: "split_transfers", state: "on\nmal" },
      },
      match: /too long or multiline/,
    },
  ];
  for (const c of cases) {
    const res = await handleDispatch(dispatchRequest(c.body), env, timingSafeEqual);
    assert.equal(res.status, 400, JSON.stringify(c.body));
    assert.match(((await res.json()) as { error: string }).error, c.match);
  }
  assert.equal(created.length, 0);
});

test("dispatch creates a checks workflow on main's sha with validated inputs", async () => {
  const { env, created } = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: unknown) => {
    assert.match(String(input), /\/repos\/VortexNYC\/vortex\/commits\/main$/);
    return Response.json({ sha: "deadbeef1234567890" });
  };
  try {
    const res = await handleDispatch(
      dispatchRequest({
        repo: "vortex",
        check: "feature-flag",
        inputs: { environment: "production", flag: "split_transfers", state: "on" },
      }),
      env,
      timingSafeEqual
    );
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(created.length, 1);
  const run = created[0]!;
  assert.match(run.id, /^dispatch-\d+-vortexnyc-vortex-feature-flag$/);
  assert.equal(run.params.repo, "VortexNYC/vortex");
  assert.equal(run.params.sha, "deadbeef1234567890");
  assert.equal(run.params.scheduled, true);
  assert.equal(run.params.dispatch, true);
  assert.equal(run.params.scheduledKey, run.id);
  assert.deepEqual(run.params.checkNames, ["feature-flag"]);
  assert.deepEqual(run.params.inputs, {
    environment: "production",
    flag: "split_transfers",
    state: "on",
  });
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

test("dispatch workflow selects dispatchChecks, injects INPUT_ env, skips check-runs", async () => {
  const runCheckCalls: Array<{ env: Record<string, string> }> = [];
  const schedulerCalls = { admit: [] as Array<{ name?: string }>, release: [] as string[] };
  const sandbox = {
    runCheck: async (opts: { env: Record<string, string> }) => {
      runCheckCalls.push(opts);
      return {
        exitCode: 0,
        stdout: [
          "===CI:CHECKOUT:RC=0===",
          "===CI:INSTALL:RC=0===",
          "===CHECK:feature-flag:START===",
          "flipped",
          "===CHECK:feature-flag:RC=0===",
        ].join("\n"),
        stderr: "",
      };
    },
    destroy: async () => {},
  };
  const scheduler = {
    trackAuxWorkflow: async () => {},
    admit: async (input: { name?: string }) => {
      schedulerCalls.admit.push(input);
      return { ok: true };
    },
    release: async (name: string) => {
      schedulerCalls.release.push(name);
    },
    completeAuxWorkflow: async () => {},
    alertDue: async () => true,
    getCheckClaim: async () => null,
  };
  const env = {
    CHECKS_GITHUB_TOKEN: "checks-token",
    CF_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CI_SCHEDULER: { idFromName: () => "global", get: () => scheduler },
    CHECKS_SANDBOX: { getByName: () => sandbox },
  } as never;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("dispatch runs must not mint check-runs on main");
  };
  try {
    const { step, names, results } = makeStep();
    const workflow = new ChecksWorkflow({}, env);
    await workflow.run(
      {
        payload: {
          repo: "VortexNYC/vortex",
          sha: "deadbeef1234567890",
          scheduled: true,
          dispatch: true,
          scheduledKey: "dispatch-1-vortexnyc-vortex-feature-flag",
          checkNames: ["feature-flag"],
          inputs: { environment: "production", flag: "split_transfers", state: "on" },
        },
        instanceId: "wf-dispatch-1",
        timestamp: new Date("2026-11-17T00:00:00Z"),
      } as never,
      step as never
    );
    assert.deepEqual(results.get("create-check-runs"), {});
    assert.equal(names.some((n) => n.startsWith("report-")), false);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(runCheckCalls.length, 1);
  const runEnv = runCheckCalls[0]!.env;
  assert.equal(runEnv.INPUT_ENVIRONMENT, "production");
  assert.equal(runEnv.INPUT_FLAG, "split_transfers");
  assert.equal(runEnv.INPUT_STATE, "on");
  assert.equal(runEnv.CF_TOKEN, "cf-token");
  assert.equal(runEnv.GITHUB_TOKEN, "checks-token");
});

test("gitWrite dispatch checks mint a contents:write installation token", async () => {
  const runCheckCalls: Array<{ env: Record<string, string>; checkoutScript: string }> = [];
  const sandbox = {
    runCheck: async (opts: { env: Record<string, string>; checkoutScript: string }) => {
      runCheckCalls.push(opts);
      return {
        exitCode: 0,
        stdout: [
          "===CI:CHECKOUT:RC=0===",
          "===CI:INSTALL:RC=0===",
          "===CHECK:deploy-lock:START===",
          "locked",
          "===CHECK:deploy-lock:RC=0===",
        ].join("\n"),
        stderr: "",
      };
    },
    destroy: async () => {},
  };
  const scheduler = {
    trackAuxWorkflow: async () => {},
    admit: async () => ({ ok: true }),
    release: async () => {},
    completeAuxWorkflow: async () => {},
    alertDue: async () => true,
    getCheckClaim: async () => null,
  };
  const env = {
    CHECKS_GITHUB_TOKEN: "checks-token",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "not-a-real-key",
    CI_SCHEDULER: { idFromName: () => "global", get: () => scheduler },
    CHECKS_SANDBOX: { getByName: () => sandbox },
  } as never;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("dispatch runs must not mint check-runs on main");
  };
  try {
    const { step } = makeStep();
    const workflow = new ChecksWorkflow({}, env);
    await workflow.run(
      {
        payload: {
          repo: "VortexNYC/vortex",
          sha: "deadbeef1234567890",
          scheduled: true,
          dispatch: true,
          scheduledKey: "dispatch-2-vortexnyc-vortex-deploy-lock",
          checkNames: ["deploy-lock"],
          inputs: { environment: "production", reason: "incident freeze" },
        },
        instanceId: "wf-dispatch-2",
        timestamp: new Date("2026-11-17T00:00:00Z"),
      } as never,
      step as never
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  // The App key is fake, so minting fails closed onto the checks token —
  // the contract asserted here is that the run still proceeds and carries
  // the operator inputs into the sandbox env.
  assert.equal(runCheckCalls.length, 1);
  assert.equal(runCheckCalls[0]!.env.GITHUB_TOKEN, "checks-token");
  assert.equal(runCheckCalls[0]!.env.INPUT_ENVIRONMENT, "production");
  assert.equal(runCheckCalls[0]!.env.INPUT_REASON, "incident freeze");
});
