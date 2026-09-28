import { and, eq, desc, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";
import { recordReceipt } from "./billing";

/**
 * The factoring ledger. A factored invoice is funded (the factor advances most of it and keeps a fee and a
 * reserve), then either collected (the customer paid the factor: the invoice is paid and the reserve comes
 * back) or charged back (unpaid past the recourse days: we repay the advance and the customer owes us again).
 * Receivables leave funded invoices out — the customer owes the factor — and this ledger shows what the factor
 * holds and what could come back.
 */

const DAY = 86400_000;

/** A percentage typed either way: 97 or 9700 both mean 97%. */
export function toBp(v: number | null | undefined, fallback: number) {
  if (v == null || !Number.isFinite(v)) return fallback;
  return v <= 100 ? Math.round(v * 100) : Math.round(v);
}

export function termsOf(e: { factorAdvanceBp: number | null; factorFeeBp: number | null; factorRecourseDays: number | null }) {
  return { advanceBp: toBp(e.factorAdvanceBp, 9700), feeBp: toBp(e.factorFeeBp, 300), recourseDays: e.factorRecourseDays ?? 90 };
}

/** What one funding splits into: advance to us, the fee, the reserve the factor holds until collection. */
export function split(totalCents: number, advanceBp: number, feeBp: number) {
  const advance = Math.round((totalCents * advanceBp) / 10000);
  const fee = Math.round((totalCents * feeBp) / 10000);
  // a flat-fee factor advances the invoice less its fee (reserve 0); others hold a reserve and take the fee from it
  return { advance, fee, reserve: Math.max(0, totalCents - advance - fee) };
}

async function loadInvoices(ctx: Ctx, ids: string[]) {
  const rows = ids.length ? await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.id, ids))) : [];
  if (rows.length !== ids.length) throw new NotFoundError("invoice", ids.join(","));
  return rows;
}

/** The factor funded these invoices (one schedule / one wire): advance and fee on each, at the entity's terms unless told otherwise. */
export async function recordFunding(ctx: Ctx, invoiceIds: string[], input: { at?: Date; reference?: string | null; advanceBp?: number | null; feeBp?: number | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!invoiceIds.length) throw new ValidationError("pick the invoices the factor funded", "invoiceIds");
  const invs = await loadInvoices(ctx, invoiceIds);
  for (const i of invs) {
    if (!i.factored) throw new ValidationError(`${i.number ?? "a draft"} isn't a factored invoice`);
    if (i.factorFundedAt) throw new ValidationError(`${i.number} was already funded`);
    if (!["issued", "sent", "partially_paid", "disputed"].includes(i.state)) throw new ValidationError(`${i.number} is ${i.state}`);
  }
  const entities = await db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), inArray(s.billingEntities.id, [...new Set(invs.map((i) => i.entityId))])));
  const at = input.at ?? new Date();
  let advanced = 0;
  await db.transaction(async (tx) => {
    for (const i of invs) {
      const e = entities.find((x) => x.id === i.entityId)!;
      const t = termsOf(e);
      const advanceBp = input.advanceBp != null ? toBp(input.advanceBp, t.advanceBp) : t.advanceBp;
      const feeBp = input.feeBp != null ? toBp(input.feeBp, t.feeBp) : t.feeBp;
      if (advanceBp + feeBp > 10000) throw new ValidationError("advance and fee are more than the invoice");
      const open = i.totalCents - i.creditedCents - i.paidCents;
      const sp = split(open, advanceBp, feeBp);
      await tx.insert(s.factorEntries).values([
        { id: newId(), tenantId: ctx.tenantId, entityId: e.id, invoiceId: i.id, kind: "advance", amountCents: sp.advance, at, reference: input.reference?.trim() || null, note: `${advanceBp / 100}% of ${(open / 100).toFixed(2)}`, createdBy: ctx.userId },
        { id: newId(), tenantId: ctx.tenantId, entityId: e.id, invoiceId: i.id, kind: "fee", amountCents: -sp.fee, at, reference: input.reference?.trim() || null, note: `${feeBp / 100}%`, createdBy: ctx.userId },
      ]);
      await tx.update(s.invoices).set({ factorFundedAt: at, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, i.id));
      await writeAudit(tx, ctx, "invoice", i.id, "update", { factorFunded: { from: null, to: at.toISOString().slice(0, 10) } }, `${e.factorName ?? "factor"} advanced ${(sp.advance / 100).toFixed(2)}, fee ${(sp.fee / 100).toFixed(2)}`);
      advanced += sp.advance;
    }
  });
  return { invoices: invs.length, advancedCents: advanced };
}

/** The customer paid the factor: the invoice is paid (method factoring) and the reserve comes back to us. */
export async function recordCollection(ctx: Ctx, invoiceId: string, input: { at?: Date; reference?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [inv] = await loadInvoices(ctx, [invoiceId]);
  if (!inv.factorFundedAt) throw new ValidationError(`${inv.number} hasn't been funded by the factor`);
  const entries = await db.select().from(s.factorEntries).where(and(eq(s.factorEntries.tenantId, ctx.tenantId), eq(s.factorEntries.invoiceId, invoiceId)));
  if (entries.some((e) => e.kind === "collected")) throw new ValidationError(`${inv.number} is already collected`);
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const advanced = entries.filter((e) => e.kind === "advance").reduce((a, e) => a + e.amountCents, 0);
  const fees = -entries.filter((e) => e.kind === "fee").reduce((a, e) => a + e.amountCents, 0);
  const reserve = Math.max(0, open - advanced - fees);
  const at = input.at ?? new Date();
  const [e] = await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, inv.entityId)).limit(1);
  if (open > 0) await recordReceipt(ctx, inv.id, { amountCents: open, receivedAt: at, method: "factoring", reference: input.reference ?? null, note: `collected by ${e?.factorName ?? "the factor"}` });
  const rows: (typeof s.factorEntries.$inferInsert)[] = [{ id: newId(), tenantId: ctx.tenantId, entityId: inv.entityId, invoiceId, kind: "collected", amountCents: open, at, reference: input.reference?.trim() || null, note: "the customer paid the factor", createdBy: ctx.userId }];
  if (reserve > 0) rows.push({ id: newId(), tenantId: ctx.tenantId, entityId: inv.entityId, invoiceId, kind: "reserve_release", amountCents: reserve, at, reference: input.reference?.trim() || null, note: "reserve released", createdBy: ctx.userId });
  await db.insert(s.factorEntries).values(rows);
  return { reserveCents: reserve };
}

/** Unpaid past recourse: the factor takes the advance back; the customer owes us again (back in Receivables). */
export async function recordChargeback(ctx: Ctx, invoiceId: string, input: { at?: Date; reference?: string | null; note?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [inv] = await loadInvoices(ctx, [invoiceId]);
  if (!inv.factorFundedAt) throw new ValidationError(`${inv.number} hasn't been funded by the factor`);
  const entries = await db.select().from(s.factorEntries).where(and(eq(s.factorEntries.tenantId, ctx.tenantId), eq(s.factorEntries.invoiceId, invoiceId)));
  if (entries.some((e) => e.kind === "collected")) throw new ValidationError(`${inv.number} was collected; nothing to charge back`);
  const advanced = entries.filter((e) => e.kind === "advance").reduce((a, e) => a + e.amountCents, 0);
  const at = input.at ?? new Date();
  await db.transaction(async (tx) => {
    await tx.insert(s.factorEntries).values({ id: newId(), tenantId: ctx.tenantId, entityId: inv.entityId, invoiceId, kind: "chargeback", amountCents: -advanced, at, reference: input.reference?.trim() || null, note: input.note?.trim() || "charged back: unpaid past recourse", createdBy: ctx.userId });
    await tx.update(s.invoices).set({ factorFundedAt: null, factored: false, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId));
    await writeAudit(tx, ctx, "invoice", invoiceId, "update", { factorFunded: { from: inv.factorFundedAt!.toISOString().slice(0, 10), to: "charged back" } }, input.note ?? undefined);
  });
  return { repaidCents: advanced };
}

export type LedgerRow = { invoiceId: string; number: string; customer: string; entity: string; totalCents: number; currency: string; fundedAt: string | null; advancedCents: number; feeCents: number; reserveCents: number; status: "to_fund" | "funded" | "collected" | "charged_back"; ageDays: number | null; recourseDays: number; atRisk: boolean };

/** Every factored invoice: waiting to be funded, funded (reserve held, exposure), collected, charged back. */
export async function factorLedger(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const entities = await db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), isNotNull(s.billingEntities.factorName)));
  const entries = await db.select().from(s.factorEntries).where(eq(s.factorEntries.tenantId, ctx.tenantId)).orderBy(desc(s.factorEntries.at));
  const ids = [...new Set(entries.map((e) => e.invoiceId))];
  const [factored, touched, customers] = await Promise.all([
    db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.factored, true), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "disputed", "paid"]))),
    ids.length ? db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.id, ids))) : [],
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
  ]);
  const all = new Map([...factored, ...touched].map((i) => [i.id, i]));
  const rows: LedgerRow[] = [];
  for (const inv of all.values()) {
    const mine = entries.filter((e) => e.invoiceId === inv.id);
    const e = entities.find((x) => x.id === inv.entityId);
    const t = e ? termsOf(e) : { recourseDays: 90 };
    const status: LedgerRow["status"] = mine.some((x) => x.kind === "chargeback") ? "charged_back" : mine.some((x) => x.kind === "collected") ? "collected" : inv.factorFundedAt ? "funded" : "to_fund";
    if (status === "to_fund" && inv.state === "paid") continue; // paid to us directly: nothing for the factor
    const advanced = mine.filter((x) => x.kind === "advance").reduce((a, x) => a + x.amountCents, 0);
    const fee = -mine.filter((x) => x.kind === "fee").reduce((a, x) => a + x.amountCents, 0);
    const released = mine.filter((x) => x.kind === "reserve_release").reduce((a, x) => a + x.amountCents, 0);
    const open = inv.totalCents - inv.creditedCents - (status === "funded" ? inv.paidCents : 0);
    const reserve = status === "funded" ? Math.max(0, open - advanced - fee) : 0;
    const ageDays = inv.factorFundedAt ? Math.floor((now.getTime() - inv.factorFundedAt.getTime()) / DAY) : null;
    rows.push({ invoiceId: inv.id, number: inv.number ?? "", customer: customers.find((c) => c.id === inv.customerId)?.name ?? "?", entity: e?.factorName ?? "", totalCents: inv.totalCents - inv.creditedCents, currency: inv.currency, fundedAt: inv.factorFundedAt?.toISOString() ?? null, advancedCents: advanced, feeCents: fee, reserveCents: status === "collected" ? released : reserve, status, ageDays, recourseDays: t.recourseDays, atRisk: status === "funded" && t.recourseDays > 0 && ageDays != null && ageDays >= t.recourseDays - 15 });
  }
  rows.sort((p, q) => ["to_fund", "funded", "charged_back", "collected"].indexOf(p.status) - ["to_fund", "funded", "charged_back", "collected"].indexOf(q.status) || (q.ageDays ?? 0) - (p.ageDays ?? 0));
  const funded = rows.filter((r) => r.status === "funded");
  return {
    rows,
    totals: {
      toFund: rows.filter((r) => r.status === "to_fund").reduce((a, r) => a + r.totalCents, 0),
      exposure: funded.reduce((a, r) => a + r.advancedCents, 0), // could come back as chargebacks
      reserveHeld: funded.reduce((a, r) => a + r.reserveCents, 0),
      feesYtd: -entries.filter((x) => x.kind === "fee" && x.at.getUTCFullYear() === now.getUTCFullYear()).reduce((a, x) => a + x.amountCents, 0),
      atRisk: funded.filter((r) => r.atRisk).length,
    },
    entities: entities.map((e) => ({ id: e.id, name: e.factorName!, ...termsOf(e) })),
  };
}

/** Funded invoices the customer owes the factor (left out of our Receivables). */
export async function fundedInvoiceIds(ctx: Ctx) {
  assertCtx(ctx);
  const rows = await db.select({ id: s.invoices.id }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), isNotNull(s.invoices.factorFundedAt), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "disputed"])));
  return new Set(rows.map((r) => r.id));
}

