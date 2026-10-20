// ChecksSandbox — the checks pool on sandbox-sdk 1.0. Each DO starts its own
// container (scheduling_policy: "durable_object") and runs one check script.
// The 0.x pools (CiSandbox/CiSandboxLite) stay untouched until @cloudflare/ci
// migrates; this class replaces only the getSandbox().exec() path in
// checks-workflow.ts.
import { DurableObject } from "cloudflare:workers";
import { Files, S3Mount } from "sandbox-1";
import type { Bindings } from "./env";

// The pnpm store cache lives under the cache/ prefix of the backups bucket.
// S3Mount presents it as a directory and S3Gateway signs each storage request
// — the container never holds R2 credentials, and the check script no longer
// needs CI_TOKEN to reach /admin/cache.
export const CHECKS_CACHE_MOUNT = "/mnt/ci-cache";

// One check's container stops itself after this much quiet; a running exec
// counts as activity. The workflow destroys explicitly — this is the backstop
// for a run that dies without its finally.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const RUN_SCRIPT_PATH = "/tmp/ci-run.sh";

// exec() processes do not see Dockerfile ENV on 1.0 — PATH/HOME ship on every
// exec call. PATH covers the go toolchain and the npm-globals layer.
const BASE_ENV: Record<string, string> = {
  PATH: "/usr/local/go/bin:/root/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: "/root",
};

export interface ChecksRunOptions {
  /** bash script delivered to the container via Files, then run under timeout. */
  script: string;
  env: Record<string, string>;
  /** GNU-timeout bound on the whole script, in seconds. */
  timeoutSec: number;
}

export interface ChecksRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ChecksSandbox extends DurableObject<Bindings> {
  private readonly container: Container;
  private readonly files: Files;
  private readonly mounts: S3Mount;
  private setup: Promise<void> | null = null;
  private cacheMounted = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) {
      throw new Error("ChecksSandbox: container binding is not configured");
    }
    this.container = container;
    this.files = new Files(container);
    this.mounts = new S3Mount(container, ctx.exports.S3Gateway);
    if (container.running) {
      // The inactivity timeout does not survive a DO restart — set it again.
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
      );
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.setup === null || !this.container.running) {
      this.setup = this.startContainer().catch((error: unknown) => {
        this.setup = null;
        throw error;
      });
    }
    return this.setup;
  }

  private async startContainer(): Promise<void> {
    const newContainer = !this.container.running;
    if (newContainer) {
      this.container.start({
        image: this.container.images["checks"]!,
        instance: "standard-2",
        enableInternet: true,
      });
    }
    try {
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      if (newContainer) {
        // A replacement container starts unmounted — reset before re-mounting
        // so a destroy/restart can't leave CI_CACHE pointed at a bare dir.
        this.cacheMounted = false;
        await this.mountCache();
      }
    } catch (error) {
      await this.container.destroy();
      throw error;
    }
  }

  // The store cache is a convenience, not a correctness requirement — a mount
  // failure runs the check cold rather than failing it.
  private async mountCache(): Promise<void> {
    try {
      await this.mounts.mount({
        mountPath: CHECKS_CACHE_MOUNT,
        source: {
          type: "s3",
          endpoint: this.env.S3_ENDPOINT,
          region: "auto",
          bucket: this.env.S3_BUCKET,
          credentials: {
            type: "static",
            accessKeyId: this.env.S3_ACCESS_KEY_ID,
            secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
          },
        },
        keyPrefix: "cache/",
        access: "read-write",
      });
      this.cacheMounted = true;
    } catch (error) {
      console.error("ChecksSandbox: cache mount failed, running cold", error);
    }
  }

  async runCheck(opts: ChecksRunOptions): Promise<ChecksRunResult> {
    await this.ensureRunning();
    await this.files.writeFile(RUN_SCRIPT_PATH, opts.script);
    // GNU timeout kills the process group — an AbortSignal would orphan the
    // script's children. Exit code 124 means the bound was hit.
    const process = await this.container.exec(
      ["timeout", "--kill-after=10", String(opts.timeoutSec), "bash", RUN_SCRIPT_PATH],
      {
        cwd: "/workspace",
        env: {
          ...BASE_ENV,
          ...(this.cacheMounted ? { CI_CACHE: CHECKS_CACHE_MOUNT } : {}),
          ...opts.env,
        },
      }
    );
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  async destroy(): Promise<void> {
    this.cacheMounted = false;
    if (this.container.running) {
      await this.container.destroy();
    }
  }
}
