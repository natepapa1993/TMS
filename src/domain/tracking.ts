import { and, eq, inArray, desc, sql, or, gt } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { PositionSource, LegState } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { advanceLeg, acceptLeg, declineLeg, midStops, pendingMidStop, stampStop, NotFoundError, ValidationError } from "./orders";
import { LEG_FORWARD } from "./states";
import { coords, roadMiles } from "@/lib/geo";

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
  const active = await db
    .select()
    .from(s.legs)
    .where(and(eq(s.legs.tenantId, tenantId), inArray(s.legs.state, ACTIVE), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId))))
    .orderBy(s.legs.dispatchedAt, s.legs.seq);
  // a load delivered in the last day stays on the phone until its POD is in (the driver can still take the photo)
  const recent = await db
    .select()
    .from(s.legs)
    .where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.state, "completed"), gt(s.legs.completedAt, new Date(Date.now() - 24 * 3600_000)), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId))));
  const legs = [...active, ...recent];
  const orderIds = [...new Set(legs.map((l) => l.orderId))];
  const [orders, stops, trucks] = await Promise.all([
    orderIds.length ? db.select().from(s.orders).where(inArray(s.orders.id, orderIds)) : Promise.resolve([]),
    orderIds.length ? db.select().from(s.stops).where(inArray(s.stops.orderId, orderIds)).orderBy(s.stops.seq) : Promise.resolve([]),
    db.select({ id: s.trucks.id, unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, tenantId)),
  ]);
  const crossingLegIds = legs.filter((l) => l.type === "crossing").map((l) => l.id);
  const legsOfOrders = orderIds.length ? await db.select({ id: s.legs.id, orderId: s.legs.orderId, toStopId: s.legs.toStopId, state: s.legs.state }).from(s.legs).where(inArray(s.legs.orderId, orderIds)) : [];
  const xs = crossingLegIds.length ? await db.select().from(s.crossings).where(inArray(s.crossings.legId, crossingLegIds)) : [];
  const XL = xs.length ? await import("./crossing") : null;
  // photos already on file for these orders (and, on a trip, on its shipments): the app shows a check instead of asking twice
  const shipments = orderIds.length ? await db.select({ id: s.orders.id, tripId: s.orders.tripId, deliveryStopId: s.orders.deliveryStopId }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), inArray(s.orders.tripId, orderIds))) : [];
  const docOrderIds = [...orderIds, ...shipments.map((x) => x.id)];
  const photos = docOrderIds.length ? await db.select({ subjectId: s.documents.subjectId, code: s.documents.code }).from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, docOrderIds), inArray(s.documents.code, ["POD", "SEAL_PHOTO"]), inArray(s.documents.status, ["present", "verified"]))) : [];
  const items = legs.map((leg) => {
    const order = orders.find((o) => o.id === leg.orderId)!;
    const from = stops.find((x) => x.id === leg.fromStopId) ?? null;
    const to = stops.find((x) => x.id === leg.toStopId) ?? null;
    const truck = trucks.find((t) => t.id === leg.truckId) ?? null;
    const x = xs.find((c) => c.legId === leg.id);
    // a crossing leg is one ordered flow: the leg's steps to the caja, then the border steps (never both at once)
    const flow = x ? XL!.crossingDriverNext(leg.state, x.state) : null;
    const crossing = x
      ? { id: x.id, state: x.state, trailerNumber: x.trailerNumber, packetToken: x.packetSentAt ? x.packetToken : null, packetSentAt: x.packetSentAt, nextStep: flow?.kind === "border" ? flow.to : null, wait: flow?.kind === "wait" ? { en: flow.en, es: flow.es } : leg.state === "loaded" && flow?.kind === "leg" ? { en: "No crossing packet from dispatch yet — call before the bridge", es: "Aún no hay paquete de cruce — llama antes del puente" } : null, fromCountry: x.fromCountry, toCountry: x.toCountry, stateLabel: XL!.crossingStateLabel(x.state, x), steps: Object.fromEntries((["departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as const).map((k) => [k, XL!.stepLabel(k, x) ?? { en: k, es: k }])) }
      : null;
    const mid = pendingMidStop(leg, stops.filter((x) => x.orderId === leg.orderId));
    const plain = mid ? { to: leg.state, label: `${mid.which === "arrived" ? "Arrived at" : "Leaving"} ${mid.stop.name}`, es: `${mid.which === "arrived" ? "Llegué a" : "Saliendo de"} ${mid.stop.name}` } : nextStep(leg.state);
    const next = !flow ? plain : flow.kind === "leg" ? nextStep(leg.state) : null;
    // the freight this leg picks up: is it there yet (the leg that brings it delivered)?
    const before = legsOfOrders.find((p) => p.orderId === leg.orderId && p.toStopId === leg.fromStopId && p.id !== leg.id);
    const freightReady = before ? before.state === "completed" : null;
    const mids = midStops(leg, stops.filter((x) => x.orderId === leg.orderId));
    const stopId = leg.state === "completed" ? leg.toStopId : currentStopId(leg, mids);
    const orderStops = stops.filter((x) => x.orderId === leg.orderId);
    const sealExpected = (() => {
      // what the driver should find on the trailer at the next opening: the last seal applied before this leg's next stop
      const nextStopId = leg.state === "en_route" ? (mids.find((m) => !m.arrivedAt)?.id ?? leg.toStopId) : ["loaded"].includes(leg.state) ? leg.toStopId : null;
      const seq = orderStops.find((x) => x.id === nextStopId)?.seq;
      if (seq == null) return null;
      return [...orderStops].filter((x) => x.seq < seq && x.sealOut).sort((p, q) => q.seq - p.seq)[0]?.sealOut ?? null;
    })();
    const podTargets = photoTargets(order, shipments, stopId);
    const docs = { pod: podTargets.length > 0 && podTargets.every((id) => photos.some((d) => d.subjectId === id && d.code === "POD")), seal: photos.some((d) => d.subjectId === order.id && d.code === "SEAL_PHOTO") };
    const held = order.state === "exception";
    return { leg, order: { id: order.id, orderNumber: order.orderNumber, equipment: order.equipment, cargoNote: order.cargoNote, refs: order.refs, state: order.state, held, holdReason: held ? (order.holdReason ?? null) : null }, from, to, mids, truck, next: held || leg.state === "completed" ? null : next, crossing, docs, sealExpected, freightReady };
  });
  // done loads only stay while their POD is missing (on a trip: a stop's shipments), and after the open ones
  // (only a real delivery wants a POD: a crossing or a hand-off that ends at a yard doesn't)
  const shown = items.filter((i) => i.leg.state !== "completed" || (!i.docs.pod && i.order.state !== "cancelled" && i.to?.type === "delivery"));
  // in the order the driver will run them: the one rolling first, then by pickup time (M13)
  const at = (i: (typeof items)[number]) => i.from?.windowStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rank = (i: (typeof items)[number]) => (i.leg.state === "completed" ? 2 : ["dispatched", "accepted"].includes(i.leg.state) ? 1 : 0);
  shown.sort((p, q) => rank(p) - rank(q) || at(p) - at(q) || p.leg.seq - q.leg.seq);
  // the leg the driver is on = the rolling one, else the next pickup; a done load waiting for its POD last
  const current = shown[0] ?? null;
  return { ctx, driver: { id: driver.id, name: driver.name, driverType: driver.driverType }, current, items: shown };
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

export type DriverStepInput = { lat?: number | string | null; lng?: number | string | null; accuracyM?: number | null; note?: string | null; decline?: boolean; declineReason?: string | null; crossingStep?: string | null; crossingHold?: string | null; seal?: string | null };

/** The driver pressed the button. Verified when the phone gave us a position. */
export async function driverStep(tenantId: string, driverId: string, legId: string, input: DriverStepInput) {
  const ctx = systemCtx(tenantId);
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  if (leg.driverId !== driverId && leg.coDriverId !== driverId) throw new NotFoundError("leg", legId);
  const hasPos = input.lat != null && input.lng != null && input.lat !== "" && input.lng !== "";
  if (!input.decline) {
    // a held load's steps are frozen (M8): the app says so; a stale button can't move it either
    const [o] = await db.select({ state: s.orders.state, holdReason: s.orders.holdReason }).from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
    if (o?.state === "exception") throw new ValidationError(`This load is on hold — wait for dispatch${o.holdReason ? ` (${o.holdReason})` : ""} · Carga en espera — espera a despacho`);
  }
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
    else await X.step(ctx, x.id, input.crossingStep as import("@/db/schema").CrossingState, { source: "driver_app", verified: hasPos, seal: input.seal ?? null });
    return leg;
  }
  if (leg.state === "dispatched") return acceptLeg(ctx, leg.id, "driver_app");
  if (leg.state === "en_route") {
    const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, leg.orderId)));
    const mid = pendingMidStop(leg, stops);
    if (mid) return stampStop(ctx, leg.id, mid.stop.id, mid.which, { source: "driver_app", verified: hasPos, lat: hasPos ? String(Number(input.lat).toFixed(6)) : undefined, lng: hasPos ? String(Number(input.lng).toFixed(6)) : undefined, note: input.note ?? undefined, seal: input.seal ?? null });
  }
  const step = nextStep(leg.state);
  if (!step) throw new ValidationError("nothing further on this leg");
  return advanceLeg(ctx, leg.id, step.to, { source: "driver_app", verified: hasPos, lat: hasPos ? String(Number(input.lat).toFixed(6)) : undefined, lng: hasPos ? String(Number(input.lng).toFixed(6)) : undefined, note: input.note ?? undefined, seal: input.seal ?? null });
}

/** The stop the driver is standing at, if any: the delivery once arrived, a mid stop between arrive and depart, the pickup while loading. */
export function currentStopId(leg: { state: LegState; fromStopId: string | null; toStopId: string | null }, mids: { id: string; arrivedAt: Date | string | null; departedAt: Date | string | null }[]) {
  if (leg.state === "at_delivery") return leg.toStopId;
  if (leg.state === "at_pickup") return leg.fromStopId;
  if (leg.state === "en_route") return mids.find((m) => m.arrivedAt && !m.departedAt)?.id ?? null;
  return null;
}

/** Where a POD taken at `stopId` belongs: on a tailgate trip, every shipment getting off there; otherwise the order itself. */
function photoTargets(order: { id: string; kind: string }, shipments: { id: string; tripId: string | null; deliveryStopId: string | null }[], stopId: string | null) {
  if (order.kind === "trip") {
    const here = shipments.filter((x) => x.tripId === order.id && stopId && x.deliveryStopId === stopId);
    return here.map((x) => x.id);
  }
  return [order.id];
}

/**
 * The orders a POD for this leg belongs to, for whoever is uploading it (driver app, carrier portal, office):
 * the order itself, or on a tailgate trip every shipment getting off at the leg's stops — at one stop when
 * `stopId` is given, otherwise anywhere between the leg's first and last stop.
 */
export async function podTargetsForLeg(tenantId: string, leg: { orderId: string; fromStopId: string | null; toStopId: string | null }, stopId: string | null = null) {
  const [order] = await db.select({ id: s.orders.id, kind: s.orders.kind }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.id, leg.orderId))).limit(1);
  if (!order) throw new NotFoundError("order", leg.orderId);
  if (order.kind !== "trip") return [order.id];
  const stops = await db.select({ id: s.stops.id, seq: s.stops.seq }).from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, order.id))).orderBy(s.stops.seq);
  const shipments = await db.select({ id: s.orders.id, tripId: s.orders.tripId, deliveryStopId: s.orders.deliveryStopId }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.tripId, order.id)));
  if (stopId) return photoTargets(order, shipments, stopId);
  const from = stops.find((x) => x.id === leg.fromStopId)?.seq ?? -Infinity;
  const to = stops.find((x) => x.id === leg.toStopId)?.seq ?? Infinity;
  const onLeg = new Set(stops.filter((x) => x.seq > from && x.seq <= to).map((x) => x.id));
  return shipments.filter((x) => x.deliveryStopId && onLeg.has(x.deliveryStopId)).map((x) => x.id);
}

export type DriverPhoto = { code: "POD" | "SEAL_PHOTO"; fileName: string; mimeType: string; bytes: Buffer };

/**
 * A photo from the driver's phone (spec §5.2: seal and POD photos). A POD lands on the order — on a
 * tailgate trip, on every shipment delivering at the stop the driver is at — as the POD billing waits
 * for; a seal photo on the order. Noted on the leg's timeline. Never blocks the milestone button.
 */
export async function driverUploadPhoto(tenantId: string, driverId: string, legId: string, photo: DriverPhoto) {
  const ctx = systemCtx(tenantId);
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg || (leg.driverId !== driverId && leg.coDriverId !== driverId)) throw new NotFoundError("leg", legId);
  if (!["POD", "SEAL_PHOTO"].includes(photo.code)) throw new ValidationError("POD or seal photo", "code");
  const [order] = await db.select({ id: s.orders.id, kind: s.orders.kind, orderNumber: s.orders.orderNumber }).from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  if (!order) throw new NotFoundError("order", leg.orderId);
  const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, leg.orderId))).orderBy(s.stops.seq);
  // a delivered leg still on the phone for its POD: the photo is for its delivery stop
  const stopId = leg.state === "completed" ? leg.toStopId : currentStopId(leg, midStops(leg, stops));
  let targets = [order.id];
  if (photo.code === "POD") {
    const here = stops.find((x) => x.id === stopId);
    if (!here || here.type === "pickup") throw new ValidationError("take the POD photo once you have arrived at the delivery · toma la foto del POD al llegar a la entrega", "code");
    const shipments = order.kind === "trip" ? await db.select({ id: s.orders.id, tripId: s.orders.tripId, deliveryStopId: s.orders.deliveryStopId }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.tripId, order.id))) : [];
    targets = photoTargets(order, shipments, stopId);
    if (!targets.length) throw new ValidationError("no shipment gets off at this stop", "code");
  }
  const { uploadOrderDocument } = await import("./billing");
  const rows = [];
  for (const orderId of targets) rows.push(await uploadOrderDocument(ctx, orderId, { code: photo.code, fileName: photo.fileName, mimeType: photo.mimeType, bytes: photo.bytes, source: "driver_app" }));
  const stop = stops.find((x) => x.id === stopId);
  await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: leg.id, orderId: leg.orderId, kind: "document", source: "driver_app", verified: false, note: `${photo.code === "POD" ? "POD" : "Seal"} photo from the driver app${stop ? ` at ${stop.name}` : ""}${targets.length > 1 ? ` (${targets.length} shipments)` : ""}` });
  return rows;
}

/** The driver writes to dispatch from the app. Lands in Messages like a WhatsApp reply, on the leg they are on. */
export async function driverMessage(tenantId: string, driverId: string, legId: string | null, body: string) {
  const text = body?.trim();
  if (!text) throw new ValidationError("write something", "body");
  if (text.length > 2000) throw new ValidationError("keep it under 2,000 characters", "body");
  const [driver] = await db.select({ id: s.drivers.id, name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  let leg: { id: string; orderId: string } | null = null;
  if (legId) {
    const [l] = await db.select({ id: s.legs.id, orderId: s.legs.orderId, driverId: s.legs.driverId, coDriverId: s.legs.coDriverId }).from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
    if (l && (l.driverId === driverId || l.coDriverId === driverId)) leg = l;
  }
  const [row] = await db.insert(s.inboundMessages).values({ id: newId(), tenantId, channel: "driver_app", from: driver.phone?.replace(/[^\d]/g, "") || driver.id, fromName: driver.name, body: text, driverId, legId: leg?.id ?? null, orderId: leg?.orderId ?? null }).returning();
  if (leg) await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: leg.id, orderId: leg.orderId, kind: "message", source: "driver_app", verified: false, note: `${driver.name}: ${text}` });
  return row;
}

/** Dispatch answers a driver: shown in the app on the next open, and on WhatsApp too when the number is connected. */
export async function replyToDriver(ctx: Ctx, driverId: string, body: string, orderId?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const text = body?.trim();
  if (!text) throw new ValidationError("write something", "body");
  const [driver] = await db.select({ id: s.drivers.id, name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  const { enqueue, whatsappFor, deliverQueued } = await import("@/lib/outbox");
  const row = await enqueue(ctx, { channel: "driver_app", to: driver.phone || driver.name, body: text, subjectKind: "driver_reply", subjectId: driverId, meta: { kind: "general", orderId: orderId ?? null } });
  if (driver.phone && (await whatsappFor(ctx.tenantId))) await enqueue(ctx, { channel: "whatsapp", to: driver.phone, body: text, subjectKind: "driver_reply", subjectId: driverId, meta: { kind: "general", template: null } });
  await deliverQueued(5).catch(() => null);
  if (orderId) {
    const [l] = await db.select({ id: s.legs.id }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId), or(eq(s.legs.driverId, driverId), eq(s.legs.coDriverId, driverId)))).orderBy(desc(s.legs.seq)).limit(1);
    if (l) await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: l.id, orderId, kind: "message", source: "dispatcher", verified: false, note: `Dispatch to ${driver.name}: ${text}` });
  }
  return row;
}

/** The conversation as the driver sees it: what they wrote and what dispatch answered, oldest first. */
export async function driverThread(tenantId: string, driverId: string, limit = 40) {
  const [ins, outs] = await Promise.all([
    db.select({ id: s.inboundMessages.id, body: s.inboundMessages.body, at: s.inboundMessages.receivedAt, orderId: s.inboundMessages.orderId, handledAt: s.inboundMessages.handledAt }).from(s.inboundMessages).where(and(eq(s.inboundMessages.tenantId, tenantId), eq(s.inboundMessages.driverId, driverId), inArray(s.inboundMessages.channel, ["driver_app", "whatsapp"]))).orderBy(desc(s.inboundMessages.receivedAt)).limit(limit),
    db.select({ id: s.outbox.id, body: s.outbox.body, at: s.outbox.createdAt, meta: s.outbox.meta }).from(s.outbox).where(and(eq(s.outbox.tenantId, tenantId), eq(s.outbox.channel, "driver_app"), eq(s.outbox.subjectId, driverId))).orderBy(desc(s.outbox.createdAt)).limit(limit),
  ]);
  const all = [...ins.map((m) => ({ id: m.id, who: "driver" as const, body: m.body, at: m.at, seen: !!m.handledAt })), ...outs.map((m) => ({ id: m.id, who: "dispatch" as const, body: m.body, at: m.at, seen: true }))];
  return all.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-limit);
}

// ---------- customer tracking link ----------

/** What a customer may see: stops, progress, last position. No rates, no carrier pay, no driver phone. */
export async function trackingView(tenantId: string, orderId: string) {
  const [order] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!order) throw new NotFoundError("order", orderId);
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  const [cust] = order.customerId ? await db.select({ country: s.customers.country }).from(s.customers).where(eq(s.customers.id, order.customerId)).limit(1) : [];
  const [stops, legs, events, last] = await Promise.all([
    db.select().from(s.stops).where(eq(s.stops.orderId, orderId)).orderBy(s.stops.seq),
    db.select().from(s.legs).where(eq(s.legs.orderId, orderId)).orderBy(s.legs.seq),
    db.select().from(s.legEvents).where(and(eq(s.legEvents.orderId, orderId), eq(s.legEvents.kind, "transition"))).orderBy(desc(s.legEvents.at)).limit(50),
    db.select().from(s.positions).where(and(eq(s.positions.tenantId, tenantId), eq(s.positions.orderId, orderId))).orderBy(desc(s.positions.at)).limit(1),
  ]);
  return {
    carrier: tenant?.name ?? "",
    order: { orderNumber: order.orderNumber, state: order.state, equipment: order.equipment, refs: { po: order.refs.po, reference: order.refs.reference, shipment: order.refs.shipment }, deliveredAt: order.deliveredAt },
    customerCountry: cust?.country ?? null,
    stops: stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, city: st.address?.city ?? null, state: st.address?.state ?? null, country: st.country, windowStart: st.windowStart, windowEnd: st.windowEnd, arrivedAt: st.arrivedAt, departedAt: st.departedAt })),
    legs: legs.map((l) => ({ id: l.id, seq: l.seq, type: l.type, state: l.state, fromStopId: l.fromStopId, toStopId: l.toStopId })),
    events: events.map((e) => ({ at: e.at, legId: e.legId, toState: e.toState, verified: e.verified })),
    lastPosition: last[0] ? { at: last[0].at, lat: last[0].lat, lng: last[0].lng, place: last[0].place, source: last[0].source } : null,
    // the board's ETA: a check call's beats GPS until a newer position (N4)
    etas: Object.fromEntries(Object.entries(await mergedOrderEtas(tenantId, orderId)).map(([legId, e]) => [legId, { at: e.at, stopId: e.stopId, miles: e.miles, late: e.late, positionAt: e.positionAt, source: e.source }])),
  };
}

// ---------- ETA (spec §5: from the last verified position, never from the carrier's number) ----------

/** Default corridor speeds until the company's own runs have taught better ones. */
const DEFAULT_MPH: Record<string, number> = { MX: 42, US: 52, X: 45 };
const profileCache = new Map<string, { at: number; mph: Record<string, number> }>();

/**
 * Corridor speed profile, learned per side of the border from the company's completed legs in the last
 * 180 days: road miles between the two stops over the hours between leaving one and arriving at the
 * other. Falls back to the defaults with fewer than three runs. Cached ten minutes.
 */
export async function speedProfile(tenantId: string, now = new Date()) {
  const hit = profileCache.get(tenantId);
  if (hit && now.getTime() - hit.at < 600_000) return hit.mph;
  const since = new Date(now.getTime() - 180 * 86400_000);
  const legs = await db.select({ id: s.legs.id, fromStopId: s.legs.fromStopId, toStopId: s.legs.toStopId, type: s.legs.type }).from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.state, "completed"), gt(s.legs.completedAt, since)));
  const stopIds = [...new Set(legs.flatMap((l) => [l.fromStopId, l.toStopId]).filter((x): x is string => !!x))];
  const stops = stopIds.length ? await db.select({ id: s.stops.id, lat: s.stops.lat, lng: s.stops.lng, country: s.stops.country, departedAt: s.stops.departedAt, arrivedAt: s.stops.arrivedAt }).from(s.stops).where(inArray(s.stops.id, stopIds)) : [];
  const samples: Record<string, number[]> = { MX: [], US: [], X: [] };
  for (const l of legs) {
    const a = stops.find((x) => x.id === l.fromStopId);
    const b = stops.find((x) => x.id === l.toStopId);
    const ca = a && coords(a.lat, a.lng);
    const cb = b && coords(b.lat, b.lng);
    if (!a || !b || !ca || !cb || !a.departedAt || !b.arrivedAt) continue;
    const hours = (b.arrivedAt.getTime() - a.departedAt.getTime()) / 3600_000;
    const miles = roadMiles(ca, cb);
    if (hours < 0.25 || miles < 5) continue;
    const mph = miles / hours;
    if (mph < 5 || mph > 80) continue;
    samples[l.type === "crossing" ? "X" : a.country === "MX" && b.country === "MX" ? "MX" : a.country === "US" && b.country === "US" ? "US" : "X"].push(mph);
  }
  const mph: Record<string, number> = { ...DEFAULT_MPH };
  for (const k of Object.keys(samples)) if (samples[k].length >= 3) mph[k] = Math.round(samples[k].reduce((p, q) => p + q, 0) / samples[k].length);
  profileCache.set(tenantId, { at: now.getTime(), mph });
  return mph;
}

export type Eta = { at: Date; miles: number; mph: number; stopId: string; stopName: string; positionAt: Date; source: string; windowEnd: Date | null; late: boolean };

/** The stop this leg is heading for, given where it is in its states. */
function nextStopFor(leg: { state: LegState; fromStopId: string | null; toStopId: string | null }, mids: { id: string; arrivedAt: Date | null; departedAt: Date | null }[]) {
  if (["accepted", "en_route_to_pickup"].includes(leg.state)) return leg.fromStopId;
  if (leg.state === "loaded") return mids.find((m) => !m.arrivedAt)?.id ?? leg.toStopId;
  if (leg.state === "en_route") return mids.find((m) => !m.arrivedAt)?.id ?? leg.toStopId;
  return null;
}

/**
 * ETA for a moving leg: last position on the leg (or its truck) inside six hours, road miles to the next
 * stop with coordinates, the corridor speed. Null when the truck has not reported or the stop has no
 * coordinates yet (they are learned on the first verified arrival).
 */
export async function legEta(tenantId: string, legId: string, now = new Date()): Promise<Eta | null> {
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) return null;
  const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, leg.orderId))).orderBy(s.stops.seq);
  return etaFrom(tenantId, leg, stops, now);
}

async function etaFrom(tenantId: string, leg: typeof s.legs.$inferSelect, stops: (typeof s.stops.$inferSelect)[], now: Date): Promise<Eta | null> {
  const mids = midStops(leg, stops);
  const stopId = nextStopFor(leg, mids);
  const stop = stops.find((x) => x.id === stopId);
  const dest = stop && coords(stop.lat, stop.lng);
  if (!stop || !dest) return null;
  const cutoff = new Date(now.getTime() - 6 * 3600_000);
  const [pos] = await db
    .select()
    .from(s.positions)
    .where(and(eq(s.positions.tenantId, tenantId), or(eq(s.positions.legId, leg.id), leg.truckId ? and(eq(s.positions.truckId, leg.truckId), gt(s.positions.at, leg.dispatchedAt ?? cutoff)) : sql`false`), gt(s.positions.at, cutoff)))
    .orderBy(desc(s.positions.at))
    .limit(1);
  let here = pos && coords(pos.lat, pos.lng);
  let fix = pos ? { at: pos.at, source: pos.source as string } : null;
  if (!here) {
    // no ping, but a step pressed with a fix (a verified milestone) is a position too
    const [ev] = await db.select({ at: s.legEvents.at, lat: s.legEvents.lat, lng: s.legEvents.lng, source: s.legEvents.source }).from(s.legEvents).where(and(eq(s.legEvents.legId, leg.id), eq(s.legEvents.verified, true), sql`${s.legEvents.lat} is not null`, gt(s.legEvents.at, cutoff))).orderBy(desc(s.legEvents.at)).limit(1);
    here = ev && coords(ev.lat, ev.lng);
    fix = ev ? { at: ev.at, source: ev.source } : null;
  }
  if (!here || !fix) return null;
  const miles = roadMiles(here, dest);
  const profile = await speedProfile(tenantId, now);
  const side = leg.type === "crossing" ? "X" : stop.country === "MX" ? "MX" : "US";
  const mph = profile[side] ?? DEFAULT_MPH[side];
  const at = new Date(Math.max(now.getTime(), fix.at.getTime()) + (miles / mph) * 3600_000);
  return { at, miles: Math.round(miles), mph, stopId: stop.id, stopName: stop.name, positionAt: fix.at, source: fix.source, windowEnd: stop.windowEnd, late: !!stop.windowEnd && at.getTime() > stop.windowEnd.getTime() };
}

/** ETAs for every moving leg of an order, keyed by leg id. */
export async function orderEtas(tenantId: string, orderId: string, now = new Date()) {
  const [legs, stops] = await Promise.all([db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.orderId, orderId), inArray(s.legs.state, ["accepted", "en_route_to_pickup", "loaded", "en_route"]))), db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, orderId))).orderBy(s.stops.seq)]);
  const out: Record<string, Eta> = {};
  for (const l of legs) {
    const e = await etaFrom(tenantId, l, stops, now);
    if (e) out[l.id] = e;
  }
  return out;
}

export type MergedEta = { at: Date; stopId: string | null; stopName: string; miles: number | null; late: boolean; positionAt: Date; source: "gps" | "check_call" };

/**
 * One ETA everywhere (N4): the same merge the board uses — the dispatcher's check-call ETA stands over the GPS
 * math until a GPS position newer than the call comes in — for the customer's tracking page, the customer
 * portal and the status replies, so the customer never gets two different ETAs. Keyed by leg id.
 */
export async function mergedOrderEtas(tenantId: string, orderId: string, now = new Date()): Promise<Record<string, MergedEta>> {
  const { mergeCallEtas } = await import("./board-buckets");
  const [gps, legs, stops, [call]] = await Promise.all([
    orderEtas(tenantId, orderId, now),
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.orderId, orderId))).orderBy(s.legs.seq),
    db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), eq(s.stops.orderId, orderId))).orderBy(s.stops.seq),
    db.select().from(s.checkCalls).where(and(eq(s.checkCalls.tenantId, tenantId), eq(s.checkCalls.orderId, orderId))).orderBy(desc(s.checkCalls.at)).limit(1),
  ]);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const row = {
    order: { id: orderId },
    legs: legs.map((l) => ({ id: l.id, state: l.state, truckId: l.truckId, fromStopId: l.fromStopId, toStopId: l.toStopId })),
    stops: stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, windowStart: iso(st.windowStart), windowEnd: iso(st.windowEnd), arrivedAt: iso(st.arrivedAt), departedAt: iso(st.departedAt) })),
  };
  const g = Object.fromEntries(Object.entries(gps).map(([k, e]) => [k, { at: e.at.toISOString(), stopId: e.stopId, stopName: e.stopName, miles: e.miles, late: e.late, positionAt: e.positionAt.toISOString(), source: "gps" as const }]));
  const merged = mergeCallEtas([row], g, call ? { [orderId]: { at: call.at.toISOString(), etaAt: call.etaAt?.toISOString() ?? null, legId: call.legId } } : {});
  return Object.fromEntries(Object.entries(merged).map(([k, e]) => [k, { at: new Date(e.at), stopId: e.stopId ?? null, stopName: e.stopName, miles: e.miles, late: e.late, positionAt: new Date(e.positionAt), source: e.source ?? "gps" }]));
}

/** ETAs for every moving leg in the company, keyed by leg id — one pass for the dispatch board. */
export async function boardEtas(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.state, ["accepted", "en_route_to_pickup", "loaded", "en_route"])));
  const orderIds = [...new Set(legs.map((l) => l.orderId))];
  const stops = orderIds.length ? await db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), inArray(s.stops.orderId, orderIds))).orderBy(s.stops.seq) : [];
  const out: Record<string, { at: string; stopId: string; stopName: string; miles: number; late: boolean; positionAt: string }> = {};
  for (const l of legs) {
    const e = await etaFrom(ctx.tenantId, l, stops.filter((x) => x.orderId === l.orderId), now);
    if (e) out[l.id] = { at: e.at.toISOString(), stopId: e.stopId, stopName: e.stopName, miles: e.miles, late: e.late, positionAt: e.positionAt.toISOString() };
  }
  return out;
}

/**
 * Job: a moving leg whose ETA is past the next stop's window gets a yellow eta_late flag, kept current
 * every tick and cleared when the ETA comes back inside the window or the truck arrives.
 */
export async function flagEta(now = new Date()) {
  const moving = await db.select().from(s.legs).where(inArray(s.legs.state, ["accepted", "en_route_to_pickup", "loaded", "en_route"]));
  const open = await db.select().from(s.flags).where(and(eq(s.flags.code, "eta_late"), sql`${s.flags.clearedAt} is null`));
  let flagged = 0;
  let cleared = 0;
  const stopsByOrder = new Map<string, (typeof s.stops.$inferSelect)[]>();
  for (const leg of moving) {
    if (!stopsByOrder.has(leg.orderId)) stopsByOrder.set(leg.orderId, await db.select().from(s.stops).where(eq(s.stops.orderId, leg.orderId)).orderBy(s.stops.seq));
    const eta = await etaFrom(leg.tenantId, leg, stopsByOrder.get(leg.orderId)!, now);
    const existing = open.find((f) => f.legId === leg.id);
    if (eta?.late) {
      const late = Math.round((eta.at.getTime() - eta.windowEnd!.getTime()) / 60_000);
      const title = `ETA at ${eta.stopName} ${late >= 60 ? `${Math.floor(late / 60)} h ${late % 60} min` : `${late} min`} past the window`;
      const detail = `From the last ${eta.source.replace("_", " ")} position: ${eta.miles} mi at ${eta.mph} mph. Warn the receiver or rebook the appointment.`;
      if (existing) {
        if (existing.title !== title) await db.update(s.flags).set({ title, detail }).where(eq(s.flags.id, existing.id));
      } else {
        await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: leg.orderId, legId: leg.id, code: "eta_late", level: "yellow", title, detail, owner: "dispatch", data: { stopId: eta.stopId, etaAt: eta.at.toISOString() } });
        flagged++;
      }
    } else if (existing) {
      await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, existing.id));
      cleared++;
    }
  }
  // legs no longer moving (arrived, delivered) drop their flag
  for (const f of open) if (!moving.some((l) => l.id === f.legId)) {
    await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, f.id));
    cleared++;
  }
  return { flagged, cleared };
}

// ---------- watchdog ----------

/**
 * Job: a moving leg on our own truck with no position for `hours` gets a yellow no_position flag, once.
 * A partner carrier's leg gets the same watch once their driver's phone has reported at all (the link
 * was opened): silence after that is worth a look; a carrier that never used the link is not.
 */
export async function flagStaleTracking(now = new Date(), hours = 2) {
  const cutoff = new Date(now.getTime() - hours * 3600_000);
  const moving = await db.select().from(s.legs).where(and(inArray(s.legs.state, MOVING), inArray(s.legs.assigneeKind, ["truck", "carrier"])));
  let flagged = 0;
  for (const leg of moving) {
    if (leg.assigneeKind === "carrier") {
      const [ever] = await db.select({ id: s.positions.id }).from(s.positions).where(and(eq(s.positions.tenantId, leg.tenantId), eq(s.positions.legId, leg.id))).limit(1);
      if (!ever) continue;
    }
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
    await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: leg.orderId, legId: leg.id, code: "no_position", level: "yellow", title: `No position for ${hours}h`, detail: leg.assigneeKind === "carrier" ? "The carrier driver's phone went quiet while moving; call the carrier" : "No driver-app or ELD ping while moving", owner: "dispatch" });
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

// ---------- detention running ----------

/**
 * Job: a truck sitting at a pickup or delivery past the customer's free time gets a yellow "detention
 * running" flag with the minutes over, updated every tick while it sits; leaving clears it. The dispatcher
 * calls the shipper while it still matters; the charge itself is computed on the order afterwards.
 */
export async function flagDetention(now = new Date()) {
  const legs = await db.select().from(s.legs).where(inArray(s.legs.state, ["at_pickup", "at_delivery", "loaded", "en_route"]));
  const open = await db.select().from(s.flags).where(and(eq(s.flags.code, "detention"), sql`${s.flags.clearedAt} is null`));
  let flagged = 0;
  let updated = 0;
  let cleared = 0;
  const orderIds = [...new Set(legs.map((l) => l.orderId))];
  const stops = orderIds.length ? await db.select().from(s.stops).where(and(inArray(s.stops.orderId, orderIds), sql`${s.stops.arrivedAt} is not null`, sql`${s.stops.departedAt} is null`, inArray(s.stops.type, ["pickup", "delivery"]))) : [];
  const orders = orderIds.length ? await db.select({ id: s.orders.id, customerId: s.orders.customerId, brokerId: s.orders.brokerId, tenantId: s.orders.tenantId }).from(s.orders).where(inArray(s.orders.id, orderIds)) : [];
  const custIds = [...new Set(orders.map((o) => o.customerId ?? o.brokerId).filter((x): x is string => !!x))];
  const custs = custIds.length ? await db.select({ id: s.customers.id, free: s.customers.detentionFreeMinutes }).from(s.customers).where(inArray(s.customers.id, custIds)) : [];
  const freeFor = (orderId: string) => {
    const o = orders.find((x) => x.id === orderId);
    return custs.find((c) => c.id === (o?.customerId ?? o?.brokerId))?.free ?? 120;
  };
  const live = new Set<string>();
  for (const st of stops) {
    const leg = legs.find((l) => l.orderId === st.orderId && (l.fromStopId === st.id || l.toStopId === st.id));
    if (!leg) continue;
    const minutes = Math.floor((now.getTime() - st.arrivedAt!.getTime()) / 60_000);
    const over = minutes - freeFor(st.orderId);
    if (over <= 0) continue;
    live.add(st.id);
    const title = `Detention running at ${st.name}: ${over} min over free time`;
    const existing = open.find((f) => f.legId === leg.id && f.data?.stopId === st.id);
    if (existing) {
      if (existing.title !== title) {
        await db.update(s.flags).set({ title }).where(eq(s.flags.id, existing.id));
        updated++;
      }
    } else {
      await db.insert(s.flags).values({ id: newId(), tenantId: leg.tenantId, orderId: st.orderId, legId: leg.id, code: "detention", level: "yellow", title, detail: `Arrived ${st.arrivedAt!.toISOString()}. Call the ${st.type === "pickup" ? "shipper" : "receiver"}; the charge is computed on the order once the truck leaves.`, owner: "dispatch", data: { stopId: st.id } });
      flagged++;
    }
  }
  for (const f of open) {
    if (!live.has(String(f.data?.stopId))) {
      await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(eq(s.flags.id, f.id));
      cleared++;
    }
  }
  return { flagged, updated, cleared };
}

// ---------- red flags to the people on duty ----------

/**
 * Job: red flags opened since the last run go to the owner and dispatchers as one email per company per
 * tick ("3 things need you on Dispatch"), when the company has an email sender. Each flag is told once;
 * the board is the source of truth either way.
 */
export async function notifyRedFlags(now = new Date()) {
  const { canSendEmail, enqueue } = await import("@/lib/outbox");
  const since = new Date(now.getTime() - 30 * 60_000);
  const fresh = await db.select().from(s.flags).where(and(eq(s.flags.level, "red"), sql`${s.flags.clearedAt} is null`, gt(s.flags.openedAt, since), sql`coalesce(${s.flags.data} ->> 'notifiedAt', '') = ''`));
  if (!fresh.length) return { emails: 0, flags: 0 };
  const byTenant = new Map<string, typeof fresh>();
  for (const f of fresh) byTenant.set(f.tenantId, [...(byTenant.get(f.tenantId) ?? []), f]);
  let emails = 0;
  for (const [tenantId, list] of byTenant) {
    const stamp = async () => {
      for (const f of list) await db.update(s.flags).set({ data: { ...(f.data ?? {}), notifiedAt: now.toISOString() } }).where(eq(s.flags.id, f.id));
    };
    if (!(await canSendEmail(tenantId))) {
      await stamp();
      continue;
    }
    const people = await db.select({ email: s.users.email }).from(s.users).where(and(eq(s.users.tenantId, tenantId), inArray(s.users.role, ["owner", "dispatcher"]), sql`${s.users.archivedAt} is null`));
    const orders = await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(inArray(s.orders.id, [...new Set(list.map((f) => f.orderId))]));
    const num = (id: string) => orders.find((o) => o.id === id)?.orderNumber ?? id;
    const { publicUrl } = await import("@/lib/tokens");
    const lines = list.map((f) => `• ${num(f.orderId)}: ${f.title}${f.detail ? ` — ${f.detail}` : ""}`);
    const ctx = systemCtx(tenantId);
    for (const p of people) {
      await enqueue(ctx, { channel: "email", to: p.email, subject: `${list.length} thing${list.length === 1 ? "" : "s"} need${list.length === 1 ? "s" : ""} you on Dispatch`, body: `${lines.join("\n")}\n\n${publicUrl("/dispatch")}`, subjectKind: "alert", subjectId: list[0].id });
      emails++;
    }
    await stamp();
  }
  return { emails, flags: fresh.length };
}


/** The latest GPS position time per truck and per leg over the last three days (the board's "last ping"). */
export async function lastPings(ctx: Ctx) {
  assertCtx(ctx);
  const since = new Date(Date.now() - 3 * 86400_000);
  const [byTruck, byLeg] = await Promise.all([
    db.select({ id: s.positions.truckId, at: sql<Date>`max(${s.positions.at})` }).from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), sql`${s.positions.truckId} is not null`, gt(s.positions.at, since))).groupBy(s.positions.truckId),
    db.select({ id: s.positions.legId, at: sql<Date>`max(${s.positions.at})` }).from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), sql`${s.positions.legId} is not null`, gt(s.positions.at, since))).groupBy(s.positions.legId),
  ]);
  const iso = (d: Date | string) => new Date(d).toISOString();
  return { byTruck: Object.fromEntries(byTruck.map((r) => [r.id!, iso(r.at)])), byLeg: Object.fromEntries(byLeg.map((r) => [r.id!, iso(r.at)])) };
}
