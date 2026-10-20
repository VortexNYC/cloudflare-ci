import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOrCreateCheckRun,
  parseCheckEvent,
  verifyGitHubSignature,
} from "../src/checks.ts";
import {
  buildCheckoutScript,
  buildRunScript,
} from "../src/checks-workflow.ts";

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
      head_ref: "refs/heads/gh-readonly-queue/main/pr-42-abcd1234",
      base_sha: "base-sha",
    },
  });
  assert.deepEqual(target, {
    repo: "VortexNYC/pile",
    sha: "queue-sha",
    headRef: "refs/heads/gh-readonly-queue/main/pr-42-abcd1234",
    baseSha: "base-sha",
    prNumber: 42,
  });
});

test("parseCheckEvent: pull_request edited marks the target for rescoping", () => {
  const target = parseCheckEvent("pull_request", {
    action: "edited",
    repository: { full_name: "VortexNYC/pile" },
    pull_request: { number: 42, head: { sha: "abc123", ref: "feat-x" } },
  });
  assert.equal(target?.edited, true);
  assert.equal(target?.sha, "abc123");
  // Non-edit actions never carry the flag.
  const opened = parseCheckEvent("pull_request", {
    action: "opened",
    repository: { full_name: "VortexNYC/pile" },
    pull_request: { number: 42, head: { sha: "abc123" } },
  });
  assert.equal(opened?.edited, undefined);
});

test("parseCheckEvent: check_suite on a queue branch recovers the PR number", () => {
  const target = parseCheckEvent("check_suite", {
    action: "requested",
    repository: { full_name: "VortexNYC/pile" },
    check_suite: {
      head_sha: "queue-sha",
      head_branch: "gh-readonly-queue/main/pr-42-abcd1234",
    },
  });
  assert.equal(target?.prNumber, 42);
  assert.equal(target?.headRef, "gh-readonly-queue/main/pr-42-abcd1234");
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

test("buildRunScript carries no cache transport or worker creds", () => {
  const script = buildRunScript(
    { checksInstallCommand: "pnpm install --frozen-lockfile" },
    [{ name: "ci", command: "pnpm check" }]
  );
  // Store seed/upload lives in the DO (DirectoryBackup on the R2 binding);
  // the script only marks a good install for the backup pass.
  assert.doesNotMatch(script, /CI_TOKEN|CI_BASE|CI_CACHE|STORE_KEY|admin\/cache|curl /);
  assert.match(script, /touch \/tmp\/\.install-ok/);
});

test("buildCheckoutScript prefers a fresh PR merge ref, head as fallback", () => {
  const script = buildCheckoutScript({
    repo: "VortexNYC/pile",
    sha: "abc123",
    prNumber: 42,
  });
  // The merge ref gives HEAD^1 = base tip — the diff base coverage checks
  // measure against; verified fresh via the merge's second parent.
  assert.match(script, /git fetch -q --depth 50 origin pull\/42\/merge/);
  assert.match(script, /git rev-parse 'FETCH_HEAD\^2'/);
  assert.match(script, /= "abc123"/);
  assert.match(script, /git checkout -q FETCH_HEAD/);
  // Stale/absent merge ref falls back to the head fetch.
  assert.match(script, /git fetch -q --depth 50 origin pull\/42\/head && git checkout -q abc123/);
  assert.match(script, /git update-ref refs\/ci\/base HEAD\^1/);
});

test("buildCheckoutScript fetches the queue ref for merge groups", () => {
  const script = buildCheckoutScript({
    repo: "VortexNYC/pile",
    sha: "queue-sha",
    headRef: "refs/heads/gh-readonly-queue/main/pr-42-abcd1234",
    prNumber: 42,
    baseSha: "base-sha",
  });
  // The queue sha is unreachable from pull/N/head — the queue branch is
  // fetched instead even though prNumber is set.
  assert.match(
    script,
    /git fetch -q --depth 50 origin 'refs\/heads\/gh-readonly-queue\/main\/pr-42-abcd1234' && git checkout -q queue-sha/
  );
  assert.doesNotMatch(script, /pull\/42\//);
  // The group's base sha pins the diff base, not HEAD^1 (chain merges).
  assert.match(script, /git update-ref refs\/ci\/base base-sha/);
});

test("buildCheckoutScript falls back to HEAD^1 base when no base sha", () => {
  const script = buildCheckoutScript({
    repo: "VortexNYC/pile",
    sha: "queue-sha",
    headRef: "gh-readonly-queue/main/pr-42-abcd1234",
  });
  assert.match(script, /git update-ref refs\/ci\/base HEAD\^1/);
});

test("buildCheckoutScript fetches sha or headRef for non-PR events", () => {
  const push = buildCheckoutScript({ repo: "VortexNYC/pile", sha: "abc123" });
  assert.match(push, /git fetch -q --depth 50 origin 'abc123' && git checkout -q abc123/);
  assert.match(push, /git update-ref refs\/ci\/base HEAD\^1/);
  const suite = buildCheckoutScript({
    repo: "VortexNYC/pile",
    sha: "abc123",
    headRef: "feat-y",
  });
  assert.match(suite, /git fetch -q --depth 50 origin 'feat-y' && git checkout -q abc123/);
});

test("buildRunScript wraps timeoutMs checks in GNU timeout, others plain", () => {
  const script = buildRunScript({}, [
    { name: "bounded", command: "pnpm test", timeoutMs: 10 * 60 * 1000 },
    { name: "unbounded", command: "pnpm lint" },
  ]);
  assert.match(script, /timeout --kill-after=10 600 bash -c 'pnpm test' > \/tmp\/check-bounded\.out/);
  assert.match(script, /^bash -c 'pnpm lint' > \/tmp\/check-unbounded\.out 2>&1$/m);
});

test("buildRunScript passes per-check env through the timeout wrapper", () => {
  const script = buildRunScript({}, [
    {
      name: "diff",
      command: "vp run diff-coverage",
      env: { DIFF_COVERAGE_BASE: "HEAD^1" },
      timeoutMs: 60_000,
    },
  ]);
  assert.match(script, /timeout --kill-after=10 60 bash -c 'export DIFF_COVERAGE_BASE=/);
  assert.ok(script.includes("HEAD^1"));
  assert.match(script, /; vp run diff-coverage' > \/tmp\/check-diff\.out 2>&1/);
});

test("getOrCreateCheckRun reopens an existing run instead of duplicating", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ method: init?.method ?? "GET", url });
    if (url.includes("/check-runs?")) {
      return new Response(
        JSON.stringify({ total_count: 1, check_runs: [{ id: 4242 }] }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  };
  try {
    const id = await getOrCreateCheckRun("t", "VortexNYC/pile", "abc123", "ci");
    assert.equal(id, 4242);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      [
        "GET /repos/VortexNYC/pile/commits/abc123/check-runs",
        "PATCH /repos/VortexNYC/pile/check-runs/4242",
      ]
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("getOrCreateCheckRun creates when no run exists for the name", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ check_runs: [], id: 77 }), {
      status: 201,
    });
  };
  try {
    const id = await getOrCreateCheckRun("t", "VortexNYC/pile", "abc123", "ci");
    assert.equal(id, 77);
    assert.deepEqual(calls, [
      "GET /repos/VortexNYC/pile/commits/abc123/check-runs",
      "POST /repos/VortexNYC/pile/check-runs",
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
