import { and, eq, inArray, arrayOverlaps } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { getCompany } from "./company";
import { loadRate } from "./billing";
import { toHome } from "./fx-rules";
import { legShare, legPayLines, payTypeLines } from "./pay-plans-pure";

type Leg = typeof s.legs.$inferSelect;

/**
 * What our drivers will earn on legs no statement has paid yet, by leg, in USD: each driver's own rule
 * (a pay plan, else the pay type on the driver) on the leg's miles — typed, else the estimate from the
 * stops — and a percent on the leg's share of the load. The load P&L, the reports and the assign
 * dialog's margin all use it, so a load run by our own truck never shows a 100% margin because nobody
 * typed the miles.
 */
export async function estimateLegPay(ctx: Ctx, legs: Leg[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ours = legs.filter((l) => l.assigneeKind === "truck" && l.driverId && l.state !== "cancelled");
  if (!ours.length) return out;
  const orderIds = [...new Set(ours.map((l) => l.orderId))];
  const driverIds = [...new Set(ours.flatMap((l) => [l.driverId, l.coDriverId].filter((x): x is string => !!x)))];
  const [orders, invs, loadLegs, drivers, company] = await Promise.all([
    db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber, rateCents: s.orders.rateCents, rateTbd: s.orders.rateTbd, currency: s.orders.currency }).from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), inArray(s.orders.id, orderIds))),
    db.select({ orderIds: s.invoices.orderIds, state: s.invoices.state, kind: s.invoices.kind, currency: s.invoices.currency, exchangeRate: s.invoices.exchangeRate, issuedAt: s.invoices.issuedAt }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), arrayOverlaps(s.invoices.orderIds, orderIds))),
    db.select({ id: s.legs.id, orderId: s.legs.orderId, type: s.legs.type, state: s.legs.state, plannedMiles: s.legs.plannedMiles, estMiles: s.legs.estMiles }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.orderId, orderIds))),
    db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), inArray(s.drivers.id, driverIds))),
    getCompany(ctx),
  ]);
  const planIds = [...new Set(drivers.map((d) => d.payPlanId).filter((x): x is string => !!x))];
  const plans = planIds.length ? await db.select().from(s.payPlans).where(and(eq(s.payPlans.tenantId, ctx.tenantId), inArray(s.payPlans.id, planIds))) : [];
  for (const l of ours) {
    const order = orders.find((o) => o.id === l.orderId);
    if (!order) continue;
    let cents = 0;
    for (const did of [l.driverId, l.coDriverId].filter((x): x is string => !!x)) {
      const d = drivers.find((x) => x.id === did);
      if (!d) continue;
      const plan = d.payPlanId ? plans.find((p) => p.id === d.payPlanId && !p.archivedAt) : null;
      if (plan) {
        const { payInputs } = await import("./pay-inputs");
        const inputs = await payInputs(ctx, d.id, [l]);
        cents += inputs.flatMap((inp) => legPayLines(plan, inp)).reduce((a, x) => a + x.amountCents, 0);
        continue;
      }
      const linehaulUsdCents = order.rateTbd || order.rateCents == null ? 0 : toHome(order.rateCents, order.currency, loadRate(order, invs, company.settings.fx).rateE4);
      cents += payTypeLines(d, l, { orderNumber: order.orderNumber, rateCents: order.rateCents, currency: order.currency, linehaulUsdCents, share: legShare(l.id, loadLegs.filter((x) => x.orderId === l.orderId)) }).reduce((a, x) => a + x.amountCents, 0);
    }
    out.set(l.id, cents);
  }
  return out;
}

/** Miles on our own trucks' legs — typed, else the estimate — and whether any part is estimated. */
export function truckMiles(legs: Pick<Leg, "assigneeKind" | "state" | "plannedMiles" | "estMiles">[]) {
  const ours = legs.filter((l) => l.assigneeKind === "truck" && l.state !== "cancelled");
  return { miles: ours.reduce((a, l) => a + (l.plannedMiles ?? l.estMiles ?? 0), 0), est: ours.some((l) => l.plannedMiles == null && l.estMiles != null) };
}

export type MarginPreview = {
  /** the load's rate in USD (null: TBD) */
  loadUsdCents: number | null;
  /** every other leg's cost in USD: carriers at their tender (company rate), our drivers' pay est., fuel on our trucks */
  otherCarrierCents: number;
  otherDriverPayCents: number;
  otherFuelCents: number;
  /** this leg on our truck: miles (typed, else est.), fuel, and the picked driver's pay by their rule */
  miles: number | null;
  milesEst: boolean;
  fuelCents: number;
  driverPayCents: number | null;
};

/**
 * The assign dialog's margin: the load's rate less what every other leg costs (a carrier's tender, our
 * drivers' pay by their rule on the leg's miles, fuel) — and, on our own truck, this leg's fuel and the
 * picked driver's pay. The same rules the P&L uses, in USD.
 */
export async function legMarginPreview(ctx: Ctx, legId: string, pick: { driverId?: string | null; coDriverId?: string | null; plannedMiles?: number | null } = {}): Promise<MarginPreview> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new Error("leg not found");
  const [[order], legs, company] = await Promise.all([
    db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, leg.orderId))).limit(1),
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, leg.orderId))),
    getCompany(ctx),
  ]);
  const { pickRate } = await import("./fx-rules");
  const fx = company.settings.fx;
  const usd = (c: number, cur: string) => toHome(c, cur, pickRate(cur, null, fx).rateE4);
  const others = legs.filter((l) => l.id !== leg.id && l.state !== "cancelled");
  const otherCarrierCents = others.filter((l) => l.assigneeKind === "carrier").reduce((a, l) => a + usd(l.carrierRateCents ?? 0, l.carrierRateCurrency ?? "USD"), 0);
  const pay = await estimateLegPay(ctx, others);
  const otherDriverPayCents = [...pay.values()].reduce((a, v) => a + v, 0);
  const cpm = company.settings.fuelCostCentsPerMile;
  const otherFuelCents = Math.round(truckMiles(others).miles * cpm);
  const typed = pick.plannedMiles !== undefined ? pick.plannedMiles : leg.plannedMiles;
  const miles = typed ?? leg.estMiles ?? null;
  let driverPayCents: number | null = null;
  if (pick.driverId) {
    const mine = await estimateLegPay(ctx, [{ ...leg, assigneeKind: "truck", driverId: pick.driverId, coDriverId: pick.coDriverId ?? null, plannedMiles: typed ?? null, state: leg.state === "cancelled" ? "planned" : leg.state }]);
    driverPayCents = mine.get(leg.id) ?? 0;
  }
  return { loadUsdCents: order.rateTbd || order.rateCents == null ? null : usd(order.rateCents, order.currency), otherCarrierCents, otherDriverPayCents, otherFuelCents, miles, milesEst: typed == null && leg.estMiles != null, fuelCents: Math.round((miles ?? 0) * cpm), driverPayCents };
}
