// Checks-in-pipeline: GitHub webhook → check runs executed inside cloudflare-ci
// containers, results posted back via the Checks API. The GitHub Actions
// control plane drops out of the merge path entirely.

export interface CheckTarget {
  repo: string;
  sha: string;
  prNumber?: number;
  headRef?: string;
  /** merge_group.base_sha — the base tip the group's diff is measured against. */
  baseSha?: string;
  /** PR body/title edit — only checks that consume the PR body should re-run. */
  edited?: boolean;
  /** check_run.rerequested — re-run only this check name, not the whole set. */
  checkNames?: string[];
  /** push event — mirror this ref to Artifacts instead of running checks. */
  mirrorRef?: string;
  /** refs/tags/* pushes → ReleaseWorkflow (cli-binary replacement). */
  tag?: string;
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
    // `edited` re-fires the PR-body escape hatch ("No tests:") — the old GHA
    // ran the coverage gate on body edits for exactly this reason.
    if (!["opened", "synchronize", "reopened", "ready_for_review", "edited"].includes(action ?? ""))
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
      ...(action === "edited" ? { edited: true } : {}),
    };
  }

  if (event === "merge_group") {
    if (str(payload.action) !== "checks_requested") return null;
    const mg = payload.merge_group;
    if (!isObj(mg)) return null;
    const sha = str(mg.head_sha);
    if (!sha) return null;
    // head_ref looks like "refs/heads/gh-readonly-queue/main/pr-42-<sha>" —
    // the pr-N segment recovers the PR number for checks needing the PR body.
    const headRef = str(mg.head_ref);
    const prMatch = headRef?.match(/pr-(\d+)-/);
    return {
      repo,
      sha,
      headRef,
      baseSha: str(mg.base_sha),
      ...(prMatch ? { prNumber: Number(prMatch[1]) } : {}),
    };
  }

  if (event === "check_suite") {
    if (!["requested", "rerequested"].includes(str(payload.action) ?? ""))
      return null;
    const suite = payload.check_suite;
    if (!isObj(suite)) return null;
    const sha = str(suite.head_sha);
    if (!sha) return null;
    const headBranch = str(suite.head_branch);
    // A suite requested on a merge-queue branch names the PR in the ref —
    // recover it so PR-body checks keep their escape hatch on that path too.
    const prMatch = headBranch?.includes("gh-readonly-queue/")
      ? headBranch.match(/pr-(\d+)-/)
      : undefined;
    return {
      repo,
      sha,
      headRef: headBranch,
      ...(prMatch ? { prNumber: Number(prMatch[1]) } : {}),
    };
  }

  // Per-check "Re-run" in the GitHub UI — fires check_run.rerequested, NOT
  // check_suite.rerequested. Without this the button silently does nothing.
  if (event === "check_run") {
    if (str(payload.action) !== "rerequested") return null;
    const run = payload.check_run;
    if (!isObj(run)) return null;
    const sha = str(run.head_sha);
    const name = str(run.name);
    if (!sha || !name) return null;
    const suite = isObj(run.check_suite) ? run.check_suite : undefined;
    const headBranch = suite ? str(suite.head_branch) : undefined;
    const prMatch = headBranch?.includes("gh-readonly-queue/")
      ? headBranch.match(/pr-(\d+)-/)
      : undefined;
    return {
      repo,
      sha,
      headRef: headBranch,
      checkNames: [name],
      ...(prMatch ? { prNumber: Number(prMatch[1]) } : {}),
    };
  }

  // push → mirror the branch to Artifacts. This replaces the artifacts-sync
  // GHA job: same ignore list, same force-push contract, so
  // cf.artifacts.repo.pushed fires downstream exactly as before.
  if (event === "push") {
    const ref = str(payload.ref);
    const sha = str(payload.after);
    if (!sha) return null;
    if (ref?.startsWith("refs/tags/")) {
      return { repo, sha, tag: ref.slice("refs/tags/".length) };
    }
    if (!ref?.startsWith("refs/heads/")) return null;
    const branch = ref.slice("refs/heads/".length);
    // Ignore list carried over verbatim from artifacts-sync.yml.
    if (
      branch.startsWith("gh-readonly-queue/") ||
      branch.startsWith("issue-") ||
      branch.startsWith("dependabot/")
    ) {
      return null;
    }
    return { repo, sha, mirrorRef: branch };
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

/** Reuse the newest check run for (sha, name) — reopened in_progress — or
 *  create one. A refired webhook must not mint a duplicate context. */
export async function getOrCreateCheckRun(
  token: string,
  repo: string,
  sha: string,
  name: string
): Promise<number> {
  const list = (await githubApi(
    token,
    "GET",
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=1`
  )) as { check_runs?: Array<{ id?: number }> };
  const existing = list.check_runs?.[0]?.id;
  if (typeof existing === "number") {
    await githubApi(token, "PATCH", `/repos/${repo}/check-runs/${existing}`, {
      status: "in_progress",
      started_at: new Date().toISOString(),
    });
    return existing;
  }
  return createCheckRun(token, repo, sha, name);
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

/** GitHub App → installation access token. OAuth user tokens can't create
 *  check runs — only App installation tokens carry checks:write. The JWT
 *  (RS256, iss=app_id) resolves the org's installation per repo. */
export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  repo: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      iss: Number(appId),
      iat: now - 60,
      exp: now + 600,
    })
  );
  const data = `${header}.${payload}`;

  const keyData = pemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );
  const jwt = `${data}.${btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )}`;

  const installation = (await githubApi(
    jwt,
    "GET",
    `/repos/${repo}/installation`
  )) as Json;
  const installationId = installation.id;
  if (typeof installationId !== "number") {
    throw new Error(`no installation on ${repo}`);
  }

  const token = (await githubApi(
    jwt,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    { permissions: { checks: "write", contents: "read", pull_requests: "read" } }
  )) as Json;
  const value = str(token.token);
  if (!value) throw new Error("installation token mint gave no token");
  return value;
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
