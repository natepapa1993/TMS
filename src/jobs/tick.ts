import { expireTenders } from "@/domain/tenders";
import { flagStaleTracking } from "@/domain/tracking";
import { deliverQueued } from "@/lib/outbox";

/**
 * The job ticker (spec §9.3). One process, one interval; each job is idempotent so a missed or
 * doubled tick is harmless. Results are logged so an operator can read what happened.
 */
let running = false;
let n = 0;

export async function tick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  n++;
  const out: Record<string, unknown> = {};
  try {
    out.tenders = await expireTenders(now).catch((e) => ({ error: String(e) }));
    out.outbox = await deliverQueued().catch((e) => ({ error: String(e) }));
    if (n % 5 === 1) out.tracking = await flagStaleTracking(now).catch((e) => ({ error: String(e) }));
    if (n % 2 === 0) {
      const { pollMotiveAll } = await import("@/integrations/motive");
      out.motive = await pollMotiveAll(now).catch((e) => ({ error: String(e) }));
    }
  } finally {
    running = false;
  }
  const interesting = Object.entries(out).filter(([, v]) => v && Object.values(v as Record<string, unknown>).some((x) => x));
  if (interesting.length) console.log(`[jobs] ${JSON.stringify(Object.fromEntries(interesting))}`);
  return out;
}

export function startTicker(everyMs = 60_000) {
  const g = globalThis as { __tmsTicker?: NodeJS.Timeout };
  if (g.__tmsTicker) return;
  g.__tmsTicker = setInterval(() => tick().catch((e) => console.error("[jobs]", e)), everyMs);
  g.__tmsTicker.unref?.();
  console.log(`[jobs] ticker started, every ${everyMs / 1000}s`);
}
