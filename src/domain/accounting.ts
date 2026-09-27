import { and, eq, gte, lt, inArray, isNull, desc } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { zonedMidnight, zonedDate } from "@/lib/time";
import { getCompany, type QbAccounts } from "./company";
import { ValidationError, NotFoundError } from "./orders";
import { CHARGE_LABEL } from "./billing";

/**
 * Accounting export (spec §7.9 "QuickBooks is a later sync, not a dependency"): the ledger stays here;
 * QuickBooks gets files. IIF for QuickBooks Desktop (one file), CSV for QuickBooks Online (one per list).
 * A run is logged with the exact records it carried, so the same file can be downloaded again, and
 * "only new" runs skip anything a previous run already carried.
 */

export type ExportFormat = "iif" | "qbo";

export type ExportData = {
  qb: QbAccounts;
  timeZone: string;
  invoices: { id: string; number: string; issuedAt: Date; dueAt: Date; termsDays: number; customer: string; currency: string; totalCents: number; memo: string; lines: { description: string; kind: string; qty: number; unit: string; rateCents: number; amountCents: number }[] }[];
  receipts: { id: string; receivedAt: Date; customer: string; invoiceNumber: string; amountCents: number; method: string; reference: string | null }[];
  credits: { id: string; number: string; issuedAt: Date; customer: string; invoiceNumber: string; amountCents: number; reason: string; currency: string }[];
  bills: { id: string; kind: "carrier" | "driver"; vendor: string; date: Date; dueAt: Date | null; number: string; memo: string; currency: string; lines: { account: string; description: string; amountCents: number }[]; paidAt: Date | null; paidCents: number | null; paidRef: string | null }[];
};

const dollars = (c: number) => (c / 100).toFixed(2);
const mdy = (d: Date, tz: string) => {
  const [y, m, day] = zonedDate(d, tz).split("-");
  return `${m}/${day}/${y}`;
};
const iso = (d: Date, tz: string) => zonedDate(d, tz);

/** Quantity and unit price as QuickBooks wants them: hours in decimals, miles/stops as counted, flat and percent lines as 1 × amount. */
const qtyPrice = (l: { qty: number; unit: string; rateCents: number; amountCents: number }) => (l.unit === "h" ? { qty: l.qty / 100, price: l.rateCents } : l.unit === "mi" || l.unit === "stop" ? { qty: l.qty, price: l.rateCents } : { qty: 1, price: l.amountCents });

const incomeFor = (qb: QbAccounts, kind: string) => (kind === "linehaul" ? qb.incomeAccount : kind === "fuel" ? qb.fuelIncomeAccount : qb.accessorialIncomeAccount);

// ---------- collect ----------

async function collect(ctx: Ctx, opts: { from: string; to: string; onlyNew: boolean; ids?: { invoices: string[]; receipts: string[]; bills: string[]; settlements: string[]; credits?: string[] } }): Promise<ExportData & { ids: NonNullable<typeof opts.ids> }> {
  const company = await getCompany(ctx);
  const tz = company.timeZone;
  const from = zonedMidnight(opts.from, tz);
  const toExclusive = new Date(zonedMidnight(opts.to, tz).getTime() + 86400_000);
  const inWindow = (col: PgColumn) => and(gte(col, from), lt(col, toExclusive));

  const [customers, carriers, drivers] = await Promise.all([
    db.select({ id: s.customers.id, name: s.customers.name, qbName: s.customers.qbName }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name, qbName: s.carriers.qbName }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
    db.select({ id: s.drivers.id, name: s.drivers.name, qbName: s.drivers.qbName }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
  ]);
  const cname = (id: string) => customers.find((c) => c.id === id)?.qbName?.trim() || customers.find((c) => c.id === id)?.name || "Customer";
  const vname = (id: string) => carriers.find((c) => c.id === id)?.qbName?.trim() || carriers.find((c) => c.id === id)?.name || "Carrier";
  const dname = (id: string) => drivers.find((c) => c.id === id)?.qbName?.trim() || drivers.find((c) => c.id === id)?.name || "Driver";

  const invRows = opts.ids
    ? opts.ids.invoices.length
      ? await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.id, opts.ids.invoices)))
      : []
    : await db
        .select()
        .from(s.invoices)
        .where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "paid", "closed", "disputed"]), inWindow(s.invoices.issuedAt), ...(opts.onlyNew ? [isNull(s.invoices.exportedAt)] : [])));
  const invoices: ExportData["invoices"] = invRows
    .filter((i) => i.snapshot && i.number && i.issuedAt && i.dueAt)
    .map((i) => ({ id: i.id, number: i.number!, issuedAt: i.issuedAt!, dueAt: i.dueAt!, termsDays: i.termsDays, customer: cname(i.customerId), currency: i.currency, totalCents: i.totalCents, memo: i.snapshot!.lines.map((l) => l.orderNumber).filter((v, idx, a) => a.indexOf(v) === idx).join(", "), lines: i.snapshot!.lines.map((l) => ({ description: l.description, kind: l.kind, qty: l.qty, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents })) }));

  const rcRows = opts.ids
    ? opts.ids.receipts.length
      ? await db.select().from(s.receipts).where(and(eq(s.receipts.tenantId, ctx.tenantId), inArray(s.receipts.id, opts.ids.receipts)))
      : []
    : await db
        .select()
        .from(s.receipts)
        .where(and(eq(s.receipts.tenantId, ctx.tenantId), inWindow(s.receipts.receivedAt), ...(opts.onlyNew ? [isNull(s.receipts.exportedAt)] : [])));
  const rcInv = rcRows.length ? await db.select({ id: s.invoices.id, number: s.invoices.number, customerId: s.invoices.customerId }).from(s.invoices).where(inArray(s.invoices.id, rcRows.map((r) => r.invoiceId))) : [];
  const receipts: ExportData["receipts"] = rcRows.map((r) => {
    const inv = rcInv.find((i) => i.id === r.invoiceId);
    return { id: r.id, receivedAt: r.receivedAt, customer: inv ? cname(inv.customerId) : "Customer", invoiceNumber: inv?.number ?? "", amountCents: r.amountCents, method: r.method, reference: r.reference };
  });

  // credit memos reduce what the customer owes: they go to QuickBooks as credit memos against the invoice
  const cmRows = opts.ids
    ? opts.ids.credits?.length
      ? await db.select().from(s.creditMemos).where(and(eq(s.creditMemos.tenantId, ctx.tenantId), inArray(s.creditMemos.id, opts.ids.credits)))
      : []
    : await db
        .select()
        .from(s.creditMemos)
        .where(and(eq(s.creditMemos.tenantId, ctx.tenantId), inWindow(s.creditMemos.issuedAt), ...(opts.onlyNew ? [isNull(s.creditMemos.exportedAt)] : [])));
  const cmInv = cmRows.length ? await db.select({ id: s.invoices.id, number: s.invoices.number, customerId: s.invoices.customerId, currency: s.invoices.currency }).from(s.invoices).where(inArray(s.invoices.id, cmRows.map((r) => r.invoiceId))) : [];
  const credits: ExportData["credits"] = cmRows.map((c) => {
    const inv = cmInv.find((i) => i.id === c.invoiceId);
    return { id: c.id, number: c.number, issuedAt: c.issuedAt, customer: inv ? cname(inv.customerId) : "Customer", invoiceNumber: inv?.number ?? "", amountCents: c.amountCents, reason: c.reason, currency: inv?.currency ?? "USD" };
  });

  const cbRows = opts.ids
    ? opts.ids.bills.length
      ? await db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ctx.tenantId), inArray(s.carrierBills.id, opts.ids.bills)))
      : []
    : await db
        .select()
        .from(s.carrierBills)
        .where(and(eq(s.carrierBills.tenantId, ctx.tenantId), inArray(s.carrierBills.state, ["approved", "scheduled", "paid"]), inWindow(s.carrierBills.approvedAt), ...(opts.onlyNew ? [isNull(s.carrierBills.exportedAt)] : [])));
  const cbOrders = cbRows.length ? await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(inArray(s.orders.id, cbRows.map((b) => b.orderId))) : [];
  const stRows = opts.ids
    ? opts.ids.settlements.length
      ? await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.id, opts.ids.settlements)))
      : []
    : await db
        .select()
        .from(s.settlements)
        .where(and(eq(s.settlements.tenantId, ctx.tenantId), inArray(s.settlements.state, ["approved", "paid"]), inWindow(s.settlements.approvedAt), ...(opts.onlyNew ? [isNull(s.settlements.exportedAt)] : [])));
  const bills: ExportData["bills"] = [
    ...cbRows.map((b) => {
      const on = cbOrders.find((o) => o.id === b.orderId)?.orderNumber ?? "";
      const amount = b.paidCents ?? b.approvedCents ?? b.invoicedCents ?? b.expectedCents;
      return { id: b.id, kind: "carrier" as const, vendor: vname(b.carrierId), date: b.approvedAt ?? b.receivedAt ?? b.createdAt, dueAt: b.payDate, number: b.carrierInvoiceNumber || `CB-${on}`, memo: on, currency: b.currency, lines: [{ account: company.settings.qb.carrierExpenseAccount, description: `${on} carrier freight${b.shortPayNote ? ` (short-paid: ${b.shortPayNote})` : ""}`, amountCents: amount }], paidAt: b.paidAt, paidCents: b.paidCents, paidRef: b.reference };
    }),
    ...stRows.map((st) => ({
      id: st.id,
      kind: "driver" as const,
      vendor: dname(st.driverId),
      date: st.approvedAt ?? st.reviewedAt ?? st.createdAt,
      dueAt: null,
      number: `PAY-${iso(st.periodStart, tz)}`,
      memo: `week of ${iso(st.periodStart, tz)}`,
      currency: st.currency,
      lines: st.lines.map((l) => ({ account: l.amountCents < 0 ? company.settings.qb.deductionAccount : company.settings.qb.driverPayAccount, description: l.description, amountCents: l.amountCents })),
      paidAt: st.paidAt,
      paidCents: st.state === "paid" ? st.netCents : null,
      paidRef: st.reference,
    })),
  ];
  return { qb: company.settings.qb, timeZone: tz, invoices, receipts, credits, bills, ids: { invoices: invoices.map((i) => i.id), receipts: receipts.map((r) => r.id), bills: cbRows.map((b) => b.id), settlements: stRows.map((x) => x.id), credits: credits.map((c) => c.id) } };
}

// ---------- IIF (QuickBooks Desktop) ----------

const tsv = (cells: (string | number)[]) => cells.map((c) => String(c).replace(/[\t\r\n]+/g, " ")).join("\t");

export function buildIif(d: ExportData): string {
  const tz = d.timeZone;
  const out: string[] = [];
  const customers = [...new Set(d.invoices.map((i) => i.customer).concat(d.receipts.map((r) => r.customer), d.credits.map((c) => c.customer)))];
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
  for (const r of d.receipts) {
    const date = mdy(r.receivedAt, tz);
    out.push(tsv(["TRNS", "", "PAYMENT", date, d.qb.bankAccount, r.customer, "", dollars(r.amountCents), r.reference ?? "", `${r.method} for ${r.invoiceNumber}`, "N", "", ""]));
    out.push(tsv(["SPL", "", "PAYMENT", date, d.qb.arAccount, r.customer, "", dollars(-r.amountCents), r.invoiceNumber, "", "", "", ""]));
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
    if (b.paidAt && b.paidCents != null) {
      const pd = mdy(b.paidAt, tz);
      out.push(tsv(["TRNS", "", "BILLPMT", pd, d.qb.bankAccount, b.vendor, "", dollars(-b.paidCents), b.paidRef ?? "", `pays ${b.number}`, "N", "", ""]));
      out.push(tsv(["SPL", "", "BILLPMT", pd, d.qb.apAccount, b.vendor, "", dollars(b.paidCents), b.number, "", "", "", ""]));
      out.push("ENDTRNS");
    }
  }
  return out.join("\r\n") + "\r\n";
}

// ---------- CSV (QuickBooks Online imports) ----------

const csvCell = (v: string | number) => {
  const str = String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function buildQboCsv(d: ExportData): { invoices: string; bills: string; payments: string; credits: string } {
  const tz = d.timeZone;
  const inv: (string | number)[][] = [["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Currency"]];
  for (const i of d.invoices)
    for (const l of i.lines) {
      const { qty, price } = qtyPrice(l);
      inv.push([i.number, i.customer, mdy(i.issuedAt, tz), mdy(i.dueAt, tz), `Net ${i.termsDays}`, i.memo, CHARGE_LABEL[l.kind as keyof typeof CHARGE_LABEL] ?? l.kind, l.description, qty, dollars(price), dollars(l.amountCents), i.currency]);
    }
  const bills: (string | number)[][] = [["BillNo", "Supplier", "BillDate", "DueDate", "Terms", "Memo", "Account", "LineDescription", "LineAmount", "Currency", "PaidDate", "PaidAmount", "PaymentRef"]];
  for (const b of d.bills) for (const l of b.lines) bills.push([b.number, b.vendor, mdy(b.date, tz), b.dueAt ? mdy(b.dueAt, tz) : "", "", b.memo, l.account, l.description, dollars(l.amountCents), b.currency, b.paidAt ? mdy(b.paidAt, tz) : "", b.paidCents != null ? dollars(b.paidCents) : "", b.paidRef ?? ""]);
  const pay: (string | number)[][] = [["PaymentDate", "Customer", "InvoiceNo", "Amount", "PaymentMethod", "ReferenceNo", "DepositTo"]];
  for (const r of d.receipts) pay.push([mdy(r.receivedAt, tz), r.customer, r.invoiceNumber, dollars(r.amountCents), r.method, r.reference ?? "", d.qb.bankAccount]);
  const cm: (string | number)[][] = [["CreditMemoNo", "Customer", "CreditMemoDate", "AppliesToInvoice", "Item(Product/Service)", "ItemDescription", "ItemAmount", "Currency"]];
  for (const c of d.credits) cm.push([c.number, c.customer, mdy(c.issuedAt, tz), c.invoiceNumber, "Credit", c.reason, dollars(c.amountCents), c.currency]);
  return { invoices: csv(inv), bills: csv(bills), payments: csv(pay), credits: csv(cm) };
}

// ---------- runs ----------

export async function previewExport(ctx: Ctx, opts: { from: string; to: string; onlyNew: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  validatePeriod(opts);
  const d = await collect(ctx, opts);
  return { invoices: d.invoices.length, receipts: d.receipts.length, credits: d.credits.length, creditedCents: d.credits.reduce((a, c) => a + c.amountCents, 0), carrierBills: d.ids.bills.length, settlements: d.ids.settlements.length, invoicedCents: d.invoices.reduce((a, i) => a + i.totalCents, 0), receivedCents: d.receipts.reduce((a, r) => a + r.amountCents, 0), billsCents: d.bills.reduce((a, b) => a + b.lines.reduce((x, l) => x + l.amountCents, 0), 0) };
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
  const total = d.invoices.length + d.receipts.length + d.bills.length + d.credits.length;
  if (!total) throw new ValidationError(opts.onlyNew ? "nothing new in that period — untick “only new” to export it again" : "nothing in that period");
  const id = newId();
  const now = new Date();
  const fileName = `crossline-${opts.format}-${opts.from}-to-${opts.to}`;
  await db.transaction(async (tx) => {
    await tx.insert(s.accountingExports).values({ id, tenantId: ctx.tenantId, format: opts.format, fromDate: opts.from, toDate: opts.to, onlyNew: opts.onlyNew, counts: { invoices: d.invoices.length, receipts: d.receipts.length, carrierBills: d.ids.bills.length, settlements: d.ids.settlements.length, credits: d.credits.length }, recordIds: d.ids, fileName, createdBy: ctx.userId });
    if (d.ids.invoices.length) await tx.update(s.invoices).set({ exportedAt: now }).where(inArray(s.invoices.id, d.ids.invoices));
    if (d.ids.receipts.length) await tx.update(s.receipts).set({ exportedAt: now }).where(inArray(s.receipts.id, d.ids.receipts));
    if (d.ids.credits?.length) await tx.update(s.creditMemos).set({ exportedAt: now }).where(inArray(s.creditMemos.id, d.ids.credits));
    if (d.ids.bills.length) await tx.update(s.carrierBills).set({ exportedAt: now }).where(inArray(s.carrierBills.id, d.ids.bills));
    if (d.ids.settlements.length) await tx.update(s.settlements).set({ exportedAt: now }).where(inArray(s.settlements.id, d.ids.settlements));
    await writeAudit(tx, ctx, "accounting_export", id, "create", { format: { from: null, to: opts.format }, period: { from: null, to: `${opts.from}..${opts.to}` }, records: { from: null, to: total } });
  });
  return { id, fileName, counts: { invoices: d.invoices.length, receipts: d.receipts.length, carrierBills: d.ids.bills.length, settlements: d.ids.settlements.length } };
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
    if (c.bills.length) await tx.update(s.carrierBills).set({ exportedAt: null }).where(inArray(s.carrierBills.id, c.bills));
    if (c.settlements.length) await tx.update(s.settlements).set({ exportedAt: null }).where(inArray(s.settlements.id, c.settlements));
    await tx.update(s.accountingExports).set({ reopenedAt: new Date() }).where(eq(s.accountingExports.id, runId));
    await writeAudit(tx, ctx, "accounting_export", runId, "update", { reopened: { from: false, to: true } });
  });
}
