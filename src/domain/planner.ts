import { and, eq, inArray, isNull, gte, lte, desc } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import { ASSET_EVENT_KINDS, type AssetEventKind } from "@/db/schema";
import { newId } from "@/lib/ids";
import { coords, roadMiles } from "@/lib/geo";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import type { Finding } from "./eligibility";
import { rollup } from "./compliance-rules";
import { NotFoundError, ValidationError } from "./orders";
import { tenantZone } from "./company";
import { fmtWhen, stopZone } from "@/lib/time";

/**
 * The dispatch planner: loads that need a truck on one side, drivers on the other with when and where
 * each one is free, what is planned next, hours left and time off. Picking a load ranks the drivers for
 * it (eligibility first, then deadhead to the pickup).
 */

export const EVENT_LABEL: Record<AssetEventKind, string> = { vacation: "Vacation", home_time: "Home time", restart: "34-h restart", sick: "Sick / emergency", repair: "In the shop", work_order: "Work order", other: "Unavailable", credentials: "Licence / medical renewal", oos: "Out-of-service order" };
/** Time off that is Safety's, not a schedule call: a licence or medical renewal (Safety can override), an out-of-service order (nobody can). */
export const SAFETY_EVENT: Partial<Record<AssetEventKind, { code: string; overridable: boolean }>> = { credentials: { code: "safety_credentials", overridable: true }, oos: { code: "safety_oos_order", overridable: false } };
const OPEN_LEG = ["unassigned", "declined", "planned"] as const;
const ACTIVE = ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const;
const MOVING = ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------- events ----------

export async function addEvent(ctx: Ctx, input: { subjectKind: string; subjectId: string; kind: string; startsAt: Date; endsAt: Date; hard?: boolean; note?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  if (!["driver", "truck", "trailer"].includes(input.subjectKind)) throw new ValidationError("events are for drivers, trucks and trailers");
  if (!(ASSET_EVENT_KINDS as readonly string[]).includes(input.kind)) throw new ValidationError("pick what kind of time off it is", "kind");
  if (input.kind === "oos") requirePermission(ctx, "compliance.edit"); // an out-of-service order comes from Safety (a roadside inspection)
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime()) || !(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) throw new ValidationError("enter when it starts and ends", "startsAt");
  if (input.endsAt <= input.startsAt) throw new ValidationError("it has to end after it starts", "endsAt");
  const table = input.subjectKind === "driver" ? s.drivers : input.subjectKind === "truck" ? s.trucks : s.trailers;
  const [subject] = await db.select({ id: table.id }).from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, input.subjectId))).limit(1);
  if (!subject) throw new NotFoundError(input.subjectKind, input.subjectId);
  const id = newId();
  await db.insert(s.assetEvents).values({ id, tenantId: ctx.tenantId, subjectKind: input.subjectKind, subjectId: input.subjectId, kind: input.kind as AssetEventKind, startsAt: input.startsAt, endsAt: input.endsAt, hard: input.hard !== false, note: input.note?.trim() || null, createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, input.subjectKind, input.subjectId, "update", undefined, `${EVENT_LABEL[input.kind as AssetEventKind]} ${input.startsAt.toISOString().slice(0, 10)} → ${input.endsAt.toISOString().slice(0, 10)}`);
  return { id };
}

export async function deleteEvent(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  const [e] = await db.select().from(s.assetEvents).where(and(eq(s.assetEvents.tenantId, ctx.tenantId), eq(s.assetEvents.id, id))).limit(1);
  if (!e || e.archivedAt) throw new NotFoundError("event", id);
  await db.update(s.assetEvents).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.assetEvents.id, id));
  await writeAudit(db, ctx, e.subjectKind, e.subjectId, "update", undefined, `${EVENT_LABEL[e.kind]} removed`);
}

/** Events that overlap [from, to]. */
export async function eventsBetween(tx: Tx | typeof db, tenantId: string, from: Date, to: Date, subjects?: { kind: string; ids: string[] }[]) {
  const rows = await tx
    .select()
    .from(s.assetEvents)
    .where(and(eq(s.assetEvents.tenantId, tenantId), isNull(s.assetEvents.archivedAt), lte(s.assetEvents.startsAt, to), gte(s.assetEvents.endsAt, from)));
  if (!subjects) return rows;
  return rows.filter((r) => subjects.some((x) => x.kind === r.subjectKind && x.ids.includes(r.subjectId)));
}

/**
 * What the events say about using these assets in this window: a hard event is red, a soft one yellow.
 * A licence / medical renewal or an out-of-service order is a Safety block (only Safety or the owner may
 * override the first; nobody the second), never a schedule conflict dispatch can wave through.
 * Time off is on the company's clock.
 */
export function eventFindings(events: (typeof s.assetEvents.$inferSelect)[], who: { kind: string; id: string; label: string }[], zone = "America/Detroit"): Finding[] {
  const fmt = (d: Date) => fmtWhen(d, zone, { style: "short" });
  const out: Finding[] = [];
  for (const w of who)
    for (const e of events.filter((x) => x.subjectKind === w.kind && x.subjectId === w.id)) {
      const safety = SAFETY_EVENT[e.kind];
      if (safety) out.push({ level: "red", code: safety.code, message: `${w.label}: Safety — ${EVENT_LABEL[e.kind].toLowerCase()} until ${fmt(e.endsAt)}${e.note ? ` (${e.note})` : ""}`, overridable: safety.overridable });
      else out.push({ level: e.hard ? "red" : "yellow", code: `event_${e.kind}`, message: `${w.label}: ${EVENT_LABEL[e.kind].toLowerCase()} ${fmt(e.startsAt)} – ${fmt(e.endsAt)}${e.note ? ` (${e.note})` : ""}`, overridable: true });
    }
  return out;
}

/** When a leg runs: from its first stop's window to its last stop's; open-ended sides get a day. */
export async function legWindow(tx: Tx | typeof db, leg: { fromStopId: string | null; toStopId: string | null; plannedStart?: Date | null; plannedEnd?: Date | null }, now = new Date()) {
  const ids = [leg.fromStopId, leg.toStopId].filter((x): x is string => !!x);
  const st = ids.length ? await tx.select({ id: s.stops.id, windowStart: s.stops.windowStart, windowEnd: s.stops.windowEnd }).from(s.stops).where(inArray(s.stops.id, ids)) : [];
  const a = st.find((x) => x.id === leg.fromStopId);
  const b = st.find((x) => x.id === leg.toStopId);
  const start = leg.plannedStart ?? a?.windowStart ?? now;
  const end = leg.plannedEnd ?? b?.windowEnd ?? b?.windowStart ?? new Date(start.getTime() + 24 * 3600_000);
  return { start, end: end > start ? end : new Date(start.getTime() + 3600_000) };
}

// ---------- the planner ----------

export type PlannerLeg = {
  legId: string;
  orderId: string;
  orderNumber: string;
  legSeq: number;
  legCount: number;
  type: string;
  state: string;
  customer: string | null;
  equipment: string;
  priority: string;
  rateCents: number | null;
  currency: string;
  miles: number | null;
  /** zone: the stop's own clock; every time on the planner is printed there, with its name */
  from: { name: string; city: string | null; state: string | null; country: string; at: string | null; zone: string; lat: number | null; lng: number | null };
  to: { name: string; city: string | null; state: string | null; country: string; at: string | null; zone: string };
  assigned: string | null;
};

export type PlannerDriver = {
  driverId: string;
  name: string;
  driverType: string;
  phone: string | null;
  truckId: string | null;
  unit: string | null;
  truckStatus: string | null;
  dispatcher: string | null;
  status: "available" | "planned" | "on_load" | "off";
  current: { orderNumber: string; state: string; to: string } | null;
  availableAt: string | null;
  /** the clock of the place it comes free (its last stop), else the company's */
  availableZone: string;
  availableIn: string | null;
  availableLat: number | null;
  availableLng: number | null;
  next: { orderNumber: string; at: string | null; from: string; zone: string } | null;
  hos: { driveMin: number | null; shiftMin: number | null; cycleMin: number | null; at: string | null } | null;
  events: { id: string; kind: string; label: string; startsAt: string; endsAt: string; hard: boolean; note: string | null; subject: "driver" | "truck" }[];
};

/**
 * The planner by truck: who is in it (solo or team, CDL or B-1), and one of four plain statuses —
 * available, on a load, waiting on a crossing (its next load's freight hasn't crossed yet), or
 * unavailable (shop, time off, no driver, or paperwork that blocks dispatch) with the reason.
 */
export type PlannerTruck = Omit<PlannerDriver, "driverId" | "name" | "driverType" | "phone" | "truckId" | "unit" | "truckStatus" | "status"> & {
  truckId: string;
  unit: string;
  crew: { driverId: string; name: string; driverType: string; phone: string | null }[];
  team: boolean;
  status: "available" | "on_load" | "waiting_crossing" | "unavailable";
  why: string | null;
};

export async function plannerData(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  await (await import("./tenders")).expireTenders(new Date(), { tenantId: ctx.tenantId });
  const legs = await db
    .select({ leg: s.legs, order: s.orders })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.state, [...new Set([...OPEN_LEG, ...ACTIVE])]), inArray(s.orders.state, ["booked", "dispatched", "in_transit", "exception"])));
  const orderIds = [...new Set(legs.map((l) => l.order.id))];
  const [stops, allLegCounts, customers, drivers, trucks, users, events, lastPos, blocked, recentDone] = await Promise.all([
    orderIds.length ? db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), inArray(s.stops.orderId, orderIds))) : Promise.resolve([]),
    orderIds.length ? db.select({ orderId: s.legs.orderId, id: s.legs.id, seq: s.legs.seq, type: s.legs.type, state: s.legs.state }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.orderId, orderIds))) : Promise.resolve([]),
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))),
    db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), isNull(s.trucks.archivedAt))),
    db.select({ id: s.users.id, name: s.users.name }).from(s.users).where(eq(s.users.tenantId, ctx.tenantId)),
    eventsBetween(db, ctx.tenantId, new Date(now.getTime() - 86400_000), new Date(now.getTime() + 30 * 86400_000)),
    db.select().from(s.positions).where(and(eq(s.positions.tenantId, ctx.tenantId), gte(s.positions.at, new Date(now.getTime() - 3 * 86400_000)))).orderBy(desc(s.positions.at)).limit(2000),
    db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.dispatchable, false))),
    // where each truck last delivered: an idle truck is free where its last load ended
    db
      .select({ truckId: s.legs.truckId, driverId: s.legs.driverId, completedAt: s.legs.completedAt, stop: s.stops })
      .from(s.legs)
      .innerJoin(s.stops, eq(s.stops.id, s.legs.toStopId))
      .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.state, "completed"), gte(s.legs.completedAt, new Date(now.getTime() - 14 * 86400_000))))
      .orderBy(desc(s.legs.completedAt))
      .limit(500),
  ]);
  const stop = new Map(stops.map((x) => [x.id, x]));
  const companyZone = await tenantZone(ctx.tenantId);
  const cName = new Map(customers.map((c) => [c.id, c.name]));
  const uName = new Map(users.map((u) => [u.id, u.name]));
  const legCount = new Map<string, number>();
  for (const l of allLegCounts) legCount.set(l.orderId, (legCount.get(l.orderId) ?? 0) + 1);
  const place = (st: typeof s.stops.$inferSelect | undefined) => (st ? [st.address?.city, st.address?.state].filter(Boolean).join(", ") || st.name : "");

  const openLegs: PlannerLeg[] = legs
    .filter((l) => (OPEN_LEG as readonly string[]).includes(l.leg.state))
    .map(({ leg, order }) => {
      const a = stop.get(leg.fromStopId ?? "");
      const b = stop.get(leg.toStopId ?? "");
      const c = a ? coords(a.lat, a.lng) : null;
      return {
        legId: leg.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        legSeq: leg.seq,
        legCount: legCount.get(order.id) ?? 1,
        type: leg.type,
        state: leg.state,
        customer: cName.get(order.customerId ?? order.brokerId ?? "") ?? null,
        equipment: order.equipment,
        priority: order.priority,
        rateCents: order.rateTbd ? null : order.rateCents,
        currency: order.currency,
        miles: leg.plannedMiles,
        from: { name: a?.name ?? "", city: a?.address?.city ?? null, state: a?.address?.state ?? null, country: a?.country ?? "US", at: iso(a?.windowStart ?? a?.windowEnd), zone: a ? stopZone(a, companyZone) : companyZone, lat: c?.lat ?? null, lng: c?.lng ?? null },
        to: { name: b?.name ?? "", city: b?.address?.city ?? null, state: b?.address?.state ?? null, country: b?.country ?? "US", at: iso(b?.windowEnd ?? b?.windowStart), zone: b ? stopZone(b, companyZone) : companyZone },
        assigned: leg.state === "planned" ? [trucks.find((t) => t.id === leg.truckId)?.unitNumber, drivers.find((d) => d.id === leg.driverId)?.name].filter(Boolean).join(" · ") || "carrier" : null,
      };
    })
    .sort((p, q) => (p.from.at ?? "9").localeCompare(q.from.at ?? "9"));

  const outDrivers: PlannerDriver[] = drivers.map((d) => {
    const truck = trucks.find((t) => t.id === d.currentTruckId) ?? null;
    const mine = legs.filter((l) => (ACTIVE as readonly string[]).includes(l.leg.state) && (l.leg.driverId === d.id || l.leg.coDriverId === d.id || (truck && l.leg.truckId === truck.id)));
    const end = (l: (typeof mine)[number]) => {
      const b = stop.get(l.leg.toStopId ?? "");
      return b?.windowEnd ?? b?.windowStart ?? l.leg.plannedEnd ?? null;
    };
    const start = (l: (typeof mine)[number]) => stop.get(l.leg.fromStopId ?? "")?.windowStart ?? l.leg.plannedStart ?? null;
    const moving = mine.filter((l) => (MOVING as readonly string[]).includes(l.leg.state) || l.leg.state === "dispatched" || l.leg.state === "accepted");
    const planned = mine.filter((l) => l.leg.state === "planned").sort((p, q) => (start(p)?.getTime() ?? 0) - (start(q)?.getTime() ?? 0));
    const cur = moving.sort((p, q) => (end(q)?.getTime() ?? 0) - (end(p)?.getTime() ?? 0))[0];
    const last = [...mine].sort((p, q) => (end(q)?.getTime() ?? 0) - (end(p)?.getTime() ?? 0))[0];
    const done = last ? undefined : recentDone.find((r) => r.driverId === d.id || (truck && r.truckId === truck.id));
    const lastStop = last ? stop.get(last.leg.toStopId ?? "") : done?.stop;
    const pos = lastPos.find((p) => p.driverId === d.id || (truck && p.truckId === truck.id));
    const posC = pos ? coords(pos.lat, pos.lng) : null;
    const lastC = lastStop ? coords(lastStop.lat, lastStop.lng) : null;
    const evs = events.filter((e) => (e.subjectKind === "driver" && e.subjectId === d.id) || (truck && e.subjectKind === "truck" && e.subjectId === truck.id));
    const offNow = evs.find((e) => e.hard && e.startsAt <= now && e.endsAt >= now);
    const status: PlannerDriver["status"] = offNow || truck?.status === "oos" ? "off" : cur ? "on_load" : planned.length ? "planned" : "available";
    const lastEnd = last ? end(last) : null;
    const freeAt = offNow ? offNow.endsAt : lastEnd && lastEnd > now ? lastEnd : last ? now : now;
    return {
      driverId: d.id,
      name: d.name,
      driverType: d.driverType,
      phone: d.phone ?? d.whatsapp ?? null,
      truckId: truck?.id ?? null,
      unit: truck?.unitNumber ?? null,
      truckStatus: truck?.status ?? null,
      dispatcher: d.dispatcherUserId ? (uName.get(d.dispatcherUserId) ?? null) : null,
      status,
      current: cur ? { orderNumber: cur.order.orderNumber, state: cur.leg.state, to: place(stop.get(cur.leg.toStopId ?? "")) } : null,
      availableAt: iso(freeAt),
      availableZone: lastStop ? stopZone(lastStop, companyZone) : companyZone,
      availableIn: lastStop ? place(lastStop) : pos ? `last seen ${pos.at.toISOString()}` : null,
      availableLat: lastC?.lat ?? posC?.lat ?? null,
      availableLng: lastC?.lng ?? posC?.lng ?? null,
      next: planned[0] ? ((st) => ({ orderNumber: planned[0].order.orderNumber, at: iso(start(planned[0])), from: place(st), zone: st ? stopZone(st, companyZone) : companyZone }))(stop.get(planned[0].leg.fromStopId ?? "")) : null,
      hos: d.hosAt ? { driveMin: d.hosDriveMin, shiftMin: d.hosShiftMin, cycleMin: d.hosCycleMin, at: iso(d.hosAt) } : null,
      events: evs.map((e) => ({ id: e.id, kind: e.kind, label: EVENT_LABEL[e.kind], startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), hard: e.hard, note: e.note, subject: e.subjectKind === "truck" ? ("truck" as const) : ("driver" as const) })),
    };
  });
  // "last seen" text is only a hint; keep availability places human
  for (const d of outDrivers) if (d.availableIn?.startsWith("last seen")) d.availableIn = "last GPS position";

  // ---- by truck ----
  const blockOf = (kind: string, id: string) => blocked.find((b) => b.subjectKind === kind && b.subjectId === id);
  // the plain reason that actually blocks (the hard one first): "Pre-employment drug test result not in", "Licence expired"
  const blockWhy = (b: (typeof blocked)[number]) => rollup(b.items).blockers[0] ?? "paperwork blocks dispatch";
  const byOrder = new Map<string, typeof allLegCounts>();
  for (const l of allLegCounts) byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), l]);
  const fmtUntil = (d: Date) => fmtWhen(d, companyZone, { style: "short", now }) ?? "";
  const outTrucks: PlannerTruck[] = trucks
    .map((t) => {
      const crewD = outDrivers.filter((d) => d.truckId === t.id);
      const lead = crewD.find((d) => d.status === "on_load") ?? crewD[0] ?? null;
      const truckLegs = legs.filter((l) => l.leg.truckId === t.id && (ACTIVE as readonly string[]).includes(l.leg.state));
      // a co-driver on the truck's current load counts as crew even if their profile names another truck
      for (const l of truckLegs) {
        const co = outDrivers.find((d) => d.driverId === l.leg.coDriverId);
        if (co && !crewD.includes(co)) crewD.push(co);
      }
      const evs = events.filter((e) => e.subjectKind === "truck" && e.subjectId === t.id);
      const truckEvents = evs.map((e) => ({ id: e.id, kind: e.kind, label: EVENT_LABEL[e.kind], startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), hard: e.hard, note: e.note, subject: "truck" as const }));
      const allEvents = [...truckEvents, ...crewD.flatMap((d) => d.events.filter((e) => e.subject === "driver"))];
      const offNow = allEvents.find((e) => e.hard && new Date(e.startsAt) <= now && new Date(e.endsAt) >= now);
      const moving = truckLegs.some((l) => (MOVING as readonly string[]).includes(l.leg.state));
      // its next load waits on freight that hasn't crossed: an earlier MX or crossing leg of the same order isn't done
      const waiting = truckLegs
        .filter((l) => ["planned", "dispatched", "accepted"].includes(l.leg.state))
        .map((l) => {
          const all = byOrder.get(l.order.id) ?? [];
          // a crossing leg that is done means the freight is across, whatever an earlier leg still says
          const lastDone = Math.max(0, ...all.filter((o) => o.seq < l.leg.seq && o.state === "completed").map((o) => o.seq));
          return { l, before: all.filter((o) => o.seq < l.leg.seq && o.seq > lastDone && (o.type === "mx" || o.type === "crossing") && o.state !== "completed" && o.state !== "cancelled") };
        })
        .find((x) => x.before.length);
      const tBlock = blockOf("truck", t.id);
      const dBlocks = crewD.map((d) => blockOf("driver", d.driverId));
      let status: PlannerTruck["status"] = "available";
      let why: string | null = null;
      if (t.status === "oos") { status = "unavailable"; why = `Out of service${t.oosReason ? ` — ${t.oosReason}` : ""}${t.oosUntil ? ` · until ${fmtUntil(t.oosUntil)}` : ""}`; }
      else if (!crewD.length) { status = "unavailable"; why = "No driver in this truck"; }
      else if (offNow) { status = "unavailable"; why = `${SAFETY_EVENT[offNow.kind as AssetEventKind] ? "Safety: " : ""}${offNow.label} until ${fmtUntil(new Date(offNow.endsAt))}`; }
      const blockText = tBlock ? `Truck: ${blockWhy(tBlock)}` : crewD.length && dBlocks.every(Boolean) ? `${crewD[0].name.split(" ")[0]}: ${blockWhy(dBlocks[0]!)}` : null;
      if (status === "unavailable") {
        /* set above */
      } else if (moving || (lead?.status === "on_load" && !waiting)) {
        // already on a load: paperwork that blocks the next dispatch shows as a warning
        status = "on_load";
        why = blockText;
      } else if (blockText) {
        status = "unavailable";
        why = blockText;
      } else if (waiting) {
        status = "waiting_crossing";
        const mxOpen = waiting.before.find((o) => o.type === "mx");
        const cross = waiting.before.find((o) => o.type === "crossing");
        why = `${waiting.l.order.orderNumber} — ${mxOpen ? "freight still on the Mexican side" : cross && (MOVING as readonly string[]).includes(cross.state) ? "freight crossing the bridge now" : "waiting for the crossing"}`;
      }
      const base = lead ?? ({ current: null, availableAt: iso(now), availableZone: companyZone, availableIn: null, availableLat: null, availableLng: null, next: null, hos: null, dispatcher: null } as Partial<PlannerDriver>);
      return {
        truckId: t.id,
        unit: t.unitNumber,
        crew: crewD.map((d) => ({ driverId: d.driverId, name: d.name, driverType: d.driverType, phone: d.phone })),
        team: crewD.length > 1,
        status,
        why,
        dispatcher: base.dispatcher ?? null,
        current: base.current ?? null,
        availableAt: status === "unavailable" && offNow ? offNow.endsAt : status === "unavailable" && t.oosUntil ? iso(t.oosUntil) : (base.availableAt ?? null),
        availableZone: base.availableZone ?? companyZone,
        availableIn: base.availableIn ?? null,
        availableLat: base.availableLat ?? null,
        availableLng: base.availableLng ?? null,
        next: base.next ?? null,
        hos: base.hos ?? null,
        events: allEvents,
      };
    })
    .sort((p, q) => p.unit.localeCompare(q.unit, "en-US", { numeric: true }));
  return { legs: openLegs, drivers: outDrivers.sort((p, q) => p.name.localeCompare(q.name)), trucks: outTrucks, now: now.toISOString() };
}

/** Road miles from where the driver comes free to the leg's pickup, when both have coordinates. */
export const deadhead = (d: { availableLat: number | null; availableLng: number | null }, l: { from: { lat: number | null; lng: number | null } }) =>
  d.availableLat != null && d.availableLng != null && l.from.lat != null && l.from.lng != null ? Math.round(roadMiles({ lat: d.availableLat, lng: d.availableLng }, { lat: l.from.lat, lng: l.from.lng })) : null;

/** Everyone's events in a window, for a calendar. */
export async function listEvents(ctx: Ctx, from: Date, to: Date) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  return eventsBetween(db, ctx.tenantId, from, to);
}


// ---------- schedule conflicts ----------

const BUSY_LEG = ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"];

/**
 * Other loads the truck or drivers are already on whose times overlap this leg's window: a double
 * booking. Only legs with real times count (a leg with no stop times and no plan can't be said to
 * overlap anything). A dispatcher can still confirm it (a relay, a load that will finish early).
 */
export async function scheduleConflicts(tx: Tx | typeof db, tenantId: string, excludeLegId: string | null, win: { start: Date; end: Date }, who: { truckId?: string | null; driverIds?: (string | null | undefined)[] }): Promise<Finding[]> {
  const drivers = (who.driverIds ?? []).filter((x): x is string => !!x);
  if (!who.truckId && !drivers.length) return [];
  const cond = [who.truckId ? eq(s.legs.truckId, who.truckId) : null, drivers.length ? inArray(s.legs.driverId, drivers) : null, drivers.length ? inArray(s.legs.coDriverId, drivers) : null].filter((x): x is NonNullable<typeof x> => !!x);
  const { or } = await import("drizzle-orm");
  const legs = await tx
    .select({ leg: s.legs, orderNumber: s.orders.orderNumber })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .where(and(eq(s.legs.tenantId, tenantId), inArray(s.legs.state, BUSY_LEG as never), or(...cond)));
  const out: Finding[] = [];
  const names = drivers.length ? await tx.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(inArray(s.drivers.id, drivers)) : [];
  const [truck] = who.truckId ? await tx.select({ unit: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.id, who.truckId)).limit(1) : [];
  const companyZone = legs.length ? await tenantZone(tenantId) : "America/Detroit";
  for (const { leg, orderNumber } of legs) {
    if (leg.id === excludeLegId) continue;
    const ids = [leg.fromStopId, leg.toStopId].filter((x): x is string => !!x);
    const st = ids.length ? await tx.select().from(s.stops).where(inArray(s.stops.id, ids)) : [];
    const a = st.find((x) => x.id === leg.fromStopId);
    const b = st.find((x) => x.id === leg.toStopId);
    const start = leg.plannedStart ?? a?.windowStart ?? null;
    const end = leg.plannedEnd ?? b?.windowEnd ?? b?.windowStart ?? null;
    if (!start && !end) continue;
    const s0 = start ?? new Date(end!.getTime() - 12 * 3600_000);
    const e0 = end ?? new Date(s0.getTime() + 12 * 3600_000);
    if (!(s0 < win.end && win.start < e0)) continue;
    const whoLabel = who.truckId && leg.truckId === who.truckId ? `unit ${truck?.unit ?? ""}` : names.find((n) => n.id === leg.driverId || n.id === leg.coDriverId)?.name ?? "driver";
    // the time it frees up is at that load's last stop: on that stop's clock
    out.push({ level: "red", code: "schedule_conflict", message: `${whoLabel} is on ${orderNumber} until ${fmtWhen(e0, b ? stopZone(b, companyZone) : companyZone, { style: "short" })}${b?.name ? ` at ${b.name}` : ""}`, overridable: true });
  }
  return out;
}
