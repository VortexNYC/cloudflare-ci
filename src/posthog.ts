// Structured Cloudflare Workers Observability event logger (formerly PostHog
// capture). Cloudflare CI telemetry stays inside Cloudflare's native logs and
// notifications plane rather than posting to PostHog.
import type { Bindings } from "./env";

export async function capturePostHog(
  _env: Bindings,
  event: string,
  properties: Record<string, unknown>
): Promise<void> {
  console.log(JSON.stringify({ event, ...properties, timestamp: new Date().toISOString() }));
}
