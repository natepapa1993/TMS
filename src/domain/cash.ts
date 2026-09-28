import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";
import { recordReceipt, creditMemo, disputeInvoice } from "./billing";
export { suggest } from "./cash-rules";

/**
 * Cash application: a check or ACH arrives for several invoices at once, often short of one or two, with a
 * remittance advice. Record it once, split it over the invoices it pays, decide what to do with each short
 * pay, and keep what's left on account for the next invoice.
 */

const OPEN = ["issued", "sent", "partially_paid", "disputed"] as const;
const money = (c: number, cur = "USD") => (c / 100).toLocaleString("en-US", { style: "currency", currency: cur });

export type Application = { invoiceId: string; amountCents: number; shortPay?: "leave_open" | "write_off" | "dispute"; reason?: string | null };
export type PaymentInput = { customerId: string; amountCents: number; receivedAt?: Date; method?: string; reference?: string | null; remittance?: string | null; note?: string | null; applications: Application[] };

/** A customer's open invoices (oldest due first) and the money they have on account. */
export async function openItems(ctx: Ctx, customerId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [invs, pays] = await Promise.all([
    db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.customerId, customerId), inArray(s.invoices.state, [...OPEN]))).orderBy(s.invoices.dueAt),
    db.select().from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), eq(s.payments.customerId, customerId), sql`${s.payments.appliedCents} < ${s.payments.amountCents}`)).orderBy(s.payments.receivedAt),
  ]);
  const orderIds = [...new Set(invs.flatMap((i) => i.orderIds))];
  const orders = orderIds.length ? await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber, refs: s.orders.refs }).from(s.orders).where(inArray(s.orders.id, orderIds)) : [];
  return {
    invoices: invs
      .map((i) => ({ id: i.id, number: i.number ?? "", state: i.state, currency: i.currency, dueAt: i.dueAt?.toISOString() ?? null, totalCents: i.totalCents, openCents: i.totalCents - i.creditedCents - i.paidCents, loads: orders.filter((o) => i.orderIds.includes(o.id)).map((o) => ({ orderNumber: o.orderNumber, refs: Object.values(o.refs ?? {}).filter(Boolean) as string[] })) }))
      .filter((i) => i.openCents > 0),
    onAccount: pays.map((p) => ({ id: p.id, receivedAt: p.receivedAt.toISOString(), method: p.method, reference: p.reference, currency: p.currency, amountCents: p.amountCents, unappliedCents: p.amountCents - p.appliedCents })),
  };
}

/** Record a payment and apply it; short pays are left open, written off (a credit memo, owner only) or disputed. */
export async function applyPayment(ctx: Ctx, input: PaymentInput) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("the payment amount", "amountCents");
  const [cust] = await db.select().from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), eq(s.customers.id, input.customerId))).limit(1);
  if (!cust) throw new NotFoundError("customer", input.customerId);
  const apps = input.applications.filter((a) => a.amountCents > 0 || a.shortPay === "write_off" || a.shortPay === "dispute");
  const { invoices } = await openItems(ctx, input.customerId);
  let currency: string | null = null;
  let total = 0;
  for (const a of apps) {
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) throw new ValidationError(`an invoice isn't open for ${cust.name}`, "applications");
    if (!Number.isInteger(a.amountCents) || a.amountCents < 0) throw new ValidationError(`${inv.number}: the amount applied`, "applications");
    if (a.amountCents > inv.openCents) throw new ValidationError(`${inv.number}: ${money(a.amountCents, inv.currency)} is more than the ${money(inv.openCents, inv.currency)} open`, "applications");
    if (currency && currency !== inv.currency) throw new ValidationError("one payment is in one currency: apply USD and MXN invoices separately", "applications");
    currency = inv.currency;
    total += a.amountCents;
    const short = inv.openCents - a.amountCents;
    if (short > 0 && a.shortPay === "write_off") {
      if (!can(ctx, "billing.void")) throw new ValidationError(`${inv.number}: writing off a short pay needs the owner (it's a credit memo) — leave it open or dispute it`, "applications");
      if (!a.reason?.trim()) throw new ValidationError(`${inv.number}: why was it short-paid? (the customer's reason)`, "applications");
    }
    if (short > 0 && a.shortPay === "dispute" && !a.reason?.trim()) throw new ValidationError(`${inv.number}: what's disputed?`, "applications");
  }
  if (total > input.amountCents) throw new ValidationError(`applied ${money(total, currency ?? "USD")} is more than the ${money(input.amountCents, currency ?? "USD")} received`, "applications");
  const receivedAt = input.receivedAt ?? new Date();
  const method = input.method ?? "ach";
  const [pay] = await db.insert(s.payments).values({ id: newId(), tenantId: ctx.tenantId, customerId: cust.id, receivedAt, amountCents: input.amountCents, currency: currency ?? "USD", method, reference: input.reference?.trim() || null, remittance: input.remittance?.trim() || null, note: input.note?.trim() || null, appliedCents: 0, createdBy: ctx.userId }).returning();
  const done: { invoiceId: string; number: string; appliedCents: number; after: string }[] = [];
  let applied = 0;
  for (const a of apps) {
    const inv = invoices.find((i) => i.id === a.invoiceId)!;
    if (a.amountCents > 0) {
      await recordReceipt(ctx, inv.id, { amountCents: a.amountCents, receivedAt, method, reference: pay.reference, note: `payment ${pay.reference ?? pay.id}`, paymentId: pay.id });
      applied += a.amountCents;
      await db.update(s.payments).set({ appliedCents: applied }).where(eq(s.payments.id, pay.id));
    }
    const short = inv.openCents - a.amountCents;
    let after = short > 0 ? `${money(short, inv.currency)} still open` : "paid";
    if (short > 0 && a.shortPay === "write_off") {
      await creditMemo(ctx, inv.id, { amountCents: short, reason: `Short pay: ${a.reason!.trim()}` });
      after = `short pay ${money(short, inv.currency)} written off`;
    } else if (short > 0 && a.shortPay === "dispute") {
      await disputeInvoice(ctx, inv.id, `Short pay ${money(short, inv.currency)}: ${a.reason!.trim()}`);
      after = `short pay ${money(short, inv.currency)} disputed`;
    }
    done.push({ invoiceId: inv.id, number: inv.number, appliedCents: a.amountCents, after });
  }
  await writeAudit(db, ctx, "payment", pay.id, "create", undefined, `${method} ${pay.reference ?? ""} ${money(input.amountCents, pay.currency)}: ${done.map((d) => `${d.number} ${money(d.appliedCents, pay.currency)}`).join(", ")}${input.amountCents - applied ? `; ${money(input.amountCents - applied, pay.currency)} on account` : ""}`.trim());
  return { paymentId: pay.id, applied: done, onAccountCents: input.amountCents - applied };
}

/** Use money on account against an invoice (the next invoice after an overpayment, a deposit). */
export async function applyOnAccount(ctx: Ctx, paymentId: string, invoiceId: string, amountCents: number) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [pay] = await db.select().from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), eq(s.payments.id, paymentId))).limit(1);
  if (!pay) throw new NotFoundError("payment", paymentId);
  const left = pay.amountCents - pay.appliedCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ValidationError("the amount", "amountCents");
  if (amountCents > left) throw new ValidationError(`only ${money(left, pay.currency)} is left on account from this payment`, "amountCents");
  const [inv] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.id, invoiceId))).limit(1);
  if (!inv) throw new NotFoundError("invoice", invoiceId);
  if (inv.customerId !== pay.customerId) throw new ValidationError("that invoice is for another customer");
  if (inv.currency !== pay.currency) throw new ValidationError("the payment and the invoice are in different currencies");
  await recordReceipt(ctx, inv.id, { amountCents, receivedAt: pay.receivedAt, method: pay.method, reference: pay.reference, note: `from money on account (${pay.reference ?? pay.id})`, paymentId: pay.id });
  await db.update(s.payments).set({ appliedCents: pay.appliedCents + amountCents }).where(eq(s.payments.id, pay.id));
  await writeAudit(db, ctx, "payment", pay.id, "update", { appliedCents: { from: pay.appliedCents, to: pay.appliedCents + amountCents } }, `to ${inv.number}`);
  return { unappliedCents: left - amountCents };
}

/** Payments received, newest first, with where each went and what's still on account. */
export async function listPayments(ctx: Ctx, opts: { customerId?: string; limit?: number } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const where = [eq(s.payments.tenantId, ctx.tenantId)];
  if (opts.customerId) where.push(eq(s.payments.customerId, opts.customerId));
  const pays = await db.select().from(s.payments).where(and(...where)).orderBy(desc(s.payments.receivedAt), desc(s.payments.createdAt)).limit(opts.limit ?? 200);
  if (!pays.length) return [];
  const [rcpts, customers] = await Promise.all([
    db.select({ paymentId: s.receipts.paymentId, invoiceId: s.receipts.invoiceId, amountCents: s.receipts.amountCents, number: s.invoices.number }).from(s.receipts).innerJoin(s.invoices, eq(s.invoices.id, s.receipts.invoiceId)).where(inArray(s.receipts.paymentId, pays.map((p) => p.id))),
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
  ]);
  return pays.map((p) => ({ ...p, customer: customers.find((c) => c.id === p.customerId)?.name ?? "?", unappliedCents: p.amountCents - p.appliedCents, applications: rcpts.filter((r) => r.paymentId === p.id).map((r) => ({ invoiceId: r.invoiceId, number: r.number ?? "", amountCents: r.amountCents })) }));
}

/** Money on account by customer (for Receivables). */
export async function onAccountByCustomer(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const rows = await db.select({ customerId: s.payments.customerId, cents: sql<number>`sum(${s.payments.amountCents} - ${s.payments.appliedCents})` }).from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), sql`${s.payments.appliedCents} < ${s.payments.amountCents}`)).groupBy(s.payments.customerId);
  return new Map(rows.map((r) => [r.customerId, Number(r.cents)]));
}
