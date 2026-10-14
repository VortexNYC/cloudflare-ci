// Deploy guard: refuse to deploy while CI runs are in flight — a deploy
// resets live sandbox DO isolates and strands every in-flight run as a
// zombie (the 2026-10-11 wedge batch). Hits /admin/runs; ADMIN_TOKEN and
// the worker URL come from env.
const BASE = process.env.CI_WORKER_URL ?? "https://cloudflare-ci.vortex-nyc.workers.dev";
const token = process.env.ADMIN_TOKEN;

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
if (running.length > 0) {
  console.error(
    `[deploy-guard] ${running.length} run(s) in flight — deploying resets ` +
      `live sandbox DO isolates and strands them. Wait or kill them first:`
  );
  for (const c of running) console.error(`  ${c.key} → ${c.claim.instanceId}`);
  process.exit(1);
}
console.log("[deploy-guard] no runs in flight — safe to deploy");
