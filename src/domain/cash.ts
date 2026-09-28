import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";
import { recordReceipt, creditMemo, disputeInvoice, assertOpenPeriod } from "./billing";
import { money as fxMoney } from "./fx-rules";
import { suggest } from "./cash-rules";
export { suggest };

/**
 * Cash application: a check or ACH arrives for several invoices at once, often short of one or two, with a
 * remittance advice. Record it once, split it over the invoices it pays, decide what to do with each short
 * pay, and keep what's left on account for the next invoice.
 */

const OPEN = ["issued", "sent", "partially_paid", "disputed"] as const;
const money = (c: number, cur = "USD") => fxMoney(c, cur);

export type Application = { invoiceId: string; amountCents: number; shortPay?: "leave_open" | "write_off" | "dispute"; reason?: string | null };
export type PaymentInput = { customerId: string; amountCents: number; /** USD, MXN or CAD: only invoices in this currency take it */ currency?: string; /** MXN / CAD: units per 1 USD the day it arrived ("18.62"); blank = the company rate */ exchangeRate?: number | string | null; receivedAt?: Date; method?: string; reference?: string | null; remittance?: string | null; note?: string | null; applications: Application[] };

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
  // the currency this customer was billed in last: a payment from them most likely came in it
  const [latest] = await db.select({ currency: s.invoices.currency }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.customerId, customerId), sql`${s.invoices.issuedAt} is not null`)).orderBy(desc(s.invoices.issuedAt)).limit(1);
  const { getCompany } = await import("./company");
  const { zonedDate } = await import("@/lib/time");
  const company = await getCompany(ctx);
  const { pickRate } = await import("./fx-rules");
  return {
    latestCurrency: latest?.currency ?? invs[0]?.currency ?? "USD",
    /** today in the company's zone (a payment's received date defaults to it) and the company's rates to start the rate box */
    today: zonedDate(new Date(), company.timeZone),
    rates: { MXN: (pickRate("MXN", null, company.settings.fx).rateE4 / 10000).toFixed(4), CAD: (pickRate("CAD", null, company.settings.fx).rateE4 / 10000).toFixed(4) } as Record<string, string>,
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
  let apps = input.applications.filter((a) => a.amountCents > 0 || a.shortPay === "write_off" || a.shortPay === "dispute");
  const { invoices } = await openItems(ctx, input.customerId);
  // a payment has one currency: the one it arrived in (or, from older callers, the invoices it pays)
  let currency: string | null = input.currency ? input.currency.toUpperCase() : null;
  if (currency && !["USD", "MXN", "CAD"].includes(currency)) throw new ValidationError("the payment's currency: USD, MXN or CAD", "currency");
  // nothing matched by hand but the remittance names open invoices: pay those, not "on account"
  let autoMatched = false;
  if (!apps.length) {
    // only the remittance: a check number that happens to look like a PO must never move money
    const auto = autoMatch(invoices, input.amountCents, input.remittance ?? "", currency ?? undefined);
    if (auto.length) {
      apps = auto;
      autoMatched = true;
    }
  }
  let total = 0;
  for (const a of apps) {
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) throw new ValidationError(`an invoice isn't open for ${cust.name}`, "applications");
    if (!Number.isInteger(a.amountCents) || a.amountCents < 0) throw new ValidationError(`${inv.number}: the amount applied`, "applications");
    if (a.amountCents > inv.openCents) throw new ValidationError(`${inv.number}: ${money(a.amountCents, inv.currency)} is more than the ${money(inv.openCents, inv.currency)} open`, "applications");
    if (currency && currency !== inv.currency) throw new ValidationError(`${inv.number} is a ${inv.currency} invoice and this payment is in ${currency}: a payment only pays invoices in its own currency — record the ${inv.currency} money as its own payment`, "applications");
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
  await assertOpenPeriod(ctx, receivedAt);
  await assertNotFuture(ctx, receivedAt);
  const method = input.method ?? "ach";
  const exchangeRate = await receiptRate(ctx, currency ?? "USD", input.exchangeRate);
  const [pay] = await db.insert(s.payments).values({ id: newId(), tenantId: ctx.tenantId, customerId: cust.id, receivedAt, amountCents: input.amountCents, currency: currency ?? "USD", exchangeRate, method, reference: input.reference?.trim() || null, remittance: input.remittance?.trim() || null, note: input.note?.trim() || null, appliedCents: 0, createdBy: ctx.userId }).returning();
  const done: { invoiceId: string; number: string; appliedCents: number; after: string }[] = [];
  let applied = 0;
  for (const a of apps) {
    const inv = invoices.find((i) => i.id === a.invoiceId)!;
    if (a.amountCents > 0) {
      await recordReceipt(ctx, inv.id, { amountCents: a.amountCents, receivedAt, method, reference: pay.reference, note: `payment ${pay.reference ?? pay.id}`, paymentId: pay.id, exchangeRate });
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
  return { paymentId: pay.id, applied: done, onAccountCents: input.amountCents - applied, autoMatched };
}

/**
 * Pure: when nobody split a payment by hand, what the remittance says to pay. It applies only when the text
 * names open invoices in the payment's currency (invoice number, load number or a load reference) and either
 * names exactly one, or the amount is exactly what the named invoices have open. Otherwise nothing (on account).
 */
export function autoMatch(invoices: { id: string; number: string; openCents: number; currency: string; loads: { orderNumber: string; refs: string[] }[] }[], amountCents: number, text: string, currency?: string): Application[] {
  if (!text.trim()) return [];
  const plan = suggest(invoices, amountCents, text, currency ?? invoices[0]?.currency);
  const named = plan.filter((p) => p.named);
  if (!named.length) return [];
  const open = named.reduce((a, p) => a + p.openCents, 0);
  if (named.length > 1 && open !== amountCents) return [];
  return named.filter((p) => p.applyCents > 0).map((p) => ({ invoiceId: p.invoiceId, amountCents: p.applyCents }));
}

/** A MXN / CAD receipt's rate: what was typed, else the company's latest. USD has none. */
async function receiptRate(ctx: Ctx, currency: string, typed: number | string | null | undefined) {
  if (currency === "USD") return null;
  const { parseRate, pickRate } = await import("./fx-rules");
  if (typed != null && String(typed).trim()) {
    try {
      return typeof typed === "number" && typed > 1000 ? Math.round(typed) : parseRate(typed, currency);
    } catch (e) {
      throw new ValidationError((e as Error).message, "exchangeRate");
    }
  }
  const { getCompany } = await import("./company");
  return pickRate(currency, null, (await getCompany(ctx)).settings.fx).rateE4;
}

/** Money can't be received tomorrow: a date after today in the company's zone is refused. */
export async function assertNotFuture(ctx: Ctx, at: Date, now = new Date()) {
  const { getCompany } = await import("./company");
  const { zonedDate } = await import("@/lib/time");
  const tz = (await getCompany(ctx)).timeZone;
  if (zonedDate(at, tz) > zonedDate(now, tz)) throw new ValidationError(`that date is in the future — money received today is dated ${zonedDate(now, tz)}`, "receivedAt");
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
  if (inv.currency !== pay.currency) throw new ValidationError(`this money on account is ${pay.currency} and ${inv.number} is a ${inv.currency} invoice: it only pays ${pay.currency} invoices`);
  // applied today: money on account from a closed month can still pay a new invoice
  await recordReceipt(ctx, inv.id, { amountCents, receivedAt: new Date(), method: pay.method, reference: pay.reference, note: `from money on account (${pay.reference ?? pay.id})`, paymentId: pay.id, exchangeRate: pay.exchangeRate });
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

/** Money on account by customer and currency (for Receivables): key "customerId|MXN". */
export async function onAccountByCustomer(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const rows = await db.select({ customerId: s.payments.customerId, currency: s.payments.currency, cents: sql<number>`sum(${s.payments.amountCents} - ${s.payments.appliedCents})` }).from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), sql`${s.payments.appliedCents} < ${s.payments.amountCents}`)).groupBy(s.payments.customerId, s.payments.currency);
  return new Map(rows.map((r) => [`${r.customerId}|${r.currency}`, Number(r.cents)]));
}
