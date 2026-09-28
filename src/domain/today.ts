import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { weekOfZoned, zonedDate, stopZone } from "@/lib/time";
import { board } from "./orders";
import { alertsOf, bucketsOf, mergeCallEtas, type EtaEntry } from "./board-buckets";
import { boardEtas, lastPings } from "./tracking";
import { lastCheckCalls } from "./check-calls";
import { openTendersForOrders } from "./tenders";

/**
 * The owner's Today page (owner top-15 #6): the handful of numbers an owner checks first thing, each one
 * a link to the list behind it. Money is always per currency — pesos are never added to dollars here.
 */

export type MoneyLine = { currency: string; cents: number; count: number };
export type Today = {
  week: { start: string; end: string };
  cashIn: { dueThisWeek: MoneyLine[]; overdue: MoneyLine[] } | null;
  cashOut: { carrierBills: MoneyLine[]; driverPay: MoneyLine[] } | null;
  approvals: { accessorials: number; overrides: number; renewals: number };
  loads: { late: number; atRisk: number; noTruckSoon: number; flagged: number };
  billing: { readyToBill: number; missingPod: number } | null;
  trucksEmptyTomorrow: number;
  documents: { expiring: number; expired: number };
};

/** Sum amounts per currency, largest first; never across currencies. */
export function byCurrency(rows: { currency: string; cents: number }[]): MoneyLine[] {
  const m = new Map<string, MoneyLine>();
  for (const r of rows) {
    if (!r.cents) continue;
    const x = m.get(r.currency) ?? { currency: r.currency, cents: 0, count: 0 };
    x.cents += r.cents;
    x.count += 1;
    m.set(r.currency, x);
  }
  return [...m.values()].sort((a, b) => (a.currency === "USD" ? -1 : b.currency === "USD" ? 1 : b.cents - a.cents));
}

export async function ownerToday(ctx: Ctx, now = new Date()): Promise<Today> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const T = ctx.tenantId;
  const [tenant] = await db.select({ zone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, T)).limit(1);
  const zone = tenant?.zone ?? "America/Chicago";
  const week = weekOfZoned(now, zone);
  const money = can(ctx, "billing.view");

  // ---- cash in: open invoices by due date
  let cashIn: Today["cashIn"] = null;
  let cashOut: Today["cashOut"] = null;
  if (money) {
    const open = await db
      .select({ currency: s.invoices.currency, total: s.invoices.totalCents, paid: s.invoices.paidCents, credited: s.invoices.creditedCents, dueAt: s.invoices.dueAt })
      .from(s.invoices)
      .where(and(eq(s.invoices.tenantId, T), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "disputed"])));
    const bal = (i: (typeof open)[number]) => Math.max(0, i.total - i.paid - i.credited);
    cashIn = {
      dueThisWeek: byCurrency(open.filter((i) => i.dueAt && i.dueAt.getTime() >= now.getTime() && i.dueAt.getTime() < week.end.getTime()).map((i) => ({ currency: i.currency, cents: bal(i) }))),
      overdue: byCurrency(open.filter((i) => i.dueAt && i.dueAt.getTime() < now.getTime()).map((i) => ({ currency: i.currency, cents: bal(i) }))),
    };
    // ---- cash out: carrier bills approved to pay (due by the end of the week), driver pay approved and not paid
    const bills = await db
      .select({ currency: s.carrierBills.currency, approved: s.carrierBills.approvedCents, invoiced: s.carrierBills.invoicedCents, expected: s.carrierBills.expectedCents, paid: s.carrierBills.paidCents, payDate: s.carrierBills.payDate })
      .from(s.carrierBills)
      .where(and(eq(s.carrierBills.tenantId, T), inArray(s.carrierBills.state, ["approved", "scheduled"])));
    const pay = await db.select({ currency: s.settlements.currency, net: s.settlements.netCents }).from(s.settlements).where(and(eq(s.settlements.tenantId, T), inArray(s.settlements.state, ["reviewed", "approved"])));
    cashOut = {
      carrierBills: byCurrency(bills.filter((b) => !b.payDate || b.payDate.getTime() < week.end.getTime()).map((b) => ({ currency: b.currency, cents: Math.max(0, (b.approved ?? b.invoiced ?? b.expected) - (b.paid ?? 0)) }))),
      driverPay: byCurrency(pay.map((p) => ({ currency: p.currency, cents: Math.max(0, p.net) }))),
    };
  }

  // ---- approvals waiting on the owner
  const since = new Date(now.getTime() - 7 * 86400_000);
  const [[acc], [ovr], [ren]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(s.charges).where(and(eq(s.charges.tenantId, T), eq(s.charges.approvalState, "pending"), isNull(s.charges.invoiceId))),
    db.select({ n: sql<number>`count(*)` }).from(s.auditLog).where(and(eq(s.auditLog.tenantId, T), eq(s.auditLog.action, "override"), gte(s.auditLog.at, since))),
    db.select({ n: sql<number>`count(*)` }).from(s.documents).where(and(eq(s.documents.tenantId, T), eq(s.documents.status, "pending"))),
  ]);

  // ---- loads: the board's own Late / At risk / No truck < 24h
  const rows = await board(ctx);
  const ids = rows.map((r) => r.order.id);
  const [gps, calls, tenders, pings] = await Promise.all([boardEtas(ctx, now), lastCheckCalls(ctx, ids), openTendersForOrders(ctx, ids), lastPings(ctx)]);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const slim = rows.map((r) => ({
    order: { id: r.order.id, state: r.order.state },
    stage: r.stage,
    legs: r.legs.map((l) => ({ id: l.id, state: l.state, truckId: l.truckId, fromStopId: l.fromStopId, toStopId: l.toStopId })),
    stops: r.stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, country: st.country, address: st.address, windowStart: iso(st.windowStart), windowEnd: iso(st.windowEnd), arrivedAt: iso(st.arrivedAt), departedAt: iso(st.departedAt) })),
    tenders: tenders.filter((t) => t.orderId === r.order.id).map((t) => ({ legId: t.legId, state: t.state === "sent" && t.expiresAt.getTime() < now.getTime() ? "expired" : t.state, expiresAt: t.expiresAt.toISOString() })),
    openFlags: r.openFlags,
  }));
  const etas = mergeCallEtas(slim, Object.fromEntries(Object.entries(gps).map(([k, e]) => [k, { ...e, source: "gps" as const } satisfies EtaEntry])), Object.fromEntries([...calls].map(([k, c]) => [k, { at: c.at.toISOString(), etaAt: c.etaAt?.toISOString() ?? null, legId: c.legId }])));
  const bctx = {
    now: now.getTime(),
    etas,
    lastPing: (l: { id: string; truckId: string | null }) => pings.byLeg[l.id] ?? (l.truckId ? (pings.byTruck[l.truckId] ?? null) : null),
    today: (st: { country?: string; address?: { state?: string | null } | null }) => zonedDate(now, stopZone(st as never, zone)),
    dayOf: (at: string, st: { country?: string; address?: { state?: string | null } | null }) => zonedDate(new Date(at), stopZone(st as never, zone)),
  };
  const loads = { late: 0, atRisk: 0, noTruckSoon: 0, flagged: 0 };
  for (const r of slim) {
    if (!bucketsOf(r).has("all")) continue;
    const a = alertsOf(r, bctx as never);
    if (a.has("late")) loads.late++;
    else if (a.has("at_risk")) loads.atRisk++;
    if (a.has("uncovered_soon")) loads.noTruckSoon++;
    if (a.has("flags")) loads.flagged++;
  }

  // ---- billing: ready to bill, and delivered with no POD
  let billingNums: Today["billing"] = null;
  if (money) {
    const delivered = await db.select({ id: s.orders.id, tonu: s.orders.tonu, custom: s.orders.custom }).from(s.orders).where(and(eq(s.orders.tenantId, T), inArray(s.orders.state, ["delivered", "ready_to_bill"]), sql`${s.orders.kind} <> 'trip'`));
    const pods = delivered.length ? await db.select({ subjectId: s.documents.subjectId }).from(s.documents).where(and(eq(s.documents.tenantId, T), eq(s.documents.subjectKind, "order"), eq(s.documents.code, "POD"), inArray(s.documents.subjectId, delivered.map((d) => d.id)), inArray(s.documents.status, ["present", "verified"]))) : [];
    const has = new Set(pods.map((p) => p.subjectId));
    const missing = delivered.filter((d) => !d.tonu && !has.has(d.id) && !(d.custom as { podWaived?: unknown } | null)?.podWaived).length;
    billingNums = { readyToBill: delivered.length - missing, missingPod: missing };
  }

  // ---- trucks with nothing to do by the end of tomorrow
  const { plannerData } = await import("./planner");
  const pd = await plannerData(ctx, now);
  const tomorrowEnd = new Date(now.getTime() + 2 * 86400_000);
  // nothing booked before tomorrow ends: a load next week doesn't make a truck busy tomorrow (N3)
  const empty = pd.trucks.filter((t) => (t.status === "available" || t.status === "on_load") && t.crew.length > 0 && (!t.next || (!!t.next.at && new Date(t.next.at).getTime() > tomorrowEnd.getTime())) && (!t.availableAt || new Date(t.availableAt).getTime() < tomorrowEnd.getTime())).length;

  // ---- documents about to run out (drivers, trucks, trailers, carriers)
  const comp = await db.select({ items: s.complianceStatus.items }).from(s.complianceStatus).where(eq(s.complianceStatus.tenantId, T));
  let expiring = 0;
  let expired = 0;
  for (const c of comp)
    for (const i of c.items) {
      if (i.status === "expiring") expiring++;
      if (i.status === "expired" && i.required) expired++;
    }

  return {
    week: { start: week.start.toISOString(), end: week.end.toISOString() },
    cashIn,
    cashOut,
    approvals: { accessorials: Number(acc?.n ?? 0), overrides: Number(ovr?.n ?? 0), renewals: Number(ren?.n ?? 0) },
    loads,
    billing: billingNums,
    trucksEmptyTomorrow: empty,
    documents: { expiring, expired },
  };
}
