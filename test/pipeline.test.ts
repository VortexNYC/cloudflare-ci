import { test } from "node:test";
import assert from "node:assert/strict";
import { CI } from "../src/ci.ts";
import { CiScheduler } from "../src/scheduler.ts";
import { makeStorage, DO_DEATH } from "./fakes.ts";

type SchedulerMethod = "admit" | "release" | "getClaim" | "claim" | "completeClaim";

/**
 * A fake WorkflowStep with the engine semantics the pipeline relies on:
 * successful results are memoized by name (workflow replay), thrown errors
 * retry up to config.retries.limit.
 */
function makeStep() {
  const calls: string[] = [];
  const memo = new Map<string, unknown>();
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const config = (typeof a === "function" ? undefined : a) as
        | { retries?: { limit?: number } }
        | undefined;
      const cb = (typeof a === "function" ? a : b) as (
        ctx: unknown
      ) => Promise<unknown>;
      if (memo.has(name)) return memo.get(name);
      const limit = config?.retries?.limit ?? 0;
      for (let attempt = 1; ; attempt++) {
        try {
          const value = await cb({
            attempt,
            step: { name, count: 1 },
            config: config ?? {},
          });
          memo.set(name, value);
          calls.push(name);
          return value;
        } catch (error) {
          if (attempt > limit) throw error;
        }
      }
    },
    async sleep(name: string) {
      calls.push(name);
    },
    async sleepUntil() {},
    async waitForEvent() {
      throw new Error("unused");
    },
  };
  return { step, calls };
}

/**
 * The real CiScheduler behind a stub facade that can inject DO teardowns
 * ("this Durable Object instance is no longer active") on chosen call counts.
 */
function makeEnv() {
  const schedulerDO = new CiScheduler(
    { storage: makeStorage() } as never,
    {} as never
  );
  const callCount = new Map<SchedulerMethod, number>();
  const failures = new Map<SchedulerMethod, number[]>();
  const post = new Map<SchedulerMethod, (() => Promise<void>)[]>();
  const wrap = <A extends unknown[], R>(
    method: SchedulerMethod,
    fn: (...args: A) => Promise<R>
  ) =>
    async (...args: A): Promise<R> => {
      const n = (callCount.get(method) ?? 0) + 1;
      callCount.set(method, n);
      if (failures.get(method)?.includes(n)) throw new Error(DO_DEATH);
      const value = await fn(...args);
      for (const fn of post.get(method) ?? []) await fn();
      return value;
    };
  const stub = {
    admit: wrap("admit", (input: never) => schedulerDO.admit(input)),
    release: wrap("release", (name: never) => schedulerDO.release(name)),
    getClaim: wrap("getClaim", (repo: never, branch: never) =>
      schedulerDO.getClaim(repo, branch)
    ),
    claim: wrap("claim", (repo: never, branch: never, instanceId: never, sha: never) =>
      schedulerDO.claim(repo, branch, instanceId, sha)
    ),
    completeClaim: wrap("completeClaim", (repo: never, branch: never, instanceId: never) =>
      schedulerDO.completeClaim(repo, branch, instanceId)
    ),
  };
  const env = {
    CI_SCHEDULER: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
    CLOUDFLARE_ACCOUNT_ID: "account",
  };
  return {
    env,
    schedulerDO,
    callCount,
    failOnCall(method: SchedulerMethod, n: number) {
      failures.set(method, [...(failures.get(method) ?? []), n]);
    },
    afterCall(method: SchedulerMethod, fn: () => Promise<void>) {
      post.set(method, [...(post.get(method) ?? []), fn]);
    },
  };
}

/** Fake CiContext: runner() records the step order and returns a chainable result. */
function makeCi() {
  const ran: string[] = [];
  const makeResult = (): unknown => ({
    runner: (next: { name: string }) => {
      ran.push(next.name);
      return Promise.resolve(makeResult());
    },
  });
  return {
    ran,
    runner: (options: { name: string }) => {
      ran.push(options.name);
      return Promise.resolve(makeResult());
    },
  };
}

function makeEvent(branch: string, sha: string, instanceId = "inst-1") {
  return {
    payload: {
      provider: "cloudflare-artifacts",
      providerData: { namespace: "vortex" },
      owner: "vortex",
      repo: "seal",
      sha,
      ref: `refs/heads/${branch}`,
      branch,
      trigger: "push",
      event: { type: "cf.artifacts.repo.pushed" },
    },
    instanceId,
    timestamp: new Date(),
    workflowName: "cloudflare-ci",
  };
}

async function runPipeline(
  env: unknown,
  step: unknown,
  ci: unknown,
  event: unknown
) {
  const workflow = new CI({}, env as never);
  await (
    workflow as unknown as {
      pipeline(e: unknown, s: unknown, c: unknown): Promise<void>;
    }
  ).pipeline(event, step, ci);
}

test("main run reaches migrate/deploy/verify despite a scheduler DO teardown between build and migrate", async () => {
  const { env, failOnCall, schedulerDO } = makeEnv();
  // The reported failure: the scheduler DO is recycled while the post-build
  // dedupe check is in flight. As a step, it retries and the run proceeds.
  failOnCall("getClaim", 2);
  const { step, calls } = makeStep();
  const ci = makeCi();

  await runPipeline(env, step, ci, makeEvent("main", "7b0148ab"));

  assert.deepEqual(ci.ran, ["deps", "build", "migrate", "deploy", "verify"]);
  assert.deepEqual(calls, [
    "dedupe-claim",
    "dedupe-settle",
    "dedupe-check",
    "dedupe-recheck",
    "dedupe-complete",
  ]);
  assert.equal((await schedulerDO.getClaim("seal", "main"))?.status, "completed");
});

test("a claim teardown on entry retries instead of killing the run", async () => {
  const { env, failOnCall } = makeEnv();
  failOnCall("claim", 1);
  const { step } = makeStep();
  const ci = makeCi();

  await runPipeline(env, step, ci, makeEvent("main", "7b0148ab"));

  assert.deepEqual(ci.ran, ["deps", "build", "migrate", "deploy", "verify"]);
});

test("a completed same-sha claim exits before spawning runners", async () => {
  const { env, schedulerDO } = makeEnv();
  await schedulerDO.claim("seal", "main", "other-instance", "7b0148ab");
  await schedulerDO.completeClaim("seal", "main", "other-instance");
  const { step } = makeStep();
  const ci = makeCi();

  await runPipeline(env, step, ci, makeEvent("main", "7b0148ab"));

  assert.deepEqual(ci.ran, []);
});

test("a newer claim during the settle window exits before any container spawn", async () => {
  const { env, afterCall, schedulerDO } = makeEnv();
  // Simulate the newer-push race: a different instance claims the branch
  // right after this run's claim lands.
  afterCall("claim", () => schedulerDO.claim("seal", "main", "inst-newer", "0bad1dea"));
  const { step, calls } = makeStep();
  const ci = makeCi();

  await runPipeline(env, step, ci, makeEvent("main", "7b0148ab"));

  assert.deepEqual(ci.ran, []);
  assert.deepEqual(calls, ["dedupe-claim", "dedupe-settle", "dedupe-check"]);
});

test("branch run ships a preview after a teardown on the dedupe check", async () => {
  const { env, failOnCall, schedulerDO } = makeEnv();
  failOnCall("getClaim", 1);
  const { step } = makeStep();
  const ci = makeCi();

  await runPipeline(env, step, ci, makeEvent("cap-polish", "0672c005"));

  assert.deepEqual(ci.ran, ["deps", "build", "preview"]);
  assert.equal(
    (await schedulerDO.getClaim("seal", "cap-polish"))?.status,
    "completed"
  );
});

test("a persistently dead scheduler still fails the run without spawning", async () => {
  const { env, failOnCall } = makeEnv();
  for (let i = 1; i <= 6; i++) failOnCall("claim", i);
  const { step } = makeStep();
  const ci = makeCi();

  await assert.rejects(
    runPipeline(env, step, ci, makeEvent("main", "7b0148ab")),
    /no longer active/
  );
  assert.deepEqual(ci.ran, []);
});
