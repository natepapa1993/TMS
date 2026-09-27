import { and, eq, gte, lt, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { zonedMidnight, zonedDate, weekOfZoned } from "@/lib/time";
import { getCompany } from "./company";
import { bucketOf } from "./crossing";

/**
 * Reporting (spec Module 9): every number here is computed from the same orders, legs, charges,
 * bills and settlements the operation runs on — a figure on a report is the figure on the load.
 * Periods follow the company time zone; "week" is Sunday to Saturday.
 */

export type Period = { from: string; to: string }; // YYYY-MM-DD inclusive, company zone

export type Dashboard = {
  period: Period;
  entityId: string | null;
  revenueCents: number;
  loads: number;
  revenuePerTruckCents: number; // delivered revenue / active trucks in the period
  activeTrucks: number;
  emptyPct: number; // empty miles / total planned miles on our trucks (equipment moves and empty repositioning legs)
  marginCents: number;
  marginPct: number;
  atRisk: { count: number; orders: { id: string; orderNumber: string; flags: string[] }[] };
  crossingsPending: { count: number; byBucket: Record<string, number> };
  expiringDocs: { count: number; expired: number; expiring: number; missing: number };
  arOpenCents: number;
  arOverdueCents: number;
};

function window(period: Period, tz: string) {
  const from = zonedMidnight(period.from, tz);
  const to = new Date(zonedMidnight(period.to, tz).getTime() + 86400_000);
  return { from, to };
}

export function defaultPeriod(now: Date, tz: string): Period {
  const d = zonedDate(now, tz);
  return { from: `${d.slice(0, 7)}-01`, to: d };
}

export function weekPeriod(now: Date, tz: string): Period {
  const w = weekOfZoned(now, tz);
  return { from: w.startDate, to: zonedDate(new Date(w.end.getTime() - 1), tz) };
}

/** Delivered orders in the period (by delivered date), with their charges, legs and costs. */
async function deliveredOrders(ctx: Ctx, period: Period, tz: string, entityId: string | null) {
  const { from, to } = window(period, tz);
  const conds = [eq(s.orders.tenantId, ctx.tenantId), inArray(s.orders.state, ["delivered", "ready_to_bill", "invoiced", "paid"]), gte(s.orders.deliveredAt, from), lt(s.orders.deliveredAt, to)];
  if (entityId) conds.push(eq(s.orders.billingEntityId, entityId));
  // trips carry no revenue of their own: their shipments do, and take the trip's costs by share
  const orders = (await db.select().from(s.orders).where(and(...conds))).filter((o) => o.kind !== "trip");
  const empty = { orders, legs: [], charges: [], bills: [], settlementPay: new Map<string, number>(), stops: [], shares: new Map<string, { tripId: string; share: number }>() };
  if (!orders.length) return empty;
  const tripIds = [...new Set(orders.filter((o) => o.kind === "shipment" && o.tripId).map((o) => o.tripId!))];
  const shares = new Map<string, { tripId: string; share: number }>();
  if (tripIds.length) {
    const { costShares } = await import("./tailgate");
    for (const tid of tripIds) for (const [sid, sh] of await costShares(ctx, tid)) shares.set(sid, { tripId: tid, share: sh });
  }
  const ids = orders.map((o) => o.id);
  const costIds = [...ids, ...tripIds];
  const [legs, charges, bills, settlements, stops] = await Promise.all([
    db.select().from(s.legs).where(inArray(s.legs.orderId, costIds)),
    db.select().from(s.charges).where(and(inArray(s.charges.orderId, ids), eq(s.charges.billable, true))),
    db.select().from(s.carrierBills).where(inArray(s.carrierBills.orderId, costIds)),
    db.select().from(s.settlements).where(eq(s.settlements.tenantId, ctx.tenantId)),
    db.select().from(s.stops).where(inArray(s.stops.orderId, ids)),
  ]);
  const legIds = new Set(legs.map((l) => l.id));
  const settlementPay = new Map<string, number>(); // legId → driver pay
  for (const st of settlements) for (const l of st.lines) if (l.legId && legIds.has(l.legId) && l.amountCents > 0) settlementPay.set(l.legId, (settlementPay.get(l.legId) ?? 0) + l.amountCents);
  return { orders, legs, charges, bills, settlementPay, stops, shares };
}

type Costed = { orderId: string; revenue: number; carrierCost: number; driverPay: number; fuel: number; extra: number; miles: number; cost: number; margin: number };

function costOrders(d: Awaited<ReturnType<typeof deliveredOrders>>, fuelCpm: number): Costed[] {
  return d.orders.map((o) => {
    const revenue = d.charges.filter((c) => c.orderId === o.id).reduce((a, c) => a + c.amountCents, 0) || (o.rateCents ?? 0);
    const alloc = d.shares.get(o.id);
    const costId = alloc?.tripId ?? o.id;
    const share = alloc?.share ?? 1;
    const legs = d.legs.filter((l) => l.orderId === costId);
    const carrierCost = Math.round((d.bills.filter((b) => b.orderId === costId).reduce((a, b) => a + (b.paidCents ?? b.approvedCents ?? b.invoicedCents ?? b.expectedCents + b.accessorialCents), 0) || legs.filter((l) => l.assigneeKind === "carrier").reduce((a, l) => a + (l.carrierRateCents ?? 0), 0)) * share);
    const driverPay = Math.round(legs.reduce((a, l) => a + (d.settlementPay.get(l.id) ?? 0), 0) * share);
    const milesAll = legs.filter((l) => l.assigneeKind === "truck").reduce((a, l) => a + (l.plannedMiles ?? 0), 0);
    const miles = Math.round(milesAll * share);
    const fuel = Math.round(milesAll * fuelCpm * share);
    const extra = o.tollsFeesCents ?? 0;
    const cost = carrierCost + driverPay + fuel + extra;
    return { orderId: o.id, revenue, carrierCost, driverPay, fuel, extra, miles, cost, margin: revenue - cost };
  });
}

export async function dashboard(ctx: Ctx, period: Period, entityId: string | null = null): Promise<Dashboard> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const company = await getCompany(ctx);
  const tz = company.timeZone;
  const d = await deliveredOrders(ctx, period, tz, entityId);
  const costed = costOrders(d, company.settings.fuelCostCentsPerMile);
  const revenueCents = costed.reduce((a, c) => a + c.revenue, 0);
  const marginCents = costed.reduce((a, c) => a + c.margin, 0);
  const truckIds = new Set(d.legs.filter((l) => l.assigneeKind === "truck" && l.truckId).map((l) => l.truckId!));
  const activeTrucks = truckIds.size;
  // empty %: equipment-move legs on our trucks against all planned miles on our trucks in the period
  const ourLegs = d.legs.filter((l) => l.assigneeKind === "truck");
  const totalMiles = ourLegs.reduce((a, l) => a + (l.plannedMiles ?? 0), 0);
  const emptyMiles = ourLegs.filter((l) => l.type === "equipment_move").reduce((a, l) => a + (l.plannedMiles ?? 0), 0);

  const [openFlags, crossings, compliance, openInvoices] = await Promise.all([
    db.select({ orderId: s.flags.orderId, code: s.flags.code, level: s.flags.level, orderNumber: s.orders.orderNumber }).from(s.flags).innerJoin(s.orders, eq(s.orders.id, s.flags.orderId)).where(and(eq(s.flags.tenantId, ctx.tenantId), isNull(s.flags.clearedAt), eq(s.flags.level, "red"), inArray(s.orders.state, ["booked", "dispatched", "in_transit", "exception"]))),
    db.select({ state: s.crossings.state }).from(s.crossings).innerJoin(s.orders, eq(s.orders.id, s.crossings.orderId)).where(and(eq(s.crossings.tenantId, ctx.tenantId), inArray(s.orders.state, ["booked", "dispatched", "in_transit", "exception"]))),
    db.select().from(s.complianceStatus).where(eq(s.complianceStatus.tenantId, ctx.tenantId)),
    db.select({ totalCents: s.invoices.totalCents, paidCents: s.invoices.paidCents, creditedCents: s.invoices.creditedCents, dueAt: s.invoices.dueAt }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "disputed"]))),
  ]);
  const byOrder = new Map<string, { id: string; orderNumber: string; flags: string[] }>();
  for (const f of openFlags) {
    const cur = byOrder.get(f.orderId) ?? { id: f.orderId, orderNumber: f.orderNumber, flags: [] };
    cur.flags.push(f.code);
    byOrder.set(f.orderId, cur);
  }
  const byBucket: Record<string, number> = {};
  for (const c of crossings) {
    const b = bucketOf(c.state);
    if (b === "cleared") continue;
    byBucket[b] = (byBucket[b] ?? 0) + 1;
  }
  const expired = compliance.reduce((a, c) => a + c.expired.length, 0);
  const expiring = compliance.reduce((a, c) => a + c.expiring.length, 0);
  const missing = compliance.reduce((a, c) => a + c.missing.length, 0);
  const now = new Date();
  const arOpenCents = openInvoices.reduce((a, i) => a + (i.totalCents - i.paidCents - i.creditedCents), 0);
  const arOverdueCents = openInvoices.filter((i) => i.dueAt && i.dueAt < now).reduce((a, i) => a + (i.totalCents - i.paidCents - i.creditedCents), 0);
  return {
    period,
    entityId,
    revenueCents,
    loads: d.orders.length,
    revenuePerTruckCents: activeTrucks ? Math.round(revenueCents / activeTrucks) : 0,
    activeTrucks,
    emptyPct: totalMiles ? Math.round((emptyMiles / totalMiles) * 1000) / 10 : 0,
    marginCents,
    marginPct: revenueCents ? Math.round((marginCents / revenueCents) * 1000) / 10 : 0,
    atRisk: { count: byOrder.size, orders: [...byOrder.values()].slice(0, 20) },
    crossingsPending: { count: Object.values(byBucket).reduce((a, n) => a + n, 0), byBucket },
    expiringDocs: { count: expired + expiring + missing, expired, expiring, missing },
    arOpenCents,
    arOverdueCents,
  };
}

// ---------- breakdowns (drill-down tables) ----------

export type BreakdownRow = { key: string; label: string; loads: number; revenueCents: number; costCents: number; marginCents: number; marginPct: number; miles: number; orderIds: string[] };

export type Breakdown = "truck" | "customer" | "lane" | "carrier" | "driver" | "week";

export async function breakdown(ctx: Ctx, by: Breakdown, period: Period, entityId: string | null = null): Promise<BreakdownRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const company = await getCompany(ctx);
  const tz = company.timeZone;
  const d = await deliveredOrders(ctx, period, tz, entityId);
  const costed = costOrders(d, company.settings.fuelCostCentsPerMile);
  const [trucks, customers, carriers, drivers] = await Promise.all([
    db.select({ id: s.trucks.id, unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
    db.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
  ]);
  const name = (list: { id: string; name?: string; unitNumber?: string }[], id: string | null) => (id ? (list.find((x) => x.id === id)?.name ?? list.find((x) => x.id === id)?.unitNumber ?? "?") : "—");
  const rows = new Map<string, BreakdownRow>();
  const add = (key: string, label: string, c: Costed, share = 1) => {
    const r = rows.get(key) ?? { key, label, loads: 0, revenueCents: 0, costCents: 0, marginCents: 0, marginPct: 0, miles: 0, orderIds: [] };
    if (!r.orderIds.includes(c.orderId)) {
      r.orderIds.push(c.orderId);
      r.loads++;
    }
    r.revenueCents += Math.round(c.revenue * share);
    r.costCents += Math.round(c.cost * share);
    r.marginCents += Math.round(c.margin * share);
    r.miles += Math.round(c.miles * share);
    rows.set(key, r);
  };
  for (const c of costed) {
    const o = d.orders.find((x) => x.id === c.orderId)!;
    const legs = d.legs.filter((l) => l.orderId === (d.shares.get(o.id)?.tripId ?? o.id)); // a shipment rides its trip's legs
    if (by === "customer") add(o.customerId ?? o.brokerId ?? "none", name(customers, o.customerId ?? o.brokerId), c);
    else if (by === "week") {
      const w = weekOfZoned(o.deliveredAt!, tz);
      add(w.startDate, `week of ${w.startDate}`, c);
    } else if (by === "lane") {
      const st = d.stops.filter((x) => x.orderId === o.id).sort((p, q) => p.seq - q.seq);
      const f = st[0];
      const l = st[st.length - 1];
      const place = (x?: typeof f) => (x ? `${x.address?.city ?? x.name}${x.address?.state ? `, ${x.address.state}` : ""}` : "?");
      add(`${place(f)}→${place(l)}`, `${place(f)} → ${place(l)}`, c);
    } else if (by === "truck") {
      const ours = legs.filter((l) => l.assigneeKind === "truck" && l.truckId);
      if (!ours.length) continue;
      const share = 1 / ours.length; // an order run by two units splits evenly
      for (const l of ours) add(l.truckId!, `Unit ${name(trucks, l.truckId)}`, c, share);
    } else if (by === "driver") {
      const ours = legs.filter((l) => l.assigneeKind === "truck" && l.driverId);
      if (!ours.length) continue;
      const share = 1 / ours.length;
      for (const l of ours) add(l.driverId!, name(drivers, l.driverId), c, share);
    } else if (by === "carrier") {
      const theirs = legs.filter((l) => l.assigneeKind === "carrier" && l.carrierId);
      if (!theirs.length) continue;
      const share = 1 / theirs.length;
      for (const l of theirs) add(l.carrierId!, name(carriers, l.carrierId), c, share);
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, marginPct: r.revenueCents ? Math.round((r.marginCents / r.revenueCents) * 1000) / 10 : 0 }));
  return out.sort((p, q) => (by === "week" ? p.key.localeCompare(q.key) : q.revenueCents - p.revenueCents));
}

/** Order-level detail for a breakdown row (the drill-down). */
export async function orderDetail(ctx: Ctx, period: Period, entityId: string | null, orderIds: string[]) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const company = await getCompany(ctx);
  const d = await deliveredOrders(ctx, period, company.timeZone, entityId);
  const costed = costOrders(d, company.settings.fuelCostCentsPerMile).filter((c) => orderIds.includes(c.orderId));
  return costed.map((c) => {
    const o = d.orders.find((x) => x.id === c.orderId)!;
    return { ...c, orderNumber: o.orderNumber, deliveredAt: o.deliveredAt, state: o.state };
  });
}

export function breakdownCsv(by: Breakdown, rows: BreakdownRow[]) {
  const head = [by, "loads", "revenue", "cost", "margin", "margin_pct", "miles"];
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [head, ...rows.map((r) => [r.label, r.loads, (r.revenueCents / 100).toFixed(2), (r.costCents / 100).toFixed(2), (r.marginCents / 100).toFixed(2), r.marginPct, r.miles])].map((r) => r.map(esc).join(",")).join("\n") + "\n";
}


