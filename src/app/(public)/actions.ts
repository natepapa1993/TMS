"use server";

import { toError, type ActionResult } from "@/lib/action";
import { respondToTender, type TenderResponse } from "@/domain/tenders";
import { resolveToken } from "@/lib/tokens";
import { driverStep, recordPosition, type DriverStepInput } from "@/domain/tracking";
import type { LegState } from "@/db/schema";

/** Public server functions: the token in the URL is the only authorization, and it is checked here every time. */

export async function respondTenderAction(token: string, r: TenderResponse): Promise<ActionResult<{ state: "accepted" | "declined" }>> {
  try {
    const res = await respondToTender(token, r);
    return { ok: true, data: { state: res.state } };
  } catch (e) {
    return toError(e);
  }
}

export async function driverStepAction(token: string, legId: string, input: DriverStepInput): Promise<ActionResult<{ state: string }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask dispatch for a new one.", code: "not_found" };
  try {
    const leg = await driverStep(t.ctx.tenantId, t.subjectId, legId, input);
    return { ok: true, data: { state: leg.state } };
  } catch (e) {
    return toError(e);
  }
}

/** Background ping from the driver's phone while the app is open. */
export async function driverPingAction(token: string, p: { lat: number; lng: number; accuracyM?: number | null; speedMph?: number | null; heading?: number | null }): Promise<ActionResult<{ ok: true }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { db } = await import("@/db/client");
    const { drivers } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [d] = await db.select({ currentTruckId: drivers.currentTruckId }).from(drivers).where(eq(drivers.id, t.subjectId)).limit(1);
    await recordPosition(t.ctx, { source: "phone", lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, speedMph: p.speedMph ?? null, heading: p.heading ?? null, driverId: t.subjectId, truckId: d?.currentTruckId ?? null });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

/** Driver disputes a settlement line from the app (spec 7.10). */
export async function disputeSettlementLineAction(token: string, settlementId: string, lineId: string, reason: string): Promise<ActionResult<{ ok: true }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { disputeSettlementLine } = await import("@/domain/billing");
    await disputeSettlementLine(t.ctx.tenantId, t.subjectId, settlementId, lineId, reason);
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

// ---------- carrier portal ----------

async function carrierFromToken(token: string) {
  const t = await resolveToken(token, "carrier_portal");
  return t ? { tenantId: t.ctx.tenantId, carrierId: t.subjectId } : null;
}

export async function portalRespondAction(token: string, tenderId: string, r: TenderResponse): Promise<ActionResult<{ state: string }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "This link is no longer valid. Ask the dispatcher for a new one.", code: "not_found" };
  try {
    const { portalRespond } = await import("@/domain/carrier-portal");
    const res = await portalRespond(c.tenantId, c.carrierId, tenderId, r);
    return { ok: true, data: { state: res.state } };
  } catch (e) {
    return toError(e);
  }
}

export async function portalAdvanceAction(token: string, legId: string, to: LegState, note?: string): Promise<ActionResult<{ state: string }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { portalAdvance } = await import("@/domain/carrier-portal");
    const leg = await portalAdvance(c.tenantId, c.carrierId, legId, to, note ?? null);
    return { ok: true, data: { state: leg.state } };
  } catch (e) {
    return toError(e);
  }
}

export async function portalDriverAction(token: string, legId: string, d: { driverName: string; driverPhone?: string; unitNumber?: string; trailerNumber?: string; by?: string }): Promise<ActionResult<{ ok: true }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { portalSetDriver } = await import("@/domain/carrier-portal");
    await portalSetDriver(c.tenantId, c.carrierId, legId, d);
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

export async function portalUploadAction(token: string, form: FormData): Promise<ActionResult<{ ok: true }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("pick a file"), { name: "ValidationError", field: "file" });
    const { portalUploadDocument } = await import("@/domain/carrier-portal");
    const { parseDate } = await import("@/data/fields");
    const expires = String(form.get("expiresAt") ?? "");
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    await portalUploadDocument(c.tenantId, c.carrierId, { documentTypeId: String(form.get("documentTypeId") ?? ""), fileName: file.name, mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()), expiresAt: expires ? parseDate(expires) : null, number: String(form.get("number") ?? "") || null });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

export async function portalInvoiceAction(token: string, legId: string, form: FormData): Promise<ActionResult<{ state: string }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { portalSubmitInvoice } = await import("@/domain/carrier-portal");
    const file = form.get("file");
    const amount = Number(String(form.get("amount") ?? "").replace(/[$,\s]/g, ""));
    const bill = await portalSubmitInvoice(c.tenantId, c.carrierId, legId, { amountCents: Math.round(amount * 100), invoiceNumber: String(form.get("invoiceNumber") ?? ""), fileName: file instanceof File ? file.name : undefined, mimeType: file instanceof File ? file.type || "application/pdf" : undefined, bytes: file instanceof File && file.size > 0 ? Buffer.from(await file.arrayBuffer()) : null });
    return { ok: true, data: { state: bill.state } };
  } catch (e) {
    return toError(e);
  }
}
