import { and, eq, gte, lt, inArray, isNull, desc } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { zonedMidnight, zonedDate } from "@/lib/time";
import { getCompany, type QbAccounts } from "./company";
import { pickRate, toHome, money as fxMoney, HOME_CURRENCY } from "./fx-rules";
import { ValidationError, NotFoundError } from "./orders";
import { CHARGE_LABEL } from "./billing";

/**
 * Accounting export (spec §7.9 "QuickBooks is a later sync, not a dependency"): the ledger stays here;
 * QuickBooks gets files. IIF for QuickBooks Desktop (one file), CSV for QuickBooks Online (one per list).
 * A run is logged with the exact records it carried, so the same file can be downloaded again, and
 * "only new" runs skip anything a previous run already carried.
 *
 * How money goes out (the rules the export page states):
 * - Everything is in US dollars. A MXN or CAD invoice, its payments and credits are converted at the
 *   rate stored on the invoice; a carrier bill in pesos at the company rate. The memo keeps the original
 *   amount and the rate. (QuickBooks files without multicurrency take them as they are.)
 * - One customer payment = one deposit (to Undeposited Funds) with a line per invoice it paid; money left
 *   on account stays as the customer's credit in QuickBooks.
 * - Factoring is a journal entry: funding (advance to the bank, the fee to Factoring fees, the reserve to
 *   Factor reserve, the invoice off Receivables), the reserve released on collection, and a chargeback
 *   (the invoice back on Receivables, the advance and fee repaid). The factor's collection is not a
 *   customer payment here: the funding journal already took the invoice off Receivables.
 * - Driver statements are bills to the driver: earnings to Driver pay, per diem and reimbursements to
 *   Driver reimbursements, advances recovered to Driver advances (an asset), escrow to Driver escrow (a
 *   liability), other deductions to Driver deductions. A statement never has a negative total.
 * - The IIF starts with the accounts (!ACCNT) and items (!INVITEM) it uses, so a fresh company file takes it.
 */

export type ExportFormat = "iif" | "qbo";

type Money = { amountCents: number; memo: string };
export type ExportData = {
  qb: QbAccounts;
  timeZone: string;
  invoices: { id: string; number: string; issuedAt: Date; dueAt: Date; termsDays: number; customer: string; currency: string; totalCents: number; memo: string; lines: { description: string; kind: string; qty: number; unit: string; rateCents: number; amountCents: number }[] }[];
  /** one deposit per payment received, with the invoices it paid (amounts in USD) */
  payments: { id: string; receivedAt: Date; customer: string; amountCents: number; method: string; reference: string | null; memo: string; applications: { invoiceNumber: string; amountCents: number }[]; onAccountCents: number }[];
  credits: { id: string; number: string; issuedAt: Date; customer: string; invoiceNumber: string; amountCents: number; reason: string; currency: string }[];
  bills: { id: string; kind: "carrier" | "driver"; vendor: string; date: Date; dueAt: Date | null; number: string; memo: string; currency: string; lines: { account: string; description: string; amountCents: number }[]; paidAt: Date | null; paidCents: number | null; paidRef: string | null }[];
  /** factoring as journal entries: debits positive, credits negative, each entry balances */
  journals: { id: string; date: Date; number: string; memo: string; lines: { account: string; name: string | null; amountCents: number; memo: string }[] }[];
};
void (null as unknown as Money);

const dollars = (c: number) => (c / 100).toFixed(2);
const mdy = (d: Date, tz: string) => {
  const [y, m, day] = zonedDate(d, tz).split("-");
  return `${m}/${day}/${y}`;
};
const iso = (d: Date, tz: string) => zonedDate(d, tz);

/** Quantity and unit price as QuickBooks wants them: hours in decimals, miles/stops as counted, flat and percent lines as 1 × amount. */
const qtyPrice = (l: { qty: number; unit: string; rateCents: number; amountCents: number }) => (l.unit === "h" ? { qty: l.qty / 100, price: l.rateCents } : l.unit === "mi" || l.unit === "stop" ? { qty: l.qty, price: l.rateCents } : { qty: 1, price: l.amountCents });

const incomeFor = (qb: QbAccounts, kind: string) => (kind === "linehaul" ? qb.incomeAccount : kind === "fuel" ? qb.fuelIncomeAccount : qb.accessorialIncomeAccount);

/** Where a driver statement line posts. */
export function settlementAccount(qb: QbAccounts, l: { kind: string; amountCents: number; source: string }) {
  if (l.kind === "reimbursement") return qb.reimbursementAccount;
  if (l.amountCents >= 0) return qb.driverPayAccount;
  if (l.source === "advance") return qb.advanceAccount;
  if (l.source === "escrow") return qb.escrowAccount;
  return qb.deductionAccount;
}

// ---------- collect ----------

type Ids = { invoices: string[]; receipts: string[]; bills: string[]; settlements: string[]; credits?: string[]; payments?: string[]; factor?: string[] };

async function collect(ctx: Ctx, opts: { from: string; to: string; onlyNew: boolean; ids?: Ids }): Promise<ExportData & { ids: Ids }> {
  const company = await getCompany(ctx);
  const tz = company.timeZone;
  const fx = company.settings.fx;
  const qb = company.settings.qb;
  const from = zonedMidnight(opts.from, tz);
  const toExclusive = new Date(zonedMidnight(opts.to, tz).getTime() + 86400_000);
  const inWindow = (col: PgColumn) => and(gte(col, from), lt(col, toExclusive));
  const pick = <T,>(ids: string[] | undefined, q: () => Promise<T[]>, byIds: (ids: string[]) => Promise<T[]>) => (opts.ids ? (ids?.length ? byIds(ids) : Promise.resolve([] as T[])) : q());

  const [customers, carriers, drivers] = await Promise.all([
    db.select({ id: s.customers.id, name: s.customers.name, qbName: s.customers.qbName }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name, qbName: s.carriers.qbName }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
    db.select({ id: s.drivers.id, name: s.drivers.name, qbName: s.drivers.qbName }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
  ]);
  const cname = (id: string) => customers.find((c) => c.id === id)?.qbName?.trim() || customers.find((c) => c.id === id)?.name || "Customer";
  const vname = (id: string) => carriers.find((c) => c.id === id)?.qbName?.trim() || carriers.find((c) => c.id === id)?.name || "Carrier";
  const dname = (id: string) => drivers.find((c) => c.id === id)?.qbName?.trim() || drivers.find((c) => c.id === id)?.name || "Driver";
  // an invoice's money in USD at its own rate; the memo keeps the original
  const invUsd = (cents: number, inv: { currency: string; exchangeRate: number | null }) => toHome(cents, inv.currency, pickRate(inv.currency, inv.exchangeRate, fx).rateE4);
  const origNote = (cents: number, inv: { currency: string; exchangeRate: number | null }) => (inv.currency === HOME_CURRENCY ? "" : ` (${fxMoney(cents, inv.currency, { code: true })} at ${(pickRate(inv.currency, inv.exchangeRate, fx).rateE4 / 10000).toFixed(4)})`);

  const invRows = await pick(opts.ids?.invoices, () => db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "paid", "closed", "disputed"]), inWindow(s.invoices.issuedAt), ...(opts.onlyNew ? [isNull(s.invoices.exportedAt)] : []))), (ids) => db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.id, ids))));
  const invoices: ExportData["invoices"] = invRows
    .filter((i) => i.snapshot && i.number && i.issuedAt && i.dueAt)
    .map((i) => {
      const lines = i.snapshot!.lines.map((l) => ({ description: l.description, kind: l.kind, qty: l.qty, unit: l.unit, rateCents: invUsd(l.rateCents, i), amountCents: invUsd(l.amountCents, i) }));
      // conversion can leave a cent of rounding: the invoice total is the sum of its converted lines
      return { id: i.id, number: i.number!, issuedAt: i.issuedAt!, dueAt: i.dueAt!, termsDays: i.termsDays, customer: cname(i.customerId), currency: HOME_CURRENCY, totalCents: lines.reduce((a, l) => a + l.amountCents, 0), memo: i.snapshot!.lines.map((l) => l.orderNumber).filter((v, idx, a) => a.indexOf(v) === idx).join(", ") + origNote(i.totalCents, i), lines };
    });

  // payments: one deposit per payment (a check that paid four invoices is one deposit with four lines)
  const payRows = await pick(opts.ids?.payments, () => db.select().from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), inWindow(s.payments.receivedAt), ...(opts.onlyNew ? [isNull(s.payments.exportedAt)] : []))), (ids) => db.select().from(s.payments).where(and(eq(s.payments.tenantId, ctx.tenantId), inArray(s.payments.id, ids))));
  const payRcpts = payRows.length ? await db.select().from(s.receipts).where(inArray(s.receipts.paymentId, payRows.map((p) => p.id))) : [];
  // single receipts recorded on an invoice (not through a payment), and never the factor's collection of a funded invoice
  const rcRowsAll = await pick(opts.ids?.receipts, () => db.select().from(s.receipts).where(and(eq(s.receipts.tenantId, ctx.tenantId), isNull(s.receipts.paymentId), inWindow(s.receipts.receivedAt), ...(opts.onlyNew ? [isNull(s.receipts.exportedAt)] : []))), (ids) => db.select().from(s.receipts).where(and(eq(s.receipts.tenantId, ctx.tenantId), inArray(s.receipts.id, ids))));
  const funded = rcRowsAll.length ? await db.select({ invoiceId: s.factorEntries.invoiceId }).from(s.factorEntries).where(and(eq(s.factorEntries.tenantId, ctx.tenantId), eq(s.factorEntries.kind, "advance"), inArray(s.factorEntries.invoiceId, rcRowsAll.map((r) => r.invoiceId)))) : [];
  const fundedIds = new Set(funded.map((x) => x.invoiceId));
  const rcRows = rcRowsAll.filter((r) => !r.paymentId);
  const touchedInv = [...new Set([...payRcpts.map((r) => r.invoiceId), ...rcRows.map((r) => r.invoiceId)])];
  const rcInv = touchedInv.length ? await db.select({ id: s.invoices.id, number: s.invoices.number, customerId: s.invoices.customerId, currency: s.invoices.currency, exchangeRate: s.invoices.exchangeRate }).from(s.invoices).where(inArray(s.invoices.id, touchedInv)) : [];
  const payments: ExportData["payments"] = [
    ...payRows.map((p) => {
      const apps = payRcpts.filter((r) => r.paymentId === p.id && !/^from money on account/.test(r.note ?? "") && r.receivedAt.getTime() === p.receivedAt.getTime());
      const applied = apps.map((r) => {
        const inv = rcInv.find((i) => i.id === r.invoiceId);
        return { invoiceNumber: inv?.number ?? "", amountCents: inv ? invUsd(r.amountCents, inv) : r.amountCents, orig: r.amountCents };
      });
      const onAcctOrig = p.amountCents - apps.reduce((a, r) => a + r.amountCents, 0);
      const onAccount = toHome(onAcctOrig, p.currency, pickRate(p.currency, null, fx).rateE4);
      const total = applied.reduce((a, x) => a + x.amountCents, 0) + onAccount;
      return { id: p.id, receivedAt: p.receivedAt, customer: cname(p.customerId), amountCents: total, method: p.method, reference: p.reference, memo: `${p.method}${p.reference ? ` ${p.reference}` : ""}${p.currency !== HOME_CURRENCY ? ` · ${fxMoney(p.amountCents, p.currency, { code: true })} converted at each invoice's rate` : ""}${onAccount ? ` · ${dollars(onAccount)} on account` : ""}`, applications: applied.map(({ invoiceNumber, amountCents }) => ({ invoiceNumber, amountCents })), onAccountCents: onAccount };
    }),
    ...rcRows
      .filter((r) => !(r.method === "factoring" && fundedIds.has(r.invoiceId)))
      .map((r) => {
        const inv = rcInv.find((i) => i.id === r.invoiceId);
        const usd = inv ? invUsd(r.amountCents, inv) : r.amountCents;
        return { id: r.id, receivedAt: r.receivedAt, customer: inv ? cname(inv.customerId) : "Customer", amountCents: usd, method: r.method, reference: r.reference, memo: `${r.method} for ${inv?.number ?? ""}${inv ? origNote(r.amountCents, inv) : ""}`, applications: [{ invoiceNumber: inv?.number ?? "", amountCents: usd }], onAccountCents: 0 };
      }),
  ];

  // credit memos reduce what the customer owes: they go to QuickBooks as credit memos against the invoice
  const cmRows = await pick(opts.ids?.credits, () => db.select().from(s.creditMemos).where(and(eq(s.creditMemos.tenantId, ctx.tenantId), inWindow(s.creditMemos.issuedAt), ...(opts.onlyNew ? [isNull(s.creditMemos.exportedAt)] : []))), (ids) => db.select().from(s.creditMemos).where(and(eq(s.creditMemos.tenantId, ctx.tenantId), inArray(s.creditMemos.id, ids))));
  const cmInv = cmRows.length ? await db.select({ id: s.invoices.id, number: s.invoices.number, customerId: s.invoices.customerId, currency: s.invoices.currency, exchangeRate: s.invoices.exchangeRate }).from(s.invoices).where(inArray(s.invoices.id, cmRows.map((r) => r.invoiceId))) : [];
  const credits: ExportData["credits"] = cmRows.map((c) => {
    const inv = cmInv.find((i) => i.id === c.invoiceId);
    return { id: c.id, number: c.number, issuedAt: c.issuedAt, customer: inv ? cname(inv.customerId) : "Customer", invoiceNumber: inv?.number ?? "", amountCents: inv ? invUsd(c.amountCents, inv) : c.amountCents, reason: `${c.reason}${inv ? origNote(c.amountCents, inv) : ""}`, currency: HOME_CURRENCY };
  });

  const cbRows = await pick(opts.ids?.bills, () => db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ctx.tenantId), inArray(s.carrierBills.state, ["approved", "scheduled", "paid"]), inWindow(s.carrierBills.approvedAt), ...(opts.onlyNew ? [isNull(s.carrierBills.exportedAt)] : []))), (ids) => db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ctx.tenantId), inArray(s.carrierBills.id, ids))));
  const cbOrders = cbRows.length ? await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(inArray(s.orders.id, cbRows.map((b) => b.orderId))) : [];
  const stRows = await pick(opts.ids?.settlements, () => db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.state, ["approved", "paid"]), inWindow(s.settlements.approvedAt), ...(opts.onlyNew ? [isNull(s.settlements.exportedAt)] : []))), (ids) => db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.id, ids))));
  const billUsd = (c: number, cur: string) => toHome(c, cur, pickRate(cur, null, fx).rateE4);
  const bills: ExportData["bills"] = [
    ...cbRows.map((b) => {
      const on = cbOrders.find((o) => o.id === b.orderId)?.orderNumber ?? "";
      const amount = b.paidCents ?? b.approvedCents ?? b.invoicedCents ?? b.expectedCents;
      const conv = b.currency !== HOME_CURRENCY ? ` (${fxMoney(amount, b.currency, { code: true })} at ${(pickRate(b.currency, null, fx).rateE4 / 10000).toFixed(4)})` : "";
      return { id: b.id, kind: "carrier" as const, vendor: vname(b.carrierId), date: b.approvedAt ?? b.receivedAt ?? b.createdAt, dueAt: b.payDate, number: b.carrierInvoiceNumber || `CB-${on}`, memo: `${on}${conv}`, currency: HOME_CURRENCY, lines: [{ account: qb.carrierExpenseAccount, description: `${on} carrier freight${b.shortPayNote ? ` (short-paid: ${b.shortPayNote})` : ""}`, amountCents: billUsd(amount, b.currency) }], paidAt: b.paidAt, paidCents: b.paidCents != null ? billUsd(b.paidCents, b.currency) : null, paidRef: b.reference };
    }),
    ...stRows
      .map((st) => ({
        id: st.id,
        kind: "driver" as const,
        vendor: dname(st.driverId),
        date: st.approvedAt ?? st.reviewedAt ?? st.createdAt,
        dueAt: null,
        number: `PAY-${iso(st.periodStart, tz)}`,
        memo: `week of ${iso(st.periodStart, tz)}`,
        currency: st.currency,
        lines: st.lines.filter((l) => l.amountCents !== 0).map((l) => ({ account: settlementAccount(qb, l), description: l.description, amountCents: l.amountCents })),
        paidAt: st.paidAt,
        paidCents: st.state === "paid" && st.netCents > 0 ? st.netCents : null,
        paidRef: st.reference,
      }))
      // never a negative bill: a statement's total is its net pay, and net pay is never below $0
      .filter((b) => b.lines.length && b.lines.reduce((a, l) => a + l.amountCents, 0) >= 0),
  ];

  // factoring journal entries: funding, reserve released, chargeback
  const feRows = await pick(opts.ids?.factor, () => db.select().from(s.factorEntries).where(and(eq(s.factorEntries.tenantId, ctx.tenantId), inArray(s.factorEntries.kind, ["advance", "fee", "reserve_release", "chargeback"]), inWindow(s.factorEntries.at), ...(opts.onlyNew ? [isNull(s.factorEntries.exportedAt)] : []))), (ids) => db.select().from(s.factorEntries).where(and(eq(s.factorEntries.tenantId, ctx.tenantId), inArray(s.factorEntries.id, ids))));
  const feInvIds = [...new Set(feRows.map((e) => e.invoiceId))];
  const [feInv, feAll, feRc, entities] = feInvIds.length
    ? await Promise.all([
        db.select().from(s.invoices).where(inArray(s.invoices.id, feInvIds)),
        db.select().from(s.factorEntries).where(inArray(s.factorEntries.invoiceId, feInvIds)),
        db.select().from(s.receipts).where(inArray(s.receipts.invoiceId, feInvIds)),
        db.select({ id: s.billingEntities.id, factorName: s.billingEntities.factorName }).from(s.billingEntities).where(eq(s.billingEntities.tenantId, ctx.tenantId)),
      ])
    : [[], [], [], []];
  const journals: ExportData["journals"] = [];
  for (const e of feRows) {
    const inv = feInv.find((i) => i.id === e.invoiceId);
    if (!inv) continue;
    const factor = entities.find((x) => x.id === e.entityId)?.factorName ?? "the factor";
    const mine = feAll.filter((x) => x.invoiceId === inv.id);
    const adv = mine.filter((x) => x.kind === "advance").reduce((a, x) => a + x.amountCents, 0);
    const fee = -mine.filter((x) => x.kind === "fee").reduce((a, x) => a + x.amountCents, 0);
    const fundedAt = mine.find((x) => x.kind === "advance")?.at ?? e.at;
    // what the factor bought: the invoice as it stood when funded (less what was paid or credited before)
    const paidBefore = feRc.filter((r) => r.invoiceId === inv.id && r.receivedAt < fundedAt && r.method !== "factoring").reduce((a, r) => a + r.amountCents, 0);
    const open = inv.totalCents - inv.creditedCents - paidBefore;
    const u = (c: number) => invUsd(c, inv);
    const cust = cname(inv.customerId);
    const tag = `${inv.number}${origNote(open, inv)}`;
    if (e.kind === "advance") {
      journals.push({ id: e.id, date: e.at, number: `FACT-${inv.number}`, memo: `${factor} funded ${tag}`, lines: [
        { account: qb.bankAccount, name: null, amountCents: u(adv), memo: `advance on ${inv.number}` },
        { account: qb.factoringFeeAccount, name: null, amountCents: u(fee), memo: `${factor} fee on ${inv.number}` },
        { account: qb.factorReserveAccount, name: null, amountCents: u(open) - u(adv) - u(fee), memo: `reserve held on ${inv.number}` },
        { account: qb.arAccount, name: cust, amountCents: -u(open), memo: `${inv.number} sold to ${factor}` },
      ].filter((l) => l.amountCents !== 0) });
    } else if (e.kind === "reserve_release") {
      journals.push({ id: e.id, date: e.at, number: `FACT-${inv.number}-R`, memo: `${factor} released the reserve on ${tag}`, lines: [
        { account: qb.bankAccount, name: null, amountCents: u(e.amountCents), memo: `reserve released on ${inv.number}` },
        { account: qb.factorReserveAccount, name: null, amountCents: -u(e.amountCents), memo: `reserve released on ${inv.number}` },
      ] });
    } else if (e.kind === "chargeback") {
      const repaid = -e.amountCents;
      journals.push({ id: e.id, date: e.at, number: `FACT-${inv.number}-CB`, memo: `${factor} charged back ${tag}`, lines: [
        { account: qb.arAccount, name: cust, amountCents: u(open), memo: `${inv.number} back on Receivables` },
        { account: qb.bankAccount, name: null, amountCents: -u(repaid), memo: `advance and fee repaid to ${factor}` },
        { account: qb.factorReserveAccount, name: null, amountCents: -(u(open) - u(repaid)), memo: `reserve on ${inv.number} no longer held` },
      ].filter((l) => l.amountCents !== 0) });
    }
  }
  return {
    qb,
    timeZone: tz,
    invoices,
    payments,
    credits,
    bills,
    journals,
    ids: { invoices: invoices.map((i) => i.id), receipts: rcRows.map((r) => r.id), bills: cbRows.map((b) => b.id), settlements: stRows.map((x) => x.id), credits: credits.map((c) => c.id), payments: payRows.map((p) => p.id), factor: feRows.map((e) => e.id) },
  };
}

// ---------- IIF (QuickBooks Desktop) ----------

const tsv = (cells: (string | number)[]) => cells.map((c) => String(c).replace(/[\t\r\n]+/g, " ")).join("\t");

/** The accounts an export posts to, with their QuickBooks type (so a fresh company file takes the IIF). */
export function accountsUsed(d: ExportData): [string, string][] {
  const q = d.qb;
  const type: [string, string][] = [
    [q.arAccount, "AR"],
    [q.apAccount, "AP"],
    [q.bankAccount, "BANK"],
    [q.depositAccount, "OCASSET"],
    [q.incomeAccount, "INC"],
    [q.fuelIncomeAccount, "INC"],
    [q.accessorialIncomeAccount, "INC"],
    [q.carrierExpenseAccount, "COGS"],
    [q.driverPayAccount, "EXP"],
    [q.reimbursementAccount, "EXP"],
    [q.deductionAccount, "EXP"],
    [q.advanceAccount, "OCASSET"],
    [q.escrowAccount, "OCLIAB"],
    [q.factorReserveAccount, "OCASSET"],
    [q.factoringFeeAccount, "EXP"],
  ];
  const used = new Set<string>([
    ...(d.invoices.length || d.payments.length || d.credits.length || d.journals.length ? [q.arAccount] : []),
    ...(d.bills.length ? [q.apAccount] : []),
    ...d.invoices.flatMap((i) => i.lines.map((l) => incomeFor(q, l.kind))),
    ...(d.credits.length ? [q.incomeAccount] : []),
    ...(d.payments.length ? [q.depositAccount] : []),
    ...(d.bills.some((b) => b.paidAt) ? [q.bankAccount] : []),
    ...d.bills.flatMap((b) => b.lines.map((l) => l.account)),
    ...d.journals.flatMap((j) => j.lines.map((l) => l.account)),
  ]);
  const seen = new Set<string>();
  return type.filter(([name]) => used.has(name) && !seen.has(name) && seen.add(name));
}

export function buildIif(d: ExportData): string {
  const tz = d.timeZone;
  const out: string[] = [];
  const accounts = accountsUsed(d);
  if (accounts.length) out.push(tsv(["!ACCNT", "NAME", "ACCNTTYPE"]), ...accounts.map(([n, t]) => tsv(["ACCNT", n, t])));
  const items = [...new Set([...d.invoices.flatMap((i) => i.lines.map((l) => l.kind)), ...(d.credits.length ? ["__credit"] : [])])];
  if (items.length) out.push(tsv(["!INVITEM", "NAME", "INVITEMTYPE", "ACCNT"]), ...items.map((k) => (k === "__credit" ? tsv(["INVITEM", "Credit", "SERV", d.qb.incomeAccount]) : tsv(["INVITEM", CHARGE_LABEL[k as keyof typeof CHARGE_LABEL] ?? k, "SERV", incomeFor(d.qb, k)]))));
  const customers = [...new Set(d.invoices.map((i) => i.customer).concat(d.payments.map((r) => r.customer), d.credits.map((c) => c.customer), d.journals.flatMap((j) => j.lines.map((l) => l.name).filter((n): n is string => !!n))))];
  const vendors = [...new Set(d.bills.map((b) => b.vendor))];
  if (customers.length) out.push(tsv(["!CUST", "NAME"]), ...customers.map((c) => tsv(["CUST", c])));
  if (vendors.length) out.push(tsv(["!VEND", "NAME"]), ...vendors.map((v) => tsv(["VEND", v])));
  out.push(tsv(["!TRNS", "TRNSID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "CLASS", "AMOUNT", "DOCNUM", "MEMO", "TOPRINT", "TERMS", "DUEDATE"]));
  out.push(tsv(["!SPL", "SPLID", "TRNSTYPE", "DATE", "ACCNT", "NAME", "CLASS", "AMOUNT", "DOCNUM", "MEMO", "QNTY", "PRICE", "INVITEM"]));
  out.push("!ENDTRNS");
  for (const i of d.invoices) {
    const date = mdy(i.issuedAt, tz);
    out.push(tsv(["TRNS", "", "INVOICE", date, d.qb.arAccount, i.customer, "", dollars(i.totalCents), i.number, i.memo, "N", `Net ${i.termsDays}`, mdy(i.dueAt, tz)]));
    for (const l of i.lines) {
      const { qty, price } = qtyPrice(l);
      out.push(tsv(["SPL", "", "INVOICE", date, incomeFor(d.qb, l.kind), i.customer, "", dollars(-l.amountCents), i.number, l.description, -qty, dollars(price), CHARGE_LABEL[l.kind as keyof typeof CHARGE_LABEL] ?? l.kind]));
    }
    out.push("ENDTRNS");
  }
  // one deposit per payment, with a line per invoice it paid (and what stayed on account)
  for (const p of d.payments) {
    const date = mdy(p.receivedAt, tz);
    out.push(tsv(["TRNS", "", "PAYMENT", date, d.qb.depositAccount, p.customer, "", dollars(p.amountCents), p.reference ?? "", p.memo, "N", "", ""]));
    for (const a of p.applications) out.push(tsv(["SPL", "", "PAYMENT", date, d.qb.arAccount, p.customer, "", dollars(-a.amountCents), a.invoiceNumber, `applied to ${a.invoiceNumber}`, "", "", ""]));
    if (p.onAccountCents) out.push(tsv(["SPL", "", "PAYMENT", date, d.qb.arAccount, p.customer, "", dollars(-p.onAccountCents), "", "on account (unapplied)", "", "", ""]));
    out.push("ENDTRNS");
  }
  for (const c of d.credits) {
    const date = mdy(c.issuedAt, tz);
    out.push(tsv(["TRNS", "", "CREDIT MEMO", date, d.qb.arAccount, c.customer, "", dollars(-c.amountCents), c.number, `credit on ${c.invoiceNumber}: ${c.reason}`, "N", "", ""]));
    out.push(tsv(["SPL", "", "CREDIT MEMO", date, d.qb.incomeAccount, c.customer, "", dollars(c.amountCents), c.number, c.reason, "", "", "Credit"]));
    out.push("ENDTRNS");
  }
  for (const b of d.bills) {
    const date = mdy(b.date, tz);
    const total = b.lines.reduce((a, l) => a + l.amountCents, 0);
    out.push(tsv(["TRNS", "", "BILL", date, d.qb.apAccount, b.vendor, "", dollars(-total), b.number, b.memo, "N", "", b.dueAt ? mdy(b.dueAt, tz) : ""]));
    for (const l of b.lines) out.push(tsv(["SPL", "", "BILL", date, l.account, b.vendor, "", dollars(l.amountCents), b.number, l.description, "", "", ""]));
    out.push("ENDTRNS");
    if (b.paidAt && b.paidCents != null && b.paidCents > 0) {
      const pd = mdy(b.paidAt, tz);
      out.push(tsv(["TRNS", "", "BILLPMT", pd, d.qb.bankAccount, b.vendor, "", dollars(-b.paidCents), b.paidRef ?? "", `pays ${b.number}`, "N", "", ""]));
      out.push(tsv(["SPL", "", "BILLPMT", pd, d.qb.apAccount, b.vendor, "", dollars(b.paidCents), b.number, "", "", "", ""]));
      out.push("ENDTRNS");
    }
  }
  for (const j of d.journals) {
    const date = mdy(j.date, tz);
    const [first, ...rest] = j.lines;
    out.push(tsv(["TRNS", "", "GENERAL JOURNAL", date, first.account, first.name ?? "", "", dollars(first.amountCents), j.number, `${j.memo} — ${first.memo}`, "N", "", ""]));
    for (const l of rest) out.push(tsv(["SPL", "", "GENERAL JOURNAL", date, l.account, l.name ?? "", "", dollars(l.amountCents), j.number, l.memo, "", "", ""]));
    out.push("ENDTRNS");
  }
  return out.join("\r\n") + "\r\n";
}

// ---------- CSV (QuickBooks Online imports) ----------

const csvCell = (v: string | number) => {
  const str = String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function buildQboCsv(d: ExportData): { invoices: string; bills: string; payments: string; credits: string; journal: string } {
  const tz = d.timeZone;
  const inv: (string | number)[][] = [["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Currency"]];
  for (const i of d.invoices)
    for (const l of i.lines) {
      const { qty, price } = qtyPrice(l);
      inv.push([i.number, i.customer, mdy(i.issuedAt, tz), mdy(i.dueAt, tz), `Net ${i.termsDays}`, i.memo, CHARGE_LABEL[l.kind as keyof typeof CHARGE_LABEL] ?? l.kind, l.description, qty, dollars(price), dollars(l.amountCents), i.currency]);
    }
  const bills: (string | number)[][] = [["BillNo", "Supplier", "BillDate", "DueDate", "Terms", "Memo", "Account", "LineDescription", "LineAmount", "Currency", "PaidDate", "PaidAmount", "PaymentRef"]];
  for (const b of d.bills) for (const l of b.lines) bills.push([b.number, b.vendor, mdy(b.date, tz), b.dueAt ? mdy(b.dueAt, tz) : "", "", b.memo, l.account, l.description, dollars(l.amountCents), b.currency, b.paidAt ? mdy(b.paidAt, tz) : "", b.paidCents != null ? dollars(b.paidCents) : "", b.paidRef ?? ""]);
  // one row per invoice a payment paid; rows with the same ReferenceNo are one deposit
  const pay: (string | number)[][] = [["PaymentDate", "Customer", "InvoiceNo", "Amount", "PaymentMethod", "ReferenceNo", "DepositTo", "PaymentTotal"]];
  for (const p of d.payments) {
    for (const a of p.applications) pay.push([mdy(p.receivedAt, tz), p.customer, a.invoiceNumber, dollars(a.amountCents), p.method, p.reference ?? "", d.qb.depositAccount, dollars(p.amountCents)]);
    if (p.onAccountCents) pay.push([mdy(p.receivedAt, tz), p.customer, "", dollars(p.onAccountCents), p.method, p.reference ?? "", d.qb.depositAccount, dollars(p.amountCents)]);
  }
  const cm: (string | number)[][] = [["CreditMemoNo", "Customer", "CreditMemoDate", "AppliesToInvoice", "Item(Product/Service)", "ItemDescription", "ItemAmount", "Currency"]];
  for (const c of d.credits) cm.push([c.number, c.customer, mdy(c.issuedAt, tz), c.invoiceNumber, "Credit", c.reason, dollars(c.amountCents), c.currency]);
  const jr: (string | number)[][] = [["JournalNo", "JournalDate", "AccountName", "Debits", "Credits", "Description", "Name", "Currency"]];
  for (const j of d.journals) for (const l of j.lines) jr.push([j.number, mdy(j.date, tz), l.account, l.amountCents > 0 ? dollars(l.amountCents) : "", l.amountCents < 0 ? dollars(-l.amountCents) : "", `${j.memo} — ${l.memo}`, l.name ?? "", HOME_CURRENCY]);
  return { invoices: csv(inv), bills: csv(bills), payments: csv(pay), credits: csv(cm), journal: csv(jr) };
}

// ---------- runs ----------

export async function previewExport(ctx: Ctx, opts: { from: string; to: string; onlyNew: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  validatePeriod(opts);
  const d = await collect(ctx, opts);
  const sum = (kind: "carrier" | "driver") => d.bills.filter((b) => b.kind === kind).reduce((a, b) => a + b.lines.reduce((x, l) => x + l.amountCents, 0), 0);
  return { invoices: d.invoices.length, receipts: d.payments.length, credits: d.credits.length, creditedCents: d.credits.reduce((a, c) => a + c.amountCents, 0), carrierBills: d.ids.bills.length, settlements: d.bills.filter((b) => b.kind === "driver").length, invoicedCents: d.invoices.reduce((a, i) => a + i.totalCents, 0), receivedCents: d.payments.reduce((a, r) => a + r.amountCents, 0), billsCents: sum("carrier") + sum("driver"), carrierBillsCents: sum("carrier"), settlementsCents: sum("driver"), factorEntries: d.journals.length };
}

function validatePeriod(opts: { from: string; to: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to)) throw new ValidationError("pick a from and to date");
  if (opts.from > opts.to) throw new ValidationError("from is after to", "from");
}

/** Create a run: log it with the exact records, stamp them as exported. Files come from `exportFiles`. */
export async function createExport(ctx: Ctx, opts: { format: ExportFormat; from: string; to: string; onlyNew: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  validatePeriod(opts);
  const d = await collect(ctx, opts);
  const total = d.invoices.length + d.payments.length + d.bills.length + d.credits.length + d.journals.length + d.ids.receipts.length + (d.ids.payments?.length ?? 0) + (d.ids.factor?.length ?? 0);
  if (!total) throw new ValidationError(opts.onlyNew ? "nothing new in that period — untick “only new” to export it again" : "nothing in that period");
  const id = newId();
  const now = new Date();
  const fileName = `crossline-${opts.format}-${opts.from}-to-${opts.to}`;
  await db.transaction(async (tx) => {
    await tx.insert(s.accountingExports).values({ id, tenantId: ctx.tenantId, format: opts.format, fromDate: opts.from, toDate: opts.to, onlyNew: opts.onlyNew, counts: { invoices: d.invoices.length, receipts: d.payments.length, carrierBills: d.ids.bills.length, settlements: d.ids.settlements.length, credits: d.credits.length, factor: d.journals.length }, recordIds: d.ids, fileName, createdBy: ctx.userId });
    if (d.ids.invoices.length) await tx.update(s.invoices).set({ exportedAt: now }).where(inArray(s.invoices.id, d.ids.invoices));
    if (d.ids.receipts.length) await tx.update(s.receipts).set({ exportedAt: now }).where(inArray(s.receipts.id, d.ids.receipts));
    if (d.ids.credits?.length) await tx.update(s.creditMemos).set({ exportedAt: now }).where(inArray(s.creditMemos.id, d.ids.credits));
    if (d.ids.payments?.length) {
      await tx.update(s.payments).set({ exportedAt: now }).where(inArray(s.payments.id, d.ids.payments));
      // the receipts a payment carried went out with it
      await tx.update(s.receipts).set({ exportedAt: now }).where(inArray(s.receipts.paymentId, d.ids.payments));
    }
    if (d.ids.factor?.length) await tx.update(s.factorEntries).set({ exportedAt: now }).where(inArray(s.factorEntries.id, d.ids.factor));
    if (d.ids.bills.length) await tx.update(s.carrierBills).set({ exportedAt: now }).where(inArray(s.carrierBills.id, d.ids.bills));
    if (d.ids.settlements.length) await tx.update(s.settlements).set({ exportedAt: now }).where(inArray(s.settlements.id, d.ids.settlements));
    await writeAudit(tx, ctx, "accounting_export", id, "create", { format: { from: null, to: opts.format }, period: { from: null, to: `${opts.from}..${opts.to}` }, records: { from: null, to: total } });
  });
  return { id, fileName, counts: { invoices: d.invoices.length, receipts: d.payments.length, carrierBills: d.ids.bills.length, settlements: d.ids.settlements.length } };
}

export async function exportFiles(ctx: Ctx, runId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [run] = await db.select().from(s.accountingExports).where(and(eq(s.accountingExports.tenantId, ctx.tenantId), eq(s.accountingExports.id, runId))).limit(1);
  if (!run) throw new NotFoundError("export", runId);
  const d = await collect(ctx, { from: run.fromDate, to: run.toDate, onlyNew: false, ids: run.recordIds });
  const files: { name: string; mime: string; body: string }[] = run.format === "iif" ? [{ name: `${run.fileName}.iif`, mime: "application/octet-stream", body: buildIif(d) }] : Object.entries(buildQboCsv(d)).map(([k, body]) => ({ name: `${run.fileName}-${k}.csv`, mime: "text/csv", body }));
  return { run, files };
}

export async function listExports(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  return db.select().from(s.accountingExports).where(eq(s.accountingExports.tenantId, ctx.tenantId)).orderBy(desc(s.accountingExports.createdAt)).limit(100);
}

/** Undo a run's stamps so the records come out again as "new" (a file that never made it into QuickBooks). */
export async function reopenExport(ctx: Ctx, runId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [run] = await db.select().from(s.accountingExports).where(and(eq(s.accountingExports.tenantId, ctx.tenantId), eq(s.accountingExports.id, runId))).limit(1);
  if (!run) throw new NotFoundError("export", runId);
  if (run.reopenedAt) throw new ValidationError("already reopened");
  const c = run.recordIds;
  await db.transaction(async (tx) => {
    if (c.invoices.length) await tx.update(s.invoices).set({ exportedAt: null }).where(inArray(s.invoices.id, c.invoices));
    if (c.receipts.length) await tx.update(s.receipts).set({ exportedAt: null }).where(inArray(s.receipts.id, c.receipts));
    if (c.credits?.length) await tx.update(s.creditMemos).set({ exportedAt: null }).where(inArray(s.creditMemos.id, c.credits));
    if (c.payments?.length) {
      await tx.update(s.payments).set({ exportedAt: null }).where(inArray(s.payments.id, c.payments));
      await tx.update(s.receipts).set({ exportedAt: null }).where(inArray(s.receipts.paymentId, c.payments));
    }
    if (c.factor?.length) await tx.update(s.factorEntries).set({ exportedAt: null }).where(inArray(s.factorEntries.id, c.factor));
    if (c.bills.length) await tx.update(s.carrierBills).set({ exportedAt: null }).where(inArray(s.carrierBills.id, c.bills));
    if (c.settlements.length) await tx.update(s.settlements).set({ exportedAt: null }).where(inArray(s.settlements.id, c.settlements));
    await tx.update(s.accountingExports).set({ reopenedAt: new Date() }).where(eq(s.accountingExports.id, runId));
    await writeAudit(tx, ctx, "accounting_export", runId, "update", { reopened: { from: false, to: true } });
  });
}
