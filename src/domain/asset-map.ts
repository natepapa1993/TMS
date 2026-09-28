import { and, eq, inArray, isNull, gte, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { coords } from "@/lib/geo";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";

/**
 * The live map: every truck at its last position (ELD, driver app or a verified step), what it is
 * doing, and partner carriers' trucks on our loads while they are tracked. Positions older than the
 * window are shown as stale rather than hidden.
 */

export type MapUnit = {
  id: string;
  kind: "truck" | "carrier";
  label: string;
  driver: string | null;
  status: "moving" | "stopped" | "stale" | "oos";
  lat: number;
  lng: number;
  at: string;
  speedMph: number | null;
  heading: number | null;
  source: string;
  place: string | null;
  load: { orderId: string; orderNumber: string; state: string; next: string | null; nextAt: string | null } | null;
};

const ACTIVE = ["dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const;

export async function assetMap(ctx: Ctx, now = new Date(), staleHours = 6): Promise<{ units: MapUnit[]; unplaced: { id: string; label: string; driver: string | null }[] }> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const since = new Date(now.getTime() - 14 * 86400_000);
  // the newest position per truck and per tracked carrier leg
  const lastByTruck = await db.execute<{ truck_id: string; lat: string; lng: string; at: Date; speed_mph: number | null; heading: number | null; source: string; place: string | null }>(sql`
    select distinct on (truck_id) truck_id, lat, lng, at, speed_mph, heading, source, place
    from positions where tenant_id = ${ctx.tenantId} and truck_id is not null and at >= ${since.toISOString()}::timestamptz
    order by truck_id, at desc`);
  const [trucks, drivers, legs] = await Promise.all([
    db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), isNull(s.trucks.archivedAt))),
    db.select({ id: s.drivers.id, name: s.drivers.name, truckId: s.drivers.currentTruckId }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))),
    db
      .select({ leg: s.legs, order: s.orders })
      .from(s.legs)
      .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
      .where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.state, [...ACTIVE]))),
  ]);
  const stopIds = legs.flatMap((l) => [l.leg.toStopId, l.leg.fromStopId]).filter((x): x is string => !!x);
  const stops = stopIds.length ? await db.select().from(s.stops).where(inArray(s.stops.id, stopIds)) : [];
  const stop = new Map(stops.map((x) => [x.id, x]));
  const carrierLegIds = legs.filter((l) => l.leg.assigneeKind === "carrier").map((l) => l.leg.id);
  const carrierPos = carrierLegIds.length
    ? await db.select().from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), inArray(s.positions.legId, carrierLegIds), gte(s.positions.at, since))).orderBy(desc(s.positions.at))
    : [];
  const carriers = carrierLegIds.length ? await db.select({ id: s.carriers.id, name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)) : [];

  const loadOf = (l: (typeof legs)[number] | undefined) => {
    if (!l) return null;
    const before = ["dispatched", "accepted", "en_route_to_pickup", "at_pickup"].includes(l.leg.state);
    const nxt = stop.get((before ? l.leg.fromStopId : l.leg.toStopId) ?? "");
    const place = nxt ? [nxt.address?.city, nxt.address?.state].filter(Boolean).join(", ") || nxt.name : null;
    return { orderId: l.order.id, orderNumber: l.order.orderNumber, state: l.leg.state, next: place, nextAt: nxt?.windowStart?.toISOString() ?? null };
  };
  const statusOf = (at: Date, speed: number | null, oos: boolean): MapUnit["status"] => (oos ? "oos" : now.getTime() - at.getTime() > staleHours * 3600_000 ? "stale" : (speed ?? 0) >= 5 ? "moving" : "stopped");

  const units: MapUnit[] = [];
  const unplaced: { id: string; label: string; driver: string | null }[] = [];
  for (const t of trucks) {
    const p = lastByTruck.find((r) => r.truck_id === t.id);
    const drv = drivers.find((d) => d.truckId === t.id);
    const c = p ? coords(p.lat, p.lng) : null;
    if (!p || !c) {
      unplaced.push({ id: t.id, label: t.unitNumber, driver: drv?.name ?? null });
      continue;
    }
    const at = new Date(p.at);
    units.push({ id: t.id, kind: "truck", label: t.unitNumber, driver: drv?.name ?? null, status: statusOf(at, p.speed_mph, t.status === "oos"), lat: c.lat, lng: c.lng, at: at.toISOString(), speedMph: p.speed_mph, heading: p.heading, source: p.source, place: p.place, load: loadOf(legs.find((l) => l.leg.truckId === t.id)) });
  }
  for (const id of carrierLegIds) {
    const p = carrierPos.find((x) => x.legId === id);
    const l = legs.find((x) => x.leg.id === id);
    const c = p ? coords(p.lat, p.lng) : null;
    if (!p || !c || !l) continue;
    units.push({ id, kind: "carrier", label: carriers.find((x) => x.id === l.leg.carrierId)?.name ?? "Carrier", driver: null, status: statusOf(p.at, p.speedMph, false), lat: c.lat, lng: c.lng, at: p.at.toISOString(), speedMph: p.speedMph, heading: p.heading, source: p.source, place: p.place, load: loadOf(l) });
  }
  return { units, unplaced };
}
