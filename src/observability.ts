/** Structured CI events for Cloudflare Workers Logs / Logpush — not third-party analytics. */
import type { Bindings } from "./env";

export async function logCiEvent(
  _env: Bindings,
  event: string,
  properties: Record<string, unknown>
): Promise<void> {
  console.log(
    JSON.stringify({
      source: "cloudflare-ci",
      event,
      ...properties,
      timestamp: new Date().toISOString(),
    })
  );
}
