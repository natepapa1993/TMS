"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as B from "@/domain/billing";
import type { ChargeKind } from "@/db/schema";

/** A date picked on a form (YYYY-MM-DD) is that calendar day everywhere in the Americas: noon UTC, never midnight (which is the day before in Chicago). */
const dayOf = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v));

const touch = (id?: string) => {
  revalidatePath("/billing");
  revalidatePath("/billing/invoices");
  revalidatePath("/billing/ar");
  revalidatePath("/billing/carriers");
  revalidatePath("/billing/settlements");
  revalidatePath("/orders");
  if (id) revalidatePath(`/billing/invoices/${id}`);
};

export async function addChargeAction(orderId: string, c: { kind: ChargeKind; description: string; qty: string; unit: string; rate: string }) {
  const r = await act((ctx) => {
    const rateCents = Math.round(Number(c.rate.replace(/[$,]/g, "")) * 100);
    const qty = c.unit === "h" ? Math.round(Number(c.qty || "1") * 100) : Math.round(Number(c.qty || "1"));
    return B.addCharge(ctx, orderId, { kind: c.kind, description: c.description, qty, unit: c.unit, rateCents });
  });
  if (r.ok) {
    touch();
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function removeChargeAction(orderId: string, chargeId: string) {
  const r = await act((ctx) => B.removeCharge(ctx, chargeId));
  if (r.ok) {
    touch();
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function computeDetentionAction(orderId: string) {
  const r = await act((ctx) => B.computeDetention(ctx, orderId));
  if (r.ok) {
    touch();
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function uploadOrderDocAction(orderId: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("pick a file"), { name: "ValidationError", field: "file" });
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const d = await B.uploadOrderDocument(ctx, orderId, { code: String(form.get("code") ?? "POD"), fileName: file.name, mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
    return { id: d.id };
  });
  if (r.ok) {
    touch();
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function acceptMismatchAction(orderId: string, note: string) {
  const r = await act((ctx) => B.acceptRateConMismatch(ctx, orderId, note));
  if (r.ok) touch();
  return r;
}
export async function createInvoiceAction(orderIds: string[], withoutPending = false) {
  const r = await act((ctx) => B.createInvoice(ctx, orderIds, { withoutPending }));
  if (r.ok) touch(r.data.id);
  return r;
}
export async function issueInvoiceAction(id: string, exchangeRate?: string) {
  const r = await act((ctx) => B.issueInvoice(ctx, id, { exchangeRate: exchangeRate ? Number(exchangeRate) : null }));
  if (r.ok) touch(id);
  return r;
}
export async function sendInvoiceAction(id: string, to?: string) {
  const r = await act((ctx) => B.sendInvoice(ctx, id, to || null));
  if (r.ok) touch(id);
  return r;
}
export async function receiptAction(id: string, v: { amount: string; receivedAt: string; method: string; reference: string; note: string }) {
  const r = await act((ctx) => B.recordReceipt(ctx, id, { amountCents: Math.round(Number(v.amount.replace(/[$,]/g, "")) * 100), receivedAt: v.receivedAt ? dayOf(v.receivedAt) : undefined, method: v.method, reference: v.reference || null, note: v.note || null }));
  if (r.ok) touch(id);
  return r;
}
export async function voidInvoiceAction(id: string, reason: string) {
  const r = await act((ctx) => B.voidInvoice(ctx, id, reason));
  if (r.ok) touch(id);
  return r;
}
export async function creditMemoAction(id: string, amount: string, reason: string) {
  const r = await act((ctx) => B.creditMemo(ctx, id, { amountCents: Math.round(Number(amount.replace(/[$,]/g, "")) * 100), reason }));
  if (r.ok) touch(id);
  return r;
}
export async function disputeInvoiceAction(id: string, reason: string, expectedAt?: string) {
  const r = await act((ctx) => B.disputeInvoice(ctx, id, reason, expectedAt ? dayOf(expectedAt) : null));
  if (r.ok) touch(id);
  return r;
}
export async function promiseToPayAction(id: string, at: string) {
  const r = await act((ctx) => B.setPromiseToPay(ctx, id, at ? dayOf(at) : null));
  if (r.ok) touch(id);
  return r;
}
export async function closePeriodAction(through: string) {
  const r = await act((ctx) => B.closePeriod(ctx, new Date(through + "T23:59:59Z")));
  if (r.ok) touch();
  return r;
}
export async function receiveBillAction(id: string, v: { amount: string; number: string; accessorial: string }) {
  const r = await act((ctx) => B.receiveCarrierBill(ctx, id, { invoicedCents: Math.round(Number(v.amount.replace(/[$,]/g, "")) * 100), carrierInvoiceNumber: v.number || null, accessorialCents: v.accessorial ? Math.round(Number(v.accessorial) * 100) : undefined }));
  if (r.ok) touch();
  return r;
}
export async function approveBillAction(id: string, v: { approved: string; note: string; shortPayNote: string; payDate: string; allowNoPod: boolean }) {
  const r = await act((ctx) => B.approveCarrierBill(ctx, id, { approvedCents: v.approved ? Math.round(Number(v.approved.replace(/[$,]/g, "")) * 100) : undefined, note: v.note || null, shortPayNote: v.shortPayNote || null, payDate: v.payDate ? dayOf(v.payDate) : null, allowNoPod: v.allowNoPod }));
  if (r.ok) touch();
  return r;
}
export async function payBillAction(id: string, v: { method: string; reference: string; amount: string }) {
  const r = await act((ctx) => B.payCarrierBill(ctx, id, { method: v.method, reference: v.reference || null, paidCents: v.amount ? Math.round(Number(v.amount.replace(/[$,]/g, "")) * 100) : undefined }));
  if (r.ok) touch();
  return r;
}
export async function buildSettlementAction(driverId: string, weekStart: string) {
  const r = await act(async (ctx) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw Object.assign(new Error("pick the week's Sunday"), { name: "ValidationError", field: "weekStart" });
    const { getCompany } = await import("@/domain/company");
    const { zonedMidnight } = await import("@/lib/time");
    const company = await getCompany(ctx);
    const start = zonedMidnight(weekStart, company.timeZone);
    const next = new Date(Date.UTC(Number(weekStart.slice(0, 4)), Number(weekStart.slice(5, 7)) - 1, Number(weekStart.slice(8, 10)) + 7)).toISOString().slice(0, 10);
    return B.buildSettlement(ctx, driverId, start, zonedMidnight(next, company.timeZone));
  });
  if (r.ok) touch();
  return r;
}
export async function settlementTransitionAction(id: string, to: "reviewed" | "approved" | "paid" | "open", method?: string, reference?: string) {
  const r = await act((ctx) => B.settlementTransition(ctx, id, to, { method, reference }));
  if (r.ok) touch();
  return r;
}
export async function addSettlementLineAction(id: string, kind: "accessorial" | "deduction" | "reimbursement" | "adjustment", description: string, amount: string) {
  const r = await act((ctx) => B.addSettlementLine(ctx, id, { kind, description, amountCents: Math.round(Number(amount.replace(/[$,]/g, "")) * 100) }));
  if (r.ok) touch();
  return r;
}
export async function addPayItemAction(driverId: string, v: { kind: "deduction" | "reimbursement" | "advance" | "escrow"; description: string; amount: string; recurring: boolean; remaining: string; target?: string }) {
  const r = await act((ctx) => B.addPayItem(ctx, driverId, { kind: v.kind, description: v.description, amountCents: Math.round(Number(v.amount) * 100), recurring: v.recurring, remainingCents: v.remaining ? Math.round(Number(v.remaining) * 100) : null, targetCents: v.target ? Math.round(Number(v.target) * 100) : null }));
  if (r.ok) touch();
  return r;
}

// ---------- QuickBooks export ----------
export async function previewExportAction(v: { from: string; to: string; onlyNew: boolean }) {
  const { previewExport } = await import("@/domain/accounting");
  return act((ctx) => previewExport(ctx, v));
}
export async function createExportAction(v: { format: "iif" | "qbo"; from: string; to: string; onlyNew: boolean }) {
  const { createExport } = await import("@/domain/accounting");
  const r = await act((ctx) => createExport(ctx, v));
  if (r.ok) revalidatePath("/billing/exports");
  return r;
}
export async function reopenExportAction(id: string) {
  const { reopenExport } = await import("@/domain/accounting");
  const r = await act((ctx) => reopenExport(ctx, id));
  if (r.ok) revalidatePath("/billing/exports");
  return r;
}

// ---------- pay plans ----------

export async function savePlanAction(input: Parameters<typeof import("@/domain/pay-plans").savePlan>[1]) {
  const P = await import("@/domain/pay-plans");
  const r = await act((ctx) => P.savePlan(ctx, input));
  if (r.ok) revalidatePath("/billing/pay-plans");
  return r;
}
export async function deletePlanAction(id: string) {
  const P = await import("@/domain/pay-plans");
  const r = await act((ctx) => P.deletePlan(ctx, id));
  if (r.ok) revalidatePath("/billing/pay-plans");
  return r;
}
export async function assignPlanAction(driverIds: string[], planId: string | null) {
  const P = await import("@/domain/pay-plans");
  const r = await act((ctx) => P.assignPlan(ctx, driverIds, planId));
  if (r.ok) revalidatePath("/billing/pay-plans");
  return r;
}
export async function releaseEscrowAction(payItemId: string, amount: string, note: string) {
  const r = await act((ctx) => B.releaseEscrow(ctx, payItemId, Math.round(Number(amount) * 100), note));
  if (r.ok) touch();
  return r;
}

// ---------- fuel surcharge ----------

export async function saveFuelTableAction(input: { id?: string | null; name: string; method: string; isDefault: boolean; bands: { from: string; to: string; value: string }[] }) {
  const R = await import("@/domain/rates");
  const r = await act((ctx) => {
    const pct = input.method !== "per_mile";
    const bands = input.bands.map((b, i) => {
      const from = Math.round(Number(b.from.replace(/[$,\s]/g, "")) * 100);
      const to = b.to.trim() ? Math.round(Number(b.to.replace(/[$,\s]/g, "")) * 100) : null;
      const v = Number(b.value.replace(/[%¢,\s]/g, ""));
      if (!b.from.trim() || !Number.isFinite(from) || (to != null && !Number.isFinite(to)) || !b.value.trim() || !Number.isFinite(v)) throw Object.assign(new Error(`Band ${i + 1}: fill the price range and the surcharge`), { name: "ValidationError", field: "bands" });
      return { from, to, value: Math.round(pct ? v * 100 : v) };
    });
    return R.saveFuelTable(ctx, { id: input.id, name: input.name, method: input.method, isDefault: input.isDefault, bands });
  });
  if (r.ok) revalidatePath("/billing/fuel");
  return r;
}
export async function deleteFuelTableAction(id: string) {
  const R = await import("@/domain/rates");
  const r = await act((ctx) => R.deleteFuelTable(ctx, id));
  if (r.ok) revalidatePath("/billing/fuel");
  return r;
}
export async function setFuelPriceAction(date: string, price: string) {
  const R = await import("@/domain/rates");
  const r = await act((ctx) => {
    const n = Number(price.replace(/[$,\s]/g, ""));
    if (!price.trim() || !Number.isFinite(n)) throw Object.assign(new Error("Enter the diesel price per gallon"), { name: "ValidationError", field: "price" });
    return R.setFuelPrice(ctx, date, Math.round(n * 100));
  });
  if (r.ok) revalidatePath("/billing/fuel");
  return r;
}

// ---------- billing runs and delivery ----------

export async function planBatchAction(orderIds: string[]) {
  const I = await import("@/domain/invoicing");
  return act((ctx) => I.planBatch(ctx, orderIds));
}
export async function runBatchAction(orderIds: string[], v: { issue: boolean; send: boolean; exchangeRate?: string }) {
  const I = await import("@/domain/invoicing");
  const r = await act((ctx) => {
    const rate = v.exchangeRate?.trim() ? Number(v.exchangeRate) : null;
    if (rate != null && (!Number.isFinite(rate) || rate <= 0)) throw Object.assign(new Error("Exchange rate must be a number"), { name: "ValidationError", field: "exchangeRate" });
    return I.runBatch(ctx, orderIds, { issue: v.issue, send: v.send, exchangeRate: rate });
  });
  if (r.ok) touch();
  return r;
}
export async function deliverInvoiceAction(id: string, v: { method: string; to: string; reference: string }) {
  const I = await import("@/domain/invoicing");
  const r = await act((ctx) => I.deliverInvoice(ctx, id, { method: v.method as never, to: v.to || null, reference: v.reference || null }));
  if (r.ok) touch();
  return r;
}
export async function factorScheduleAction(ids: string[]) {
  const I = await import("@/domain/invoicing");
  const r = await act((ctx) => I.sendFactorSchedule(ctx, ids));
  if (r.ok) touch();
  return r;
}

// ---------- IFTA ----------

const iftaTouch = () => revalidatePath("/billing/ifta");
export async function computeMilesAction(quarter: string) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => I.computeMiles(ctx, quarter));
  if (r.ok) iftaTouch();
  return r;
}
export async function addFuelPurchaseAction(v: { truckId: string; date: string; jurisdiction: string; country: string; qty: string; unit: "gal" | "l"; amount: string; vendor: string; city: string; receipt: string; fuelType: string }) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => {
    const q = Number(v.qty.replace(/[,\s]/g, ""));
    const amt = v.amount.trim() ? Math.round(Number(v.amount.replace(/[$,\s]/g, "")) * 100) : null;
    if (amt != null && !Number.isFinite(amt)) throw Object.assign(new Error("Amount must be a number"), { name: "ValidationError", field: "amount" });
    return I.addFuelPurchase(ctx, { truckId: v.truckId || null, purchasedAt: v.date, jurisdiction: v.jurisdiction, country: v.country || null, gallons: v.unit === "gal" ? q : null, liters: v.unit === "l" ? q : null, amountCents: amt, vendor: v.vendor, city: v.city, receiptNumber: v.receipt, fuelType: v.fuelType });
  });
  if (r.ok) iftaTouch();
  return r;
}
export async function deleteFuelPurchaseAction(id: string) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => I.deleteFuelPurchase(ctx, id));
  if (r.ok) iftaTouch();
  return r;
}
export async function importFuelAction(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File)) return { ok: false as const, error: "Choose the fuel card export" };
  const I = await import("@/domain/ifta");
  const bytes = Buffer.from(await f.arrayBuffer());
  const r = await act((ctx) => I.importFuelPurchases(ctx, { fileName: f.name, bytes }));
  if (r.ok) iftaTouch();
  return r;
}
export async function addTripMilesAction(v: { truckId: string; date: string; jurisdiction: string; miles: string; note: string }) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => I.addTripMiles(ctx, { truckId: v.truckId, date: v.date, jurisdiction: v.jurisdiction, miles: Number(v.miles.replace(/[,\s]/g, "")), note: v.note }));
  if (r.ok) iftaTouch();
  return r;
}
export async function deleteTripMilesAction(id: string) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => I.deleteTripMiles(ctx, id));
  if (r.ok) iftaTouch();
  return r;
}
export async function setIftaRatesAction(quarter: string, rows: { jurisdiction: string; rate: string; surcharge: string }[]) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) =>
    I.setRates(
      ctx,
      quarter,
      rows.map((x) => ({ jurisdiction: x.jurisdiction, rate: x.rate.trim() ? Number(x.rate.replace(/[$\s]/g, "")) : null, surcharge: x.surcharge.trim() ? Number(x.surcharge.replace(/[$\s]/g, "")) : null })),
    ),
  );
  if (r.ok) iftaTouch();
  return r;
}
export async function copyIftaRatesAction(quarter: string) {
  const I = await import("@/domain/ifta");
  const r = await act((ctx) => I.copyRatesFrom(ctx, quarter, I.previousQuarter(quarter)));
  if (r.ok) iftaTouch();
  return r;
}

// ---------- extras the customer approves ----------

export async function approveChargeAction(orderId: string, chargeId: string, by: string, ref: string) {
  const r = await act((ctx) => B.approveCharge(ctx, chargeId, { by, ref }));
  if (r.ok) {
    touch(r.data.joinedDraft ?? undefined);
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function rejectChargeAction(orderId: string, chargeId: string, reason: string) {
  const r = await act((ctx) => B.rejectCharge(ctx, chargeId, reason));
  if (r.ok) {
    touch();
    revalidatePath(`/orders/${orderId}`);
  }
  return r;
}
export async function rebillAction(id: string, reason: string) {
  const r = await act(async (ctx) => {
    const inv = await B.rebillInvoice(ctx, id, reason);
    return { id: inv.id };
  });
  if (r.ok) {
    touch(id);
    touch(r.data.id);
  }
  return r;
}

// ---------- cash application ----------

const cents = (v: string) => Math.round(Number(String(v).replace(/[$,\s]/g, "")) * 100);

export async function openItemsAction(customerId: string) {
  const { openItems } = await import("@/domain/cash");
  return act((ctx) => openItems(ctx, customerId));
}
export async function applyPaymentAction(v: { customerId: string; amount: string; receivedAt: string; method: string; reference: string; remittance: string; note: string; applications: { invoiceId: string; amount: string; shortPay: string; reason: string }[] }) {
  const { applyPayment } = await import("@/domain/cash");
  const r = await act((ctx) =>
    applyPayment(ctx, {
      customerId: v.customerId,
      amountCents: cents(v.amount),
      receivedAt: v.receivedAt ? dayOf(v.receivedAt) : undefined,
      method: v.method,
      reference: v.reference,
      remittance: v.remittance,
      note: v.note,
      applications: v.applications.map((a) => ({ invoiceId: a.invoiceId, amountCents: a.amount ? cents(a.amount) : 0, shortPay: (a.shortPay || "leave_open") as "leave_open" | "write_off" | "dispute", reason: a.reason })),
    }),
  );
  if (r.ok) {
    touch();
    revalidatePath("/billing/payments");
  }
  return r;
}
export async function applyOnAccountAction(paymentId: string, invoiceId: string, amount: string) {
  const { applyOnAccount } = await import("@/domain/cash");
  const r = await act((ctx) => applyOnAccount(ctx, paymentId, invoiceId, cents(amount)));
  if (r.ok) {
    touch(invoiceId);
    revalidatePath("/billing/payments");
  }
  return r;
}

// ---------- weekly pay run ----------

async function weekBounds(ctx: Parameters<Parameters<typeof act>[0]>[0], weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw Object.assign(new Error("pick the week's Sunday"), { name: "ValidationError", field: "weekStart" });
  const { getCompany } = await import("@/domain/company");
  const { zonedMidnight } = await import("@/lib/time");
  const company = await getCompany(ctx);
  const next = new Date(Date.UTC(Number(weekStart.slice(0, 4)), Number(weekStart.slice(5, 7)) - 1, Number(weekStart.slice(8, 10)) + 7)).toISOString().slice(0, 10);
  return { start: zonedMidnight(weekStart, company.timeZone), end: zonedMidnight(next, company.timeZone) };
}
export async function settlementRunAction(weekStart: string) {
  const { settlementRun } = await import("@/domain/settlement-run");
  const r = await act(async (ctx) => {
    const { start, end } = await weekBounds(ctx, weekStart);
    return settlementRun(ctx, start, end);
  });
  if (r.ok) touch();
  return r;
}
export async function approveSettlementsAction(ids: string[]) {
  const { approveSettlements } = await import("@/domain/settlement-run");
  const r = await act((ctx) => approveSettlements(ctx, ids));
  if (r.ok) touch();
  return r;
}
export async function paySettlementsAction(ids: string[], method: string, reference: string) {
  const { paySettlements } = await import("@/domain/settlement-run");
  const r = await act((ctx) => paySettlements(ctx, ids, { method, reference }));
  if (r.ok) touch();
  return r;
}

// ---------- factoring ----------

export async function recordFundingAction(ids: string[], v: { at: string; reference: string; advance: string; fee: string }) {
  const F = await import("@/domain/factoring");
  const r = await act((ctx) => F.recordFunding(ctx, ids, { at: v.at ? dayOf(v.at) : undefined, reference: v.reference, advanceBp: v.advance ? Number(v.advance) : null, feeBp: v.fee ? Number(v.fee) : null }));
  if (r.ok) {
    touch();
    revalidatePath("/billing/factoring");
  }
  return r;
}
export async function recordCollectionAction(id: string, v: { at: string; reference: string }) {
  const F = await import("@/domain/factoring");
  const r = await act((ctx) => F.recordCollection(ctx, id, { at: v.at ? dayOf(v.at) : undefined, reference: v.reference }));
  if (r.ok) {
    touch(id);
    revalidatePath("/billing/factoring");
  }
  return r;
}
export async function recordChargebackAction(id: string, v: { at: string; reference: string; note: string }) {
  const F = await import("@/domain/factoring");
  const r = await act((ctx) => F.recordChargeback(ctx, id, { at: v.at ? dayOf(v.at) : undefined, reference: v.reference, note: v.note }));
  if (r.ok) {
    touch(id);
    revalidatePath("/billing/factoring");
  }
  return r;
}
