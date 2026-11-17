import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLinearWebhook, verifyLinearSignature } from "../src/linear-relay.ts";
import type { Bindings } from "../src/env.ts";

const SECRET = "lin_wh_test_secret";
const UPSTREAM = "https://upstream.example/automations/webhook/test";
const NOW = 1_800_000_000_000;

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeEnv(overrides: Record<string, unknown> = {}): Bindings {
  return {
    LINEAR_WEBHOOK_SECRET: SECRET,
    CURSOR_AUTOMATION_URL: UPSTREAM,
    CURSOR_AUTOMATION_KEY: "cursor-key",
    ...overrides,
  } as unknown as Bindings;
}

function recorder(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

function linearRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "linear-delivery": "d-1",
    "linear-event": "Comment",
    "x-unrelated": "drop-me",
  };
  if (signature !== null) headers["linear-signature"] = signature;
  return new Request("https://ci.example/webhook/linear", { method: "POST", headers, body });
}

const freshBody = JSON.stringify({ type: "Comment", action: "create", webhookTimestamp: NOW - 1000 });

test("verifyLinearSignature accepts valid hex and rejects tampering", async () => {
  const sig = await sign(freshBody);
  assert.equal(await verifyLinearSignature(SECRET, freshBody, sig), true);
  assert.equal(await verifyLinearSignature(SECRET, freshBody + " ", sig), false);
  assert.equal(await verifyLinearSignature("wrong", freshBody, sig), false);
  assert.equal(await verifyLinearSignature(SECRET, freshBody, `sha256=${sig}`), false);
  assert.equal(await verifyLinearSignature(SECRET, freshBody, null), false);
});

test("valid signature forwards raw body + Linear-* headers with bearer, proxies status", async () => {
  const { calls, fetcher } = recorder(202);
  const res = await handleLinearWebhook(
    linearRequest(freshBody, await sign(freshBody)),
    makeEnv(),
    fetcher,
    () => NOW
  );
  assert.equal(res.status, 202);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, UPSTREAM);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, freshBody);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer cursor-key");
  assert.equal(headers.get("linear-delivery"), "d-1");
  assert.equal(headers.get("linear-event"), "Comment");
  assert.ok(headers.get("linear-signature"));
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.get("x-unrelated"), null);
});

test("upstream failure status is proxied so Linear retries", async () => {
  const { fetcher } = recorder(401);
  const res = await handleLinearWebhook(
    linearRequest(freshBody, await sign(freshBody)),
    makeEnv(),
    fetcher,
    () => NOW
  );
  assert.equal(res.status, 401);
});

test("bad or missing signature is 401 and never forwards", async () => {
  const { calls, fetcher } = recorder();
  const bad = await handleLinearWebhook(
    linearRequest(freshBody, await sign(freshBody, "wrong")),
    makeEnv(),
    fetcher,
    () => NOW
  );
  assert.equal(bad.status, 401);
  const missing = await handleLinearWebhook(linearRequest(freshBody, null), makeEnv(), fetcher, () => NOW);
  assert.equal(missing.status, 401);
  assert.equal(calls.length, 0);
});

test("stale, missing timestamp, or invalid JSON is 400 and never forwards", async () => {
  const { calls, fetcher } = recorder();
  const stale = JSON.stringify({ type: "Comment", webhookTimestamp: NOW - 6 * 60 * 1000 });
  const noTs = JSON.stringify({ type: "Comment" });
  const notJson = "not json";
  for (const body of [stale, noTs, notJson]) {
    const res = await handleLinearWebhook(linearRequest(body, await sign(body)), makeEnv(), fetcher, () => NOW);
    assert.equal(res.status, 400, body);
  }
  assert.equal(calls.length, 0);
});

test("missing relay config 503s the route with the missing names", async () => {
  const { calls, fetcher } = recorder();
  const res = await handleLinearWebhook(
    linearRequest(freshBody, await sign(freshBody)),
    makeEnv({ CURSOR_AUTOMATION_KEY: undefined }),
    fetcher,
    () => NOW
  );
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /CURSOR_AUTOMATION_KEY/);
  assert.equal(calls.length, 0);
});
