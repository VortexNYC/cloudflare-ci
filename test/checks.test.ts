import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCheckEvent,
  verifyGitHubSignature,
} from "../src/checks.ts";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return (
    "sha256=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

test("verifyGitHubSignature accepts a valid signature", async () => {
  const body = '{"hello":"world"}';
  const sig = await sign("s3cret", body);
  assert.equal(await verifyGitHubSignature("s3cret", body, sig), true);
});

test("verifyGitHubSignature rejects tampered body + wrong secret", async () => {
  const body = '{"hello":"world"}';
  const sig = await sign("s3cret", body);
  assert.equal(await verifyGitHubSignature("s3cret", body + " ", sig), false);
  assert.equal(await verifyGitHubSignature("wrong", body, sig), false);
  assert.equal(await verifyGitHubSignature("s3cret", body, "sha256=dead"), false);
  assert.equal(await verifyGitHubSignature("s3cret", body, null), false);
});

test("parseCheckEvent: pull_request synchronize → head sha", () => {
  const target = parseCheckEvent("pull_request", {
    action: "synchronize",
    repository: { full_name: "VortexNYC/pile" },
    pull_request: { number: 42, head: { sha: "abc123", ref: "feat-x" } },
  });
  assert.deepEqual(target, {
    repo: "VortexNYC/pile",
    sha: "abc123",
    prNumber: 42,
    headRef: "feat-x",
  });
});

test("parseCheckEvent: pull_request closed is ignored", () => {
  const target = parseCheckEvent("pull_request", {
    action: "closed",
    repository: { full_name: "VortexNYC/pile" },
    pull_request: { number: 42, head: { sha: "abc123" } },
  });
  assert.equal(target, null);
});

test("parseCheckEvent: merge_group checks_requested recovers the PR number", () => {
  const target = parseCheckEvent("merge_group", {
    action: "checks_requested",
    repository: { full_name: "VortexNYC/pile" },
    merge_group: {
      head_sha: "queue-sha",
      head_ref: "gh-readonly-queue/main/pr-42-abcd1234",
    },
  });
  assert.deepEqual(target, {
    repo: "VortexNYC/pile",
    sha: "queue-sha",
    headRef: "gh-readonly-queue/main/pr-42-abcd1234",
    prNumber: 42,
  });
});

test("parseCheckEvent: check_suite requested", () => {
  const target = parseCheckEvent("check_suite", {
    action: "requested",
    repository: { full_name: "VortexNYC/pile" },
    check_suite: { head_sha: "sha9", head_branch: "feat-y" },
  });
  assert.deepEqual(target, {
    repo: "VortexNYC/pile",
    sha: "sha9",
    headRef: "feat-y",
  });
  assert.equal(target?.prNumber, undefined);
});

test("parseCheckEvent: unrelated events return null", () => {
  assert.equal(parseCheckEvent("push", {}), null);
  assert.equal(parseCheckEvent("pull_request", null), null);
});
