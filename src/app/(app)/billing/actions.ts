"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as B from "@/domain/billing";
import type { ChargeKind } from "@/db/schema";

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
export async function createInvoiceAction(orderIds: string[]) {
  const r = await act((ctx) => B.createInvoice(ctx, orderIds));
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
  const r = await act((ctx) => B.recordReceipt(ctx, id, { amountCents: Math.round(Number(v.amount.replace(/[$,]/g, "")) * 100), receivedAt: v.receivedAt ? new Date(v.receivedAt) : undefined, method: v.method, reference: v.reference || null, note: v.note || null }));
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
  const r = await act((ctx) => B.disputeInvoice(ctx, id, reason, expectedAt ? new Date(expectedAt) : null));
  if (r.ok) touch(id);
  return r;
}
export async function promiseToPayAction(id: string, at: string) {
  const r = await act((ctx) => B.setPromiseToPay(ctx, id, at ? new Date(at) : null));
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
  const r = await act((ctx) => B.approveCarrierBill(ctx, id, { approvedCents: v.approved ? Math.round(Number(v.approved.replace(/[$,]/g, "")) * 100) : undefined, note: v.note || null, shortPayNote: v.shortPayNote || null, payDate: v.payDate ? new Date(v.payDate) : null, allowNoPod: v.allowNoPod }));
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
export async function addPayItemAction(driverId: string, v: { kind: "deduction" | "reimbursement"; description: string; amount: string; recurring: boolean; remaining: string }) {
  const r = await act((ctx) => B.addPayItem(ctx, driverId, { kind: v.kind, description: v.description, amountCents: Math.round(Number(v.amount) * 100), recurring: v.recurring, remainingCents: v.remaining ? Math.round(Number(v.remaining) * 100) : null }));
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
