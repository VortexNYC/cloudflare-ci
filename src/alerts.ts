// Worker-side alerting for scheduled/ops failures — the replacement for the
// GitHub-issue fallbacks the old Actions jobs used. Best-effort by contract:
// alerting must never mask the check result that triggered it.
import type { Bindings } from "./env";

export async function sendAlertEmail(
  env: Bindings,
  subject: string,
  text: string
): Promise<void> {
  const emailBinding = env.EMAIL;
  const fromHeader = env.ALERT_EMAIL_FROM ?? "Cloudflare CI <noreply@veil.nyc>";
  const to = env.ALERT_EMAIL_TO ?? "shlomo@vortex.nyc";
  if (!emailBinding || !to) return;
  try {
    const match = fromHeader.match(/<([^>]+)>/);
    const fromAddr = match ? match[1] : fromHeader;
    const boundary = `cfci-${crypto.randomUUID()}`;
    const raw = [
      `From: ${fromHeader}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "",
      text,
      `--${boundary}--`,
    ].join("\r\n");
    const mod = (await import("cloudflare:email")) as {
      EmailMessage: new (from: string, to: string, raw: string) => unknown;
    };
    await emailBinding.send(new mod.EmailMessage(fromAddr, to, raw));
  } catch {
    // best-effort — never block the run on email delivery
  }
}

export async function createPileIssue(
  env: Bindings,
  title: string,
  description: string,
  priority: "low" | "medium" | "high" = "high"
): Promise<void> {
  const baseUrl = env.PILE_BASE_URL as string | undefined;
  const apiKey = env.PILE_API_KEY as string | undefined;
  const workspace = env.PILE_WORKSPACE as string | undefined;
  if (!baseUrl || !apiKey || !workspace) return;
  try {
    await fetch(`${baseUrl}/workspaces/${workspace}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        description,
        status: "triage",
        priority,
      }),
    });
  } catch {
    // reporting is best-effort — never block the run on Pile
  }
}

/** Email + Pile for one deduped operational failure. */
export async function sendOpsAlert(
  env: Bindings,
  title: string,
  description: string
): Promise<void> {
  await sendAlertEmail(env, `[cloudflare-ci] ${title}`, description);
  await createPileIssue(env, title, description);
}
