// PostHog capture — engineering signal connector. Fire-and-forget by
// contract: observability must never fail a pipeline step, so every error
// is swallowed after a stderr note. POSTHOG_CI_API_KEY unset → no-op.
import type { Bindings } from "./env";

export async function capturePostHog(
  env: Bindings,
  event: string,
  properties: Record<string, unknown>
): Promise<void> {
  const apiKey = env.POSTHOG_CI_API_KEY;
  if (!apiKey) return;
  try {
    await fetch(`${env.POSTHOG_CI_HOST ?? "https://us.i.posthog.com"}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: "cloudflare-ci",
        properties,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.log(`[posthog] capture ${event} failed: ${err}`);
  }
}
