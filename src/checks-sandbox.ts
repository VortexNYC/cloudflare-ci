// ChecksSandbox — the checks pool on sandbox-sdk 1.0. Each DO starts its own
// container (scheduling_policy: "durable_object") and runs one check in two
// phases: checkout, then install+check, with a DirectoryBackup pnpm-store
// cache between them. The 0.x pools (CiSandbox/CiSandboxLite) stay untouched
// until @cloudflare/ci migrates.
//
// Why DirectoryBackup and not S3Mount: the gateway moves bytes between the
// container and the R2 *binding* — no S3 credentials exist anywhere in the
// flow, and each transfer is grant-scoped to one upload/download. The
// container never holds a token (this also retires CI_TOKEN from the sandbox
// env, which used to carry the admin bearer).
import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, Files, type DirectoryBackupRecord } from "sandbox-1";
import type { Bindings } from "./env";

const STORE_CACHE_INDEX_PREFIX = "cache-idx/";
const STORE_BACKUP_PREFIX = "cache-store/";
const STORE_CACHE_DIR = "/tmp/.pnpm-store";
const INSTALL_OK_SENTINEL = "/tmp/.install-ok";
const CHECKOUT_SCRIPT_PATH = "/tmp/ci-checkout.sh";
const RUN_SCRIPT_PATH = "/tmp/ci-run.sh";

// Checkout is a shallow fetch — well under this bound.
const CHECKOUT_TIMEOUT_SEC = 15 * 60;

// One check's container stops itself after this much quiet; a running exec
// counts as activity. The workflow destroys explicitly — this is the backstop
// for a run that dies without its finally.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// exec() processes do not see Dockerfile ENV on 1.0 — PATH/HOME ship on every
// exec call. PATH covers the go toolchain and the npm-globals layer.
const BASE_ENV: Record<string, string> = {
  PATH: "/usr/local/go/bin:/root/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: "/root",
};

export interface ChecksRunOptions {
  /** bash script that leaves a checkout of the target sha in /workspace. */
  checkoutScript: string;
  /** bash script for install + the check itself, run after cache restore. */
  script: string;
  env: Record<string, string>;
  /** GNU-timeout bound on the install+check script, in seconds. */
  timeoutSec: number;
  /** Repo short name for the store-cache key; absent disables caching. */
  cacheRepo?: string;
}

export interface ChecksRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ChecksSandbox extends DurableObject<Bindings> {
  private readonly container: Container;
  private readonly files: Files;
  private readonly backups: DirectoryBackup;
  private setup: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) {
      throw new Error("ChecksSandbox: container binding is not configured");
    }
    this.container = container;
    this.files = new Files(container);
    this.backups = new DirectoryBackup(
      container,
      ctx.exports.DirectoryBackupGateway,
      { binding: "BACKUP_BUCKET", prefix: STORE_BACKUP_PREFIX }
    );
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
    if (!this.container.running) {
      const image = this.container.images["checks"];
      console.log(
        "ChecksSandbox: starting container",
        JSON.stringify(this.container.images)
      );
      if (!image) {
        throw new Error("ChecksSandbox: no 'checks' image registered");
      }
      this.container.start({
        image,
        instance: "standard-2",
        enableInternet: true,
      });
    }
    try {
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      await this.container.destroy();
      throw error;
    }
  }

  private async execScript(
    path: string,
    script: string,
    timeoutSec: number,
    env: Record<string, string>
  ): Promise<ChecksRunResult> {
    await this.files.writeFile(path, script);
    // GNU timeout kills the process group — an AbortSignal would orphan the
    // script's children. Exit code 124 means the bound was hit. argv[0] lives
    // in /usr/local/bin: container.exec resolves commands against the shim's
    // PATH view, not the image's full PATH.
    const process = await this.container.exec(
      ["/usr/local/bin/timeout", "--kill-after=10", String(timeoutSec), "/usr/local/bin/bash", path],
      { cwd: "/workspace", env: { ...BASE_ENV, ...env } }
    );
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  /** sha256 of the checked-out lockfile → the store-cache key. Any failure
   *  means "no cache" — a missing lockfile just runs the install cold. */
  private async storeKey(repo: string): Promise<string | null> {
    try {
      const process = await this.container.exec(
        ["/usr/local/bin/sha256sum", "pnpm-lock.yaml"],
        { cwd: "/workspace", env: BASE_ENV }
      );
      const output = await process.output();
      if (output.exitCode !== 0) return null;
      const hash = new TextDecoder().decode(output.stdout).trim().split(/\s+/)[0];
      return hash ? `pnpm-${repo}-${hash}` : null;
    } catch {
      return null;
    }
  }

  private async getCacheRecord(
    key: string
  ): Promise<DirectoryBackupRecord | null> {
    const object = await this.env.BACKUP_BUCKET.get(
      `${STORE_CACHE_INDEX_PREFIX}${key}.json`
    );
    if (!object) return null;
    try {
      const record = (await object.json()) as DirectoryBackupRecord;
      // The record only works with the same binding+prefix — trust the shape
      // enough to hand to restore(), which validates and verifies sha256.
      if (!record.id || !record.sha256 || !record.format) return null;
      return record;
    } catch {
      return null;
    }
  }

  private async restoreStore(key: string): Promise<void> {
    const record = await this.getCacheRecord(key);
    if (!record) return;
    try {
      await this.backups.restore(record, { dir: STORE_CACHE_DIR });
    } catch (error) {
      // A bad/missing object isn't fatal — install runs cold.
      console.error("ChecksSandbox: store restore failed, running cold", error);
    }
  }

  private async saveStore(key: string): Promise<void> {
    try {
      const stat = await this.files
        .stat(INSTALL_OK_SENTINEL)
        .catch(() => null);
      if (!stat) return;
      const record = await this.backups.backup({
        dir: STORE_CACHE_DIR,
        name: key,
      });
      await this.env.BACKUP_BUCKET.put(
        `${STORE_CACHE_INDEX_PREFIX}${key}.json`,
        JSON.stringify(record)
      );
    } catch (error) {
      // Cache save is best-effort — a failed upload never fails a check.
      console.error("ChecksSandbox: store backup failed", error);
    }
  }

  async runCheck(opts: ChecksRunOptions): Promise<ChecksRunResult> {
    await this.ensureRunning();
    const checkout = await this.execScript(
      CHECKOUT_SCRIPT_PATH,
      opts.checkoutScript,
      CHECKOUT_TIMEOUT_SEC,
      opts.env
    );
    // Seed the pnpm store from the previous run with the same lockfile, then
    // run install+check, then publish the fresh store when install succeeded
    // (the script touches the sentinel). Restores/backup are best-effort.
    const key =
      opts.cacheRepo && checkout.exitCode === 0
        ? await this.storeKey(opts.cacheRepo)
        : null;
    if (key) await this.restoreStore(key);
    const run = await this.execScript(
      RUN_SCRIPT_PATH,
      opts.script,
      opts.timeoutSec,
      opts.env
    );
    if (key) await this.saveStore(key);
    return {
      exitCode: run.exitCode,
      stdout: checkout.stdout + run.stdout,
      stderr: checkout.stderr + run.stderr,
    };
  }

  async destroy(): Promise<void> {
    if (this.container.running) {
      await this.container.destroy();
    }
  }
}
