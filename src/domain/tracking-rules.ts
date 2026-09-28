import { haversineMiles } from "@/lib/geo";

/**
 * Does a delivery look real? (M14) A leg marked delivered faster than a truck can drive it, or delivered
 * from a phone far from the delivery address, gets a yellow flag for dispatch to look at — the step
 * still counts (the driver may have pressed late or early); nobody is blocked.
 */

/** Faster than this door to door, averaged over the whole leg, is not a truck. */
export const MAX_PLAUSIBLE_MPH = 65;
/** A delivery pressed this far from the delivery stop is worth a look. */
export const FAR_FROM_STOP_MI = 25;

const dur = (min: number) => (min < 1 ? "0 minutes" : min < 90 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);

export function implausibleDelivery(i: { miles: number | null; startedAt: Date | null; completedAt: Date; fix?: { lat: number; lng: number } | null; stop?: { lat: number; lng: number } | null }): string[] {
  const out: string[] = [];
  if (i.miles != null && i.miles >= 20 && i.startedAt) {
    const min = Math.max(0, (i.completedAt.getTime() - i.startedAt.getTime()) / 60_000);
    const mph = min > 0 ? (i.miles / min) * 60 : Infinity;
    if (mph > MAX_PLAUSIBLE_MPH) out.push(`Delivered ${i.miles.toLocaleString("en-US")} mi in ${dur(min)} — check the times${Number.isFinite(mph) ? ` (${Math.round(mph)} mph)` : ""}`);
  }
  if (i.fix && i.stop) {
    const away = haversineMiles(i.fix, i.stop);
    if (away > FAR_FROM_STOP_MI) out.push(`Marked delivered ${Math.round(away)} mi from the delivery address`);
  }
  return out;
}
