import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCheckEvent,
  verifyGitHubSignature,
} from "../src/checks.ts";
import { buildRunScript } from "../src/checks-workflow.ts";

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

test("buildRunScript uses the mounted cache prefix — no worker creds in-sandbox", () => {
  const script = buildRunScript(
    { repo: "VortexNYC/pile", sha: "abc123" },
    { checksInstallCommand: "pnpm install --frozen-lockfile" },
    [{ name: "ci", command: "pnpm check" }]
  );
  // S3Mount path, not the retired /admin/cache curl + CI_TOKEN path.
  assert.match(script, /\$CI_CACHE\/\$STORE_KEY/);
  assert.doesNotMatch(script, /CI_TOKEN|CI_BASE|admin\/cache|curl /);
  // store still lands in /tmp/.pnpm-store for --store-dir installs
  assert.match(script, /tar -xzf "\$CI_CACHE\/\$STORE_KEY" -C \/tmp\/\.pnpm-store/);
  assert.match(script, /cp \/tmp\/store-new\.tgz "\$CI_CACHE\/\$STORE_KEY"/);
});

test("buildRunScript fetches pull/N/head for PR events, sha otherwise", () => {
  const pr = buildRunScript(
    { repo: "VortexNYC/pile", sha: "abc123", prNumber: 42 },
    {},
    []
  );
  assert.match(pr, /git fetch -q --depth 50 origin pull\/42\/head/);
  const push = buildRunScript(
    { repo: "VortexNYC/pile", sha: "abc123" },
    {},
    []
  );
  assert.match(push, /git fetch -q --depth 50 origin abc123/);
});

test("buildRunScript wraps timeoutMs checks in GNU timeout, others plain", () => {
  const script = buildRunScript(
    { repo: "VortexNYC/pile", sha: "abc123" },
    {},
    [
      { name: "bounded", command: "pnpm test", timeoutMs: 10 * 60 * 1000 },
      { name: "unbounded", command: "pnpm lint" },
    ]
  );
  assert.match(script, /timeout --kill-after=10 600 bash -c 'pnpm test' > \/tmp\/check-bounded\.out/);
  assert.match(script, /^bash -c 'pnpm lint' > \/tmp\/check-unbounded\.out 2>&1$/m);
});

test("buildRunScript passes per-check env through the timeout wrapper", () => {
  const script = buildRunScript(
    { repo: "VortexNYC/pile", sha: "abc123" },
    {},
    [
      {
        name: "diff",
        command: "vp run diff-coverage",
        env: { DIFF_COVERAGE_BASE: "HEAD^1" },
        timeoutMs: 60_000,
      },
    ]
  );
  assert.match(script, /timeout --kill-after=10 60 bash -c 'export DIFF_COVERAGE_BASE=/);
  assert.ok(script.includes("HEAD^1"));
  assert.match(script, /; vp run diff-coverage' > \/tmp\/check-diff\.out 2>&1/);
});
