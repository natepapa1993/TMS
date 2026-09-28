import { and, eq, inArray, lt, or, desc } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { coords, roadMiles } from "@/lib/geo";
import type { Ctx } from "@/lib/context";
import type { LegPayInput } from "./pay-plans";

type Leg = typeof s.legs.$inferSelect;

/**
 * What each completed leg brings to a pay plan: loaded miles (planned on the leg), empty miles (from the
 * driver's previous delivery to this pickup, by road estimate), the pickups and deliveries on it, the hours
 * from accepted to completed, the load's line haul and everything billed on it.
 */
export async function payInputs(ctx: Ctx, driverId: string, legs: Leg[]): Promise<LegPayInput[]> {
  if (!legs.length) return [];
  const orderIds = [...new Set(legs.map((l) => l.orderId))];
  const [orders, stops, charges, allMine] = await Promise.all([
    db.select().from(s.orders).where(inArray(s.orders.id, orderIds)),
    db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), inArray(s.stops.orderId, orderIds))),
    db.select({ orderId: s.charges.orderId, amountCents: s.charges.amountCents, billable: s.charges.billable }).from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), inArray(s.charges.orderId, orderIds))),
    // every completed leg this driver ran on these loads, to know which is the first one per load
    db.select({ id: s.legs.id, orderId: s.legs.orderId, seq: s.legs.seq }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.orderId, orderIds), eq(s.legs.state, "completed"), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId)))),
  ]);
  const stop = new Map(stops.map((x) => [x.id, x]));
  const out: LegPayInput[] = [];
  for (const leg of [...legs].sort((a, b) => (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0))) {
    const order = orders.find((o) => o.id === leg.orderId)!;
    const from = stop.get(leg.fromStopId ?? "");
    const to = stop.get(leg.toStopId ?? "");
    const inLeg = stops.filter((x) => x.orderId === leg.orderId && from && to && x.seq >= from.seq && x.seq <= to.seq && (x.type === "pickup" || x.type === "delivery"));
    // empty miles: the driver's previous completed leg before this one started, its delivery → this pickup
    const [prev] = await db
      .select({ toStopId: s.legs.toStopId })
      .from(s.legs)
      .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.state, "completed"), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId)), lt(s.legs.completedAt, leg.acceptedAt ?? leg.dispatchedAt ?? leg.completedAt ?? new Date())))
      .orderBy(desc(s.legs.completedAt))
      .limit(1);
    let emptyMiles: number | null = null;
    if (prev?.toStopId && from) {
      const [p] = await db.select({ lat: s.stops.lat, lng: s.stops.lng }).from(s.stops).where(eq(s.stops.id, prev.toStopId)).limit(1);
      const a = p ? coords(p.lat, p.lng) : null;
      const b = coords(from.lat, from.lng);
      if (a && b) emptyMiles = Math.round(roadMiles(a, b));
    }
    const start = leg.acceptedAt ?? leg.dispatchedAt;
    const hours = start && leg.completedAt ? Math.max(0, (leg.completedAt.getTime() - start.getTime()) / 3600_000) : null;
    const mineOnLoad = allMine.filter((x) => x.orderId === leg.orderId).sort((a, b) => a.seq - b.seq);
    const billed = charges.filter((c) => c.orderId === leg.orderId && c.billable).reduce((a, c) => a + c.amountCents, 0);
    out.push({
      legId: leg.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      seq: leg.seq,
      type: leg.type,
      customerId: order.customerId ?? order.brokerId,
      equipment: order.equipment,
      loadedMiles: leg.plannedMiles ?? leg.estMiles ?? null,
      loadedMilesEst: leg.plannedMiles == null && leg.estMiles != null,
      emptyMiles,
      stops: inLeg.length,
      hours: hours == null ? null : Math.round(hours * 100) / 100,
      linehaulCents: order.rateTbd ? null : order.rateCents,
      billedCents: billed || null,
      firstLegOfLoad: mineOnLoad[0]?.id === leg.id,
      team: !!leg.coDriverId,
    });
  }
  return out;
}
