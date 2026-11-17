// VOR-321 — Linear webhook relay. Linear webhooks can't attach custom
// headers, but the Cursor automation endpoint requires a bearer token, so
// Linear posts here: we verify Linear's HMAC, then forward the raw body with
// the Authorization header added. Upstream status is proxied verbatim so
// Linear's own retry semantics (retry on non-2xx) still apply.
import { missingLinearRelayEnv, type Bindings } from "./env";
import { logCiEvent } from "./observability";

/** Linear rejects replays older than ~1 minute; we allow 5 for clock skew. */
export const LINEAR_MAX_SKEW_MS = 5 * 60 * 1000;

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify Linear-Signature — HMAC-SHA256 hex of the raw body, no prefix. */
export async function verifyLinearSignature(
  secret: string,
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody))
  );
  const provided = signature.toLowerCase();
  let diff = expected.length ^ provided.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ (provided.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function handleLinearWebhook(
  request: Request,
  env: Bindings,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<Response> {
  const missing = missingLinearRelayEnv(env);
  if (missing.length) {
    await logCiEvent(env, "ci.linear_relay.misconfigured", { missing });
    return Response.json(
      { error: `linear relay not configured: ${missing.join(", ")}` },
      { status: 503 }
    );
  }
  const rawBody = await request.text();
  const signature = request.headers.get("linear-signature");
  if (!(await verifyLinearSignature(env.LINEAR_WEBHOOK_SECRET!, rawBody, signature))) {
    await logCiEvent(env, "ci.linear_relay.bad_signature", {});
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: { webhookTimestamp?: unknown; type?: unknown; action?: unknown };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const ts = payload?.webhookTimestamp;
  if (typeof ts !== "number" || Math.abs(now() - ts) > LINEAR_MAX_SKEW_MS) {
    await logCiEvent(env, "ci.linear_relay.stale", {});
    return Response.json({ error: "stale or missing webhookTimestamp" }, { status: 400 });
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (name.toLowerCase().startsWith("linear-")) headers.set(name, value);
  }
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("authorization", `Bearer ${env.CURSOR_AUTOMATION_KEY}`);

  let upstream: Response;
  try {
    upstream = await fetcher(env.CURSOR_AUTOMATION_URL!, {
      method: "POST",
      headers,
      body: rawBody,
    });
  } catch (err) {
    await logCiEvent(env, "ci.linear_relay.upstream_error", { error: String(err) });
    return Response.json({ error: "upstream unreachable" }, { status: 502 });
  }
  // Never log the upstream URL — its path is the routine's address.
  await logCiEvent(env, "ci.linear_relay.forwarded", {
    linearType: typeof payload.type === "string" ? payload.type : undefined,
    linearAction: typeof payload.action === "string" ? payload.action : undefined,
    delivery: request.headers.get("linear-delivery") ?? undefined,
    upstreamStatus: upstream.status,
  });
  return Response.json(
    { ok: upstream.ok, upstreamStatus: upstream.status },
    { status: upstream.status }
  );
}
