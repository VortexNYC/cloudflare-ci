import { CiSandbox } from "@cloudflare/ci/worker";
import { getSandbox } from "@cloudflare/sandbox";

import { CI } from "./ci";
import type { Bindings } from "./env";

// Same sandbox runtime on a smaller container instance_type, bound as
// SANDBOX_LITE for steps that don't need a full build machine.
export class CiSandboxLite extends CiSandbox {}

export { CiSandbox, CI };

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
  return Response.json(results);
}

// Terminated/failed workflow runs leave inactive container instances behind,
// and inactive instances still count against the app's instance cap — the
// next spawn then fails with "WebSocket upgrade failed: 503". The runner
// registers every sandbox it spawns under ci/sandboxes/<binding>/<name> and
// removes the marker on clean destroy; sweep reaps markers older than the
// longest possible step so a dead run's containers can't linger.
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

async function handleSandboxSweep(
  request: Request,
  env: Bindings
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await sweepSandboxes(env));
}

async function sweepSandboxes(
  env: Bindings
): Promise<Record<string, string[]>> {
  const cutoff = Date.now() - SWEEP_MIN_AGE_MS;
  const results: Record<string, string[]> = { destroyed: [], skipped: [] };
  const listed = await env.BACKUP_BUCKET.list({ prefix: "ci/sandboxes/" });

  for (const object of listed.objects) {
    const [, , binding, name] = object.key.split("/");
    if (
      (binding !== "SANDBOX" && binding !== "SANDBOX_LITE") ||
      !name ||
      !/^[a-z0-9-]+$/.test(name)
    ) {
      results.skipped.push(object.key);
      continue;
    }
    if (object.uploaded.getTime() > cutoff) {
      results.skipped.push(`${name} (young)`);
      continue;
    }
    try {
      await getSandbox(env[binding], name).destroy();
      results.destroyed.push(name);
    } catch (error) {
      results.skipped.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await env.BACKUP_BUCKET.delete(object.key);
  }
  return results;
}

export default {
  fetch(request: Request, env: Bindings) {
    const { pathname } = new URL(request.url);
    if (pathname === "/admin/artifacts" && request.method === "POST") {
      return handleAdmin(request, env);
    }
    const backupMatch = pathname.match(/^\/admin\/backup\/([0-9a-f-]+)$/);
    if (backupMatch && request.method === "GET") {
      return handleBackupDownload(request, env, backupMatch[1]!);
    }
    if (pathname === "/admin/sandbox/kill" && request.method === "POST") {
      return handleSandboxKill(request, env);
    }
    if (pathname === "/admin/sandbox/sweep" && request.method === "POST") {
      return handleSandboxSweep(request, env);
    }
    return new Response("cloudflare-ci", { status: 200 });
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      sweepSandboxes(env).then((results) => {
        if (results.destroyed.length > 0) {
          console.log("sandbox sweep", results);
        }
      })
    );
  },
};
