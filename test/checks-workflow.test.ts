import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  ChecksWorkflow,
  redactSecrets,
  type ChecksParams,
} from "../src/checks-workflow.ts";
import type { Bindings } from "../src/env.ts";

// End-to-end harness for ChecksWorkflow.run: a passthrough step, a fake
// scheduler ledger, a recording ChecksSandbox, and a fetch mock standing
// in for the GitHub REST API.

type RunOpts = {
  script: string;
  env: Record<string, string>;
  cacheRepo?: string;
};

type GhPatch = { id: string; body: { conclusion?: string; output?: { title?: string; summary?: string } } };

type Harness = {
  env: Bindings;
  step: WorkflowStep;
  sandboxNames: string[];
  sandboxRuns: Array<{ name: string; env: Record<string, string> }>;
  destroyed: string[];
  admits: string[];
  releases: string[];
  ghPatches: GhPatch[];
  completedAux: string[];
};

function makeHarness(opts: { headRepo?: string; secretInOutput?: string } = {}): Harness {
  const headRepo = opts.headRepo ?? "VortexNYC/vortex";
  const sandboxNames: string[] = [];
  const sandboxRuns: Array<{
    name: string;
    env: Record<string, string>;
    script: string;
    cacheRepo?: string;
  }> = [];
  const destroyed: string[] = [];
  const admits: string[] = [];
  const releases: string[] = [];
  const ghPatches: GhPatch[] = [];
  const completedAux: string[] = [];

  const schedStub = {
    trackAuxWorkflow: async () => {},
    claimCheck: async () => {},
    getCheckClaim: async () => null,
    admit: async (a: { name: string }) => {
      admits.push(a.name);
      return { ok: true };
    },
    release: async (name: string) => {
      releases.push(name);
    },
    completeAuxWorkflow: async (kind: string) => {
      completedAux.push(kind);
    },
  };

  const env = {
    CHECKS_GITHUB_TOKEN: "gh-token",
    NPM_TOKEN: "npm-token",
    FINIX_SANDBOX_USERNAME: "finix-user",
    FINIX_SANDBOX_PASSWORD: "finix-pass",
    CI_SCHEDULER: {
      idFromName: () => "id-global",
      get: () => schedStub,
    },
    CHECKS_SANDBOX: {
      getByName: (name: string) => {
        sandboxNames.push(name);
        return {
          runCheck: async (o: RunOpts) => {
            sandboxRuns.push({
              name,
              env: o.env,
              script: o.script,
              cacheRepo: o.cacheRepo,
            });
            // Emit the same markers the real run script produces.
            const names = [...o.script.matchAll(/> \/tmp\/check-([A-Za-z0-9_-]+)\.out/g)].map(
              (m) => m[1]!
            );
            const stdout = [
              "===CI:CHECKOUT:RC=0===",
              "===CI:INSTALL:RC=0===",
              ...names.flatMap((n) => [
                `===CHECK:${n}:START===`,
                opts.secretInOutput ?? `out-${n}`,
                `===CHECK:${n}:RC=0===`,
              ]),
            ].join("\n");
            return { exitCode: 0, stdout, stderr: "" };
          },
          destroy: async () => {
            destroyed.push(name);
          },
        };
      },
    },
  } as unknown as Bindings;

  const step = {
    calls: [] as string[],
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      this.calls.push(name);
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      return fn();
    },
  } as unknown as WorkflowStep;

  let nextRunId = 500;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.pathname;
    if (p.endsWith("/check-runs") && init?.method === "POST") {
      return Response.json({ id: nextRunId++ }, { status: 201 });
    }
    if (p.includes("/check-runs/") && init?.method === "PATCH") {
      ghPatches.push({
        id: p.split("/check-runs/")[1]!,
        body: JSON.parse(String(init?.body ?? "{}")) as GhPatch["body"],
      });
      return Response.json({});
    }
    if (p.includes("/check-runs")) {
      return Response.json({ total_count: 0, check_runs: [] });
    }
    if (p.includes("/pulls/")) {
      return Response.json({
        head: { repo: { full_name: headRepo } },
        body: "",
      });
    }
    return Response.json({});
  };

  return {
    env,
    step,
    sandboxNames,
    sandboxRuns,
    destroyed,
    admits,
    releases,
    ghPatches,
    completedAux,
  };
}

function prEvent(): WorkflowEvent<ChecksParams> {
  return {
    payload: {
      repo: "VortexNYC/vortex",
      sha: "abc1234567def0",
      prNumber: 1143,
      headRef: "hotfix/money-path-drain",
      baseRef: "main",
    },
    instanceId: "wf-1",
    timestamp: new Date(),
  } as unknown as WorkflowEvent<ChecksParams>;
}

const SERIAL_SUITE = ["trufflehog", "ci", "prc", "gitleaks"];
const ISOLATED = "worker-money-paths-regression";

test("serial repo: an isolated check runs in its own sandbox + claim, secrets only in its env", async () => {
  const h = makeHarness();
  const restore = globalThis.fetch;
  try {
    await new ChecksWorkflow({}, h.env).run(prEvent(), h.step);
  } finally {
    globalThis.fetch = restore;
  }

  const base = "checks-vortexnyc-vortex-abc1234567";
  // Serial suite stays in the one shared slot; the isolated check gets
  // its own ChecksSandbox + admission claim, both released.
  assert.ok(h.sandboxNames.includes(`${base}-all`));
  assert.ok(h.sandboxNames.includes(`${base}-${ISOLATED}`));
  assert.ok(h.admits.includes(`${base}-all`));
  assert.ok(h.admits.includes(`${base}-${ISOLATED}`));
  assert.ok(h.releases.includes(`${base}-all`));
  assert.ok(h.releases.includes(`${base}-${ISOLATED}`));
  assert.ok(h.destroyed.includes(`${base}-${ISOLATED}`));

  const serialRun = h.sandboxRuns.find((r) => r.name === `${base}-all`)!;
  const isoRun = h.sandboxRuns.find((r) => r.name === `${base}-${ISOLATED}`)!;
  assert.ok(serialRun && isoRun);
  assert.equal(isoRun.cacheRepo, "vortex");
  assert.match(isoRun.script, /pnpm install --frozen-lockfile/);
  assert.match(isoRun.script, /touch \/tmp\/\.install-ok/);
  // Secrets reach only the check that declares them by name.
  assert.equal(isoRun.env.FINIX_SANDBOX_USERNAME, "finix-user");
  assert.equal(isoRun.env.FINIX_SANDBOX_PASSWORD, "finix-pass");
  assert.equal(isoRun.env.PR_NUMBER, "1143");
  assert.equal(serialRun.env.FINIX_SANDBOX_USERNAME, undefined);
  assert.equal(serialRun.env.FINIX_SANDBOX_PASSWORD, undefined);
  assert.deepEqual(
    Object.keys(serialRun.env).sort(),
    ["CI", "GITHUB_TOKEN", "NPM_TOKEN", "PR_BODY"].sort()
  );
});

test("fork PR: secret-bearing check closes neutral and never touches a sandbox", async () => {
  const h = makeHarness({ headRepo: "someone-else/vortex" });
  const restore = globalThis.fetch;
  try {
    await new ChecksWorkflow({}, h.env).run(prEvent(), h.step);
  } finally {
    globalThis.fetch = restore;
  }

  const neutral = h.ghPatches.find((p) => p.body.conclusion === "neutral");
  assert.ok(neutral);
  assert.match(neutral.body.output?.title ?? "", new RegExp(ISOLATED));
  // The secret-bearing check never spawned a sandbox.
  const base = "checks-vortexnyc-vortex-abc1234567";
  assert.ok(!h.sandboxNames.includes(`${base}-${ISOLATED}`));
  // The rest of the suite still ran in the serial slot.
  assert.ok(h.sandboxNames.includes(`${base}-all`));
  assert.ok(h.completedAux.includes("checks"));
});

test("redactSecrets masks every non-empty value, longest first", () => {
  const scrubbed = redactSecrets("tok=alpha-beta tail alpha-beta gamma", {
    SHORT: "alpha",
    LONG: "alpha-beta",
    EMPTY: "",
  });
  assert.equal(scrubbed, "tok=*** tail *** gamma");
  // Values must never survive into check output even when embedded.
  const out = redactSecrets("set FINIX_SANDBOX_PASSWORD=s3cr3t-x ok", {
    FINIX_SANDBOX_PASSWORD: "s3cr3t-x",
  });
  assert.equal(out, "set FINIX_SANDBOX_PASSWORD=*** ok");
});

test("secret values in check output never reach the GitHub check-run summary", async () => {
  const h = makeHarness({ secretInOutput: "leak finix-user finix-pass" });
  const restore = globalThis.fetch;
  try {
    await new ChecksWorkflow({}, h.env).run(prEvent(), h.step);
  } finally {
    globalThis.fetch = restore;
  }

  const patch = h.ghPatches.find((p) =>
    p.body.output?.title?.includes(ISOLATED)
  );
  assert.ok(patch);
  const summary = patch.body.output?.summary ?? "";
  assert.ok(!summary.includes("finix-user"));
  assert.ok(!summary.includes("finix-pass"));
  assert.match(summary, /leak \*\*\* \*\*\*/);
});
