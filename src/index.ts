import { CiSandbox } from "@cloudflare/ci/worker";
import { getSandbox } from "@cloudflare/sandbox";

import { CI } from "./ci";
import { ChecksWorkflow } from "./checks-workflow";
import { ChecksSandbox } from "./checks-sandbox";
import { parseCheckEvent, verifyGitHubSignature } from "./checks";
import { getRepoConfig } from "./repos";
import type { Bindings } from "./env";
import type { CiScheduler } from "./scheduler";

// Same sandbox runtime on a smaller container instance_type, bound as
// SANDBOX_LITE for steps that don't need a full build machine.
export class CiSandboxLite extends CiSandbox {}

export { CiSandbox, CI };
export { ChecksSandbox };
export { MirrorWorkflow } from "./mirror-workflow";

// DirectoryBackup routes container storage traffic to this entrypoint, which
// holds the operation's scoped grant and reads/writes the R2 bucket through
// the binding — no S3 credentials anywhere in the flow.
export { DirectoryBackupGateway } from "sandbox-1";

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aKey, bKey] = await Promise.all([
    crypto.subtle.importKey(
      "raw",
      encoder.encode(a),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ),
    crypto.subtle.importKey(
      "raw",
      encoder.encode(b),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ),
  ]);
  const [aMac, bMac] = await Promise.all([
    crypto.subtle.sign("HMAC", aKey, encoder.encode("cloudflare-ci-admin")),
    crypto.subtle.sign("HMAC", bKey, encoder.encode("cloudflare-ci-admin")),
  ]);
  const aBytes = new Uint8Array(aMac);
  const bBytes = new Uint8Array(bMac);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function handleAdmin(request: Request, env: Bindings): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { repo?: string };
  const repoName = body.repo;
  if (!repoName || !/^[a-z0-9][a-z0-9-]*$/.test(repoName)) {
    return Response.json({ error: "invalid repo name" }, { status: 400 });
  }

  try {
    await env.ARTIFACTS.create(repoName);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ALREADY_EXISTS") {
      return Response.json(
        { error: `create failed: ${code ?? "UNKNOWN"}` },
        { status: 502 }
      );
    }
  }

  const repo = await env.ARTIFACTS.get(repoName);
  const token = await repo.createToken("write", TOKEN_TTL_SECONDS);
  return Response.json({
    repo: repoName,
    remote: `https://${env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/vortex/${repoName}.git`,
    token: token.plaintext,
    expiresInSeconds: TOKEN_TTL_SECONDS,
  });
}

// Archive download for sandbox restores. Restoring by streaming the R2 body
// through the DO isolate into an RPC writeFileStream OOMs the isolate on
// large snapshots; serving it over HTTP lets the container curl the object
// straight to disk, bounded by nothing but bandwidth.
async function handleBackupDownload(
  request: Request,
  env: Bindings,
  id: string
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return Response.json({ error: "invalid backup id" }, { status: 400 });
  }
  const key = `backups/${id}/data.sqsh`;
  // Range passthrough lets the container parallel-download large archives.
  const rangeHeader = request.headers.get("range");
  const rangeMatch = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  if (rangeMatch) {
    const offset = Number(rangeMatch[1]);
    const suffix = rangeMatch[2];
    const [head, object] = await Promise.all([
      env.BACKUP_BUCKET.head(key),
      env.BACKUP_BUCKET.get(key, {
        range: suffix
          ? { offset, length: Number(suffix) - offset + 1 }
          : { offset },
      }),
    ]);
    if (!head || !object) return new Response("Not Found", { status: 404 });
    const headers = new Headers();
    headers.set("content-length", String(object.size));
    headers.set("content-type", "application/octet-stream");
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + object.size - 1}/${head.size}`
    );
    headers.set("accept-ranges", "bytes");
    return new Response(object.body, { status: 206, headers });
  }
  const object = await env.BACKUP_BUCKET.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  headers.set("content-length", String(object.size));
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  return new Response(object.body, { headers });
}

// pnpm-store cache for the checks pipeline — check runs curl their dep
// store in/out instead of re-resolving every package on every event.
// Keyed `cache/<name>` where name is repo + lockfile hash (set by the
// check script); same Bearer auth as the other admin routes.
async function handleChecksCache(
  request: Request,
  env: Bindings,
  key: string
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const obj = `cache/${key}`;
  if (request.method === "GET") {
    const object = await env.BACKUP_BUCKET.get(obj);
    if (!object) return new Response("Not Found", { status: 404 });
    const headers = new Headers();
    headers.set("content-length", String(object.size));
    headers.set("content-type", "application/octet-stream");
    return new Response(object.body, { headers });
  }
  if (!request.body) return new Response("Bad Request", { status: 400 });
  await env.BACKUP_BUCKET.put(obj, request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return new Response("OK", { status: 200 });
}

// Escape hatch for sandboxes whose step wedged before destroy() ran — a dead
// exec stream or abandoned log stream leaves the container billing forever.
async function handleSandboxKill(
  request: Request,
  env: Bindings
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = body.name;
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    return Response.json({ error: "invalid sandbox name" }, { status: 400 });
  }

  const results: Record<string, string> = {};
  for (const binding of ["SANDBOX", "SANDBOX_LITE"] as const) {
    try {
      await getSandbox(env[binding], name).destroy();
      results[binding] = "destroyed";
    } catch (error) {
      results[binding] = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    await env.CHECKS_SANDBOX.getByName(name).destroy();
    results["CHECKS_SANDBOX"] = "destroyed";
  } catch (error) {
    results["CHECKS_SANDBOX"] = error instanceof Error ? error.message : String(error);
  }
  return Response.json(results);
}

// Terminated/failed workflow runs leave inactive containers behind that
// still count against the app's instance cap — the next spawn then fails
// with "WebSocket upgrade failed: 503". The scheduler DO owns the ledger;
// sweep reaps reservations older than the longest possible step so a dead
// run's containers can't linger.
function scheduler(env: Bindings) {
  return env.CI_SCHEDULER.get(env.CI_SCHEDULER.idFromName("global"));
}

async function handleAdminJson(
  request: Request,
  env: Bindings,
  fn: (stub: DurableObjectStub<CiScheduler>) => Promise<unknown>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await fn(scheduler(env)));
}

async function handleSandboxSweep(
  request: Request,
  env: Bindings
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await scheduler(env).sweep());
}

async function handleSandboxAdmit(
  request: Request,
  env: Bindings
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    pool?: string;
    ttlMs?: number;
  };
  if (!body.name) return new Response("name required", { status: 400 });
  const verdict = await scheduler(env).admit({
    pool: body.pool === "EXTERNAL" ? "EXTERNAL" : "EXTERNAL",
    name: body.name,
    ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
  });
  return Response.json(verdict, { status: verdict.ok ? 200 : 429 });
}

async function handleSandboxRelease(
  request: Request,
  env: Bindings
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  if (!body.name) return new Response("name required", { status: 400 });
  await scheduler(env).release(body.name);
  return Response.json({ ok: true });
}


/** GitHub webhook → checks-in-pipeline. Verifies the HMAC signature, then
 *  one ChecksWorkflow per (repo, sha): check runs open immediately as
 *  in_progress and the container path posts conclusions. */
async function handleGitHubWebhook(
  request: Request,
  env: Bindings
): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  const token =
    env.CHECKS_GITHUB_TOKEN ||
    (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? "app" : undefined);
  if (!secret || !token) {
    return Response.json(
      { error: "checks not configured (webhook secret / GitHub token missing)" },
      { status: 501 }
    );
  }
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyGitHubSignature(secret, rawBody, signature))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const target = parseCheckEvent(
    event,
    JSON.parse(rawBody) as unknown
  );
  if (!target) return Response.json({ ok: true, skipped: event });

  // push events mirror the branch to Artifacts — the fire that replaces
  // artifacts-sync.yml. The cf.artifacts.repo.pushed event carries the
  // pipeline downstream exactly as the GHA job did.
  if (target.mirrorRef) {
    const id = `mirror-${target.repo.replace("/", "-")}-${target.mirrorRef}-${target.sha.slice(0, 10)}`;
    await env.MIRROR_WORKFLOW.create({
      id,
      params: { repo: target.repo, branch: target.mirrorRef, sha: target.sha },
    });
    return Response.json({ ok: true, id, mirrored: target.mirrorRef });
  }

  const config = getRepoConfig(target.repo.split("/")[1] ?? "");
  if (!config || config.checks.length === 0) {
    return Response.json({ ok: true, skipped: `no checks for ${target.repo}` });
  }
  const params = { ...target, checkNames: target.checkNames };
  if (target.edited) {
    // Body edits exist to re-fire the "No tests:" escape hatch — re-running
    // checks that never read PR_BODY on every title edit just burns the pool.
    const names = config.checks.filter((c) => c.usesPrBody).map((c) => c.name);
    if (names.length === 0) {
      return Response.json({ ok: true, skipped: `edited: no PR-body checks for ${target.repo}` });
    }
    params.checkNames = names;
  }
  const id = `checks-${target.repo.replace("/", "-")}-${target.sha.slice(0, 10)}-${Date.now()}`;
  await env.CHECKS_WORKFLOW.create({ id, params });
  return Response.json({ ok: true, id });
}

export default {
  fetch(request: Request, env: Bindings) {
    const { pathname } = new URL(request.url);
    if (pathname === "/webhook/github" && request.method === "POST") {
      return handleGitHubWebhook(request, env);
    }
    if (pathname === "/admin/artifacts" && request.method === "POST") {
      return handleAdmin(request, env);
    }
    const backupMatch = pathname.match(/^\/admin\/backup\/([0-9a-f-]+)$/);
    if (backupMatch && request.method === "GET") {
      return handleBackupDownload(request, env, backupMatch[1]!);
    }
    const cacheMatch = pathname.match(/^\/admin\/cache\/([a-z0-9-]+)$/);
    if (cacheMatch && (request.method === "GET" || request.method === "PUT")) {
      return handleChecksCache(request, env, cacheMatch[1]!);
    }
    if (pathname === "/admin/sandbox/kill" && request.method === "POST") {
      return handleSandboxKill(request, env);
    }
    if (pathname === "/admin/sandbox/sweep" && request.method === "POST") {
      return handleSandboxSweep(request, env);
    }
    if (pathname === "/admin/runs" && request.method === "GET") {
      return handleAdminJson(request, env, (scheduler) => scheduler.runsReport());
    }
    // Shared container admission: external consumers (Pile lane sandboxes)
    // reserve a slot here before spawning so one ledger sees account-wide
    // container pressure — the 503 saturation loop can't hide between apps.
    if (pathname === "/admin/sandbox/admit" && request.method === "POST") {
      return handleSandboxAdmit(request, env);
    }
    if (pathname === "/admin/sandbox/release" && request.method === "POST") {
      return handleSandboxRelease(request, env);
    }
    return new Response("cloudflare-ci", { status: 200 });
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      scheduler(env).sweep().then((results) => {
        if (results.reaped.length > 0) {
          console.log("sandbox sweep", results);
        }
      })
    );
  },
};

export { CiScheduler } from "./scheduler";
export { ChecksWorkflow } from "./checks-workflow";
