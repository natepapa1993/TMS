import { and, eq, inArray, desc, sql, or, gt } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { PositionSource, LegState } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { advanceLeg, acceptLeg, declineLeg, midStops, pendingMidStop, stampStop, NotFoundError, ValidationError } from "./orders";
import { LEG_FORWARD } from "./states";

/**
 * Tracking (spec §5): positions from the driver app, the ELD, or a phone; the driver's "today"
 * view with one next-step button; the customer tracking page; the no-position watchdog.
 */

const MOVING: LegState[] = ["accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"];
const ACTIVE: LegState[] = ["dispatched", ...MOVING];

export type PositionInput = { source: PositionSource; at?: Date; lat: number | string; lng: number | string; truckId?: string | null; driverId?: string | null; legId?: string | null; speedMph?: number | null; heading?: number | null; accuracyM?: number | null; place?: string | null; externalId?: string | null };

export async function recordPosition(ctx: Ctx, p: PositionInput) {
  assertCtx(ctx);
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ValidationError("bad coordinates", "lat");
  if (p.externalId) {
    const [dupe] = await db.select({ id: s.positions.id }).from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), eq(s.positions.externalId, p.externalId))).limit(1);
    if (dupe) return { id: dupe.id, duplicate: true };
  }
  let legId = p.legId ?? null;
  let orderId: string | null = null;
  if (!legId && (p.truckId || p.driverId)) {
    const [leg] = await db
      .select({ id: s.legs.id, orderId: s.legs.orderId })
      .from(s.legs)
      .where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.state, MOVING), p.truckId ? eq(s.legs.truckId, p.truckId) : or(eq(s.legs.driverId, p.driverId!), eq(s.legs.coDriverId, p.driverId!))))
      .orderBy(s.legs.seq)
      .limit(1);
    if (leg) {
      legId = leg.id;
      orderId = leg.orderId;
    }
  } else if (legId) {
    const [leg] = await db.select({ orderId: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
    orderId = leg?.orderId ?? null;
  }
  const [row] = await db
    .insert(s.positions)
    .values({ id: newId(), tenantId: ctx.tenantId, at: p.at ?? new Date(), source: p.source, truckId: p.truckId ?? null, driverId: p.driverId ?? null, legId, orderId, lat: lat.toFixed(6), lng: lng.toFixed(6), speedMph: p.speedMph ?? null, heading: p.heading ?? null, accuracyM: p.accuracyM ?? null, place: p.place ?? null, externalId: p.externalId ?? null })
    .returning();
  return { id: row.id, duplicate: false, legId, orderId };
}

/** Latest position per truck (Fleet / board). */
export async function latestTruckPositions(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const rows = await db.execute(sql`
    select distinct on (truck_id) id, truck_id as "truckId", at, source, lat, lng, speed_mph as "speedMph", place
    from positions where tenant_id = ${ctx.tenantId} and truck_id is not null
    order by truck_id, at desc`);
  return rows as unknown as { id: string; truckId: string; at: Date; source: PositionSource; lat: string; lng: string; speedMph: number | null; place: string | null }[];
}

export async function positionsForOrder(ctx: Ctx, orderId: string, limit = 500) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  return db.select().from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), eq(s.positions.orderId, orderId))).orderBy(desc(s.positions.at)).limit(limit);
}

// ---------- driver app ----------

export async function driverToday(tenantId: string, driverId: string) {
  const ctx = systemCtx(tenantId);
  const [driver] = await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  const legs = await db
    .select()
    .from(s.legs)
    .where(and(eq(s.legs.tenantId, tenantId), inArray(s.legs.state, ACTIVE), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId))))
    .orderBy(s.legs.dispatchedAt, s.legs.seq);
  const orderIds = [...new Set(legs.map((l) => l.orderId))];
  const [orders, stops, trucks] = await Promise.all([
    orderIds.length ? db.select().from(s.orders).where(inArray(s.orders.id, orderIds)) : Promise.resolve([]),
    orderIds.length ? db.select().from(s.stops).where(inArray(s.stops.orderId, orderIds)).orderBy(s.stops.seq) : Promise.resolve([]),
    db.select({ id: s.trucks.id, unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, tenantId)),
  ]);
  const crossingLegIds = legs.filter((l) => l.type === "crossing").map((l) => l.id);
  const xs = crossingLegIds.length ? await db.select().from(s.crossings).where(inArray(s.crossings.legId, crossingLegIds)) : [];
  const items = legs.map((leg) => {
    const order = orders.find((o) => o.id === leg.orderId)!;
    const from = stops.find((x) => x.id === leg.fromStopId) ?? null;
    const to = stops.find((x) => x.id === leg.toStopId) ?? null;
    const truck = trucks.find((t) => t.id === leg.truckId) ?? null;
    const x = xs.find((c) => c.legId === leg.id);
    const crossing = x
      ? { id: x.id, state: x.state, trailerNumber: x.trailerNumber, packetToken: x.packetSentAt ? x.packetToken : null, packetSentAt: x.packetSentAt, nextStep: ({ packet_sent: "departed_yard", departed_yard: "at_mx_customs", at_mx_customs: "in_us_customs", in_us_customs: "cleared" } as Record<string, string>)[x.state] ?? null }
      : null;
    const mid = pendingMidStop(leg, stops.filter((x) => x.orderId === leg.orderId));
    const next = mid ? { to: leg.state, label: `${mid.which === "arrived" ? "Arrived at" : "Leaving"} ${mid.stop.name}`, es: `${mid.which === "arrived" ? "Llegué a" : "Saliendo de"} ${mid.stop.name}` } : nextStep(leg.state);
    const mids = midStops(leg, stops.filter((x) => x.orderId === leg.orderId));
    return { leg, order: { id: order.id, orderNumber: order.orderNumber, equipment: order.equipment, cargoNote: order.cargoNote, refs: order.refs, state: order.state }, from, to, mids, truck, next, crossing };
  });
  // the leg the driver is on = first non-dispatched active leg, else the first offered one
  const current = items.find((i) => i.leg.state !== "dispatched") ?? items[0] ?? null;
  return { ctx, driver: { id: driver.id, name: driver.name, driverType: driver.driverType }, current, items };
}

export function nextStep(state: LegState): { to: LegState; label: string; es: string } | null {
  const map: Partial<Record<LegState, { to: LegState; label: string; es: string }>> = {
    dispatched: { to: "accepted", label: "Accept this load", es: "Aceptar esta carga" },
    accepted: { to: "en_route_to_pickup", label: "Rolling to pickup", es: "Saliendo a recoger" },
    en_route_to_pickup: { to: "at_pickup", label: "Arrived at pickup", es: "Llegué a recoger" },
    at_pickup: { to: "loaded", label: "Loaded — leaving", es: "Cargado — saliendo" },
    loaded: { to: "en_route", label: "En route to delivery", es: "En ruta a entrega" },
    en_route: { to: "at_delivery", label: "Arrived at delivery", es: "Llegué a entrega" },
    at_delivery: { to: "completed", label: "Delivered — empty", es: "Entregado — vacío" },
  };
  return map[state] ?? null;
}

export type DriverStepInput = { lat?: number | string | null; lng?: number | string | null; accuracyM?: number | null; note?: string | null; decline?: boolean; declineReason?: string | null; crossingStep?: string | null; crossingHold?: string | null };

/** The driver pressed the button. Verified when the phone gave us a position. */
export async function driverStep(tenantId: string, driverId: string, legId: string, input: DriverStepInput) {
  const ctx = systemCtx(tenantId);
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  if (leg.driverId !== driverId && leg.coDriverId !== driverId) throw new NotFoundError("leg", legId);
  const hasPos = input.lat != null && input.lng != null && input.lat !== "" && input.lng !== "";
  if (hasPos) await recordPosition(ctx, { source: "driver_app", lat: input.lat!, lng: input.lng!, accuracyM: input.accuracyM ?? null, truckId: leg.truckId, driverId, legId: leg.id }).catch(() => null);
  if (input.decline) {
    if (!input.declineReason?.trim()) throw new ValidationError("say why", "declineReason");
    return declineLeg(ctx, leg.id, input.declineReason.trim(), "driver_app");
  }
  if (input.crossingStep || input.crossingHold) {
    const X = await import("./crossing");
    const [x] = await db.select().from(s.crossings).where(eq(s.crossings.legId, leg.id)).limit(1);
    if (!x) throw new NotFoundError("crossing", leg.id);
    if (input.crossingHold) await X.hold(ctx, x.id, input.crossingHold, "driver_app");
    else await X.step(ctx, x.id, input.crossingStep as import("@/db/schema").CrossingState, { source: "driver_app", verified: hasPos });
    return leg;
  }
  if (leg.state === "dispatched") return acceptLeg(ctx, leg.id, "driver_app");
  if (leg.state === "en_route") {
    const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, leg.orderId)));
    const mid = pendingMidStop(leg, stops);
    if (mid) return stampStop(ctx, leg.id, mid.stop.id, mid.which, { source: "driver_app", verified: hasPos, lat: hasPos ? String(Number(input.lat).toFixed(6)) : undefined, lng: hasPos ? String(Number(input.lng).toFixed(6)) : undefined, note: input.note ?? undefined });
  }
  const step = nextStep(leg.state);
  if (!step) throw new ValidationError("nothing further on this leg");
  return advanceLeg(ctx, leg.id, step.to, { source: "driver_app", verified: hasPos, lat: hasPos ? String(Number(input.lat).toFixed(6)) : undefined, lng: hasPos ? String(Number(input.lng).toFixed(6)) : undefined, note: input.note ?? undefined });
}

// ---------- customer tracking link ----------

/** What a customer may see: stops, progress, last position. No rates, no carrier pay, no driver phone. */
export async function trackingView(tenantId: string, orderId: string) {
  const [order] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!order) throw new NotFoundError("order", orderId);
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  const [stops, legs, events, last] = await Promise.all([
    db.select().from(s.stops).where(eq(s.stops.orderId, orderId)).orderBy(s.stops.seq),
    db.select().from(s.legs).where(eq(s.legs.orderId, orderId)).orderBy(s.legs.seq),
    db.select().from(s.legEvents).where(and(eq(s.legEvents.orderId, orderId), eq(s.legEvents.kind, "transition"))).orderBy(desc(s.legEvents.at)).limit(50),
    db.select().from(s.positions).where(and(eq(s.positions.tenantId, tenantId), eq(s.positions.orderId, orderId))).orderBy(desc(s.positions.at)).limit(1),
  ]);
  return {
    carrier: tenant?.name ?? "",
    order: { orderNumber: order.orderNumber, state: order.state, equipment: order.equipment, refs: { po: order.refs.po, reference: order.refs.reference, shipment: order.refs.shipment }, deliveredAt: order.deliveredAt },
    stops: stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, city: st.address?.city ?? null, state: st.address?.state ?? null, country: st.country, windowStart: st.windowStart, windowEnd: st.windowEnd, arrivedAt: st.arrivedAt, departedAt: st.departedAt })),
    legs: legs.map((l) => ({ id: l.id, seq: l.seq, type: l.type, state: l.state, fromStopId: l.fromStopId, toStopId: l.toStopId })),
    events: events.map((e) => ({ at: e.at, legId: e.legId, toState: e.toState, verified: e.verified })),
    lastPosition: last[0] ? { at: last[0].at, lat: last[0].lat, lng: last[0].lng, place: last[0].place, source: last[0].source } : null,
  };
}

// ---------- watchdog ----------

/** Job: a moving leg on our own truck with no position for `hours` gets a yellow no_position flag, once. */
export async function flagStaleTracking(now = new Date(), hours = 2) {
  const cutoff = new Date(now.getTime() - hours * 3600_000);
  const moving = await db.select().from(s.legs).where(and(inArray(s.legs.state, MOVING), eq(s.legs.assigneeKind, "truck")));
  let flagged = 0;
  for (const leg of moving) {
    const [open] = await db.select({ id: s.flags.id }).from(s.flags).where(and(eq(s.flags.legId, leg.id), eq(s.flags.code, "no_position"), sql`${s.flags.clearedAt} is null`)).limit(1);
    const [recent] = await db
      .select({ id: s.positions.id })
      .from(s.positions)
      .where(and(eq(s.positions.tenantId, leg.tenantId), or(eq(s.positions.legId, leg.id), leg.truckId ? eq(s.positions.truckId, leg.truckId) : sql`false`), gt(s.positions.at, cutoff)))
      .limit(1);
    if (recent) {
      if (open) await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, open.id));
      continue;
    }
    if (open) continue;
    // only after the leg has been moving for at least `hours`
    const [lastMove] = await db.select({ at: s.legEvents.at }).from(s.legEvents).where(and(eq(s.legEvents.legId, leg.id), eq(s.legEvents.kind, "transition"))).orderBy(desc(s.legEvents.recordedAt)).limit(1);
    if (lastMove && lastMove.at.getTime() > cutoff.getTime()) continue;
    await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: leg.orderId, legId: leg.id, code: "no_position", level: "yellow", title: `No position for ${hours}h`, detail: "No driver-app or ELD ping while moving", owner: "dispatch" });
    flagged++;
  }
  return { flagged };
}

export { LEG_FORWARD };

// ---------- appointment windows ----------

const OPEN_STOP_STATES: LegState[] = ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route"];

/**
 * Job: appointment windows against the clock, no map needed.
 * - window_missed (red): the truck has not arrived at a stop whose window has closed.
 * - window_risk (yellow): the pickup window opens within `riskHours` and nobody has accepted the leg yet.
 * Both clear themselves: arriving clears the first; accepting clears the second.
 */
export async function flagWindows(now = new Date(), riskHours = 2) {
  const legs = await db.select().from(s.legs).where(inArray(s.legs.state, OPEN_STOP_STATES));
  const stopIds = [...new Set(legs.flatMap((l) => [l.fromStopId, l.toStopId]).filter((x): x is string => !!x))];
  const stops = stopIds.length ? await db.select().from(s.stops).where(inArray(s.stops.id, stopIds)) : [];
  const byId = new Map(stops.map((st) => [st.id, st]));
  const open = await db.select().from(s.flags).where(and(inArray(s.flags.code, ["window_missed", "window_risk"]), sql`${s.flags.clearedAt} is null`));
  const openFor = (legId: string, code: string, stopId: string) => open.find((f) => f.legId === legId && f.code === code && f.data?.stopId === stopId);
  let missed = 0;
  let atRisk = 0;
  let cleared = 0;
  const soon = new Date(now.getTime() + riskHours * 3600_000);
  for (const leg of legs) {
    const from = leg.fromStopId ? byId.get(leg.fromStopId) : undefined;
    const to = leg.toStopId ? byId.get(leg.toStopId) : undefined;
    // the stop the truck is heading for: pickup until it has been reached, then the delivery
    const target = from && !from.arrivedAt ? from : to && !to.arrivedAt ? to : null;
    // missed windows
    for (const st of [from, to]) {
      if (!st) continue;
      const flag = openFor(leg.id, "window_missed", st.id);
      const missedNow = !st.arrivedAt && !!st.windowEnd && st.windowEnd.getTime() < now.getTime() && st === target;
      if (missedNow && !flag) {
        await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: leg.orderId, legId: leg.id, code: "window_missed", level: "red", title: `Missed the ${st.type === "pickup" ? "pickup" : st.type === "delivery" ? "delivery" : "stop"} window at ${st.name}`, detail: `Window closed ${st.windowEnd!.toISOString()} and the truck has not arrived. Call the ${st.type === "pickup" ? "shipper" : "receiver"} and the driver.`, owner: "dispatch", data: { stopId: st.id } });
        missed++;
      } else if (!missedNow && flag) {
        await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, flag.id));
        cleared++;
      }
    }
    // at risk: pickup opens soon and the leg is not accepted
    if (from) {
      const flag = openFor(leg.id, "window_risk", from.id);
      const riskNow = !from.arrivedAt && !!from.windowStart && from.windowStart.getTime() < soon.getTime() && ["planned", "dispatched"].includes(leg.state);
      if (riskNow && !flag) {
        const mins = Math.max(0, Math.round((from.windowStart!.getTime() - now.getTime()) / 60_000));
        await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: leg.orderId, legId: leg.id, code: "window_risk", level: "yellow", title: mins > 0 ? `Pickup at ${from.name} opens in ${mins} min and nobody has accepted` : `Pickup window at ${from.name} is open and nobody has accepted`, detail: leg.state === "planned" ? "The leg is planned but was never sent." : "Sent, no answer yet. Call them or reassign.", owner: "dispatch", data: { stopId: from.id } });
        atRisk++;
      } else if (!riskNow && flag) {
        await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, flag.id));
        cleared++;
      }
    }
  }
  // legs that left the open set (completed, cancelled, declined…) take their window flags with them
  for (const f of open) {
    if (!legs.some((l) => l.id === f.legId)) {
      await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, f.id));
      cleared++;
    }
  }
  return { missed, atRisk, cleared };
}
