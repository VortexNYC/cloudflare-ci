// VOR-278 — authenticated workflow_dispatch replacement. An operator POSTs
// {repo, check, inputs?} with the ADMIN_TOKEN Bearer; the named dispatch
// check runs in the ChecksWorkflow log+alert lane on the repo's main sha.
// Input validation is the contract GitHub's choice/required inputs gave:
// undeclared names, missing required values, and out-of-choice values are
// rejected before any workflow exists.
import { getChecksGitHubToken, getCommitSha } from "./checks";
import type { Bindings } from "./env";
import { logCiEvent } from "./observability";
import { getRepoConfig } from "./repos";
import { safe } from "./scheduled";

export async function handleDispatch(
  request: Request,
  env: Bindings,
  timingSafeEqual: (a: string, b: string) => Promise<boolean>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  const provided = request.headers
    .get("authorization")
    ?.replace(/^Bearer /i, "");
  if (!expected || !provided || !(await timingSafeEqual(provided, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    repo?: string;
    check?: string;
    ref?: string;
    inputs?: Record<string, unknown>;
  };
  const repoShort =
    typeof body.repo === "string" ? (body.repo.split("/").pop() ?? "") : "";
  const config = getRepoConfig(repoShort);
  if (!config) {
    return Response.json(
      { error: `unknown repo: ${body.repo}` },
      { status: 400 }
    );
  }
  const repo = `VortexNYC/${config.name}`;
  const check = config.dispatchChecks.find((c) => c.name === body.check);
  if (!check) {
    return Response.json(
      {
        error: `unknown dispatch check for ${config.name}: ${body.check}`,
        checks: config.dispatchChecks.map((c) => c.name),
      },
      { status: 400 }
    );
  }

  const declared = new Map(check.inputs.map((i) => [i.name, i]));
  const inputs: Record<string, string> = {};
  const rawInputs =
    typeof body.inputs === "object" && body.inputs !== null ? body.inputs : {};
  const unknownInputs = Object.keys(rawInputs).filter((k) => !declared.has(k));
  if (unknownInputs.length > 0) {
    return Response.json(
      { error: `undeclared inputs: ${unknownInputs.join(", ")}` },
      { status: 400 }
    );
  }
  for (const [name, spec] of declared) {
    const raw = rawInputs[name];
    if (raw === undefined || raw === null || raw === "") {
      if (spec.required) {
        return Response.json(
          { error: `missing required input: ${name}` },
          { status: 400 }
        );
      }
      continue;
    }
    if (
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    ) {
      return Response.json(
        { error: `input ${name} must be a string` },
        { status: 400 }
      );
    }
    const value = String(raw);
    if (value.length > 500 || /[\r\n]/.test(value)) {
      return Response.json(
        { error: `input ${name} is too long or multiline` },
        { status: 400 }
      );
    }
    if (spec.choices && !spec.choices.includes(value)) {
      return Response.json(
        { error: `input ${name} must be one of: ${spec.choices.join(", ")}` },
        { status: 400 }
      );
    }
    inputs[name] = value;
  }

  const token = await getChecksGitHubToken(env, repo);
  if (!token) {
    return Response.json(
      { error: "dispatch not configured (GitHub token missing)" },
      { status: 501 }
    );
  }
  const ref =
    typeof body.ref === "string" && /^[a-zA-Z0-9._/-]{1,100}$/.test(body.ref)
      ? body.ref
      : "main";
  let sha: string;
  try {
    sha = await getCommitSha(token, repo, ref);
  } catch (error) {
    return Response.json(
      { error: `could not resolve ${repo}@${ref}: ${String(error)}` },
      { status: 502 }
    );
  }

  // Every explicit call gets a unique workflow id — an operator re-run is
  // intentional and must not dedupe against a previous dispatch.
  const id = `dispatch-${Date.now()}-${safe(repo)}-${safe(check.name)}`;
  await env.CHECKS_WORKFLOW.create({
    id,
    params: {
      repo,
      sha,
      scheduled: true,
      dispatch: true,
      scheduledKey: id,
      checkNames: [check.name],
      inputs,
    },
  });
  await logCiEvent(env, "ci.dispatch.created", {
    repo,
    sha,
    check: check.name,
    ref,
    workflowId: id,
  });
  return Response.json({ ok: true, id, repo, sha, check: check.name, ref });
}
