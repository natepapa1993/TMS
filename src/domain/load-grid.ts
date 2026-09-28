import { and, eq, inArray, isNull, desc, gte, or, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";

/**
 * The load board: one flat row per load with everything a dispatcher or biller scans for — lane,
 * dates, who is on it, money, miles — so the grid can sort, filter and total on the client.
 */

export type LoadRow = {
  id: string;
  orderNumber: string;
  kind: string;
  state: string;
  tonu: boolean;
  priority: string;
  locked: boolean;
  salesAgent: string | null;
  dispatcher: string | null;
  customer: string | null;
  broker: string | null;
  equipment: string;
  po: string | null;
  reference: string | null;
  rateCon: string | null;
  bol: string | null;
  refs: string;
  pickupName: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupCountry: string | null;
  pickupAt: string | null;
  deliveryName: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryCountry: string | null;
  deliveryAt: string | null;
  stops: number;
  legs: string;
  uncoveredLegs: number;
  crossBorder: boolean;
  truck: string | null;
  driver: string | null;
  carrier: string | null;
  rateCents: number | null;
  currency: string;
  carrierCostCents: number;
  marginCents: number | null;
  miles: number | null;
  /** some of the miles are estimated from the stops */
  milesEst: boolean;
  rpmCents: number | null;
  flags: number;
  redFlags: number;
  crossing: string | null;
  source: string;
  enteredBy: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** delivered, and no POD on file (nor a "bill without POD" from dispatch): not ready to bill */
  podMissing: boolean;
};

const CLOSED = ["paid", "cancelled"] as const;
const LEG_SHORT: Record<string, string> = { mx: "MX", ca: "CA", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment" };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Loads created in the last `days` (all of them when days is 0), plus every load still open. */
export async function loadGrid(ctx: Ctx, opts: { days?: number } = {}): Promise<LoadRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const days = opts.days ?? 60;
  const since = new Date(Date.now() - days * 86400_000);
  const scope = eq(s.orders.tenantId, ctx.tenantId);
  const where = days ? and(scope, or(gte(s.orders.createdAt, since), notInArray(s.orders.state, [...CLOSED]))) : scope;
  const orders = await db.select().from(s.orders).where(where).orderBy(desc(s.orders.createdAt)).limit(5000);
  if (!orders.length) return [];
  // a shipment rides on its trip: its lane, legs and truck come from the trip's stops and legs
  const ids = [...new Set([...orders.map((o) => o.id), ...orders.map((o) => o.tripId).filter((x): x is string => !!x)])];
  const [stops, legs, customers, carriers, drivers, trucks, flags, crossings, users] = await Promise.all([
    db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), inArray(s.stops.orderId, ids))).orderBy(s.stops.seq),
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.orderId, ids))).orderBy(s.legs.seq),
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
    db.select({ id: s.drivers.id, name: s.drivers.name, payType: s.drivers.payType, payRateCents: s.drivers.payRateCents }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
    db.select({ id: s.trucks.id, unit: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
    db.select({ orderId: s.flags.orderId, level: s.flags.level }).from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), isNull(s.flags.clearedAt), inArray(s.flags.orderId, ids))),
    db.select({ orderId: s.crossings.orderId, state: s.crossings.state, fromCountry: s.crossings.fromCountry, toCountry: s.crossings.toCountry }).from(s.crossings).where(and(eq(s.crossings.tenantId, ctx.tenantId), inArray(s.crossings.orderId, ids))),
    db.select({ id: s.users.id, name: s.users.name }).from(s.users).where(eq(s.users.tenantId, ctx.tenantId)),
  ]);
  // delivered loads wait for a POD before they are ready to bill (M14)
  const deliveredIds = orders.filter((o) => ["delivered", "ready_to_bill"].includes(o.state)).map((o) => o.id);
  const pods = deliveredIds.length ? await db.select({ subjectId: s.documents.subjectId }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "order"), eq(s.documents.code, "POD"), inArray(s.documents.subjectId, deliveredIds), inArray(s.documents.status, ["present", "verified"]))) : [];
  const hasPod = new Set(pods.map((p) => p.subjectId));
  const { podSatisfied } = await import("./orders");
  const { crossingStateLabel } = await import("./crossing");
  const [ten] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const fuelCpm = Number((ten?.settings as Record<string, unknown> | null)?.fuelCostCentsPerMile ?? 65);
  const name = <T extends { id: string }>(rows: T[], key: keyof T) => new Map(rows.map((r) => [r.id, String(r[key])]));
  const cName = name(customers, "name");
  const carName = name(carriers, "name");
  const dName = name(drivers, "name");
  const tName = name(trucks, "unit");
  const uName = name(users, "name");
  const by = <T extends { orderId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.orderId) ?? m.set(r.orderId, []).get(r.orderId)!).push(r);
    return m;
  };
  const stopsBy = by(stops);
  const legsBy = by(legs);
  const flagsBy = by(flags);
  const xBy = by(crossings);
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

  return orders.map((o) => {
    const onTrip = o.kind === "shipment" && o.tripId;
    const tripStops = onTrip ? (stopsBy.get(o.tripId!) ?? []) : [];
    const st = onTrip ? tripStops.filter((x) => x.seq >= (tripStops.find((y) => y.id === o.pickupStopId)?.seq ?? 0) && x.seq <= (tripStops.find((y) => y.id === o.deliveryStopId)?.seq ?? Infinity)) : (stopsBy.get(o.id) ?? []);
    const lg = onTrip ? (legsBy.get(o.tripId!) ?? []) : (legsBy.get(o.id) ?? []);
    const pu = onTrip ? tripStops.find((y) => y.id === o.pickupStopId) : (st.find((x) => x.type === "pickup") ?? st[0]);
    const de = onTrip ? tripStops.find((y) => y.id === o.deliveryStopId) : ([...st].reverse().find((x) => x.type === "delivery") ?? st[st.length - 1]);
    // the trip carries the carrier cost; its shipments carry the revenue — never both
    const carrierCostCents = onTrip ? 0 : lg.reduce((sum, l) => sum + (l.carrierRateCents ?? 0), 0) + (o.tollsFeesCents ?? 0);
    // our own trucks cost driver pay and fuel too: estimated from the driver's pay rule and the company's fuel cost per mile (the load's Money tab has the exact figures)
    const ownCost = onTrip
      ? 0
      : lg
          .filter((l) => l.assigneeKind === "truck" && l.state !== "cancelled")
          .reduce((sum, l) => {
            const mi = l.plannedMiles ?? l.estMiles ?? 0;
            const pay = [l.driverId, l.coDriverId].filter(Boolean).reduce((a, did) => {
              const d = drivers.find((x) => x.id === did);
              if (!d?.payRateCents) return a;
              const share = l.coDriverId ? 0.5 : 1;
              return a + Math.round((d.payType === "per_mile" ? mi * d.payRateCents : d.payType === "pct" ? ((o.rateCents ?? 0) * d.payRateCents) / 10000 : d.payRateCents) * share);
            }, 0);
            return sum + pay + mi * fuelCpm;
          }, 0);
    // typed miles, else the estimate from the stops ("est." on the screen)
    const live = lg.filter((l) => l.state !== "cancelled");
    const milesKnown = live.some((l) => l.plannedMiles != null || l.estMiles != null);
    const miles = milesKnown ? live.reduce((sum, l) => sum + (l.plannedMiles ?? l.estMiles ?? 0), 0) : null;
    const milesEst = milesKnown && live.some((l) => l.plannedMiles == null);
    const rate = o.rateTbd ? null : o.rateCents;
    const fl = flagsBy.get(o.id) ?? [];
    const x = (xBy.get(o.id) ?? [])[0];
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      kind: o.kind,
      state: o.state,
      tonu: o.tonu,
      priority: o.priority,
      locked: !!o.lockedAt,
      salesAgent: o.salesAgentId ? (uName.get(o.salesAgentId) ?? null) : null,
      dispatcher: o.dispatcherId ? (uName.get(o.dispatcherId) ?? null) : null,
      customer: o.customerId ? (cName.get(o.customerId) ?? null) : null,
      broker: o.brokerId ? (cName.get(o.brokerId) ?? null) : null,
      equipment: o.equipment,
      po: o.refs?.po ?? null,
      reference: o.refs?.reference ?? null,
      rateCon: o.refs?.rate_con ?? null,
      bol: o.refs?.shipment ?? null,
      refs: Object.values(o.refs ?? {}).filter(Boolean).join(" · "),
      pickupName: pu?.name ?? null,
      pickupCity: pu?.address?.city ?? null,
      pickupState: pu?.address?.state ?? null,
      pickupCountry: pu?.country ?? null,
      pickupAt: iso(pu?.windowStart),
      deliveryName: de?.name ?? null,
      deliveryCity: de?.address?.city ?? null,
      deliveryState: de?.address?.state ?? null,
      deliveryCountry: de?.country ?? null,
      deliveryAt: iso(de?.windowStart),
      stops: st.length,
      legs: lg.map((l) => LEG_SHORT[l.type] ?? l.type).join(" → "),
      uncoveredLegs: lg.filter((l) => l.state === "unassigned" || l.state === "declined").length,
      crossBorder: new Set(st.map((x) => x.country)).size > 1,
      truck: uniq(lg.map((l) => (l.truckId ? tName.get(l.truckId) : null))).join(", ") || null,
      driver: uniq(lg.map((l) => (l.driverId ? dName.get(l.driverId) : null))).join(", ") || null,
      carrier: uniq(lg.map((l) => (l.carrierId ? carName.get(l.carrierId) : null))).join(", ") || null,
      rateCents: rate,
      currency: o.currency,
      carrierCostCents,
      // margin once every leg has someone on it; before that the cost is not known
      marginCents: rate != null && !lg.some((l) => l.state === "unassigned" || l.state === "declined") ? rate - carrierCostCents - ownCost : null,
      miles: onTrip ? null : miles,
      milesEst: onTrip ? false : milesEst,
      rpmCents: rate != null && miles && !onTrip ? Math.round(rate / miles) : null,
      flags: fl.length,
      redFlags: fl.filter((f) => f.level === "red").length,
      crossing: x ? crossingStateLabel(x.state, x) : null,
      source: o.source,
      enteredBy: o.createdBy ? (uName.get(o.createdBy) ?? null) : null,
      createdAt: o.createdAt.toISOString(),
      deliveredAt: iso(o.deliveredAt),
      podMissing: ["delivered", "ready_to_bill"].includes(o.state) && o.kind !== "trip" && !podSatisfied(o, hasPod.has(o.id)),
    };
  });
}

// ---------- saved views ----------

export type ViewConfig = { columns?: string[]; hidden?: string[]; widths?: Record<string, number>; sort?: { id: string; desc: boolean }[]; filters?: { id: string; value: unknown }[]; quick?: string; search?: string; pageSize?: number };

export async function listViews(ctx: Ctx, page: string) {
  assertCtx(ctx);
  const rows = await db
    .select()
    .from(s.savedViews)
    .where(and(eq(s.savedViews.tenantId, ctx.tenantId), eq(s.savedViews.page, page), isNull(s.savedViews.archivedAt), or(eq(s.savedViews.userId, ctx.userId ?? ""), eq(s.savedViews.shared, true))))
    .orderBy(s.savedViews.name);
  return rows.map((v) => ({ id: v.id, name: v.name, shared: v.shared, mine: v.userId === ctx.userId, config: v.config as ViewConfig }));
}

export async function saveView(ctx: Ctx, page: string, input: { id?: string | null; name: string; shared?: boolean; config: ViewConfig }) {
  assertCtx(ctx);
  if (!ctx.userId) throw new ValidationError("sign in to save a view");
  const name = input.name?.trim();
  if (!name) throw new ValidationError("give the view a name", "name");
  if (name.length > 60) throw new ValidationError("keep the name under 60 characters", "name");
  if (input.id) {
    const [v] = await db.select().from(s.savedViews).where(and(eq(s.savedViews.tenantId, ctx.tenantId), eq(s.savedViews.id, input.id))).limit(1);
    if (!v || v.archivedAt) throw new NotFoundError("view", input.id);
    if (v.userId !== ctx.userId && ctx.role !== "owner") throw new ValidationError("only its owner can change a shared view");
    await db.update(s.savedViews).set({ name, shared: !!input.shared, config: input.config, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.savedViews.id, v.id));
    await writeAudit(db, ctx, "saved_view", v.id, "update", undefined, name);
    return { id: v.id };
  }
  const id = newId();
  await db.insert(s.savedViews).values({ id, tenantId: ctx.tenantId, userId: ctx.userId, page, name, shared: !!input.shared, config: input.config, createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, "saved_view", id, "create", undefined, name);
  return { id };
}

export async function deleteView(ctx: Ctx, id: string) {
  assertCtx(ctx);
  const [v] = await db.select().from(s.savedViews).where(and(eq(s.savedViews.tenantId, ctx.tenantId), eq(s.savedViews.id, id))).limit(1);
  if (!v || v.archivedAt) throw new NotFoundError("view", id);
  if (v.userId !== ctx.userId && ctx.role !== "owner") throw new ValidationError("only its owner can delete a shared view");
  await db.update(s.savedViews).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.savedViews.id, id));
  await writeAudit(db, ctx, "saved_view", id, "archive", undefined, v.name);
}
