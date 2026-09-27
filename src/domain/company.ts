import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit, diff } from "@/lib/audit";
import { ValidationError } from "./orders";

/** Company-wide settings (spec §1.1 "everything is master data"): the numbers the P&L, digests and close use. */
export type CompanySettings = { fuelCostCentsPerMile: number; closedThrough: string | null };

export const DEFAULT_FUEL_CPM = 65;

export async function getCompany(ctx: Ctx) {
  assertCtx(ctx);
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  if (!t) throw new ValidationError("company not found");
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  return { id: t.id, name: t.name, timeZone: t.timeZone, country: t.country, settings: { fuelCostCentsPerMile: Number(settings.fuelCostCentsPerMile ?? DEFAULT_FUEL_CPM), closedThrough: settings.closedThrough ? String(settings.closedThrough) : null } as CompanySettings };
}

export async function updateCompany(ctx: Ctx, values: { name?: string; timeZone?: string; fuelCostCentsPerMile?: number | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "settings.edit");
  const before = await getCompany(ctx);
  const patch: Partial<typeof s.tenants.$inferInsert> = {};
  if (values.name !== undefined) {
    if (!values.name.trim()) throw new ValidationError("company name is required", "name");
    patch.name = values.name.trim();
  }
  if (values.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: values.timeZone }).format(new Date());
    } catch {
      throw new ValidationError(`"${values.timeZone}" is not a time zone (try America/Detroit or America/Monterrey)`, "timeZone");
    }
    patch.timeZone = values.timeZone;
  }
  if (values.fuelCostCentsPerMile !== undefined) {
    const cpm = values.fuelCostCentsPerMile;
    if (cpm != null && (!Number.isFinite(cpm) || cpm < 0 || cpm > 1000)) throw new ValidationError("fuel cost per mile: cents, 0–1000", "fuelCostCentsPerMile");
    const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
    patch.settings = { ...(t?.settings ?? {}), fuelCostCentsPerMile: cpm ?? DEFAULT_FUEL_CPM };
  }
  await db.update(s.tenants).set(patch).where(eq(s.tenants.id, ctx.tenantId));
  const after = await getCompany(ctx);
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
  return after;
}
