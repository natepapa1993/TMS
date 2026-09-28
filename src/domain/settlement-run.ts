import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "./orders";
import { buildSettlement, settlementTransition, approvalBlockers } from "./billing";
import { buildSettlementPdf } from "./billing-pdf";
import { getCompany } from "./company";

/**
 * The weekly pay run: every driver who ran a leg that week (or has a pay item due) gets a statement in one go;
 * the reviewed ones are approved together; the approved ones are paid under one ACH batch reference; each
 * driver gets a PDF statement with the year to date, in the office and in the driver app.
 */

export type RunRow = { driverId: string; driver: string; settlementId: string | null; state: string; netCents: number; lines: number; note: string | null; /** lines a person added to the open statement, kept through the rebuild */ keptManual?: number };

/**
 * Build every statement for the week. A driver gets one when they have pay: legs completed that week,
 * legs completed in a week whose statement was already approved or paid (late), or a reimbursement.
 * Deductions alone never make a statement. A week that hasn't ended can be built to look at, but not approved.
 */
export async function settlementRun(ctx: Ctx, periodStart: Date, periodEnd: Date, now = new Date()): Promise<RunRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!(periodEnd > periodStart)) throw new ValidationError("the week");
  const lookBack = new Date(periodStart.getTime() - 8 * 7 * 86400_000);
  const [drivers, legs, items, existing, older] = await Promise.all([
    db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))).orderBy(s.drivers.name),
    db.select({ id: s.legs.id, driverId: s.legs.driverId, coDriverId: s.legs.coDriverId, completedAt: s.legs.completedAt }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.state, "completed"), gte(s.legs.completedAt, lookBack), lt(s.legs.completedAt, periodEnd))),
    db.select({ driverId: s.payItems.driverId, kind: s.payItems.kind }).from(s.payItems).where(and(eq(s.payItems.tenantId, ctx.tenantId), eq(s.payItems.active, true))),
    db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.periodStart, periodStart))),
    db.select({ driverId: s.settlements.driverId, state: s.settlements.state, periodStart: s.settlements.periodStart, periodEnd: s.settlements.periodEnd, lines: s.settlements.lines }).from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), gte(s.settlements.periodEnd, lookBack))),
  ]);
  const onStatement = new Set(older.flatMap((x) => x.lines.map((l) => l.legId).filter((v): v is string => !!v)));
  const people = (l: { driverId: string | null; coDriverId: string | null }) => [l.driverId, l.coDriverId].filter((x): x is string => !!x);
  const ran = new Set(legs.filter((l) => l.completedAt! >= periodStart).flatMap(people));
  // late legs: completed in a week this driver's statement was already approved or paid for, and on no statement
  const lateFor = new Set(
    legs
      .filter((l) => l.completedAt! < periodStart && !onStatement.has(l.id))
      .flatMap((l) => people(l).filter((d) => older.some((x) => x.driverId === d && (x.state === "approved" || x.state === "paid") && l.completedAt! >= x.periodStart && l.completedAt! < x.periodEnd))),
  );
  const due = new Set(items.map((i) => i.driverId));
  const unfinished = periodEnd.getTime() > now.getTime();
  const out: RunRow[] = [];
  for (const d of drivers) {
    if (!ran.has(d.id) && !due.has(d.id) && !lateFor.has(d.id)) continue;
    const st = existing.find((x) => x.driverId === d.id);
    if (st && st.state !== "open") {
      out.push({ driverId: d.id, driver: d.name, settlementId: st.id, state: st.state, netCents: st.netCents, lines: st.lines.length, note: `already ${st.state}${lateFor.has(d.id) ? " — a late leg goes on next week's statement" : ""}` });
      continue;
    }
    try {
      const built = await buildSettlement(ctx, d.id, periodStart, periodEnd);
      const notes = [unfinished ? "the week isn't over: approve after it ends" : null, lateFor.has(d.id) ? "includes a late leg from an earlier week" : null, !ran.has(d.id) && !lateFor.has(d.id) ? "pay items only (no legs this week)" : null, built.lines.some((l) => l.blocker) ? "a load has no miles: fix it before approving" : null, built.lines.some((l) => l.shortCents) ? "some deductions didn't fit: they carry over" : null, built.keptManual ? `kept ${built.keptManual} line${built.keptManual === 1 ? "" : "s"} added by hand` : null].filter(Boolean);
      out.push({ driverId: d.id, driver: d.name, settlementId: built.id, state: built.state, netCents: built.netCents, lines: built.lines.length, note: notes.length ? notes.join(" · ") : null, keptManual: built.keptManual ?? 0 });
    } catch (e) {
      const msg = (e as Error).message;
      out.push({ driverId: d.id, driver: d.name, settlementId: null, state: /no pay for the week/.test(msg) ? "skipped" : "error", netCents: 0, lines: 0, note: /no pay for the week/.test(msg) ? "no pay this week: no statement — deductions wait for the next one with pay" : msg });
    }
  }
  return out;
}

/** Approve statements together: open ones are marked reviewed first; one with a dispute, a load with no miles, or an unfinished week waits (with the reason). */
export async function approveSettlements(ctx: Ctx, ids: string[], now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const rows = ids.length ? await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.id, ids))) : [];
  const tz = (await getCompany(ctx)).timeZone;
  const approved: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const st of rows) {
    if (st.lines.some((l) => l.disputed && !l.response)) {
      skipped.push({ id: st.id, reason: "the driver disputed a line: answer it first" });
      continue;
    }
    if (st.state !== "open" && st.state !== "reviewed") {
      skipped.push({ id: st.id, reason: `already ${st.state}` });
      continue;
    }
    const why = approvalBlockers(st, now, tz);
    if (why.length) {
      skipped.push({ id: st.id, reason: why.join("; ") });
      continue;
    }
    if (st.state === "open") await settlementTransition(ctx, st.id, "reviewed");
    await settlementTransition(ctx, st.id, "approved", { now });
    approved.push(st.id);
  }
  return { approved: approved.length, skipped };
}

/** Pay approved statements under one batch reference (the ACH file, the check run). */
export async function paySettlements(ctx: Ctx, ids: string[], p: { method: string; reference?: string | null; now?: Date }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!p.method) throw new ValidationError("how are they paid?", "method");
  const rows = ids.length ? await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.id, ids))) : [];
  let total = 0;
  let paid = 0;
  for (const st of rows) {
    if (st.state !== "approved") continue;
    await settlementTransition(ctx, st.id, "paid", { method: p.method, reference: p.reference ?? undefined, now: p.now });
    total += st.netCents;
    paid++;
  }
  if (!paid) throw new ValidationError("nothing approved to pay");
  return { paid, totalCents: total };
}

async function pdfFor(ctx: Ctx, st: typeof s.settlements.$inferSelect) {
  const [driver] = await db.select({ name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.id, st.driverId)).limit(1);
  const company = await getCompany(ctx);
  const year = st.periodStart.getUTCFullYear();
  const yearRows = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.driverId, st.driverId), gte(s.settlements.periodStart, new Date(Date.UTC(year, 0, 1))), lt(s.settlements.periodStart, new Date(st.periodStart.getTime() + 1))));
  // the year to date counts paid statements and this one
  const counted = yearRows.filter((r) => r.state === "paid" || r.id === st.id);
  const ytd = counted.reduce((a, r) => ({ grossCents: a.grossCents + r.grossCents, deductionsCents: a.deductionsCents + r.deductionsCents, netCents: a.netCents + r.netCents }), { grossCents: 0, deductionsCents: 0, netCents: 0 });
  return buildSettlementPdf({ company: company.name, driver: driver?.name ?? "Driver", periodStart: st.periodStart, periodEnd: st.periodEnd, state: st.state, lines: st.lines, grossCents: st.grossCents, deductionsCents: st.deductionsCents, netCents: st.netCents, paidAt: st.paidAt, method: st.method, reference: st.reference, ytd, timeZone: company.timeZone });
}

/** The statement PDF for the office. */
export async function settlementPdf(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [st] = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.id, id))).limit(1);
  if (!st) throw new NotFoundError("settlement", id);
  return pdfFor(ctx, st);
}

/** The statement PDF for the driver in the app: only their own, only once approved. */
export async function driverSettlementPdf(tenantId: string, driverId: string, id: string) {
  const ctx = systemCtx(tenantId);
  const [st] = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, tenantId), eq(s.settlements.id, id), eq(s.settlements.driverId, driverId))).limit(1);
  if (!st || !["approved", "paid"].includes(st.state)) return null;
  return pdfFor(ctx, st);
}
