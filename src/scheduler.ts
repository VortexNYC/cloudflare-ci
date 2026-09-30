import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { Bindings } from "./env";

export type PoolName = "SANDBOX" | "SANDBOX_LITE";

// Per-app container caps — must match max_instances in wrangler.jsonc.
const POOL_LIMITS: Record<PoolName, number> = {
  SANDBOX: 10,
  SANDBOX_LITE: 10,
};

// Longest a live step can hold a slot: ~15min source checkout + 30min
// command timeout + slack. Anything older is a corpse from a dead run.
const RESERVATION_STALE_MS = 60 * 60 * 1000;

// One teardown can hang when the containers control plane is unresponsive —
// destroy() has no internal timeout. An unbounded await here keeps the
// admit/sweep request open long enough that the isolate can be recycled with
// callers queued behind it, which is how "this Durable Object instance is no
// longer active" reached runs between steps. Bound each destroy and cap the
// whole pass; leftovers retry on the next admit or the hourly sweep.
const REAP_DESTROY_TIMEOUT_MS = 30 * 1000;
const REAP_BUDGET_MS = 90 * 1000;

export type Reservation = {
  name: string;
  pool: PoolName;
  instanceId?: string;
  createdAt: number;
};

export type RunClaim = {
  instanceId: string;
  sha?: string;
  status: "running" | "completed";
  at: number;
};

type AdmitResult = { ok: true } | { ok: false; reason: string };

/**
 * Serialized admission control for sandbox capacity. Every container spawn
 * reserves a slot here first; destroys release it; reservations older than
 * the longest possible step are reaped by destroying the sandbox. Because a
 * single DO owns the ledger, spawns can never race past the app-level
 * instance cap — the "WebSocket upgrade failed: 503" starvation loop.
 *
 * It also owns per-repo+branch run claims so dedupe is an atomic write,
 * not a write-jitter-reread race on R2.
 */
export class CiScheduler extends DurableObject<Bindings> {
  private async reservations(): Promise<Reservation[]> {
    const map = await this.ctx.storage.list<Reservation>({ prefix: "resv/" });
    return [...map.values()];
  }

  // Overridable so tests can shrink the per-destroy bound.
  protected reapDestroyTimeoutMs = REAP_DESTROY_TIMEOUT_MS;

  private async reapStale(): Promise<string[]> {
    const stale = (await this.reservations()).filter(
      (r) => Date.now() - r.createdAt > RESERVATION_STALE_MS
    );
    const deadline = Date.now() + REAP_BUDGET_MS;
    const reaped: string[] = [];
    for (const r of stale) {
      if (Date.now() >= deadline) break;
      if (!(await this.reapReservation(r))) continue;
      await this.ctx.storage.delete(`resv/${r.name}`);
      reaped.push(r.name);
    }
    return reaped;
  }

  /**
   * Destroys one stale sandbox within the reap bound. Returns false only on
   * timeout — the container may still be alive, so the reservation stays on
   * the ledger (still counts against the pool) for the next pass to retry.
   * Errors mean the sandbox is already gone: the reservation is the only
   * thing left to drop.
   */
  private async reapReservation(r: Reservation): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getSandbox(this.env[r.pool], r.name)
          .destroy()
          .then(() => true as const),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            this.reapDestroyTimeoutMs
          );
        }),
      ]);
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  async admit(input: {
    pool: PoolName;
    name: string;
    instanceId?: string;
  }): Promise<AdmitResult> {
    // Reap before deciding — dead reservations shouldn't deny live work.
    await this.reapStale();
    const inPool = (await this.reservations()).filter(
      (r) => r.pool === input.pool
    );
    if (inPool.some((r) => r.name === input.name)) {
      return { ok: true };
    }
    const limit = POOL_LIMITS[input.pool];
    if (inPool.length >= limit) {
      return {
        ok: false,
        reason: `${input.pool} at capacity ${inPool.length}/${limit}`,
      };
    }
    await this.ctx.storage.put(`resv/${input.name}`, {
      ...input,
      createdAt: Date.now(),
    });
    return { ok: true };
  }

  async release(name: string): Promise<void> {
    await this.ctx.storage.delete(`resv/${name}`);
  }

  /**
   * Atomic newest-wins claim per repo+branch. Returns false when the branch's
   * sha already completed — duplicate events arrive minutes late and would
   * otherwise re-run the whole pipeline after the winner finished.
   */
  async claim(
    repo: string,
    branch: string,
    instanceId: string,
    sha?: string
  ): Promise<boolean> {
    const existing = await this.getClaim(repo, branch);
    if (
      existing &&
      sha &&
      existing.sha === sha &&
      existing.status === "completed"
    ) {
      return false;
    }
    await this.ctx.storage.put(`claim/${repo}/${branch}`, {
      instanceId,
      sha,
      status: "running",
      at: Date.now(),
    } satisfies RunClaim);
    return true;
  }

  async getClaim(repo: string, branch: string): Promise<RunClaim | null> {
    return (
      (await this.ctx.storage.get<RunClaim>(`claim/${repo}/${branch}`)) ?? null
    );
  }

  /** Mark the current winner finished — same-sha duplicates stop re-running. */
  async completeClaim(
    repo: string,
    branch: string,
    instanceId: string
  ): Promise<void> {
    const existing = await this.getClaim(repo, branch);
    if (existing?.instanceId === instanceId) {
      await this.ctx.storage.put(`claim/${repo}/${branch}`, {
        ...existing,
        status: "completed",
        at: Date.now(),
      } satisfies RunClaim);
    }
  }

  async sweep(): Promise<{
    reaped: string[];
    reservations: Reservation[];
  }> {
    const reaped = await this.reapStale();
    return { reaped, reservations: await this.reservations() };
  }
}
