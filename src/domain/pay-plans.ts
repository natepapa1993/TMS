import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { PAY_RULE_KINDS, type PayRule } from "@/db/schema";
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

import { isPct } from "./pay-plans-pure";
export { RULE_LABEL, isPct, legPayLines, statementExtras, type LegPayInput } from "./pay-plans-pure";

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
