/** Shared admission polling for AUX-pool workflows (mirror, release, canary).
 *  Mirror must not fail closed when CHECKS is saturated — deploy waits on it. */
export const AUX_ADMIT_ATTEMPTS = 36;
export const AUX_ADMIT_MIN_DELAY_MS = 5_000;
export const AUX_ADMIT_MAX_DELAY_MS = 60_000;

export function auxAdmitRetryDelayMs(attempt: number): number {
  return Math.min(
    AUX_ADMIT_MAX_DELAY_MS,
    AUX_ADMIT_MIN_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
}
