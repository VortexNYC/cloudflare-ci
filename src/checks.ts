// Checks-in-pipeline: GitHub webhook → check runs executed inside cloudflare-ci
// containers, results posted back via the Checks API. The GitHub Actions
// control plane drops out of the merge path entirely.

export interface CheckTarget {
  repo: string;
  sha: string;
  prNumber?: number;
  headRef?: string;
}

/** Verify X-Hub-Signature-256 against the raw body — HMAC-SHA256 hex. */
export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Parse the webhook events checks care about into a target SHA + repo. */
export function parseCheckEvent(
  event: string,
  payload: unknown
): CheckTarget | null {
  if (!isObj(payload)) return null;
  const repo = isObj(payload.repository)
    ? str(payload.repository.full_name)
    : undefined;
  if (!repo) return null;

  if (event === "pull_request") {
    const action = str(payload.action);
    if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(action ?? ""))
      return null;
    const pr = payload.pull_request;
    if (!isObj(pr) || !isObj(pr.head)) return null;
    const sha = str(pr.head.sha);
    if (!sha) return null;
    return {
      repo,
      sha,
      prNumber: typeof pr.number === "number" ? pr.number : undefined,
      headRef: str(pr.head.ref),
    };
  }

  if (event === "merge_group") {
    if (str(payload.action) !== "checks_requested") return null;
    const mg = payload.merge_group;
    if (!isObj(mg)) return null;
    const sha = str(mg.head_sha);
    if (!sha) return null;
    // head_ref looks like "gh-readonly-queue/main/pr-42-<sha>" — the pr-N
    // segment recovers the PR number for checks needing the PR body.
    const headRef = str(mg.head_ref);
    const prMatch = headRef?.match(/pr-(\d+)-/);
    return {
      repo,
      sha,
      headRef,
      prNumber: prMatch ? Number(prMatch[1]) : undefined,
    };
  }

  if (event === "check_suite") {
    if (!["requested", "rerequested"].includes(str(payload.action) ?? ""))
      return null;
    const suite = payload.check_suite;
    if (!isObj(suite)) return null;
    const sha = str(suite.head_sha);
    if (!sha) return null;
    return { repo, sha, headRef: str(suite.head_branch) };
  }

  return null;
}

async function githubApi(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cloudflare-ci-checks",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Open a check run on a SHA; returns its id for completion patching. */
export async function createCheckRun(
  token: string,
  repo: string,
  sha: string,
  name: string
): Promise<number> {
  const res = (await githubApi(token, "POST", `/repos/${repo}/check-runs`, {
    name,
    head_sha: sha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  })) as Json;
  const id = res.id;
  if (typeof id !== "number") throw new Error("check-run create gave no id");
  return id;
}

/** Close a check run with a conclusion + bounded output. */
export async function completeCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  result: {
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
  }
): Promise<void> {
  await githubApi(token, "PATCH", `/repos/${repo}/check-runs/${checkRunId}`, {
    status: "completed",
    conclusion: result.conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: result.title,
      summary: result.summary.slice(0, 65000),
    },
  });
}

/** Fetch a PR's body — the diff-coverage "No tests:" escape hatch needs it. */
export async function fetchPrBody(
  token: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const res = (await githubApi(
    token,
    "GET",
    `/repos/${repo}/pulls/${prNumber}`
  )) as Json;
  return str(res.body) ?? "";
}
