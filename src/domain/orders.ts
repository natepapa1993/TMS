import { and, eq, sql, asc, inArray, desc, or, gte, isNull } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { LegState, OrderState, LegType, StopType, EventSource } from "@/db/schema";
import { newId } from "@/lib/ids";
import { coords } from "@/lib/geo";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit, diff } from "@/lib/audit";
import { assertLegTransition, assertOrderTransition, canOrderTransition, LEG_FORWARD, STAGE_OF_LEG, TransitionError } from "./states";
import { LEG_TEMPLATES, templateByKey } from "./templates";
import { checkDriver, checkTruck, checkCarrierZone, summarize, type Finding } from "./eligibility";
import { legZone, legsFromStops, HANDOFF, type LegZone } from "./zones";
import { complianceFindings, statusMap, forLeg } from "./compliance";

/**
 * Orders & dispatch service (spec §2, §11.1–11.3, §11.15). Every write runs in one transaction,
 * is tenant-scoped, and leaves an audit row. State changes go through the transition tables.
 */

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export class EligibilityError extends Error {
  constructor(public findings: Finding[], public hardBlocked: boolean) {
    super(findings.map((f) => f.message).join("; "));
    this.name = "EligibilityError";
  }
}
export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

type Order = typeof s.orders.$inferSelect;
type Stop = typeof s.stops.$inferSelect;
type Leg = typeof s.legs.$inferSelect;

export type StopInput = {
  type: StopType;
  name: string;
  sealIn?: string | null;
  sealOut?: string | null;
  locationId?: string | null;
  address?: Stop["address"];
  country?: string;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  appointment?: boolean;
  contact?: string | null;
  refs?: Record<string, string>;
  notes?: string | null;
};

export type CreateOrderInput = {
  customerId?: string | null;
  brokerId?: string | null;
  billingEntityId?: string | null;
  portId?: string | null;
  equipment?: string;
  refs?: Record<string, string>;
  rateCents?: number | null;
  rateTbd?: boolean;
  currency?: string;
  fuelRule?: string;
  freight?: s.FreightLine[];
  cargoNote?: string | null;
  template?: string | null;
  /** Tailgate trips: legs cut from the stops by the caller instead of a fixed template. */
  legPlan?: { type: LegType; from: number; to: number }[] | null;
  kind?: s.OrderKind;
  source?: string;
  sourceRef?: string | null;
  stops: StopInput[];
  book?: boolean;
};

const ACTIVE_LEG = ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const;
const MOVING_LEG = ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const;

// ---------- loaders ----------

async function loadOrder(tx: Tx, ctx: Ctx, orderId: string): Promise<Order> {
  const [o] = await tx.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!o) throw new NotFoundError("order", orderId);
  return o;
}
async function loadLeg(tx: Tx, ctx: Ctx, legId: string): Promise<Leg> {
  const [l] = await tx.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l) throw new NotFoundError("leg", legId);
  return l;
}
async function loadLegs(tx: Tx, ctx: Ctx, orderId: string): Promise<Leg[]> {
  return tx.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId))).orderBy(asc(s.legs.seq));
}
async function loadStops(tx: Tx, ctx: Ctx, orderId: string): Promise<Stop[]> {
  return tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId))).orderBy(asc(s.stops.seq));
}

export async function getOrder(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    const [stops, legs] = await Promise.all([loadStops(tx, ctx, orderId), loadLegs(tx, ctx, orderId)]);
    return { order, stops, legs };
  });
}

export async function getLeg(ctx: Ctx, legId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const [l] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l) throw new NotFoundError("leg", legId);
  return l;
}

export async function listOrders(ctx: Ctx, opts: { states?: OrderState[]; limit?: number } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const where = opts.states?.length ? and(eq(s.orders.tenantId, ctx.tenantId), inArray(s.orders.state, opts.states)) : eq(s.orders.tenantId, ctx.tenantId);
  return db.select().from(s.orders).where(where).orderBy(desc(s.orders.createdAt)).limit(opts.limit ?? 500);
}

// ---------- numbering ----------

/** YY-NNNNN per tenant, gap-free within a year, serialized on the tenant row (spec §2.1). */
async function nextOrderNumber(tx: Tx, tenantId: string, now = new Date()): Promise<string> {
  await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
  const yy = String(now.getFullYear()).slice(-2);
  const [row] = await tx
    .select({ max: sql<string | null>`max(${s.orders.orderNumber})` })
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, tenantId), sql`${s.orders.orderNumber} like ${yy + "-%"}`));
  const last = row?.max ? parseInt(row.max.split("-")[1] ?? "0", 10) : 0;
  return `${yy}-${String(last + 1).padStart(5, "0")}`;
}

// ---------- create / book / cancel ----------

export async function createOrder(ctx: Ctx, input: CreateOrderInput) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  if (!input.stops || input.stops.length < 2) throw new ValidationError("an order needs at least a pickup and a delivery", "stops");
  for (const st of input.stops) if (!st.name?.trim()) throw new ValidationError("every stop needs a name", "stops");
  if (input.rateCents != null && input.rateCents < 0) throw new ValidationError("rate cannot be negative", "rateCents");

  let template: { key: string; legs: { type: LegType; from: number; to: number }[] };
  if (input.legPlan) {
    for (const lg of input.legPlan) if (lg.from < 0 || lg.to >= input.stops.length || lg.from >= lg.to) throw new ValidationError("leg plan does not fit the stops", "stops");
    template = { key: input.kind === "trip" ? "trip" : "custom", legs: input.legPlan };
  } else if (!input.template) {
    // the stops as entered, any number of them: a leg ends wherever the trailer changes hands
    template = { key: "stops", legs: legsFromStops(input.stops) };
  } else {
    const templateKey = input.template;
    const found = templateByKey(templateKey);
    if (!found) throw new ValidationError(`unknown leg template ${templateKey}`, "template");
    if (found.stops.length !== input.stops.length) throw new ValidationError(`template "${found.label}" expects ${found.stops.length} stops, got ${input.stops.length}`, "template");
    template = found;
  }

  return db.transaction(async (tx) => {
    const orderId = newId();
    const orderNumber = await nextOrderNumber(tx, ctx.tenantId);
    const values: typeof s.orders.$inferInsert = {
      id: orderId,
      tenantId: ctx.tenantId,
      orderNumber,
      customerId: input.customerId ?? null,
      brokerId: input.brokerId ?? null,
      billingEntityId: input.billingEntityId ?? null,
      portId: input.portId ?? null,
      equipment: input.equipment ?? "53_dry",
      refs: input.refs ?? {},
      rateCents: input.rateCents ?? null,
      rateTbd: input.rateTbd ?? false,
      currency: input.currency ?? "USD",
      fuelRule: input.fuelRule ?? "included",
      freight: input.freight ?? [],
      cargoNote: input.cargoNote ?? null,
      legTemplate: template.key,
      kind: input.kind ?? "order",
      source: input.source ?? "manual",
      sourceRef: input.sourceRef ?? null,
      state: "draft",
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    const [order] = await tx.insert(s.orders).values(values).returning();
    await writeAudit(tx, ctx, "order", orderId, "create", diff(null, { orderNumber, customerId: values.customerId, rateCents: values.rateCents, legTemplate: template.key }));

    const locIds = input.stops.map((st) => st.locationId).filter((x): x is string => !!x);
    const locs = locIds.length ? await tx.select({ id: s.locations.id, lat: s.locations.lat, lng: s.locations.lng }).from(s.locations).where(and(eq(s.locations.tenantId, ctx.tenantId), inArray(s.locations.id, locIds))) : [];
    const stopRows = input.stops.map((st, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      orderId,
      seq: i + 1,
      type: st.type,
      locationId: st.locationId ?? null,
      name: st.name.trim(),
      address: st.address ?? null,
      country: st.country ?? "US",
      lat: st.locationId ? (locs.find((l) => l.id === st.locationId)?.lat ?? null) : null,
      lng: st.locationId ? (locs.find((l) => l.id === st.locationId)?.lng ?? null) : null,
      windowStart: st.windowStart ?? null,
      windowEnd: st.windowEnd ?? null,
      appointment: st.appointment ?? false,
      contact: st.contact ?? null,
      refs: st.refs ?? {},
      notes: st.notes ?? null,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    }));
    const stops = await tx.insert(s.stops).values(stopRows).returning();

    const legRows = template.legs.map((lg, i) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      orderId,
      seq: i + 1,
      type: lg.type,
      fromStopId: stops[lg.from].id,
      toStopId: stops[lg.to].id,
      state: "unassigned" as LegState,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    }));
    const legs = legRows.length ? await tx.insert(s.legs).values(legRows).returning() : []; // a tailgate shipment has none: its trip moves it

    let finalOrder = order;
    if (input.book) finalOrder = await bookIn(tx, ctx, order, stops);
    return { order: finalOrder, stops, legs };
  }).then(async (r) => {
    if (r.legs.some((l) => l.type === "crossing")) {
      const { ensureCrossingsForOrder } = await import("./crossing");
      await ensureCrossingsForOrder(ctx, r.order.id);
    }
    return r;
  });
}

function bookGuards(order: Order, stops: Stop[]) {
  const problems: { field: string; message: string }[] = [];
  if (order.kind !== "trip" && !order.customerId && !order.brokerId) problems.push({ field: "customerId", message: "pick a customer or broker" });
  if (order.kind !== "trip" && order.rateCents == null && !order.rateTbd) problems.push({ field: "rateCents", message: "enter a rate or mark it TBD" });
  if (stops.length < 2) problems.push({ field: "stops", message: "at least two stops" });
  return problems;
}

async function setOrderState(tx: Tx, ctx: Ctx, order: Order, to: OrderState, extra: Partial<typeof s.orders.$inferInsert> = {}, note?: string) {
  if (order.state === to) return order;
  assertOrderTransition(order.state, to);
  const [after] = await tx
    .update(s.orders)
    .set({ state: to, previousState: order.state, updatedAt: new Date(), updatedBy: ctx.userId, ...extra })
    .where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, order.id)))
    .returning();
  await writeAudit(tx, ctx, "order", order.id, "transition", { state: { from: order.state, to } }, note);
  if (to === "dispatched") await sendTrackingIfRequired(tx, ctx, after);
  return after;
}

/**
 * A customer whose tracking requirement is "link" gets the tracking link by email the moment the order is
 * dispatched, once per order, to the first contact with an email (never the billing mailbox). EDI-214
 * customers get their 214s; portal customers have the portal.
 */
async function sendTrackingIfRequired(tx: Tx, ctx: Ctx, order: Order) {
  const custId = order.customerId ?? order.brokerId;
  if (!custId) return;
  const [cust] = await tx.select().from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), eq(s.customers.id, custId))).limit(1);
  if (!cust || cust.trackingRequirement !== "link") return;
  const to = cust.contacts.find((c) => c.email)?.email; // an operations contact, never the AP mailbox
  if (!to) return;
  const [already] = await tx.select({ id: s.outbox.id }).from(s.outbox).where(and(eq(s.outbox.tenantId, ctx.tenantId), eq(s.outbox.subjectKind, "tracking_link"), eq(s.outbox.subjectId, order.id), eq(s.outbox.channel, "email"))).limit(1);
  if (already) return;
  const { issueToken, publicUrl } = await import("@/lib/tokens");
  const { enqueue } = await import("@/lib/outbox");
  const [tenant] = await tx.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const stops = await tx.select().from(s.stops).where(eq(s.stops.orderId, order.id)).orderBy(asc(s.stops.seq));
  const tok = await issueToken(ctx, "tracking_link", order.id, { label: "customer" }, tx);
  const url = publicUrl(`/track/${tok.token}`);
  const route = stops.length ? `${stops[0].name} → ${stops[stops.length - 1].name}` : order.orderNumber;
  const ref = order.refs.po ? ` · PO ${order.refs.po}` : order.refs.shipment ? ` · shipment ${order.refs.shipment}` : "";
  await enqueue(ctx, { channel: "email", to, subject: `Tracking for ${order.orderNumber}${ref}: ${route}`, body: `${cust.name},

Your load ${order.orderNumber}${ref} (${route}) is dispatched with ${tenant?.name ?? "us"}. Follow it here, live, until it delivers:

${url}

This link is for this load only.`, subjectKind: "tracking_link", subjectId: order.id, meta: { kind: "tracking" } }, tx);
}

async function bookIn(tx: Tx, ctx: Ctx, order: Order, stops: Stop[]) {
  const problems = bookGuards(order, stops);
  if (problems.length) throw new ValidationError(problems.map((p) => p.message).join("; "), problems[0].field);
  // a customer-portal request is answered by booking it
  await tx.update(s.flags).set({ clearedAt: new Date() }).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.orderId, order.id), eq(s.flags.code, "portal_request"), sql`${s.flags.clearedAt} is null`));
  return setOrderState(tx, ctx, order, "booked");
}

/**
 * "Book it again": a new draft with the same customer, rate, equipment, stops and notes. Windows, references
 * that belong to the old load (rate con, PO, shipment), the crossing paperwork and every leg assignment start
 * over — a recurring lane is the same shape, never the same load.
 */
export async function copyOrder(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const { order, stops, legs } = await getOrder(ctx, orderId);
  if (order.kind !== "order") throw new ValidationError("only a plain order can be copied; build a new trip from its stops instead");
  const legPlan = legs
    .filter((l) => l.state !== "cancelled")
    .map((l) => ({ type: l.type, from: stops.findIndex((st) => st.id === l.fromStopId), to: stops.findIndex((st) => st.id === l.toStopId) }))
    .filter((l) => l.from >= 0 && l.to > l.from);
  const refs: Record<string, string> = {};
  if (order.refs.reference) refs.reference = order.refs.reference;
  return createOrder(ctx, {
    customerId: order.customerId,
    brokerId: order.brokerId,
    billingEntityId: order.billingEntityId,
    portId: order.portId,
    equipment: order.equipment,
    refs,
    rateCents: order.rateCents,
    rateTbd: order.rateTbd,
    currency: order.currency,
    fuelRule: order.fuelRule,
    freight: order.freight ?? [],
    cargoNote: order.cargoNote,
    legPlan: legPlan.length ? legPlan : null,
    template: legPlan.length || !order.legTemplate || !templateByKey(order.legTemplate) ? null : order.legTemplate,
    source: "copy",
    sourceRef: order.orderNumber,
    stops: stops.map((st) => ({ type: st.type, name: st.name, locationId: st.locationId, address: st.address, country: st.country, appointment: st.appointment, contact: st.contact, notes: st.notes })),
    book: false,
  });
}

export async function bookOrder(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  return db.transaction(async (tx) => bookIn(tx, ctx, await loadOrder(tx, ctx, orderId), await loadStops(tx, ctx, orderId)));
}

export async function updateOrder(ctx: Ctx, orderId: string, values: Partial<CreateOrderInput> & Record<string, unknown>, expectedUpdatedAt?: Date) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  return db.transaction(async (tx) => {
    const before = await loadOrder(tx, ctx, orderId);
    if (expectedUpdatedAt && before.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new ValidationError("someone else changed this order; reload", "updatedAt");
    if (["paid", "cancelled"].includes(before.state)) throw new ValidationError(`a ${before.state} order is read-only`);
    const allowed = ["customerId", "brokerId", "billingEntityId", "portId", "equipment", "refs", "rateCents", "rateTbd", "currency", "fuelRule", "fuelPct", "tollsFeesCents", "freight", "cargoNote", "custom"] as const;
    const safe: Record<string, unknown> = {};
    for (const k of allowed) if (k in values) safe[k] = values[k];
    if (typeof safe.rateCents === "number" && safe.rateCents < 0) throw new ValidationError("rate cannot be negative", "rateCents");
    const [after] = await tx
      .update(s.orders)
      .set({ ...safe, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId)))
      .returning();
    await writeAudit(tx, ctx, "order", orderId, "update", diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
    return after;
  });
}

export async function updateStop(ctx: Ctx, stopId: string, values: Partial<StopInput>) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.id, stopId))).limit(1);
    if (!before) throw new NotFoundError("stop", stopId);
    const order = await loadOrder(tx, ctx, before.orderId);
    if (["paid", "cancelled"].includes(order.state)) throw new ValidationError(`a ${order.state} order is read-only`);
    if (values.name !== undefined && !values.name?.trim()) throw new ValidationError("a stop needs a name", "name");
    const allowed = ["name", "locationId", "address", "country", "windowStart", "windowEnd", "appointment", "contact", "refs", "notes", "type", "sealIn", "sealOut"] as const;
    const safe: Record<string, unknown> = {};
    for (const k of allowed) if (k in values) safe[k] = values[k];
    if (typeof safe.name === "string") safe.name = safe.name.trim();
    for (const k of ["sealIn", "sealOut"] as const) if (k in safe) safe[k] = typeof safe[k] === "string" && (safe[k] as string).trim() ? (safe[k] as string).trim() : null;
    const [after] = await tx
      .update(s.stops)
      .set({ ...safe, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.id, stopId)))
      .returning();
    await writeAudit(tx, ctx, "stop", stopId, "update", diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
    if ("sealIn" in safe || "sealOut" in safe) await checkSealContinuity(tx, ctx, before.orderId);
    return after;
  });
}

/**
 * A verified arrival is a geocode: a stop with no coordinates takes the phone's fix, and so does the
 * location it came from when it has none — the second run to the same plant gets an ETA without
 * anyone typing a latitude.
 */
export async function learnStopCoordinates(tx: Tx | typeof db, ctx: Ctx, stopId: string, lat: string, lng: string) {
  const c = coords(lat, lng);
  if (!c) return;
  const [stop] = await tx.select({ id: s.stops.id, lat: s.stops.lat, lng: s.stops.lng, locationId: s.stops.locationId }).from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.id, stopId))).limit(1);
  if (!stop) return;
  const val = { lat: c.lat.toFixed(6), lng: c.lng.toFixed(6) };
  if (!coords(stop.lat, stop.lng)) await tx.update(s.stops).set(val).where(eq(s.stops.id, stop.id));
  if (stop.locationId) {
    const [loc] = await tx.select({ id: s.locations.id, lat: s.locations.lat, lng: s.locations.lng }).from(s.locations).where(and(eq(s.locations.tenantId, ctx.tenantId), eq(s.locations.id, stop.locationId))).limit(1);
    if (loc && !coords(loc.lat, loc.lng)) {
      await tx.update(s.locations).set({ ...val, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.locations.id, loc.id));
      await writeAudit(tx, ctx, "location", loc.id, "update", { lat: { from: null, to: val.lat }, lng: { from: null, to: val.lng } }, "learned from a verified arrival");
    }
  }
}

/**
 * Seal continuity (spec §12 "seal continuity across stops recorded at each open/close"): the seal a
 * stop was left with must be the seal found at the next stop. A difference is a red flag on the
 * order naming both; a correction clears it. Runs whenever a seal is recorded, from any app.
 */
export async function checkSealContinuity(tx: Tx | typeof db, ctx: Ctx, orderId: string) {
  const stops = await tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId))).orderBy(s.stops.seq);
  const open = await tx.select().from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.orderId, orderId), eq(s.flags.code, "seal_mismatch"), sql`${s.flags.clearedAt} is null`));
  let opened = 0;
  let cleared = 0;
  for (let i = 1; i < stops.length; i++) {
    // the seal to match is the last one applied before this stop (a stop with no seal recorded is skipped, not a break)
    const prev = [...stops.slice(0, i)].reverse().find((x) => x.sealOut);
    const cur = stops[i];
    const existing = open.find((f) => (f.data as { stopId?: string } | null)?.stopId === cur.id);
    const mismatch = !!prev?.sealOut && !!cur.sealIn && prev.sealOut.trim().toUpperCase() !== cur.sealIn.trim().toUpperCase();
    if (mismatch && !existing) {
      await tx.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId, code: "seal_mismatch", level: "red", title: `Seal ${prev!.sealOut} applied at ${prev!.name}; ${cur.sealIn} found at ${cur.name}`, detail: "The trailer was opened between the two, or a number was typed wrong. Check with the driver and the receiver before the load moves on; fix the number on the stop if it was a typo.", owner: "dispatch", data: { stopId: cur.id, expected: prev!.sealOut, found: cur.sealIn } });
      const legs = await tx.select({ id: s.legs.id, fromStopId: s.legs.fromStopId, toStopId: s.legs.toStopId }).from(s.legs).where(eq(s.legs.orderId, orderId)).orderBy(s.legs.seq);
      const legId = (legs.find((l) => l.toStopId === cur.id || l.fromStopId === cur.id) ?? legs[0])?.id;
      if (legId) await tx.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId, orderId, kind: "flag", source: "system", verified: false, note: `Seal mismatch at ${cur.name}: expected ${prev!.sealOut}, found ${cur.sealIn}` });
      opened++;
    } else if (!mismatch && existing) {
      await tx.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(eq(s.flags.id, existing.id));
      cleared++;
    }
  }
  return { opened, cleared };
}

// ---------- building the load stop by stop ----------

const NOT_STARTED: LegState[] = ["unassigned", "planned", "declined"];

/**
 * Add, remove or reorder stops on a load, the way every TMS lets you: before anything is dispatched
 * the stops are free and the legs are cut again from them (a leg keeps its truck or carrier when its
 * two ends did not change). Once a leg is out, a pickup or drop can still be added or removed inside a
 * leg that has not reached it; hand-offs after dispatch are a split.
 */
type StopDraft = { id: string | null; row: Partial<typeof s.stops.$inferInsert> & { type: StopType; name: string; country: string }; arrived: boolean };

async function restructureStops(ctx: Ctx, orderId: string, change: (stops: StopDraft[]) => StopDraft[], note: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const result = await db.transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    if (order.kind === "shipment") throw new ValidationError("a shipment rides its trip's stops; change them on the trip");
    if (order.kind === "trip") throw new ValidationError("change a trip's stops on the trip builder");
    if (["delivered", "ready_to_bill", "invoiced", "paid", "cancelled"].includes(order.state)) throw new ValidationError(`a ${order.state.replace(/_/g, " ")} load's stops are final`);
    const before = await tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId))).orderBy(asc(s.stops.seq));
    const legs = await tx.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId))).orderBy(asc(s.legs.seq));
    const live = legs.filter((l) => l.state !== "cancelled");
    const started = live.some((l) => !NOT_STARTED.includes(l.state));
    const next = change(before.map((st) => ({ id: st.id, row: { ...st }, arrived: !!st.arrivedAt })));
    if (next.length < 2) throw new ValidationError("a load needs at least two stops", "stops");
    for (const st of next) if (!st.row.name?.trim()) throw new ValidationError("every stop needs a name", "stops");
    const removed = before.filter((st) => !next.some((n) => n.id === st.id));
    for (const r of removed) if (r.arrivedAt) throw new ValidationError(`${r.name} was already reached; it stays`);

    if (started) {
      // legs keep their ends: nothing may move across or remove a leg's first or last stop, or a stop already reached
      const ends = new Set(live.flatMap((l) => [l.fromStopId, l.toStopId]));
      for (const r of removed) if (ends.has(r.id)) throw new ValidationError(`${r.name} is where a leg starts or ends; with the load already out, split or pull back the leg instead`);
      const order_ = next.map((n) => n.id).filter((x): x is string => !!x);
      const kept = before.filter((st) => order_.includes(st.id)).map((st) => st.id);
      if (kept.join() !== order_.join()) {
        // moving stops once out: only stops not yet reached, and never past a leg end
        for (const l of live) {
          const a = order_.indexOf(l.fromStopId!);
          const b = order_.indexOf(l.toStopId!);
          if (a >= b) throw new ValidationError("that move would turn a leg around; split the leg instead");
        }
      }
      for (const n of next) if (!n.id && HANDOFF.includes(n.row.type)) throw new ValidationError("the load is already out: add a yard or transfer by splitting the leg there");
      const reachedSeqs = next.map((n, i) => (n.arrived ? i : -1)).filter((i) => i >= 0);
      const lastReached = reachedSeqs.length ? Math.max(...reachedSeqs) : -1;
      next.forEach((n, i) => {
        if (!n.id && i <= lastReached) throw new ValidationError("a new stop has to come after the last stop the truck reached");
      });
    }

    // write: temporary seqs first, then the final order
    await tx.update(s.stops).set({ seq: sql`${s.stops.seq} + 10000` }).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId)));
    for (const r of removed) await tx.delete(s.stops).where(eq(s.stops.id, r.id));
    const finalIds: string[] = [];
    for (let i = 0; i < next.length; i++) {
      const n = next[i];
      if (n.id) {
        await tx.update(s.stops).set({ seq: i + 1, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.stops.id, n.id));
        finalIds.push(n.id);
      } else {
        const id = newId();
        const r = n.row;
        await tx.insert(s.stops).values({ id, tenantId: ctx.tenantId, orderId, seq: i + 1, type: r.type, locationId: r.locationId ?? null, name: r.name.trim(), address: r.address ?? null, country: r.country, lat: r.lat ?? null, lng: r.lng ?? null, windowStart: r.windowStart ?? null, windowEnd: r.windowEnd ?? null, appointment: r.appointment ?? false, contact: r.contact ?? null, refs: r.refs ?? {}, notes: r.notes ?? null, createdBy: ctx.userId, updatedBy: ctx.userId });
        finalIds.push(id);
      }
    }
    const stopsNow = await tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId))).orderBy(asc(s.stops.seq));

    if (!started) {
      // cut the legs again; a leg whose two ends are unchanged keeps its row, assignment and history
      const plan = legsFromStops(stopsNow);
      const keep = new Set<string>();
      for (let k = 0; k < plan.length; k++) {
        const p = plan[k];
        const fromId = stopsNow[p.from].id;
        const toId = stopsNow[p.to].id;
        const same = live.find((l) => l.fromStopId === fromId && l.toStopId === toId && !keep.has(l.id));
        if (same) {
          keep.add(same.id);
          await tx.update(s.legs).set({ seq: k + 1, type: p.type, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.legs.id, same.id));
        } else {
          const id = newId();
          keep.add(id);
          await tx.insert(s.legs).values({ id, tenantId: ctx.tenantId, orderId, seq: k + 1, type: p.type, fromStopId: fromId, toStopId: toId, state: "unassigned", createdBy: ctx.userId, updatedBy: ctx.userId });
        }
      }
      for (const l of legs) {
        if (keep.has(l.id)) continue;
        const [x] = await tx.select({ id: s.crossings.id }).from(s.crossings).where(eq(s.crossings.legId, l.id)).limit(1);
        if (x) {
          const [doc] = await tx.select({ id: s.documents.id }).from(s.documents).where(and(eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, x.id))).limit(1);
          if (doc) throw new ValidationError("the crossing on this load already has documents uploaded; move them or keep the border stops as they are");
          await tx.delete(s.crossings).where(eq(s.crossings.id, x.id));
        }
        await tx.update(s.tenders).set({ state: "withdrawn", respondedAt: new Date(), respondedBy: "dispatcher", responseNote: "the leg was re-cut" }).where(and(eq(s.tenders.legId, l.id), eq(s.tenders.state, "sent")));
        await tx.delete(s.legEvents).where(eq(s.legEvents.legId, l.id));
        await tx.delete(s.legs).where(eq(s.legs.id, l.id));
      }
      await tx.update(s.orders).set({ legTemplate: "stops", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, orderId));
    } else {
      // legs keep their ends; a leg's type follows the countries it now runs through
      const international = new Set(stopsNow.map((x) => x.country)).size > 1;
      for (const l of live) {
        const a = stopsNow.findIndex((x) => x.id === l.fromStopId);
        const b = stopsNow.findIndex((x) => x.id === l.toStopId);
        const on = new Set(stopsNow.slice(a, b + 1).map((x) => x.country));
        const type: LegType = l.type === "equipment_move" ? l.type : on.size > 1 ? "crossing" : on.has("MX") ? "mx" : on.has("CA") ? "ca" : international ? "us" : "domestic";
        if (type !== l.type) await tx.update(s.legs).set({ type }).where(eq(s.legs.id, l.id));
      }
    }
    await writeAudit(tx, ctx, "order", orderId, "update", { stops: { from: before.map((x) => x.name).join(", "), to: stopsNow.map((x) => x.name).join(", ") } }, note);
    return { stops: stopsNow };
  });
  const { ensureCrossingsForOrder } = await import("./crossing");
  await ensureCrossingsForOrder(ctx, orderId);
  void result;
  return getOrder(ctx, orderId);
}

/** Put a new stop on the load at a position (0 = first). */
export async function addStop(ctx: Ctx, orderId: string, position: number, stop: StopInput) {
  if (!stop.name?.trim()) throw new ValidationError("a stop needs a name", "name");
  return restructureStops(
    ctx,
    orderId,
    (list) => {
      const at = Math.max(0, Math.min(position, list.length));
      const row = { type: stop.type, name: stop.name.trim(), country: stop.country ?? "US", locationId: stop.locationId ?? null, address: stop.address ?? null, windowStart: stop.windowStart ?? null, windowEnd: stop.windowEnd ?? null, appointment: stop.appointment ?? false, contact: stop.contact ?? null, refs: stop.refs ?? {}, notes: stop.notes ?? null };
      return [...list.slice(0, at), { id: null, row, arrived: false }, ...list.slice(at)];
    },
    `stop added: ${stop.name.trim()}`,
  );
}

export async function removeStop(ctx: Ctx, orderId: string, stopId: string) {
  return restructureStops(ctx, orderId, (list) => {
    if (!list.some((x) => x.id === stopId)) throw new NotFoundError("stop", stopId);
    return list.filter((x) => x.id !== stopId);
  }, "stop removed");
}

/** Move a stop one place up (-1) or down (+1). */
export async function moveStop(ctx: Ctx, orderId: string, stopId: string, dir: -1 | 1) {
  return restructureStops(ctx, orderId, (list) => {
    const i = list.findIndex((x) => x.id === stopId);
    if (i < 0) throw new NotFoundError("stop", stopId);
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    if (list[i].arrived || list[j].arrived) throw new ValidationError("a stop already reached cannot move");
    const out = [...list];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }, "stops reordered");
}

export async function orderTimeline(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const [events, audits, flagRows] = await Promise.all([
    db.select().from(s.legEvents).where(and(eq(s.legEvents.tenantId, ctx.tenantId), eq(s.legEvents.orderId, orderId))).orderBy(desc(s.legEvents.at)).limit(200),
    db.select().from(s.auditLog).where(and(eq(s.auditLog.tenantId, ctx.tenantId), eq(s.auditLog.entityId, orderId))).orderBy(desc(s.auditLog.at)).limit(100),
    db.select().from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.orderId, orderId))).orderBy(desc(s.flags.openedAt)),
  ]);
  return { events, audits, flags: flagRows };
}

export async function cancelOrder(ctx: Ctx, orderId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.cancel");
  if (!reason?.trim()) throw new ValidationError("a cancel reason is required", "reason");
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    const legs = await loadLegs(tx, ctx, orderId);
    if (legs.some((l) => (MOVING_LEG as readonly string[]).includes(l.state)))
      throw new TransitionError("order", order.state, "cancelled", "a leg is moving; bring it back or complete it first");
    for (const l of legs) if (l.state !== "completed" && l.state !== "cancelled") await setLegState(tx, ctx, l, "cancelled", { source: "dispatcher", note: reason });
    await tx.update(s.flags).set({ clearedAt: new Date() }).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.orderId, order.id), sql`${s.flags.clearedAt} is null`));
    return setOrderState(tx, ctx, order, "cancelled", { cancelReason: reason.trim() }, reason);
  });
}

// ---------- hold / release (order-level exception) ----------

export async function holdOrder(ctx: Ctx, orderId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!reason?.trim()) throw new ValidationError("a hold reason is required", "reason");
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    if (!canOrderTransition(order.state, "exception")) throw new TransitionError("order", order.state, "exception", "only dispatched or in-transit orders can be held");
    return setOrderState(tx, ctx, order, "exception", { holdReason: reason.trim() }, reason);
  });
}

export async function releaseOrder(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, orderId);
    if (order.state !== "exception") throw new TransitionError("order", order.state, "release", "order is not on hold");
    const legs = await loadLegs(tx, ctx, orderId);
    const to = derivedOrderState(legs, order) ?? "dispatched";
    return setOrderState(tx, ctx, order, to, { holdReason: null }, "released");
  });
}

// ---------- legs: plan / unplan / dispatch / accept / decline / advance ----------

async function setLegState(
  tx: Tx,
  ctx: Ctx,
  leg: Leg,
  to: LegState,
  ev: { source?: EventSource; verified?: boolean; at?: Date; lat?: string; lng?: string; note?: string; data?: Record<string, unknown> } = {},
  extra: Partial<typeof s.legs.$inferInsert> = {},
) {
  assertLegTransition(leg.state, to);
  const at = ev.at ?? new Date();
  const [after] = await tx
    .update(s.legs)
    .set({ state: to, updatedAt: new Date(), updatedBy: ctx.userId, ...extra })
    .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, leg.id)))
    .returning();
  await tx.insert(s.legEvents).values({
    id: newId(),
    tenantId: ctx.tenantId,
    legId: leg.id,
    orderId: leg.orderId,
    at,
    kind: "transition",
    fromState: leg.state,
    toState: to,
    source: ev.source ?? "dispatcher",
    verified: ev.verified ?? false,
    lat: ev.lat,
    lng: ev.lng,
    userId: ctx.userId,
    note: ev.note,
    data: ev.data,
  });
  await writeAudit(tx, ctx, "leg", leg.id, "transition", { state: { from: leg.state, to } }, ev.note);
  return after;
}

/** Where a leg runs, from its stops: the countries it touches decide who may run it. */
export async function zoneForLeg(tx: Tx | typeof db, leg: Leg): Promise<LegZone> {
  const stops = await tx.select({ id: s.stops.id, seq: s.stops.seq, country: s.stops.country }).from(s.stops).where(eq(s.stops.orderId, leg.orderId));
  return legZone(leg, stops);
}

export type Assignment =
  | { kind: "truck"; truckId: string; driverId?: string | null; coDriverId?: string | null; trailerId?: string | null }
  | { kind: "carrier"; carrierId: string; carrierRateCents?: number | null };

export type PlanOptions = { override?: boolean; reason?: string; plannedStart?: Date | null; plannedEnd?: Date | null; plannedMiles?: number | null };

/** Run the eligibility engine for a proposed assignment. Pure read; used by planLeg and the picker. */
export async function eligibilityFor(ctx: Ctx, legType: LegType | LegZone, a: Assignment, now = new Date()) {
  assertCtx(ctx);
  const findings: Finding[] = [];
  if (a.kind === "truck") {
    const [truck] = await db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, a.truckId))).limit(1);
    if (!truck) throw new NotFoundError("truck", a.truckId);
    if (truck.archivedAt) findings.push({ level: "red", code: "truck_archived", message: `${truck.unitNumber} is archived`, overridable: false });
    findings.push(...checkTruck(truck, legType, now));
    findings.push(...(await complianceFindings(ctx, "truck", truck.id, `unit ${truck.unitNumber}`, legType)));
    for (const did of [a.driverId, a.coDriverId]) {
      if (!did) continue;
      const [drv] = await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), eq(s.drivers.id, did))).limit(1);
      if (!drv) throw new NotFoundError("driver", did);
      if (drv.archivedAt) findings.push({ level: "red", code: "driver_archived", message: `${drv.name} is archived`, overridable: false });
      findings.push(...checkDriver(drv, legType, now));
      findings.push(...(await complianceFindings(ctx, "driver", drv.id, drv.name, legType)));
    }
    if (a.driverId && a.coDriverId && a.driverId === a.coDriverId) findings.push({ level: "red", code: "same_driver", message: "driver and co-driver are the same person", overridable: false });
    if (a.trailerId) {
      const [tr] = await db.select().from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), eq(s.trailers.id, a.trailerId))).limit(1);
      if (!tr) throw new NotFoundError("trailer", a.trailerId);
      if (tr.status === "oos") findings.push({ level: "red", code: "trailer_oos", message: `trailer ${tr.unitNumber} is out of service`, overridable: false });
    }
  } else {
    const [c] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, a.carrierId))).limit(1);
    if (!c) throw new NotFoundError("carrier", a.carrierId);
    if (c.archivedAt) findings.push({ level: "red", code: "carrier_archived", message: `${c.name} is archived`, overridable: false });
    if (c.doNotUse) findings.push({ level: "red", code: "carrier_do_not_use", message: `${c.name} is marked do-not-use`, overridable: false });
    if (c.country === "MX" && c.caatExpires && c.caatExpires.getTime() < now.getTime()) findings.push({ level: "red", code: "caat_expired", message: `${c.name}: CAAT expired`, overridable: false });
    if (c.country === "US" && c.fmcsaStatus?.authority && c.fmcsaStatus.authority.toLowerCase() !== "active") findings.push({ level: "red", code: "fmcsa_not_authorized", message: `${c.name}: FMCSA authority ${c.fmcsaStatus.authority}`, overridable: false });
    findings.push(...checkCarrierZone(c, legType));
    findings.push(...(await complianceFindings(ctx, "carrier", c.id, c.name, legType)));
  }
  return summarize(findings);
}

export async function planLeg(ctx: Ctx, legId: string, a: Assignment, opts: PlanOptions = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const order = await loadOrder(tx, ctx, leg.orderId);
    if (order.state === "cancelled" || order.state === "draft") throw new TransitionError("leg", leg.state, "planned", order.state === "draft" ? "book the order first" : "order is cancelled");
    const from: LegState = leg.state === "declined" || leg.state === "dispatched" || leg.state === "accepted" ? "planned" : "planned";
    if (!["unassigned", "declined", "planned", "dispatched", "accepted"].includes(leg.state)) throw new TransitionError("leg", leg.state, from, "leg already moving");

    const elig = await eligibilityFor(ctx, await zoneForLeg(tx, leg), a);
    if (elig.hardBlocked) throw new EligibilityError(elig.findings, true);
    if (!elig.ok) {
      if (!opts.override) throw new EligibilityError(elig.findings, false);
      requirePermission(ctx, "dispatch.override");
      if (!opts.reason?.trim()) throw new ValidationError("an override needs a reason", "reason");
      await writeAudit(tx, ctx, "leg", leg.id, "override", { findings: { from: null, to: elig.findings.map((f) => f.code) } }, opts.reason);
    }

    const assignment =
      a.kind === "truck"
        ? { assigneeKind: "truck", truckId: a.truckId, driverId: a.driverId ?? null, coDriverId: a.coDriverId ?? null, trailerId: a.trailerId ?? null, carrierId: null, carrierRateCents: null }
        : { assigneeKind: "carrier", carrierId: a.carrierId, carrierRateCents: a.carrierRateCents ?? null, truckId: null, driverId: null, coDriverId: null, trailerId: null };
    const extra = {
      ...assignment,
      plannedStart: opts.plannedStart ?? leg.plannedStart,
      plannedEnd: opts.plannedEnd ?? leg.plannedEnd,
      plannedMiles: opts.plannedMiles ?? leg.plannedMiles,
      planReason: opts.reason ?? null,
      declineReason: null,
      dispatchedAt: null,
      acceptedAt: null,
    };
    let after: Leg;
    if (leg.state === "planned") {
      // re-plan in place: no state change, but audit the reassignment
      const [row] = await tx.update(s.legs).set({ ...extra, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, leg.id))).returning();
      after = row;
      await writeAudit(tx, ctx, "leg", leg.id, "assign", diff(leg as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>), opts.reason);
    } else {
      after = await setLegState(tx, ctx, leg, "planned", { source: "dispatcher", note: opts.reason }, extra);
      await writeAudit(tx, ctx, "leg", leg.id, "assign", diff({}, assignment as Record<string, unknown>));
    }
    await recomputeOrder(tx, ctx, order.id);
    return { leg: after, findings: elig.findings };
  });
}

/** Planned miles on a leg: drives per-mile driver pay and the fuel estimate. Editable until the order is invoiced. */
export async function setLegMiles(ctx: Ctx, legId: string, miles: number | null) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (miles != null && (!Number.isFinite(miles) || miles < 0 || miles > 10000)) throw new ValidationError("miles: 0–10,000", "plannedMiles");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const order = await loadOrder(tx, ctx, leg.orderId);
    if (["invoiced", "paid", "cancelled"].includes(order.state)) throw new ValidationError(`the order is ${order.state}; miles are locked`);
    const [after] = await tx.update(s.legs).set({ plannedMiles: miles == null ? null : Math.round(miles), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.legs.id, legId)).returning();
    await writeAudit(tx, ctx, "leg", legId, "update", diff(leg as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
    return after;
  });
}

export async function unplanLeg(ctx: Ctx, legId: string, reason?: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const cleared = { assigneeKind: null, truckId: null, driverId: null, coDriverId: null, trailerId: null, carrierId: null, carrierRateCents: null, planReason: null, dispatchedAt: null, acceptedAt: null };
    let after: Leg;
    if (leg.state === "dispatched" || leg.state === "accepted") {
      // back to planned first (allowed), then unassigned
      const mid = await setLegState(tx, ctx, leg, "planned", { source: "dispatcher", note: reason });
      after = await setLegState(tx, ctx, mid, "unassigned", { source: "dispatcher", note: reason }, cleared);
    } else {
      after = await setLegState(tx, ctx, leg, "unassigned", { source: "dispatcher", note: reason }, cleared);
    }
    await recomputeOrder(tx, ctx, leg.orderId);
    return after;
  });
}

export async function dispatchLeg(ctx: Ctx, legId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const order = await loadOrder(tx, ctx, leg.orderId);
    if (order.state === "draft") throw new TransitionError("leg", leg.state, "dispatched", "book the order first");
    if (order.state === "exception") throw new TransitionError("leg", leg.state, "dispatched", `order is on hold: ${order.holdReason ?? ""}`.trim());
    if (!leg.assigneeKind) throw new TransitionError("leg", leg.state, "dispatched", "plan the leg first");
    const after = await setLegState(tx, ctx, leg, "dispatched", { source: "dispatcher" }, { dispatchedAt: new Date() });
    await writeAudit(tx, ctx, "leg", leg.id, "dispatch");
    await recomputeOrder(tx, ctx, order.id);
    return after;
  });
}

export async function acceptLeg(ctx: Ctx, legId: string, source: EventSource = "driver_app") {
  assertCtx(ctx);
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const after = await setLegState(tx, ctx, leg, "accepted", { source }, { acceptedAt: new Date() });
    await recomputeOrder(tx, ctx, leg.orderId);
    return after;
  });
}

export async function declineLeg(ctx: Ctx, legId: string, reason: string, source: EventSource = "driver_app") {
  assertCtx(ctx);
  if (!reason?.trim()) throw new ValidationError("a decline reason is required", "reason");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const after = await setLegState(tx, ctx, leg, "declined", { source, note: reason }, { declineReason: reason.trim() });
    await tx.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: leg.orderId, legId: leg.id, code: "declined", level: "red", title: `Leg ${leg.seq} declined`, detail: reason.trim(), owner: "dispatch" });
    await recomputeOrder(tx, ctx, leg.orderId);
    return after;
  });
}

export type AdvanceEvent = { source?: EventSource; verified?: boolean; at?: Date; lat?: string; lng?: string; note?: string; data?: Record<string, unknown>; seal?: string | null };

// ---------- intermediate stops (a tailgate leg with three or more stops) ----------

type StopLike = { id: string; seq: number; name: string; arrivedAt: Date | null; departedAt: Date | null };

/** Stops strictly between a leg's first and last stop, in driving order. */
export function midStops<T extends StopLike>(leg: Pick<Leg, "fromStopId" | "toStopId">, stops: T[]): T[] {
  const from = stops.find((x) => x.id === leg.fromStopId);
  const to = stops.find((x) => x.id === leg.toStopId);
  if (!from || !to) return [];
  return stops.filter((x) => x.seq > from.seq && x.seq < to.seq).sort((a, b) => a.seq - b.seq);
}

/** The next intermediate stop the truck still has to clock: arrive at it, then leave it. Only while the leg is en route. */
export function pendingMidStop<T extends StopLike>(leg: Pick<Leg, "fromStopId" | "toStopId" | "state">, stops: T[]): { stop: T; which: "arrived" | "departed" } | null {
  if (leg.state !== "en_route") return null;
  for (const st of midStops(leg, stops)) {
    if (!st.arrivedAt) return { stop: st, which: "arrived" };
    if (!st.departedAt) return { stop: st, which: "departed" };
  }
  return null;
}

/** Clock an intermediate stop (arrived / departed). The leg stays en route; shipments that ride the trip follow the clocks. */
export async function stampStop(ctx: Ctx, legId: string, stopId: string, which: "arrived" | "departed", ev: AdvanceEvent = {}) {
  assertCtx(ctx);
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    const stops = await tx.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, leg.orderId)));
    const stop = midStops(leg, stops).find((x) => x.id === stopId);
    if (!stop) throw new ValidationError("that stop is not between this leg's pickup and delivery", "stopId");
    if (leg.state !== "en_route") throw new TransitionError("leg", leg.state, which, "the truck has to be en route to clock a stop in between");
    if (which === "arrived" && stop.arrivedAt) throw new ValidationError(`already arrived at ${stop.name}`);
    if (which === "departed" && !stop.arrivedAt) throw new ValidationError(`arrive at ${stop.name} first`);
    if (which === "departed" && stop.departedAt) throw new ValidationError(`already left ${stop.name}`);
    const at = ev.at ?? new Date();
    const seal = ev.seal?.trim() || null;
    await tx
      .update(s.stops)
      .set({ ...(which === "arrived" ? { arrivedAt: at, ...(seal ? { sealIn: seal } : {}) } : { departedAt: at, ...(seal ? { sealOut: seal } : {}) }), updatedAt: new Date(), updatedBy: ctx.userId })
      .where(eq(s.stops.id, stop.id));
    await tx.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: leg.id, orderId: leg.orderId, at, kind: "stop", fromState: leg.state, toState: leg.state, source: ev.source ?? "dispatcher", verified: ev.verified ?? false, lat: ev.lat, lng: ev.lng, userId: ctx.userId, note: `${which === "arrived" ? "Arrived at" : "Left"} ${stop.name}${seal ? ` · seal ${seal}` : ""}`, data: { stopId: stop.id, which, seal } });
    await writeAudit(tx, ctx, "stop", stop.id, "update", { [which === "arrived" ? "arrivedAt" : "departedAt"]: { from: null, to: at } }, `${which === "arrived" ? "arrived at" : "left"} ${stop.name} · leg ${leg.seq}`);
    if (seal) await checkSealContinuity(tx, ctx, leg.orderId);
    if (which === "arrived" && ev.verified && ev.lat && ev.lng) await learnStopCoordinates(tx, ctx, stop.id, ev.lat, ev.lng);
    await recomputeOrder(tx, ctx, leg.orderId);
    return leg;
  });
}

/** Move a leg one step (or to an explicit forward state). Writes the stop timestamps. */
export async function advanceLeg(ctx: Ctx, legId: string, to: LegState | "next", ev: AdvanceEvent = {}) {
  assertCtx(ctx);
  // "next" while en route with a stop still to clock in between = clock that stop, not the delivery
  if (to === "next") {
    const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
    if (leg?.state === "en_route") {
      const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, leg.orderId)));
      const mid = pendingMidStop(leg, stops);
      if (mid) return stampStop(ctx, legId, mid.stop.id, mid.which, ev);
    }
  }
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    let target: LegState;
    if (to === "next") {
      const i = LEG_FORWARD.indexOf(leg.state);
      if (leg.state === "dispatched") target = "accepted";
      else if (i < 0 || i === LEG_FORWARD.length - 1) throw new TransitionError("leg", leg.state, "next", "nothing further");
      else target = LEG_FORWARD[i + 1];
    } else target = to;
    if (!LEG_FORWARD.includes(target) && target !== "en_route") throw new TransitionError("leg", leg.state, target, "not a forward step");

    const at = ev.at ?? new Date();
    const extra: Partial<typeof s.legs.$inferInsert> = {};
    if (target === "accepted") extra.acceptedAt = at;
    if (target === "completed") extra.completedAt = at;
    const after = await setLegState(tx, ctx, leg, target, { ...ev, at }, extra);

    const stopId = target === "at_pickup" ? leg.fromStopId : target === "at_delivery" ? leg.toStopId : target === "loaded" ? leg.fromStopId : target === "completed" ? leg.toStopId : null;
    const seal = ev.seal?.trim() || null;
    if (stopId) {
      const arriving = target === "at_pickup" || target === "at_delivery";
      const set = arriving ? { arrivedAt: at, ...(seal ? { sealIn: seal } : {}) } : { departedAt: at, ...(seal ? { sealOut: seal } : {}) };
      await tx.update(s.stops).set({ ...set, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.id, stopId)));
      if (seal) await checkSealContinuity(tx, ctx, leg.orderId);
      if (arriving && ev.verified && ev.lat && ev.lng) await learnStopCoordinates(tx, ctx, stopId, ev.lat, ev.lng);
    }
    await recomputeOrder(tx, ctx, leg.orderId, target === "completed" ? at : undefined);
    return after;
  });
}

// ---------- order state derivation ----------

/** What the order's state should be given its legs; null = leave as is. */
export function derivedOrderState(legs: Leg[], order: Pick<Order, "state">): OrderState | null {
  if (["cancelled", "paid", "invoiced", "ready_to_bill"].includes(order.state)) return null;
  const live = legs.filter((l) => l.state !== "cancelled");
  if (!live.length) return null;
  if (live.every((l) => l.state === "completed")) return "delivered";
  if (live.some((l) => (MOVING_LEG as readonly string[]).includes(l.state))) return "in_transit";
  if (live.some((l) => l.state === "completed")) return "in_transit"; // between legs
  if (live.some((l) => l.state === "dispatched" || l.state === "accepted")) return "dispatched";
  if (order.state === "draft") return null;
  return "booked";
}

async function recomputeOrder(tx: Tx, ctx: Ctx, orderId: string, deliveredAt?: Date) {
  const order = await loadOrder(tx, ctx, orderId);
  if (order.state === "exception") return order; // hold is explicit; release recomputes
  const legs = await loadLegs(tx, ctx, orderId);
  const to = derivedOrderState(legs, order);
  let after = order;
  if (to && to !== order.state && canOrderTransition(order.state, to)) after = await setOrderState(tx, ctx, order, to, to === "delivered" ? { deliveredAt: deliveredAt ?? new Date() } : {}, "derived from legs");
  if (after.kind === "trip") {
    const { syncShipmentStates } = await import("./tailgate");
    await syncShipmentStates(tx, ctx, after.id);
  }
  return after;
}

// ---------- split ----------

/** Split a leg at a new stop (spec §11.3 / quick action Split). The first half keeps the assignment. */
export async function splitLeg(ctx: Ctx, legId: string, at: StopInput, secondType?: LegType) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  if (!at.name?.trim()) throw new ValidationError("the split stop needs a name", "stops");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    if (leg.state === "completed" || leg.state === "cancelled" || leg.state === "at_delivery") throw new TransitionError("leg", leg.state, "split", "too late to split this leg");
    const stops = await loadStops(tx, ctx, leg.orderId);
    const legs = await loadLegs(tx, ctx, leg.orderId);
    const from = stops.find((x) => x.id === leg.fromStopId)!;
    const toStop = stops.find((x) => x.id === leg.toStopId)!;

    // insert the stop after `from`
    const newSeq = from.seq + 1;
    for (const st of stops.filter((x) => x.seq >= newSeq).sort((p, q) => q.seq - p.seq))
      await tx.update(s.stops).set({ seq: st.seq + 1 }).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.id, st.id)));
    const [mid] = await tx
      .insert(s.stops)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        orderId: leg.orderId,
        seq: newSeq,
        type: at.type,
        locationId: at.locationId ?? null,
        name: at.name.trim(),
        address: at.address ?? null,
        country: at.country ?? toStop.country,
        windowStart: at.windowStart ?? null,
        windowEnd: at.windowEnd ?? null,
        appointment: at.appointment ?? false,
        refs: at.refs ?? {},
        notes: at.notes ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning();

    // shift later legs' seq, insert the second half
    for (const l of legs.filter((x) => x.seq > leg.seq).sort((p, q) => q.seq - p.seq))
      await tx.update(s.legs).set({ seq: l.seq + 1 }).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, l.id)));
    const [first] = await tx
      .update(s.legs)
      .set({ toStopId: mid.id, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, leg.id)))
      .returning();
    const [second] = await tx
      .insert(s.legs)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        orderId: leg.orderId,
        seq: leg.seq + 1,
        type: secondType ?? leg.type,
        fromStopId: mid.id,
        toStopId: leg.toStopId,
        state: "unassigned",
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, "leg", leg.id, "update", { toStopId: { from: leg.toStopId, to: mid.id } }, `split at ${mid.name}`);
    await writeAudit(tx, ctx, "leg", second.id, "create", diff(null, { seq: second.seq, type: second.type, fromStopId: mid.id, toStopId: leg.toStopId }), `split from leg ${leg.seq}`);
    await recomputeOrder(tx, ctx, leg.orderId);
    return { first, second, stop: mid };
  });
}

// ---------- unit OOS / team swap ----------

/** Put a truck out of service. Planned/sent legs go back to Pending; moving legs get a red flag (spec §11.3). */
export async function setTruckOos(ctx: Ctx, truckId: string, reason: string, until?: Date | null) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  if (!reason?.trim()) throw new ValidationError("an out-of-service reason is required", "reason");
  return db.transaction(async (tx) => {
    const [truck] = await tx.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, truckId))).limit(1);
    if (!truck) throw new NotFoundError("truck", truckId);
    await tx.update(s.trucks).set({ status: "oos", oosReason: reason.trim(), oosUntil: until ?? null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.trucks.id, truckId));
    await writeAudit(tx, ctx, "truck", truckId, "update", { status: { from: truck.status, to: "oos" }, oosReason: { from: truck.oosReason, to: reason.trim() } });
    const affected = await tx.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.truckId, truckId), inArray(s.legs.state, [...ACTIVE_LEG])));
    const unplanned: Leg[] = [];
    const flagged: Leg[] = [];
    for (const l of affected) {
      if ((MOVING_LEG as readonly string[]).includes(l.state)) {
        await tx.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: l.orderId, legId: l.id, code: "truck_oos", level: "red", title: `${truck.unitNumber} out of service while moving`, detail: reason.trim(), owner: "dispatch" });
        flagged.push(l);
      } else {
        const cleared = { assigneeKind: null, truckId: null, driverId: null, coDriverId: null, trailerId: null, planReason: null, dispatchedAt: null, acceptedAt: null };
        let cur = l;
        if (cur.state === "dispatched" || cur.state === "accepted") cur = await setLegState(tx, ctx, cur, "planned", { source: "system", note: `unit ${truck.unitNumber} OOS: ${reason}` });
        cur = await setLegState(tx, ctx, cur, "unassigned", { source: "system", note: `unit ${truck.unitNumber} OOS: ${reason}` }, cleared);
        unplanned.push(cur);
        await recomputeOrder(tx, ctx, l.orderId);
      }
    }
    return { unplanned, flagged };
  });
}

export async function setTruckActive(ctx: Ctx, truckId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  return db.transaction(async (tx) => {
    const [truck] = await tx.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, truckId))).limit(1);
    if (!truck) throw new NotFoundError("truck", truckId);
    await tx.update(s.trucks).set({ status: "active", oosReason: null, oosUntil: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.trucks.id, truckId));
    await writeAudit(tx, ctx, "truck", truckId, "update", { status: { from: truck.status, to: "active" } });
  });
}

/** Change drivers on a leg that is already assigned (team swap, add co-driver). Eligibility re-runs. */
export async function setLegDrivers(ctx: Ctx, legId: string, drivers: { driverId?: string | null; coDriverId?: string | null }, opts: PlanOptions = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  return db.transaction(async (tx) => {
    const leg = await loadLeg(tx, ctx, legId);
    if (leg.assigneeKind !== "truck" || !leg.truckId) throw new ValidationError("leg is not assigned to a truck");
    if (leg.state === "completed" || leg.state === "cancelled") throw new TransitionError("leg", leg.state, "drivers", "leg is closed");
    const next = { driverId: drivers.driverId === undefined ? leg.driverId : drivers.driverId, coDriverId: drivers.coDriverId === undefined ? leg.coDriverId : drivers.coDriverId };
    const elig = await eligibilityFor(ctx, await zoneForLeg(db, leg), { kind: "truck", truckId: leg.truckId, ...next, trailerId: leg.trailerId });
    if (elig.hardBlocked) throw new EligibilityError(elig.findings, true);
    if (!elig.ok) {
      if (!opts.override) throw new EligibilityError(elig.findings, false);
      requirePermission(ctx, "dispatch.override");
      if (!opts.reason?.trim()) throw new ValidationError("an override needs a reason", "reason");
      await writeAudit(tx, ctx, "leg", leg.id, "override", { findings: { from: null, to: elig.findings.map((f) => f.code) } }, opts.reason);
    }
    const [after] = await tx.update(s.legs).set({ ...next, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, leg.id))).returning();
    await writeAudit(tx, ctx, "leg", leg.id, "assign", diff({ driverId: leg.driverId, coDriverId: leg.coDriverId }, next), opts.reason);
    return { leg: after, findings: elig.findings };
  });
}

// ---------- ranked candidates (spec §11.2) ----------

export type Candidate = {
  truckId: string;
  unitNumber: string;
  driverId: string | null;
  driverName: string | null;
  ok: boolean;
  hardBlocked: boolean;
  busy: { orderNumber: string; state: LegState }[];
  findings: Finding[];
  reason: string;
  score: number;
};

/** Trucks ranked for a leg: green & free first, then green & busy, then yellow, red last with reasons. */
export async function candidatesForLeg(ctx: Ctx, legId: string, now = new Date()): Promise<Candidate[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const leg = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1).then((r) => r[0]);
  if (!leg) throw new NotFoundError("leg", legId);
  const zone = await zoneForLeg(db, leg);
  const trucks = await db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), sql`${s.trucks.archivedAt} is null`));
  const drivers = await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), sql`${s.drivers.archivedAt} is null`));
  const busyRows = await db
    .select({ truckId: s.legs.truckId, state: s.legs.state, orderNumber: s.orders.orderNumber })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.state, [...ACTIVE_LEG]), sql`${s.legs.id} <> ${legId}`));
  const busyBy = new Map<string, { orderNumber: string; state: LegState }[]>();
  for (const b of busyRows) if (b.truckId) busyBy.set(b.truckId, [...(busyBy.get(b.truckId) ?? []), { orderNumber: b.orderNumber, state: b.state }]);
  const [truckComp, driverComp] = await Promise.all([statusMap(ctx, "truck"), statusMap(ctx, "driver")]);
  const compFindings = (kind: "truck" | "driver", id: string, label: string): Finding[] => {
    const raw = kind === "truck" ? truckComp.get(id) : driverComp.get(id);
    if (!raw) return [];
    const st = forLeg(raw, zone);
    if (!st.dispatchable && !st.override) return [{ level: "red", code: "compliance_block", message: `${label}: ${[...st.expired.map((x) => `${x} expired`), ...st.missing.map((x) => `${x} missing`)].join(", ")}`, overridable: !st.expired.some((l) => /licen|medical|I-94|plate/i.test(l)) }];
    const out: Finding[] = [];
    if (st.override) out.push({ level: "yellow", code: "compliance_override", message: `${label}: dispatch override (${st.override.reason})`, overridable: true });
    if (st.expiring.length) out.push({ level: "yellow", code: "compliance_expiring", message: `${label}: ${st.expiring.join(", ")} expiring`, overridable: true });
    return out;
  };

  const out: Candidate[] = trucks.map((t) => {
    const drv = drivers.find((d) => d.currentTruckId === t.id) ?? null;
    const findings = [...checkTruck(t, zone, now), ...compFindings("truck", t.id, `unit ${t.unitNumber}`), ...(drv ? [...checkDriver(drv, zone, now), ...compFindings("driver", drv.id, drv.name)] : [])];
    if (!drv) findings.push({ level: "yellow", code: "no_driver", message: `${t.unitNumber} has no driver assigned`, overridable: true });
    const sum = summarize(findings);
    const busy = busyBy.get(t.id) ?? [];
    let score = 0;
    if (sum.hardBlocked) score = 1000;
    else if (!sum.ok) score = 500;
    else score = findings.length * 10;
    score += busy.length * 100;
    const reason = sum.hardBlocked
      ? findings.find((f) => f.level === "red")!.message
      : !sum.ok
        ? `needs override: ${findings.find((f) => f.level === "red")!.message}`
        : busy.length
          ? `on ${busy.map((b) => b.orderNumber).join(", ")}`
          : findings.length
            ? findings[0].message
            : `free${drv ? `, ${drv.name}` : ""}`;
    return { truckId: t.id, unitNumber: t.unitNumber, driverId: drv?.id ?? null, driverName: drv?.name ?? null, ok: sum.ok, hardBlocked: sum.hardBlocked, busy, findings, reason, score };
  });
  return out.sort((p, q) => p.score - q.score || p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true }));
}

// ---------- board query ----------

export type BoardRow = {
  order: Order;
  stops: Stop[];
  legs: (Leg & { truckUnit: string | null; driverName: string | null; carrierName: string | null })[];
  openFlags: (typeof s.flags.$inferSelect)[];
  stage: "pending" | "planned" | "dispatched" | "delivered" | "closed";
  shipments: number; // tailgate trips: how many ride on it
};

/** Everything the dispatch board needs in one query set (spec §2.3: Pending / Planned / Dispatched). */
export async function board(ctx: Ctx, opts: { includeClosed?: boolean; deliveredDays?: number } = {}): Promise<BoardRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const states: OrderState[] = opts.includeClosed ? [...s.ORDER_STATES] : ["draft", "booked", "dispatched", "in_transit", "exception", "delivered"];
  // shipments ride on trips: the trip is the row; the shipments show inside it.
  // Delivered rows are this week's: older ones live on Orders and in the billing queue, not on today's board.
  const recent = new Date(Date.now() - (opts.deliveredDays ?? 7) * 86400_000);
  const ords = await db
    .select()
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, ctx.tenantId), inArray(s.orders.state, states), sql`${s.orders.kind} <> 'shipment'`, opts.includeClosed ? sql`true` : or(sql`${s.orders.state} <> 'delivered'`, gte(s.orders.deliveredAt, recent), and(eq(s.orders.state, "delivered"), isNull(s.orders.deliveredAt)))))
    .orderBy(desc(s.orders.createdAt))
    .limit(1000);
  if (!ords.length) return [];
  const ids = ords.map((o) => o.id);
  const tripIds = ords.filter((o) => o.kind === "trip").map((o) => o.id);
  const shipCounts = tripIds.length ? await db.select({ tripId: s.orders.tripId, n: sql<number>`count(*)` }).from(s.orders).where(and(inArray(s.orders.tripId, tripIds), sql`${s.orders.state} <> 'cancelled'`)).groupBy(s.orders.tripId) : [];
  const [stopRows, legRows, flagRows, trucks, drivers, carriers] = await Promise.all([
    db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), inArray(s.stops.orderId, ids))).orderBy(asc(s.stops.seq)),
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.orderId, ids))).orderBy(asc(s.legs.seq)),
    db.select().from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), inArray(s.flags.orderId, ids), sql`${s.flags.clearedAt} is null`)),
    db.select({ id: s.trucks.id, unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
    db.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
  ]);
  const tName = new Map(trucks.map((t) => [t.id, t.unitNumber]));
  const dName = new Map(drivers.map((d) => [d.id, d.name]));
  const cName = new Map(carriers.map((c) => [c.id, c.name]));
  return ords.map((order) => {
    const legs = legRows.filter((l) => l.orderId === order.id).map((l) => ({ ...l, truckUnit: l.truckId ? (tName.get(l.truckId) ?? null) : null, driverName: l.driverId ? (dName.get(l.driverId) ?? null) : null, carrierName: l.carrierId ? (cName.get(l.carrierId) ?? null) : null }));
    return { order, stops: stopRows.filter((x) => x.orderId === order.id), legs, openFlags: flagRows.filter((f) => f.orderId === order.id), stage: stageOfOrder(order, legs), shipments: Number(shipCounts.find((c) => c.tripId === order.id)?.n ?? 0) };
  });
}

export function stageOfOrder(order: Pick<Order, "state">, legs: Pick<Leg, "state">[]): BoardRow["stage"] {
  if (order.state === "cancelled" || ["ready_to_bill", "invoiced", "paid"].includes(order.state)) return "closed";
  if (order.state === "delivered") return "delivered";
  // Per-leg dispatchable (spec §11.16): the order sits in the stage of its next leg that still needs work.
  const live = legs.filter((l) => l.state !== "cancelled");
  const next = live.find((l) => l.state !== "completed");
  if (!next) return live.length ? "delivered" : "pending";
  return STAGE_OF_LEG[next.state];
}

export { LEG_TEMPLATES };

// ---------- carrier lane rates ----------

/** Loose lane match: the zone text is found in the stop's "name, city, state", or the other way round. */
export function zoneMatches(zone: string | null | undefined, stop: { name: string; address?: { city?: string | null; state?: string | null } | null } | null | undefined) {
  if (!zone || !stop) return false;
  const z = zone.trim().toLowerCase();
  if (!z) return false;
  const hay = [stop.name, stop.address?.city, stop.address?.state].filter(Boolean).join(", ").toLowerCase();
  if (hay.includes(z) || z.includes(hay)) return true;
  // every word of the zone appears somewhere (Monterrey NL vs "Planta Monterrey, Apodaca, NL")
  const words = z.split(/[\s,]+/).filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

/**
 * The rate on file for this carrier on this leg's lane (Settings → Carrier rates), valid today, with
 * equipment matching or unspecified. The assign popup prefills it; the dispatcher can still type another.
 */
export async function suggestCarrierRate(ctx: Ctx, legId: string, carrierId: string, now = new Date()) {
  assertCtx(ctx);
  const leg = await getLeg(ctx, legId);
  const [order] = await db.select({ equipment: s.orders.equipment }).from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, leg.orderId)));
  const from = stops.find((x) => x.id === leg.fromStopId);
  const to = stops.find((x) => x.id === leg.toStopId);
  const rates = await db.select().from(s.carrierRates).where(and(eq(s.carrierRates.tenantId, ctx.tenantId), eq(s.carrierRates.carrierId, carrierId), sql`${s.carrierRates.archivedAt} is null`));
  const live = rates.filter((r) => (!r.validFrom || r.validFrom.getTime() <= now.getTime()) && (!r.validTo || r.validTo.getTime() >= now.getTime()));
  const hits = live.filter((r) => zoneMatches(r.originZone, from) && zoneMatches(r.destinationZone, to) && (!r.equipment || r.equipment === order?.equipment));
  if (!hits.length) return null;
  // the newest rate on file wins (a re-negotiated lane is entered as a new row or an edit)
  const best = hits.sort((p, q) => q.updatedAt.getTime() - p.updatedAt.getTime())[0];
  return { id: best.id, rateCents: best.rateCents, currency: best.currency, fuelRule: best.fuelRule, fuelValue: best.fuelValue, lane: `${best.originZone} → ${best.destinationZone}`, validTo: best.validTo, notes: best.notes ?? null };
}
