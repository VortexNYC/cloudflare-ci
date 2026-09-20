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

export default {
  fetch(request: Request, env: Bindings) {
    const { pathname } = new URL(request.url);
    if (pathname === "/admin/artifacts" && request.method === "POST") {
      return handleAdmin(request, env);
    }
    if (pathname === "/admin/sandbox/kill" && request.method === "POST") {
      return handleSandboxKill(request, env);
    }
    return new Response("cloudflare-ci", { status: 200 });
  },
};
