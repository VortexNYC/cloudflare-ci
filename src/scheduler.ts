import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
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
  status: "running" | "completed" | "errored";
  at: number;
  /** Original event payload — lets the sweeper re-fire an errored run. */
  params?: CiParams<CloudflareArtifacts>;
  /** Re-fire attempts so a persistently-failing push doesn't loop forever. */
  refires?: number;
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
    sha?: string,
    params?: CiParams<CloudflareArtifacts>
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
      params,
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

  private async instanceStatus(instanceId: string): Promise<string | null> {
    try {
      const instance = await this.env.CI_WORKFLOW.get(instanceId);
      const status = await instance.status();
      return typeof status === "string" ? status : (status.status ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Reservations orphaned by a dead run — the workflow errored/terminated so
   * its runner finally never ran and the container never released. The age
   * window (reapStale) is for runs still executing; a dead run's slot is
   * reclaimable immediately.
   */
  private async reapDeadRuns(): Promise<string[]> {
    const reaped: string[] = [];
    for (const r of await this.reservations()) {
      if (!r.instanceId) continue;
      const status = await this.instanceStatus(r.instanceId);
      if (!status || status === "running" || status === "queued" || status === "paused") continue;
      try {
        await getSandbox(this.env[r.pool], r.name).destroy();
      } catch {
        // already gone — the reservation is the only thing left to drop
      }
      await this.ctx.storage.delete(`resv/${r.name}`);
      reaped.push(r.name);
    }
    return reaped;
  }

  /**
   * A claim stuck "running" whose workflow instance is dead = a pipeline that
   * died mid-flight. Mark it errored, free its reservations, and re-fire
   * main-branch runs once — an errored deploy otherwise leaves prod stale
   * until the next push.
   */
  private async reconcileClaims(): Promise<{ refired: string[] }> {
    const refired: string[] = [];
    const claims = await this.ctx.storage.list<RunClaim>({ prefix: "claim/" });
    for (const [key, claim] of claims) {
      if (claim.status !== "running") continue;
      const status = await this.instanceStatus(claim.instanceId);
      if (!status || status === "running" || status === "queued" || status === "paused") continue;
      const branch = key.slice("claim/".length).split("/").slice(1).join("/");
      if (branch !== "main") {
        await this.ctx.storage.put(key, { ...claim, status: "errored" });
        continue;
      }
      if ((claim.refires ?? 0) >= 1 || !claim.params) {
        await this.ctx.storage.put(key, { ...claim, status: "errored" });
        continue;
      }
      try {
        const created = await this.env.CI_WORKFLOW.create({
          params: claim.params,
        });
        await this.ctx.storage.put(key, {
          ...claim,
          instanceId: created.id,
          refires: (claim.refires ?? 0) + 1,
          at: Date.now(),
        });
        refired.push(key);
      } catch {
        await this.ctx.storage.put(key, { ...claim, status: "errored" });
      }
    }
    return { refired };
  }

  async sweep(): Promise<{
    reaped: string[];
    deadReaped: string[];
    refired: string[];
    reservations: Reservation[];
  }> {
    const reaped = await this.reapStale();
    const deadReaped = await this.reapDeadRuns();
    const { refired } = await this.reconcileClaims();
    return {
      reaped,
      deadReaped,
      refired,
      reservations: await this.reservations(),
    };
  }
}
