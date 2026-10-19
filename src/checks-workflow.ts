import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getSandbox, type ExecResult } from "@cloudflare/sandbox";
import type { Bindings } from "./env";
import { getRepoConfig } from "./repos";
import {
  completeCheckRun,
  createCheckRun,
  fetchPrBody,
  getInstallationToken,
  type CheckTarget,
} from "./checks";

const MINUTE = 60 * 1000;

export interface ChecksParams extends CheckTarget {
  /** Optional subset of checks to run — defaults to all configured. */
  checkNames?: string[];
}

type SchedulerStub = ReturnType<Bindings["CI_SCHEDULER"]["get"]>;

interface CheckRunOut {
  name: string;
  rc: number;
  output: string;
}

export class ChecksWorkflow extends WorkflowEntrypoint<Bindings, ChecksParams> {
  override async run(event: WorkflowEvent<ChecksParams>, step: WorkflowStep) {
    const { repo, sha, prNumber } = event.payload;
    const config = getRepoConfig(repo.split("/")[1] ?? repo);
    const token = this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY
      ? await getInstallationToken(
          this.env.GITHUB_APP_ID,
          this.env.GITHUB_APP_PRIVATE_KEY,
          repo
        ).catch(() => this.env.CHECKS_GITHUB_TOKEN)
      : this.env.CHECKS_GITHUB_TOKEN;
    if (!config || !token) {
      console.log(`[checks] skipping ${repo}: no config or no GitHub creds`);
      return;
    }
    const checks = config.checks.filter(
      (c) => !event.payload.checkNames || event.payload.checkNames.includes(c.name)
    );
    if (checks.length === 0) return;

    const scheduler = () =>
      this.env.CI_SCHEDULER.get(this.env.CI_SCHEDULER.idFromName("global"));
    const withScheduler = <T extends Rpc.Serializable<T>>(
      name: string,
      fn: (stub: SchedulerStub) => Promise<T>
    ): Promise<T> =>
      step.do(
        name,
        { retries: { limit: 5, delay: 5_000, backoff: "linear" }, timeout: 60_000 },
        () => fn(scheduler())
      );

    const sandboxId = `checks-${repo.replace("/", "-")}-${sha.slice(0, 10)}`;
    const runIds = await step.do("create-check-runs", async () => {
      const ids: Record<string, number> = {};
      for (const c of checks) {
        ids[c.name] = await createCheckRun(token, repo, sha, c.name);
      }
      return ids;
    });

    const failAll = async (title: string, summary: string) => {
      await Promise.all(
        checks.map((c) =>
          completeCheckRun(token, repo, runIds[c.name]!, {
            conclusion: "failure",
            title,
            summary,
          }).catch(() => {})
        )
      );
    };

    const admitted = await step.do(
      "admit",
      { retries: { limit: 5, delay: 5_000, backoff: "linear" }, timeout: 60_000 },
      async () => {
        const r = await scheduler().admit({
          pool: "SANDBOX",
          name: sandboxId,
          instanceId: event.instanceId,
        });
        return { ok: r.ok, reason: r.ok ? "" : r.reason };
      }
    );
    if (!admitted.ok) {
      await failAll("CI capacity", "The checks pool is at capacity; retry shortly.");
      return;
    }

    try {
      // PR body for checks that honor the "No tests:" escape hatch.
      const prBody = prNumber
        ? await step.do("fetch-pr-body", () =>
            fetchPrBody(token, repo, prNumber).catch(() => "")
          )
        : "";

      // One exec for the whole run: containers do NOT survive step.do
      // checkpoints (each sandbox.exec on a recycled sandbox returns a bare
      // exit 1). A single shell does checkout + install + every check,
      // delimiting each check's output and exit code with markers the
      // parse below turns into per-check conclusions.
      const run = await step.do(
        "run-checks",
        {
          retries: { limit: 1, delay: 5_000 },
          timeout: 28 * MINUTE,
        },
        () => {
          const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
          return sandbox.exec(buildRunScript(event.payload, config, checks), {
            env: {
              GITHUB_TOKEN: token,
              NPM_TOKEN: this.env.NPM_TOKEN ?? "",
              PR_BODY: prBody,
            },
            timeout: 25 * MINUTE,
          });
        }
      );

      const parsed = parseRunOutput(run);
      if (parsed.checkoutRc !== 0) {
        await failAll("Checkout failed", parsed.output.slice(-4000));
        return;
      }
      if (parsed.installRc !== 0) {
        await failAll("Install failed", parsed.output.slice(-4000));
        return;
      }
      // Post each check's conclusion — the markers carry real per-check
      // output even though they ran in one shell.
      for (const check of checks) {
        const out = parsed.checks[check.name];
        const ok = out?.rc === 0;
        await step.do(`report-${check.name}`, () =>
          completeCheckRun(token, repo, runIds[check.name]!, {
            conclusion: ok ? "success" : "failure",
            title: ok ? `${check.name} passed` : `${check.name} failed`,
            summary: (out?.output ?? "(no output)").slice(-4000),
          })
        );
      }
    } finally {
      await withScheduler("release", (stub) => stub.release(sandboxId)).catch(() => {});
    }
  }
}

interface RepoConfigShape {
  checksInstallCommand?: string;
}

function buildRunScript(
  payload: { repo: string; sha: string; headRef?: string },
  config: RepoConfigShape,
  checks: Array<{ name: string; command: string; env?: Record<string, string> }>
): string {
  const ref = payload.headRef ?? payload.sha;
  const fetchExtra = ref === payload.sha ? "" : ` ${payload.sha}`;
  const lines: string[] = [
    "set +e",
    "mkdir -p /workspace && cd /workspace",
    "git init -q .",
    `git remote add origin https://x-access-token:\$GITHUB_TOKEN@github.com/${payload.repo}.git`,
    `git fetch -q --depth 50 origin ${ref}${fetchExtra} && git checkout -q FETCH_HEAD`,
    "echo ===CI:CHECKOUT:RC=$?===",
  ];
  if (config.checksInstallCommand) {
    lines.push(
      `{ ${config.checksInstallCommand}; } > /tmp/install.out 2>&1`,
      "rc=$?; tail -c 3500 /tmp/install.out",
      "echo ===CI:INSTALL:RC=$rc==="
    );
  } else {
    lines.push("echo ===CI:INSTALL:RC=0===");
  }
  for (const check of checks) {
    const exports = Object.entries(check.env ?? {})
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("; ");
    const outFile = `/tmp/check-${check.name}.out`;
    // Check output goes to a file — the exec response caps buffered
    // stdout and verbose suites (go test) eat the whole budget. Emit a
    // bounded tail between markers instead.
    lines.push(
      `{ ${exports ? exports + "; " : ""}${check.command}; } > ${outFile} 2>&1`,
      `rc=$?; echo ===CHECK:${check.name}:START===`,
      `tail -c 3500 ${outFile}`,
      `echo ===CHECK:${check.name}:RC=$rc===`
    );
  }
  return lines.join("\n");
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

interface ParsedRun {
  checkoutRc: number;
  installRc: number;
  checks: Record<string, CheckRunOut>;
  output: string;
}

function parseRunOutput(res: ExecResult): ParsedRun {
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n");
  const parsed: ParsedRun = { checkoutRc: 1, installRc: 1, checks: {}, output: text };
  let lastCheck = "";
  const buckets: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const ci = line.match(/^===CI:(CHECKOUT|INSTALL):RC=(\d+)===?$/);
    if (ci) {
      if (ci[1] === "CHECKOUT") parsed.checkoutRc = Number(ci[2]);
      else parsed.installRc = Number(ci[2]);
      continue;
    }
    const cm = line.match(/^===CHECK:([^:]+):(START|RC=(\d+))===$/);
    if (cm) {
      if (cm[2] === "START") {
        lastCheck = cm[1]!;
        parsed.checks[lastCheck] = { name: lastCheck, rc: 1, output: "" };
        buckets[lastCheck] = [];
      } else if (lastCheck && parsed.checks[lastCheck]) {
        parsed.checks[lastCheck]!.rc = Number(cm[3]);
        parsed.checks[lastCheck]!.output = buckets[lastCheck]!.join("\n");
      }
      continue;
    }
    if (lastCheck) buckets[lastCheck]?.push(line);
  }
    return parsed;
}
