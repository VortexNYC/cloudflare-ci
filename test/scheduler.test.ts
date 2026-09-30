import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CiScheduler, type Reservation } from "../src/scheduler.ts";
import { __hooks } from "@cloudflare/sandbox";
import { makeStorage, type FakeStorage } from "./fakes.ts";

const STALE_MS = 60 * 60 * 1000;
const POOL_LIMIT = 10;

class TestScheduler extends CiScheduler {
  protected override reapDestroyTimeoutMs = 25;
}

function makeScheduler(storage = makeStorage()) {
  const env = { SANDBOX: {}, SANDBOX_LITE: {} };
  return {
    scheduler: new TestScheduler(
      { storage } as never,
      env as never
    ),
    storage,
  };
}

async function seedStaleReservation(
  storage: FakeStorage,
  name: string,
  pool: Reservation["pool"] = "SANDBOX"
) {
  const reservation: Reservation = {
    name,
    pool,
    createdAt: Date.now() - STALE_MS - 1,
  };
  await storage.put(`resv/${name}`, reservation);
}

beforeEach(() => {
  __hooks.destroyed.length = 0;
  __hooks.onDestroy = undefined;
});

test("admit reserves capacity per pool and release frees the slot", async () => {
  const { scheduler } = makeScheduler();
  for (let i = 0; i < POOL_LIMIT; i++) {
    assert.deepEqual(
      await scheduler.admit({ pool: "SANDBOX", name: `s-${i}` }),
      { ok: true }
    );
  }
  const denied = await scheduler.admit({ pool: "SANDBOX", name: "s-x" });
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? "" : denied.reason, /SANDBOX at capacity 10\/10/);
  // the lite pool has its own ledger
  assert.deepEqual(
    await scheduler.admit({ pool: "SANDBOX_LITE", name: "l-0" }),
    { ok: true }
  );
  await scheduler.release("s-0");
  assert.deepEqual(await scheduler.admit({ pool: "SANDBOX", name: "s-x" }), {
    ok: true,
  });
});

test("claim is newest-wins and rejects a completed same-sha duplicate", async () => {
  const { scheduler } = makeScheduler();
  assert.equal(await scheduler.claim("seal", "main", "i1", "sha1"), true);
  assert.equal(await scheduler.claim("seal", "main", "i2", "sha2"), true);
  const claim = await scheduler.getClaim("seal", "main");
  assert.equal(claim?.instanceId, "i2");
  assert.equal(claim?.status, "running");

  await scheduler.completeClaim("seal", "main", "i2");
  // a late duplicate event for the finished sha is rejected
  assert.equal(await scheduler.claim("seal", "main", "i3", "sha2"), false);
  // the next push claims the branch again
  assert.equal(await scheduler.claim("seal", "main", "i3", "sha3"), true);
  // completeClaim from a non-winner is a no-op
  await scheduler.completeClaim("seal", "main", "stale-instance");
  assert.equal((await scheduler.getClaim("seal", "main"))?.status, "running");
});

test("a wedged destroy does not stall the reaper or drop the ledger entry", async () => {
  const { scheduler, storage } = makeScheduler();
  await seedStaleReservation(storage, "wedged");
  __hooks.onDestroy = () => new Promise<void>(() => {});

  const started = Date.now();
  const out = await scheduler.sweep();
  assert.ok(
    Date.now() - started < 5_000,
    "reap stayed inside the per-destroy bound"
  );
  assert.deepEqual(out.reaped, []);
  // the container may still exist — the reservation stays on the ledger so
  // the next pass retries the teardown
  assert.equal(out.reservations.length, 1);
  assert.deepEqual(__hooks.destroyed, ["wedged"]);
});

test("a failing destroy drops the reservation (sandbox already gone)", async () => {
  const { scheduler, storage } = makeScheduler();
  await seedStaleReservation(storage, "gone");
  __hooks.onDestroy = () => {
    throw new Error("sandbox does not exist");
  };

  const out = await scheduler.sweep();
  assert.deepEqual(out.reaped, ["gone"]);
  assert.equal(out.reservations.length, 0);
});

test("reap stays bounded across several wedged teardowns", async () => {
  const { scheduler, storage } = makeScheduler();
  for (const name of ["w1", "w2", "w3", "w4", "w5"]) {
    await seedStaleReservation(storage, name);
  }
  __hooks.onDestroy = () => new Promise<void>(() => {});

  const started = Date.now();
  const out = await scheduler.sweep();
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(out.reaped, []);
  assert.equal(out.reservations.length, 5);
  // every stale sandbox got a destroy attempt
  assert.equal(__hooks.destroyed.length, 5);
});

test("admit reaps stale entries and still reserves promptly", async () => {
  const { scheduler, storage } = makeScheduler();
  await seedStaleReservation(storage, "corpse");
  __hooks.onDestroy = () => new Promise<void>(() => {});

  const started = Date.now();
  assert.deepEqual(
    await scheduler.admit({ pool: "SANDBOX", name: "live" }),
    { ok: true }
  );
  assert.ok(Date.now() - started < 5_000);
  // wedged corpse kept its ledger entry; the live reservation landed
  assert.equal((await scheduler.sweep()).reservations.length, 2);
});

test("fresh reservations are never reaped", async () => {
  const { scheduler } = makeScheduler();
  await scheduler.admit({ pool: "SANDBOX", name: "live" });
  const out = await scheduler.sweep();
  assert.deepEqual(out.reaped, []);
  assert.equal(out.reservations.length, 1);
  assert.deepEqual(__hooks.destroyed, []);
});
