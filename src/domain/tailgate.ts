import { legsFromStops } from "./zones";
import { and, eq, inArray, asc } from "drizzle-orm";
import { pdfText } from "@/lib/pdf-text";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { LegType, StopType, OrderState } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { createOrder, getOrder, NotFoundError, ValidationError, type StopInput } from "./orders";
import { assertOrderTransition, canOrderTransition } from "./states";

/**
 * Tailgate / LTL (spec Module 12): a Trip is an order of kind "trip" with the unit, the stops and the legs
 * (dispatch, tracking, crossing and settlements all work on legs); a Shipment is an order of kind "shipment"
 * that rides on the trip between two of its stops and keeps its own customer, rate, references, documents,
 * POD, charges and invoice. Shipment states follow the trip's stop clocks.
 */

export type TripStopInput = StopInput & { type: StopType };

/** Cut legs from a stop list: same-country runs become one leg; a US yard ↔ MX border yard pair becomes the crossing. */
/** A trip's legs: the same cut as every load (a leg ends where the trailer changes hands), at least two stops. */
export function legsForStops(stops: { type: StopType; country?: string }[]): { type: LegType; from: number; to: number }[] {
  if (stops.length < 2) throw new ValidationError("a trip needs at least two stops", "stops");
  return legsFromStops(stops);
}

/** Trailer capacity by equipment when the unit has none on record. */
export const EQUIPMENT_CAPACITY: Record<string, { linearFt: number; weightLbs: number; cubeFt: number }> = {
  "53_dry": { linearFt: 53, weightLbs: 45000, cubeFt: 3800 },
  "53_reefer": { linearFt: 53, weightLbs: 43000, cubeFt: 3500 },
  "48_dry": { linearFt: 48, weightLbs: 45000, cubeFt: 3400 },
  flatbed: { linearFt: 48, weightLbs: 48000, cubeFt: 0 },
  sprinter: { linearFt: 14, weightLbs: 3500, cubeFt: 480 },
  straight: { linearFt: 24, weightLbs: 10000, cubeFt: 1500 },
  power_only: { linearFt: 53, weightLbs: 45000, cubeFt: 3800 },
};

export async function createTrip(ctx: Ctx, input: { stops: TripStopInput[]; equipment?: string; billingEntityId?: string | null; cargoNote?: string | null; refs?: Record<string, string> }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const legPlan = legsForStops(input.stops);
  const r = await createOrder(ctx, { kind: "trip", stops: input.stops, legPlan, equipment: input.equipment ?? "53_dry", billingEntityId: input.billingEntityId ?? null, cargoNote: input.cargoNote ?? null, refs: input.refs ?? {}, rateTbd: true, source: "manual" });
  return r;
}

export type ShipmentInput = { customerId: string; brokerId?: string | null; rateCents: number | null; rateTbd?: boolean; refs?: Record<string, string>; pickupStopId: string; deliveryStopId: string; pieces?: number | null; weightLbs?: number | null; linearFt?: number | null; cubeFt?: number | null; stackable?: boolean; hazmat?: boolean; cargoNote?: string | null; billingEntityId?: string | null };

async function loadTrip(ctx: Ctx, tripId: string) {
  const [trip] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, tripId))).limit(1);
  if (!trip || trip.kind !== "trip") throw new NotFoundError("trip", tripId);
  return trip;
}

export async function tripStops(ctx: Ctx, tripId: string) {
  return db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, tripId))).orderBy(asc(s.stops.seq));
}

export async function tripShipments(ctx: Ctx, tripId: string) {
  return db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.tripId, tripId))).orderBy(asc(s.orders.loadSeq), asc(s.orders.orderNumber));
}

/** Add a shipment to a trip: its own order (customer, rate, refs, docs, charges) riding between two trip stops. */
export async function addShipment(ctx: Ctx, tripId: string, input: ShipmentInput) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const trip = await loadTrip(ctx, tripId);
  if (["delivered", "ready_to_bill", "invoiced", "paid", "cancelled"].includes(trip.state)) throw new ValidationError(`the trip is ${trip.state}`);
  const stops = await tripStops(ctx, tripId);
  const pick = stops.find((x) => x.id === input.pickupStopId);
  const drop = stops.find((x) => x.id === input.deliveryStopId);
  if (!pick || !drop) throw new ValidationError("pick the trip stops it gets on and off at", "pickupStopId");
  if (pick.seq >= drop.seq) throw new ValidationError("delivery must come after pickup on the trip", "deliveryStopId");
  if (pick.departedAt) throw new ValidationError(`the trip already left ${pick.name}`, "pickupStopId");
  if (input.rateCents != null && input.rateCents < 0) throw new ValidationError("rate cannot be negative", "rateCents");
  if (input.weightLbs != null && input.weightLbs < 0) throw new ValidationError("weight", "weightLbs");
  const cap = await capacity(ctx, tripId, { pickupStopId: pick.id, deliveryStopId: drop.id, weightLbs: input.weightLbs ?? 0, linearFt: input.linearFt ?? 0, cubeFt: input.cubeFt ?? 0 });
  if (cap.overWith.length) throw new ValidationError(`it will not fit: ${cap.overWith.join(", ")} over capacity between ${pick.name} and ${drop.name}`, "weightLbs");
  const existing = await tripShipments(ctx, tripId);
  const r = await createOrder(ctx, {
    kind: "shipment",
    customerId: input.customerId,
    brokerId: input.brokerId ?? null,
    billingEntityId: input.billingEntityId ?? trip.billingEntityId ?? null,
    equipment: trip.equipment,
    refs: input.refs ?? {},
    rateCents: input.rateCents,
    rateTbd: input.rateTbd ?? input.rateCents == null,
    cargoNote: input.cargoNote ?? null,
    legPlan: [], // no legs of its own: the trip moves it
    stops: [
      { type: "pickup", name: pick.name, locationId: pick.locationId, address: pick.address ?? undefined, country: pick.country, windowStart: pick.windowStart, windowEnd: pick.windowEnd, contact: pick.contact },
      { type: "delivery", name: drop.name, locationId: drop.locationId, address: drop.address ?? undefined, country: drop.country, windowStart: drop.windowStart, windowEnd: drop.windowEnd, contact: drop.contact },
    ],
    source: "manual",
    book: false,
  });
  const [ship] = await db
    .update(s.orders)
    .set({ tripId, pickupStopId: pick.id, deliveryStopId: drop.id, pieces: input.pieces ?? null, weightLbs: input.weightLbs ?? null, linearFt: input.linearFt ?? null, cubeFt: input.cubeFt ?? null, stackable: input.stackable ?? true, hazmat: input.hazmat ?? false, loadSeq: existing.length + 1, updatedAt: new Date(), updatedBy: ctx.userId })
    .where(eq(s.orders.id, r.order.id))
    .returning();
  await writeAudit(db, ctx, "order", tripId, "update", { shipment: { from: null, to: ship.orderNumber } }, `shipment ${ship.orderNumber} added`);
  await reorderLifo(ctx, tripId);
  await db.transaction((tx) => syncShipmentStates(tx, ctx, tripId));
  return db.select().from(s.orders).where(eq(s.orders.id, ship.id)).then((x) => x[0]);
}

export async function removeShipment(ctx: Ctx, shipmentId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.cancel");
  const [ship] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, shipmentId))).limit(1);
  if (!ship || ship.kind !== "shipment" || !ship.tripId) throw new NotFoundError("shipment", shipmentId);
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const [pick] = await db.select().from(s.stops).where(eq(s.stops.id, ship.pickupStopId ?? "")).limit(1);
  if (pick?.departedAt && ship.state !== "exception") throw new ValidationError("it is already on the truck; hold it at a stop instead");
  if (["invoiced", "paid"].includes(ship.state)) throw new ValidationError(`shipment is ${ship.state}`);
  await db.update(s.orders).set({ state: "cancelled", previousState: ship.state, cancelReason: reason.trim(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, shipmentId));
  await writeAudit(db, ctx, "order", shipmentId, "transition", { state: { from: ship.state, to: "cancelled" } }, reason.trim());
  await reorderLifo(ctx, ship.tripId);
}

/** LIFO: what comes off last goes in first. loadSeq 1 = nose. */
async function reorderLifo(ctx: Ctx, tripId: string) {
  const [ships, stops] = await Promise.all([tripShipments(ctx, tripId), tripStops(ctx, tripId)]);
  const seqOf = (id: string | null) => stops.find((x) => x.id === id)?.seq ?? 0;
  const live = ships.filter((x) => x.state !== "cancelled").sort((p, q) => seqOf(q.deliveryStopId) - seqOf(p.deliveryStopId) || seqOf(p.pickupStopId) - seqOf(q.pickupStopId) || p.orderNumber.localeCompare(q.orderNumber));
  for (let i = 0; i < live.length; i++) if (live[i].loadSeq !== i + 1) await db.update(s.orders).set({ loadSeq: i + 1 }).where(eq(s.orders.id, live[i].id));
}

/** Capacity of the trip's unit (trailer on the crossing/long leg, else the truck, else the equipment default). */
export async function tripCapacity(ctx: Ctx, tripId: string) {
  const trip = await loadTrip(ctx, tripId);
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, tripId)));
  const trailerId = legs.find((l) => l.trailerId)?.trailerId ?? null;
  const truckId = legs.find((l) => l.truckId)?.truckId ?? null;
  const base = EQUIPMENT_CAPACITY[trip.equipment] ?? EQUIPMENT_CAPACITY["53_dry"];
  if (trailerId) {
    const [tr] = await db.select().from(s.trailers).where(eq(s.trailers.id, trailerId)).limit(1);
    if (tr) return { source: `trailer ${tr.unitNumber}`, linearFt: tr.lengthFt ?? base.linearFt, weightLbs: tr.maxWeightLbs ?? base.weightLbs, cubeFt: tr.cubeFt ?? base.cubeFt };
  }
  if (truckId) {
    const [tk] = await db.select().from(s.trucks).where(eq(s.trucks.id, truckId)).limit(1);
    if (tk && tk.equipmentType !== "tractor") return { source: `unit ${tk.unitNumber}`, linearFt: tk.cargoLengthFt ?? base.linearFt, weightLbs: tk.maxWeightLbs ?? base.weightLbs, cubeFt: tk.cubeFt ?? base.cubeFt };
  }
  return { source: `${trip.equipment.replace("_", " ")} (default)`, ...base };
}

export type StopLoad = { stopId: string; seq: number; name: string; type: string; on: string[]; off: string[]; afterWeightLbs: number; afterLinearFt: number; afterCubeFt: number; afterPieces: number };

/** Load at every stop, the peak, and whether a proposed shipment would still fit. */
export async function capacity(ctx: Ctx, tripId: string, proposed?: { pickupStopId: string; deliveryStopId: string; weightLbs: number; linearFt: number; cubeFt: number }) {
  assertCtx(ctx);
  const [cap, stops, ships] = await Promise.all([tripCapacity(ctx, tripId), tripStops(ctx, tripId), tripShipments(ctx, tripId)]);
  const live = ships.filter((x) => x.state !== "cancelled");
  const items = [...live.map((x) => ({ id: x.id, pick: x.pickupStopId, drop: x.deliveryStopId, weightLbs: x.weightLbs ?? 0, linearFt: x.linearFt ?? 0, cubeFt: x.cubeFt ?? 0, pieces: x.pieces ?? 0 })), ...(proposed ? [{ id: "proposed", pick: proposed.pickupStopId, drop: proposed.deliveryStopId, weightLbs: proposed.weightLbs, linearFt: proposed.linearFt, cubeFt: proposed.cubeFt, pieces: 0 }] : [])];
  const perStop: StopLoad[] = [];
  let w = 0;
  let lf = 0;
  let cu = 0;
  let pc = 0;
  const peak = { weightLbs: 0, linearFt: 0, cubeFt: 0 };
  for (const st of stops) {
    const off = items.filter((i) => i.drop === st.id);
    const on = items.filter((i) => i.pick === st.id);
    for (const i of off) {
      w -= i.weightLbs;
      lf -= i.linearFt;
      cu -= i.cubeFt;
      pc -= i.pieces;
    }
    for (const i of on) {
      w += i.weightLbs;
      lf += i.linearFt;
      cu += i.cubeFt;
      pc += i.pieces;
    }
    peak.weightLbs = Math.max(peak.weightLbs, w);
    peak.linearFt = Math.max(peak.linearFt, lf);
    peak.cubeFt = Math.max(peak.cubeFt, cu);
    perStop.push({ stopId: st.id, seq: st.seq, name: st.name, type: st.type, on: on.map((i) => i.id), off: off.map((i) => i.id), afterWeightLbs: w, afterLinearFt: lf, afterCubeFt: cu, afterPieces: pc });
  }
  const overWith: string[] = [];
  if (peak.weightLbs > cap.weightLbs) overWith.push(`${peak.weightLbs.toLocaleString()} lb`);
  if (peak.linearFt > cap.linearFt) overWith.push(`${peak.linearFt} linear ft`);
  if (cap.cubeFt && peak.cubeFt > cap.cubeFt) overWith.push(`${peak.cubeFt} cu ft`);
  return { capacity: cap, perStop, peak, spaceLeft: { weightLbs: cap.weightLbs - peak.weightLbs, linearFt: cap.linearFt - peak.linearFt, cubeFt: cap.cubeFt ? cap.cubeFt - peak.cubeFt : null }, fillPct: cap.linearFt ? Math.round((peak.linearFt / cap.linearFt) * 100) : 0, overWith };
}

/** Shipment states follow the trip: on the truck once its pickup stop is departed, delivered once its delivery stop is departed. */
export async function syncShipmentStates(tx: Tx, ctx: Ctx, tripId: string) {
  const [trip] = await tx.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, tripId))).limit(1);
  if (!trip || trip.kind !== "trip") return;
  const [ships, stops] = await Promise.all([tx.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.tripId, tripId))), tx.select().from(s.stops).where(eq(s.stops.orderId, tripId))]);
  for (const sh of ships) {
    if (["cancelled", "exception", "invoiced", "paid", "ready_to_bill"].includes(sh.state)) continue;
    const pick = stops.find((x) => x.id === sh.pickupStopId);
    const drop = stops.find((x) => x.id === sh.deliveryStopId);
    let to: OrderState | null = null;
    let deliveredAt: Date | null = null;
    if (trip.state === "cancelled") to = "cancelled";
    else if (drop?.departedAt || (drop?.arrivedAt && trip.state === "delivered")) {
      to = "delivered";
      deliveredAt = drop.departedAt ?? drop.arrivedAt ?? new Date();
    } else if (pick?.departedAt) to = "in_transit";
    else if (["dispatched", "in_transit"].includes(trip.state)) to = "dispatched";
    else if (trip.state === "booked" || trip.state === "delivered") to = "booked";
    if (!to || to === sh.state) continue;
    // walk the lifecycle in order (booked → dispatched → in_transit → delivered) so nothing is skipped in the audit
    const PATH: OrderState[] = ["draft", "booked", "dispatched", "in_transit", "delivered"];
    let cur = sh.state;
    const steps: OrderState[] = [];
    if (PATH.includes(cur) && PATH.includes(to) && PATH.indexOf(to) > PATH.indexOf(cur)) steps.push(...PATH.slice(PATH.indexOf(cur) + 1, PATH.indexOf(to) + 1));
    else if (canOrderTransition(cur, to)) steps.push(to);
    else continue;
    for (const next of steps) {
      if (!canOrderTransition(cur, next)) break;
      assertOrderTransition(cur, next);
      await tx.update(s.orders).set({ state: next, previousState: cur, deliveredAt: next === "delivered" ? (deliveredAt ?? sh.deliveredAt ?? new Date()) : sh.deliveredAt, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, sh.id));
      await writeAudit(tx, ctx, "order", sh.id, "transition", { state: { from: cur, to: next } }, `follows trip ${trip.orderNumber}`);
      cur = next;
    }
    // the shipment's own stop copies mirror the trip's clocks (timeline, detention, invoice route)
    const own = await tx.select().from(s.stops).where(eq(s.stops.orderId, sh.id)).orderBy(asc(s.stops.seq));
    if (own[0] && pick) await tx.update(s.stops).set({ arrivedAt: pick.arrivedAt, departedAt: pick.departedAt }).where(eq(s.stops.id, own[0].id));
    if (own[1] && drop) await tx.update(s.stops).set({ arrivedAt: drop.arrivedAt, departedAt: drop.departedAt }).where(eq(s.stops.id, own[1].id));
  }
}

/** Book the trip: needs at least one shipment; books every draft shipment with it. */
export async function bookTrip(ctx: Ctx, tripId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const trip = await loadTrip(ctx, tripId);
  const ships = (await tripShipments(ctx, tripId)).filter((x) => x.state !== "cancelled");
  if (!ships.length) throw new ValidationError("add at least one shipment before booking the trip");
  for (const sh of ships) if (sh.rateCents == null && !sh.rateTbd) throw new ValidationError(`${sh.orderNumber} needs a rate or TBD`, "rateCents");
  const { bookOrder } = await import("./orders");
  if (trip.state === "draft") await bookOrder(ctx, tripId);
  await db.transaction(async (tx) => {
    for (const sh of ships) if (sh.state === "draft") await tx.update(s.orders).set({ state: "booked", previousState: "draft", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, sh.id));
    await syncShipmentStates(tx, ctx, tripId);
  });
  return getOrder(ctx, tripId);
}

/** Hold one shipment (short-shipped, held at the border, refused): it stays put while the trip continues. */
export async function holdShipment(ctx: Ctx, shipmentId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  const [sh] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, shipmentId))).limit(1);
  if (!sh || sh.kind !== "shipment") throw new NotFoundError("shipment", shipmentId);
  if (!reason?.trim()) throw new ValidationError("say why", "reason");
  if (!canOrderTransition(sh.state, "exception")) throw new ValidationError(`a ${sh.state} shipment cannot be held`);
  await db.update(s.orders).set({ state: "exception", previousState: sh.state, holdReason: reason.trim(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, shipmentId));
  await writeAudit(db, ctx, "order", shipmentId, "transition", { state: { from: sh.state, to: "exception" } }, reason.trim());
  await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: sh.tripId ?? shipmentId, code: "shipment_held", level: "yellow", title: `${sh.orderNumber} held: ${reason.trim()}`, detail: "The trip continues without it; release it when it can move.", owner: "dispatch" });
}

export async function releaseShipment(ctx: Ctx, shipmentId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  const [sh] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, shipmentId))).limit(1);
  if (!sh || sh.kind !== "shipment" || sh.state !== "exception") throw new NotFoundError("held shipment", shipmentId);
  await db.update(s.orders).set({ state: sh.previousState ?? "booked", previousState: "exception", holdReason: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, shipmentId));
  await writeAudit(db, ctx, "order", shipmentId, "transition", { state: { from: "exception", to: sh.previousState ?? "booked" } }, "released");
  if (sh.tripId) await db.transaction((tx) => syncShipmentStates(tx, ctx, sh.tripId!));
}

/** Trip cost shares for the P&L: by weight (default), revenue or cube — a company setting. */
export async function costShares(ctx: Ctx, tripId: string): Promise<Map<string, number>> {
  const [tenant] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const basis = String((tenant?.settings as Record<string, unknown>)?.tailgateAllocation ?? "weight");
  const ships = (await tripShipments(ctx, tripId)).filter((x) => x.state !== "cancelled");
  const measure = (x: (typeof ships)[number]) => (basis === "revenue" ? (x.rateCents ?? 0) : basis === "cube" ? (x.cubeFt ?? 0) : (x.weightLbs ?? 0));
  let total = ships.reduce((a, x) => a + measure(x), 0);
  const out = new Map<string, number>();
  if (!ships.length) return out;
  if (total <= 0) {
    for (const x of ships) out.set(x.id, 1 / ships.length); // nothing to weigh by → even split
    return out;
  }
  total = total || 1;
  for (const x of ships) out.set(x.id, measure(x) / total);
  return out;
}

/** Everything the trip page shows. */
export async function tripPage(ctx: Ctx, tripId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const trip = await getOrder(ctx, tripId);
  if (trip.order.kind !== "trip") throw new NotFoundError("trip", tripId);
  const [ships, cap, customers] = await Promise.all([tripShipments(ctx, tripId), capacity(ctx, tripId), db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId))]);
  const shipIds = ships.map((x) => x.id);
  const docs = shipIds.length ? await db.select({ subjectId: s.documents.subjectId, code: s.documents.code }).from(s.documents).where(and(eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, shipIds), inArray(s.documents.status, ["present", "verified"]))) : [];
  const invoices = shipIds.length ? await db.select({ id: s.invoices.id, number: s.invoices.number, state: s.invoices.state, orderIds: s.invoices.orderIds }).from(s.invoices).where(eq(s.invoices.tenantId, ctx.tenantId)) : [];
  const shares = await costShares(ctx, tripId);
  return {
    ...trip,
    capacity: cap,
    shipments: ships.map((x) => ({ ...x, customerName: customers.find((c) => c.id === x.customerId)?.name ?? "—", pod: docs.some((d) => d.subjectId === x.id && d.code === "POD"), docCodes: docs.filter((d) => d.subjectId === x.id).map((d) => d.code), invoice: invoices.find((i) => i.orderIds.includes(x.id)) ?? null, costShare: shares.get(x.id) ?? 0 })),
    customers,
  };
}

export async function listTrips(ctx: Ctx, opts: { limit?: number } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const trips = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.kind, "trip"))).orderBy(asc(s.orders.state), asc(s.orders.orderNumber)).limit(opts.limit ?? 200);
  const ids = trips.map((t) => t.id);
  const [ships, stops] = ids.length ? await Promise.all([db.select({ tripId: s.orders.tripId, state: s.orders.state, weightLbs: s.orders.weightLbs, linearFt: s.orders.linearFt, rateCents: s.orders.rateCents }).from(s.orders).where(inArray(s.orders.tripId, ids)), db.select().from(s.stops).where(inArray(s.stops.orderId, ids)).orderBy(asc(s.stops.seq))]) : [[], []];
  return trips.map((t) => {
    const mine = ships.filter((x) => x.tripId === t.id && x.state !== "cancelled");
    const st = stops.filter((x) => x.orderId === t.id);
    return { trip: t, shipments: mine.length, revenueCents: mine.reduce((a, x) => a + (x.rateCents ?? 0), 0), weightLbs: mine.reduce((a, x) => a + (x.weightLbs ?? 0), 0), from: st[0]?.name ?? "", to: st[st.length - 1]?.name ?? "", stops: st.length };
  });
}

/** Trip manifest: one page listing every shipment by stop, with seal continuity lines. */
export async function manifestPdf(ctx: Ctx, tripId: string): Promise<Uint8Array> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const p = await tripPage(ctx, tripId);
  const [tenant] = await db.select().from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const T = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: ink });
  T(tenant?.name ?? "", 54, 760, 18, bold, rgb(1, 1, 1));
  T("TRIP MANIFEST", 400, 760, 14, bold, rgb(0.6, 0.96, 0.89));
  T(`${p.order.orderNumber} · ${p.order.equipment.replace("_", " ")} · ${p.shipments.filter((x) => x.state !== "cancelled").length} shipments · ${p.capacity.peak.weightLbs.toLocaleString()} lb peak`, 54, 715, 10, font, muted);
  let y = 690;
  for (const st of p.capacity.perStop) {
    if (y < 110) {
      page = doc.addPage([612, 792]);
      y = 740;
    }
    const stop = p.stops.find((x) => x.id === st.stopId)!;
    T(`${st.seq}. ${stop.name}${stop.address?.city ? `, ${stop.address.city}` : ""}${stop.address?.state ? ` ${stop.address.state}` : ""} ${stop.country}`, 54, y, 11, bold);
    T(`${stop.type.replace("_", " ")} · after this stop: ${st.afterPieces} pcs · ${st.afterWeightLbs.toLocaleString()} lb · ${st.afterLinearFt} ft`, 54, y - 13, 8.5, font, muted);
    y -= 28;
    for (const [label, ids] of [["OFF", st.off], ["ON", st.on]] as const) {
      for (const id of ids) {
        const sh = p.shipments.find((x) => x.id === id);
        if (!sh) continue;
        T(label, 64, y, 8, bold, label === "ON" ? rgb(0.05, 0.46, 0.43) : rgb(0.7, 0.1, 0.1));
        T(`${sh.orderNumber}  ${sh.customerName}  ${Object.entries(sh.refs).map(([k, v]) => `${k}:${v}`).join(" ") || ""}`, 92, y, 9.5);
        T(`${sh.pieces ?? "?"} pcs · ${(sh.weightLbs ?? 0).toLocaleString()} lb · ${sh.linearFt ?? "?"} ft${sh.hazmat ? " · HAZMAT" : ""}${sh.state === "exception" ? ` · HELD: ${sh.holdReason ?? ""}` : ""}`, 380, y, 8.5, font, muted);
        y -= 14;
      }
    }
    const sealLine = (stop.sealIn || stop.sealOut ? `Seal on open: ${stop.sealIn ?? "—"}   Seal on close: ${stop.sealOut ?? "________________"}` : "Seal on open: ________________   Seal on close: ________________") + "   Signature: ________________";
    T(sealLine, 64, y, 8.5, font, muted);
    y -= 22;
  }
  T(`Generated by Crossline · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, 54, 40, 8, font, muted);
  return doc.save();
}


