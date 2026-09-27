import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { PAY_RULE_KINDS, type PayRule, type PayRuleKind, type SettlementLine } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";

/**
 * Driver pay plans (the way Alvys and the big TMSs do it): a plan is a list of rules — per loaded or
 * empty mile, a percent of the line haul or of everything billed, flat per load or leg, per stop,
 * hourly, crossing pay — each optionally limited to some leg types, customers or equipment or a mile
 * range; plus, for the whole statement, a team split, a per diem per day worked and a minimum.
 */

export const RULE_LABEL: Record<PayRuleKind, string> = {
  per_loaded_mile: "Per loaded mile",
  per_empty_mile: "Per empty mile",
  per_total_mile: "Per mile (loaded + empty)",
  pct_linehaul: "% of line haul",
  pct_total: "% of everything billed",
  flat_per_load: "Flat per load",
  flat_per_leg: "Flat per leg",
  per_stop: "Per stop",
  per_extra_stop: "Per extra stop (beyond pickup and delivery)",
  hourly: "Per hour",
  crossing: "Crossing pay",
};
export const isPct = (k: PayRuleKind) => k === "pct_linehaul" || k === "pct_total";

/** What a completed leg brings to the rules. */
export type LegPayInput = {
  legId: string;
  orderId: string;
  orderNumber: string;
  seq: number;
  type: string;
  customerId: string | null;
  equipment: string;
  loadedMiles: number | null;
  emptyMiles: number | null;
  stops: number; // pickups and deliveries on the leg
  hours: number | null;
  linehaulCents: number | null;
  billedCents: number | null;
  firstLegOfLoad: boolean;
  team: boolean;
};

const matches = (r: PayRule, l: LegPayInput) => {
  const w = r.when ?? {};
  if (w.legTypes?.length && !w.legTypes.includes(l.type)) return false;
  if (w.customerIds?.length && (!l.customerId || !w.customerIds.includes(l.customerId))) return false;
  if (w.equipment?.length && !w.equipment.includes(l.equipment)) return false;
  const miles = l.loadedMiles ?? 0;
  if (w.minMiles != null && miles < w.minMiles) return false;
  if (w.maxMiles != null && miles > w.maxMiles) return false;
  return true;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Pure: the lines a leg earns under a plan. */
export function legPayLines(plan: { rules: PayRule[]; teamSplit: string }, l: LegPayInput): SettlementLine[] {
  const share = l.team && plan.teamSplit !== "full" ? 0.5 : 1;
  const team = share < 1 ? " (team ½)" : "";
  const out: SettlementLine[] = [];
  const base = { legId: l.legId, orderNumber: l.orderNumber };
  const line = (r: PayRule, qty: number, unit: string, rateCents: number, amount: number, what: string, source: string) =>
    out.push({ id: newId(), kind: r.kind === "crossing" ? "accessorial" : "leg", ...base, description: `${l.orderNumber} leg ${l.seq} · ${r.label || what}${team}`, qty, unit, rateCents, amountCents: Math.round(amount * share), source });
  for (const r of plan.rules) {
    if (!matches(r, l)) continue;
    switch (r.kind) {
      case "per_loaded_mile":
      case "per_empty_mile":
      case "per_total_mile": {
        const mi = r.kind === "per_loaded_mile" ? l.loadedMiles : r.kind === "per_empty_mile" ? l.emptyMiles : l.loadedMiles == null && l.emptyMiles == null ? null : (l.loadedMiles ?? 0) + (l.emptyMiles ?? 0);
        const which = r.kind === "per_loaded_mile" ? "loaded" : r.kind === "per_empty_mile" ? "empty" : "total";
        if (mi == null) {
          if (r.kind !== "per_empty_mile") line(r, 0, "mi", r.amount, 0, `no ${which} miles on the leg`, "missing miles");
          continue;
        }
        if (mi === 0) continue;
        line(r, mi, "mi", r.amount, mi * r.amount, `${mi} ${which} mi × ${money(r.amount)}`, r.kind === "per_empty_mile" ? "empty miles from the last delivery" : "planned miles");
        break;
      }
      case "pct_linehaul":
      case "pct_total": {
        const basis = r.kind === "pct_linehaul" ? l.linehaulCents : (l.billedCents ?? l.linehaulCents);
        if (!basis || !l.firstLegOfLoad) continue; // a percent is paid once per load, on its first leg for this driver
        line(r, r.amount / 100, "pct", basis, (basis * r.amount) / 10000, `${r.amount / 100}% of ${money(basis)}`, r.kind === "pct_linehaul" ? "line haul" : "everything billed");
        break;
      }
      case "flat_per_load":
        if (!l.firstLegOfLoad) continue;
        line(r, 1, "flat", r.amount, r.amount, "flat per load", "plan");
        break;
      case "flat_per_leg":
        line(r, 1, "flat", r.amount, r.amount, "flat per leg", "plan");
        break;
      case "per_stop":
        if (l.stops) line(r, l.stops, "stop", r.amount, l.stops * r.amount, `${l.stops} stops × ${money(r.amount)}`, "stops on the leg");
        break;
      case "per_extra_stop": {
        const extra = Math.max(0, l.stops - 2);
        if (extra) line(r, extra, "stop", r.amount, extra * r.amount, `${extra} extra stop${extra === 1 ? "" : "s"} × ${money(r.amount)}`, "stops beyond pickup and delivery");
        break;
      }
      case "hourly":
        if (l.hours != null && l.hours > 0) line(r, Math.round(l.hours * 100) / 100, "h", r.amount, l.hours * r.amount, `${l.hours.toFixed(2)} h × ${money(r.amount)}`, "accepted → completed");
        break;
      case "crossing":
        if (l.type === "crossing") line(r, 1, "flat", r.amount, r.amount, "border crossing pay", "plan");
        break;
    }
  }
  return out;
}

/** Pure: per diem for the days worked, then a top-up to the plan's minimum. */
export function statementExtras(plan: { perDiemCents: number | null; minimumCents: number | null }, workedDays: number, earnedCents: number): SettlementLine[] {
  const out: SettlementLine[] = [];
  if (plan.perDiemCents && workedDays) out.push({ id: newId(), kind: "reimbursement", description: `Per diem · ${workedDays} day${workedDays === 1 ? "" : "s"} × ${money(plan.perDiemCents)}`, qty: workedDays, unit: "day", rateCents: plan.perDiemCents, amountCents: workedDays * plan.perDiemCents, source: "plan" });
  if (plan.minimumCents && earnedCents < plan.minimumCents) out.push({ id: newId(), kind: "adjustment", description: `Minimum pay top-up to ${money(plan.minimumCents)}`, qty: 1, unit: "flat", rateCents: plan.minimumCents - earnedCents, amountCents: plan.minimumCents - earnedCents, source: "plan minimum" });
  return out;
}

// ---------- plans ----------

function cleanRules(rules: PayRule[]): PayRule[] {
  if (!Array.isArray(rules) || !rules.length) throw new ValidationError("a plan needs at least one rule", "rules");
  return rules.map((r, i) => {
    if (!(PAY_RULE_KINDS as readonly string[]).includes(r.kind)) throw new ValidationError(`rule ${i + 1}: unknown kind`, "rules");
    const amount = Math.round(Number(r.amount));
    if (!Number.isFinite(amount) || amount < 0) throw new ValidationError(`rule ${i + 1}: amount must be positive`, "rules");
    if (isPct(r.kind) && amount > 10000) throw new ValidationError(`rule ${i + 1}: a percent is at most 100`, "rules");
    const w = r.when ?? {};
    const when = { legTypes: w.legTypes?.filter(Boolean), customerIds: w.customerIds?.filter(Boolean), equipment: w.equipment?.filter(Boolean), minMiles: w.minMiles ?? null, maxMiles: w.maxMiles ?? null };
    return { id: r.id || newId(), kind: r.kind, amount, label: r.label?.trim() || undefined, when };
  });
}

export async function listPlans(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [plans, drivers] = await Promise.all([
    db.select().from(s.payPlans).where(and(eq(s.payPlans.tenantId, ctx.tenantId), isNull(s.payPlans.archivedAt))).orderBy(asc(s.payPlans.name)),
    db.select({ id: s.drivers.id, name: s.drivers.name, payPlanId: s.drivers.payPlanId, payType: s.drivers.payType, payRateCents: s.drivers.payRateCents }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))).orderBy(asc(s.drivers.name)),
  ]);
  return { plans, drivers };
}

export async function savePlan(ctx: Ctx, input: { id?: string | null; name: string; rules: PayRule[]; teamSplit?: string; minimumCents?: number | null; perDiemCents?: number | null; notes?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const name = input.name?.trim();
  if (!name) throw new ValidationError("name the plan", "name");
  const rules = cleanRules(input.rules);
  for (const k of ["minimumCents", "perDiemCents"] as const) if (input[k] != null && (!Number.isFinite(input[k]) || (input[k] as number) < 0)) throw new ValidationError(`${k === "minimumCents" ? "minimum" : "per diem"} must be a positive amount`, k);
  const row = { name, rules, teamSplit: input.teamSplit === "full" ? "full" : "half", minimumCents: input.minimumCents ?? null, perDiemCents: input.perDiemCents ?? null, notes: input.notes?.trim() || null, updatedAt: new Date(), updatedBy: ctx.userId };
  if (input.id) {
    const [cur] = await db.select().from(s.payPlans).where(and(eq(s.payPlans.tenantId, ctx.tenantId), eq(s.payPlans.id, input.id))).limit(1);
    if (!cur || cur.archivedAt) throw new NotFoundError("pay plan", input.id);
    await db.update(s.payPlans).set(row).where(eq(s.payPlans.id, cur.id));
    await writeAudit(db, ctx, "pay_plan", cur.id, "update", undefined, name);
    return { id: cur.id };
  }
  const id = newId();
  await db.insert(s.payPlans).values({ id, tenantId: ctx.tenantId, ...row, createdBy: ctx.userId });
  await writeAudit(db, ctx, "pay_plan", id, "create", undefined, name);
  return { id };
}

export async function deletePlan(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const on = await db.select({ id: s.drivers.id }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), eq(s.drivers.payPlanId, id), isNull(s.drivers.archivedAt))).limit(1);
  if (on.length) throw new ValidationError("drivers are still on this plan; move them first");
  await db.update(s.payPlans).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.payPlans.tenantId, ctx.tenantId), eq(s.payPlans.id, id)));
  await writeAudit(db, ctx, "pay_plan", id, "archive");
}

/** Put drivers on a plan (or back on their own pay type with null). */
export async function assignPlan(ctx: Ctx, driverIds: string[], planId: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (planId) {
    const [p] = await db.select({ id: s.payPlans.id }).from(s.payPlans).where(and(eq(s.payPlans.tenantId, ctx.tenantId), eq(s.payPlans.id, planId), isNull(s.payPlans.archivedAt))).limit(1);
    if (!p) throw new NotFoundError("pay plan", planId);
  }
  if (!driverIds.length) return { moved: 0 };
  const rows = await db.update(s.drivers).set({ payPlanId: planId, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.drivers.tenantId, ctx.tenantId), inArray(s.drivers.id, driverIds))).returning({ id: s.drivers.id });
  for (const r of rows) await writeAudit(db, ctx, "driver", r.id, "update", { payPlanId: { from: null, to: planId } });
  return { moved: rows.length };
}
