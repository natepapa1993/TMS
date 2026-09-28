import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit, diff } from "@/lib/audit";
import { ValidationError } from "./orders";
import { parseRate, type FxRates } from "./fx-rules";

/** Company-wide settings (spec §1.1 "everything is master data"): the numbers the P&L, digests and close use. */
export type QbAccounts = { arAccount: string; apAccount: string; bankAccount: string; depositAccount: string; incomeAccount: string; fuelIncomeAccount: string; accessorialIncomeAccount: string; carrierExpenseAccount: string; driverPayAccount: string; reimbursementAccount: string; deductionAccount: string; advanceAccount: string; escrowAccount: string; factorReserveAccount: string; factoringFeeAccount: string };
export type CompanySettings = { fuelCostCentsPerMile: number; closedThrough: string | null; qb: QbAccounts; dispatchPhone: string | null; fx: FxRates };

export const DEFAULT_FUEL_CPM = 65;
export const DEFAULT_QB: QbAccounts = { arAccount: "Accounts Receivable", apAccount: "Accounts Payable", bankAccount: "Checking", depositAccount: "Undeposited Funds", incomeAccount: "Freight Income", fuelIncomeAccount: "Fuel Surcharge Income", accessorialIncomeAccount: "Accessorial Income", carrierExpenseAccount: "Purchased Transportation", driverPayAccount: "Driver Pay", reimbursementAccount: "Driver Reimbursements", deductionAccount: "Driver Deductions", advanceAccount: "Driver Advances", escrowAccount: "Driver Escrow", factorReserveAccount: "Factor Reserve", factoringFeeAccount: "Factoring Fees" };

/** The company's latest exchange rates (MXN / CAD per 1 USD × 10,000), from Settings or the last invoice issued with one. */
function readFx(settings: Record<string, unknown>): FxRates {
  const raw = (settings.fx ?? {}) as Record<string, { rateE4?: unknown; at?: unknown }>;
  const out: FxRates = {};
  for (const c of ["MXN", "CAD"]) {
    const r = raw[c];
    const n = Number(r?.rateE4);
    if (r && Number.isFinite(n) && n > 0) out[c] = { rateE4: Math.round(n), at: String(r.at ?? "") };
  }
  return out;
}

/** Save the company's latest rate for a currency (Settings → Company, or an invoice issued with a rate). */
export async function setFxRate(ctx: Ctx, currency: string, rateE4: number, opts: { silent?: boolean } = {}) {
  assertCtx(ctx);
  if (!opts.silent) requirePermission(ctx, "settings.edit");
  if (currency !== "MXN" && currency !== "CAD") throw new ValidationError("a rate is for MXN or CAD", "currency");
  if (!Number.isInteger(rateE4) || rateE4 <= 0) throw new ValidationError("the rate", "rate");
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const cur = (t?.settings ?? {}) as Record<string, unknown>;
  const fx = { ...readFx(cur), [currency]: { rateE4, at: new Date().toISOString() } };
  await db.update(s.tenants).set({ settings: { ...cur, fx } }).where(eq(s.tenants.id, ctx.tenantId));
  if (!opts.silent) await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { [`fx.${currency}`]: { from: readFx(cur)[currency]?.rateE4 ?? null, to: rateE4 } }, "exchange rate");
}

export async function getCompany(ctx: Ctx) {
  assertCtx(ctx);
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  if (!t) throw new ValidationError("company not found");
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  return { id: t.id, name: t.name, timeZone: t.timeZone, country: t.country, settings: { fuelCostCentsPerMile: Number(settings.fuelCostCentsPerMile ?? DEFAULT_FUEL_CPM), closedThrough: settings.closedThrough ? String(settings.closedThrough) : null, qb: { ...DEFAULT_QB, ...((settings.qb as Partial<QbAccounts> | undefined) ?? {}) }, dispatchPhone: settings.dispatchPhone ? String(settings.dispatchPhone) : null, fx: readFx(settings) } as CompanySettings };
}

export async function updateCompany(ctx: Ctx, values: { name?: string; timeZone?: string; fuelCostCentsPerMile?: number | null; qb?: Partial<QbAccounts>; dispatchPhone?: string | null; /** the latest rates, "18.45" MXN / "1.37" CAD per USD; blank leaves it as is */ fx?: Record<string, string | null | undefined> }) {
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
  if (values.qb) {
    for (const [k, v] of Object.entries(values.qb)) if (v != null && !String(v).trim()) throw new ValidationError(`QuickBooks account "${k}" cannot be blank`, k);
    const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
    const cur = (patch.settings ?? t?.settings ?? {}) as Record<string, unknown>;
    patch.settings = { ...cur, qb: { ...DEFAULT_QB, ...((cur.qb as Partial<QbAccounts> | undefined) ?? {}), ...Object.fromEntries(Object.entries(values.qb).map(([k, v]) => [k, String(v).trim()])) } };
  }
  if (values.dispatchPhone !== undefined) {
    const raw = (values.dispatchPhone ?? "").trim();
    if (raw && raw.replace(/\D/g, "").length < 8) throw new ValidationError("dispatch phone: the full number with country code, e.g. +1 313 555 0100", "dispatchPhone");
    const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
    const cur = (patch.settings ?? t?.settings ?? {}) as Record<string, unknown>;
    patch.settings = { ...cur, dispatchPhone: raw || null };
  }
  if (values.fx) {
    const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
    const cur = (patch.settings ?? t?.settings ?? {}) as Record<string, unknown>;
    const fx = { ...readFx(cur) } as FxRates;
    for (const c of ["MXN", "CAD"]) {
      const raw = values.fx[c];
      if (raw == null || !String(raw).trim()) continue;
      let rateE4: number;
      try {
        rateE4 = parseRate(String(raw), c);
      } catch (e) {
        throw new ValidationError((e as Error).message, `fx${c}`);
      }
      if (fx[c]?.rateE4 !== rateE4) fx[c] = { rateE4, at: new Date().toISOString() };
    }
    patch.settings = { ...cur, fx };
  }
  await db.update(s.tenants).set(patch).where(eq(s.tenants.id, ctx.tenantId));
  const after = await getCompany(ctx);
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
  return after;
}

/** What a driver or a partner's driver may need with no one signed in: the company's name and its dispatch number. */
export async function tenantContact(tenantId: string): Promise<{ name: string; dispatchPhone: string | null }> {
  const [t] = await db.select({ name: s.tenants.name, settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  const dp = (t?.settings as Record<string, unknown> | undefined)?.dispatchPhone;
  return { name: t?.name ?? "", dispatchPhone: dp ? String(dp) : null };
}

/** The company's time zone by tenant id, for public pages and outbound messages that have no signed-in user. */
export async function tenantZone(tenantId: string): Promise<string> {
  const [t] = await db.select({ timeZone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  return t?.timeZone || "America/Detroit";
}
