// Deploy guard: a deploy resets live sandbox DO isolates and strands every
// in-flight run as a zombie (the 2026-10-11 wedge batch).
//
// Default: refuse while runs are in flight.
// DRAIN=1: terminate them deliberately instead — recoverable-by-design
// (VTX-627): the claim ledger carries fencing+expiry, so reconcileClaims
// refires dead main claims and marks the rest errored. The deploy ships
// now; the work restarts itself. Hits /admin/runs; ADMIN_TOKEN and the
// worker URL come from env.
import { execSync } from "node:child_process";

const BASE = process.env.CI_WORKER_URL ?? "https://cloudflare-ci.vortex-nyc.workers.dev";
const token = process.env.ADMIN_TOKEN;
const drain = process.env.DRAIN === "1";

if (!token) {
  console.warn("[deploy-guard] no ADMIN_TOKEN — skipping in-flight check");
  process.exit(0);
}

const res = await fetch(`${BASE}/admin/runs`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.warn(`[deploy-guard] /admin/runs ${res.status} — proceeding anyway`);
  process.exit(0);
}
const { claims } = await res.json();
const running = claims.filter(
  (c) =>
    c.claim.status === "running" &&
    (c.instanceStatus === "running" || c.instanceStatus === "queued")
);
if (running.length === 0) {
  console.log("[deploy-guard] no runs in flight — safe to deploy");
  process.exit(0);
}

if (!drain) {
  console.error(
    `[deploy-guard] ${running.length} run(s) in flight — deploying resets ` +
      `live sandbox DO isolates and strands them. Wait, or re-run with DRAIN=1:`
  );
  for (const c of running) console.error(`  ${c.key} → ${c.claim.instanceId}`);
  process.exit(1);
}

console.warn(`[deploy-guard] DRAIN=1 — terminating ${running.length} in-flight run(s); the ledger refires dead claims`);
for (const c of running) {
  try {
    execSync(
      `pnpm exec wrangler workflows instances terminate cloudflare-ci ${c.claim.instanceId}`,
      { stdio: "inherit" }
    );
  } catch {
    console.warn(`[deploy-guard] terminate failed for ${c.claim.instanceId} — continuing anyway`);
  }
}

// Wait for the platform to settle — terminated instances take a beat to flip.
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5_000));
  const again = await fetch(`${BASE}/admin/runs`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => (r.ok ? r.json() : null));
  const still = (again?.claims ?? []).filter(
    (c) =>
      c.claim.status === "running" &&
      (c.instanceStatus === "running" || c.instanceStatus === "queued")
  );
  if (still.length === 0) {
    console.log("[deploy-guard] drained — safe to deploy");
    process.exit(0);
  }
}
console.warn("[deploy-guard] instances still settling after 30s — proceeding anyway");
