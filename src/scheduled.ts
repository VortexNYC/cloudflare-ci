import type { ScheduledJobGroup } from "./repos";

const SAFE_CHARS = /[^a-z0-9-]/g;

function safe(value: string): string {
  return value.toLowerCase().replace(SAFE_CHARS, "-");
}

/** Deterministic scope/workflow id for one cron delivery. Retries of the same
 *  scheduled event reuse the id, so Cloudflare rejects the duplicate instead
 *  of starting a second run. */
export function scheduledScopeFor(
  job: ScheduledJobGroup,
  scheduledTime: number
): string {
  const repoKey = safe(job.repo);
  const checkSlug = safe(job.checkNames.join("+"));
  // The timestamp leads so repo commands that truncate CI_RUN_KEY to 24
  // chars still get a per-tick unique PlanetScale branch/role suffix.
  return `scheduled-${scheduledTime}-${repoKey}-${checkSlug}`;
}

export function scheduledWorkflowId(scope: string): string {
  return scope;
}

export function isWorkflowAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|already_exists|instance .*exists|duplicate/i.test(message);
}

/** Deduped "not configured" key — one alert per repo+missing-secret set. */
export function notConfiguredAlertKey(repo: string, missing: string[]): string {
  return `scheduled-not-configured/${safe(repo)}/${safe([...missing].sort().join("+"))}`;
}
