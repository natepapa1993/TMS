/**
 * The trip board's buckets and alerts, worked out from a row (pure: the page and the tests share it).
 * A row can be in more than one bucket: a cross-border load whose MX leg is rolling while its US leg
 * still needs a truck is both "in transit" and "needs truck" — the dispatcher sees both.
 */

export type BucketKey = "all" | "needs" | "tendered" | "planned" | "sent" | "transit" | "delivered" | "drafts";
export type AlertKey = "late" | "at_risk" | "no_ping" | "uncovered_soon" | "picks_today" | "delivers_today" | "flags";

export const BUCKETS: { key: BucketKey; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Everything open, most urgent first" },
  { key: "needs", label: "Needs truck", hint: "A leg with nobody on it (a declined one too)" },
  { key: "tendered", label: "Tendered", hint: "Offered to a carrier, waiting for yes or no" },
  { key: "planned", label: "Planned", hint: "Truck or carrier picked, not sent yet" },
  { key: "sent", label: "Sent", hint: "Sent to the driver or carrier, not rolling yet" },
  { key: "transit", label: "In transit", hint: "Rolling to pickup, loading, on the road, unloading" },
  { key: "delivered", label: "Delivered", hint: "Delivered this week — on to billing" },
  { key: "drafts", label: "Drafts", hint: "Quotes and requests not booked yet" },
];

export const ALERTS: { key: AlertKey; label: string; hint: string }[] = [
  { key: "late", label: "Late", hint: "ETA past the appointment, or the appointment passed with no arrival" },
  { key: "at_risk", label: "At risk", hint: "ETA within an hour of the appointment, or a tender about to expire" },
  { key: "no_ping", label: "No ping 2h+", hint: "Rolling with no GPS position in two hours" },
  { key: "uncovered_soon", label: "No truck < 24h", hint: "Picks up within a day and a leg still needs a truck" },
  { key: "picks_today", label: "Picks today", hint: "A pickup appointment today" },
  { key: "delivers_today", label: "Delivers today", hint: "A delivery appointment today" },
  { key: "flags", label: "Flagged", hint: "An open flag or on hold" },
];

const ROLLING = ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"];
const BEFORE_LOADED = ["unassigned", "declined", "planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup"];

type LegLike = { id: string; state: string; truckId: string | null; fromStopId: string | null; toStopId: string | null };
type StopLike = { id: string; seq: number; type: string; windowStart: string | null; windowEnd: string | null; arrivedAt: string | null; departedAt?: string | null };
export type RowLike = { order: { state: string }; stage: string; legs: LegLike[]; stops: StopLike[]; tenders: { legId: string; state: string; expiresAt: string }[]; openFlags: { code?: string; level?: string }[] };
export type BoardCtx = { now: number; etas: Record<string, { at: string; late: boolean }>; lastPing: (leg: LegLike) => string | null; today: (stop: StopLike) => string; dayOf: (iso: string, stop: StopLike) => string };

/** The leg that needs work next: the first one not done. */
export function currentLeg<L extends LegLike>(legs: L[]): L | null {
  return legs.find((l) => l.state !== "completed" && l.state !== "cancelled") ?? null;
}

/** The stop the current leg is heading for: its pickup until loaded, then its delivery. */
export function nextStop<S extends StopLike>(r: { legs: LegLike[]; stops: S[] }): S | null {
  const l = currentLeg(r.legs);
  if (!l) return null;
  const id = BEFORE_LOADED.includes(l.state) ? l.fromStopId : l.toStopId;
  return r.stops.find((x) => x.id === id) ?? null;
}

const appt = (st: StopLike | null) => (st ? (st.windowEnd ?? st.windowStart) : null);

export function bucketsOf(r: RowLike): Set<BucketKey> {
  const out = new Set<BucketKey>();
  if (r.order.state === "draft") return new Set(["drafts"]);
  if (r.stage === "delivered") return new Set(["delivered"]);
  if (r.stage === "closed" || r.order.state === "cancelled") return out;
  out.add("all");
  const open = r.legs.filter((l) => l.state !== "completed" && l.state !== "cancelled");
  const tenderOut = (legId: string) => r.tenders.some((t) => t.legId === legId && t.state === "sent");
  if (open.some((l) => (l.state === "unassigned" || l.state === "declined") && !tenderOut(l.id))) out.add("needs");
  if (open.some((l) => tenderOut(l.id))) out.add("tendered");
  const cur = currentLeg(r.legs);
  if (cur?.state === "planned") out.add("planned");
  if (cur && ["dispatched", "accepted"].includes(cur.state) && !tenderOut(cur.id)) out.add("sent");
  if (open.some((l) => ROLLING.includes(l.state))) out.add("transit");
  return out;
}

export function alertsOf(r: RowLike, c: BoardCtx): Set<AlertKey> {
  const out = new Set<AlertKey>();
  if (r.stage === "delivered" || r.order.state === "draft") return out;
  const cur = currentLeg(r.legs);
  const ns = nextStop(r);
  const a = appt(ns);
  const eta = cur ? c.etas[cur.id] : undefined;
  if (eta?.late || (a && !ns?.arrivedAt && new Date(a).getTime() < c.now)) out.add("late");
  else if ((eta && a && new Date(eta.at).getTime() > new Date(a).getTime() - 3600_000) || r.tenders.some((t) => t.state === "sent" && new Date(t.expiresAt).getTime() - c.now < 30 * 60_000)) out.add("at_risk");
  if (cur && ROLLING.includes(cur.state)) {
    const p = c.lastPing(cur);
    if (!p || c.now - new Date(p).getTime() > 2 * 3600_000) out.add("no_ping");
  }
  const firstPick = r.stops.find((s) => s.type === "pickup") ?? r.stops[0];
  const needs = r.legs.some((l) => l.state === "unassigned" || l.state === "declined");
  if (needs && firstPick?.windowStart && new Date(firstPick.windowStart).getTime() - c.now < 24 * 3600_000) out.add("uncovered_soon");
  for (const s of r.stops) {
    if (!s.windowStart || s.arrivedAt) continue;
    if (c.dayOf(s.windowStart, s) !== c.today(s)) continue;
    if (s.type === "pickup") out.add("picks_today");
    if (s.type === "delivery") out.add("delivers_today");
  }
  if (r.openFlags.length || r.order.state === "exception") out.add("flags");
  return out;
}

/** A tender ran out with nobody on the leg: the load goes to the very top until someone covers it (B1). */
export const tenderExpired = (r: Pick<RowLike, "openFlags">) => r.openFlags.some((f) => f.code === "tender_expired");

export type EtaEntry = { at: string; stopName: string; miles: number | null; late: boolean; positionAt: string; source?: "gps" | "check_call" };
type CallLike = { at: string; etaAt: string | null; legId: string | null };

/**
 * The dispatcher's word beats the GPS math (M6): a check call with an ETA for the leg that is running
 * now stands as that leg's ETA — and drives Late and At risk — until a GPS position newer than the call
 * comes in, or the truck gets to the stop.
 */
export function mergeCallEtas<S extends StopLike & { name: string }>(rows: { order: { id: string }; legs: LegLike[]; stops: S[] }[], gps: Record<string, EtaEntry>, calls: Record<string, CallLike>): Record<string, EtaEntry> {
  const out: Record<string, EtaEntry> = { ...gps };
  for (const r of rows) {
    const call = calls[r.order.id];
    const cur = currentLeg(r.legs);
    if (!call?.etaAt || !cur || (call.legId && call.legId !== cur.id)) continue;
    const ns = nextStop(r);
    if (!ns || ns.arrivedAt) continue;
    // a call made before the truck left the stop before this one was about that stop, not this one
    const left = r.stops.filter((x) => x.seq < ns.seq && x.departedAt).map((x) => new Date(x.departedAt!).getTime());
    if (left.length && Math.max(...left) > new Date(call.at).getTime()) continue;
    const g = gps[cur.id];
    if (g && new Date(g.positionAt).getTime() > new Date(call.at).getTime()) continue;
    const a = appt(ns);
    out[cur.id] = { at: call.etaAt, stopName: ns.name, miles: g?.miles ?? null, late: !!a && new Date(call.etaAt).getTime() > new Date(a).getTime(), positionAt: call.at, source: "check_call" };
  }
  return out;
}

/** A leg the driver or carrier just turned down, or a truck taken off it (out of service): it needs a new truck now (m5, m6). */
export function lostItsTruck(r: Pick<RowLike, "legs" | "openFlags">): boolean {
  if (r.legs.some((l) => l.state === "declined")) return true;
  return r.openFlags.some((f) => {
    const code = (f as { code?: string }).code;
    return code === "truck_removed" || code === "declined";
  }) && r.legs.some((l) => l.state === "unassigned" || l.state === "declined");
}

/** Sort key: an expired tender first, then late, then a load that just lost its truck, then at risk, then no truck soon, then by the next appointment. */
export function urgency(r: RowLike, alerts: Set<AlertKey>): number {
  const ns = nextStop(r);
  const a = appt(ns) ?? r.stops[0]?.windowStart ?? null;
  const t = a ? new Date(a).getTime() / 60_000 : 9e9;
  return (tenderExpired(r) ? -1e8 : alerts.has("late") ? 0 : lostItsTruck(r) ? 0.5e8 : alerts.has("at_risk") ? 1e8 : alerts.has("uncovered_soon") ? 2e8 : alerts.has("no_ping") ? 3e8 : 4e8) + t / 1e3;
}
