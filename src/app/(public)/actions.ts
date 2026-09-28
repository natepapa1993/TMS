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

/** A POD or seal photo from the driver's phone; lands on the order (on a trip, on the shipments getting off here). */
export async function driverPhotoAction(token: string, legId: string, form: FormData): Promise<ActionResult<{ count: number }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask dispatch for a new one.", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("take the photo first · toma la foto primero"), { name: "ValidationError", field: "file" });
    const code = String(form.get("code") ?? "POD") as "POD" | "SEAL_PHOTO";
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const { driverUploadPhoto } = await import("@/domain/tracking");
    const rows = await driverUploadPhoto(t.ctx.tenantId, t.subjectId, legId, { code, fileName: file.name || `${code.toLowerCase()}.jpg`, mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, data: { count: rows.length } };
  } catch (e) {
    return toError(e);
  }
}

/** A renewal (new licence, medical card…) photographed by the driver; waits for safety to confirm it. */
export async function driverRenewalAction(token: string, form: FormData): Promise<ActionResult<{ ok: true }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask dispatch for a new one.", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("take the photo first · toma la foto primero"), { name: "ValidationError", field: "file" });
    const { driverUploadRenewal } = await import("@/domain/compliance");
    const { parseDate } = await import("@/data/fields");
    const expires = String(form.get("expiresAt") ?? "");
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    await driverUploadRenewal(t.ctx.tenantId, t.subjectId, { uploadKey: String(form.get("uploadKey") ?? "") || null, documentTypeId: String(form.get("documentTypeId") ?? "") || null, fileName: file.name || "renewal.jpg", mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()), expiresAt: expires ? parseDate(expires) : null, number: String(form.get("number") ?? "") || null });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

/** The driver writes to dispatch from the app. */
export async function driverMessageAction(token: string, legId: string | null, body: string): Promise<ActionResult<{ id: string }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask dispatch for a new one.", code: "not_found" };
  try {
    const { driverMessage } = await import("@/domain/tracking");
    const row = await driverMessage(t.ctx.tenantId, t.subjectId, legId, body);
    return { ok: true, data: { id: row.id } };
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

export async function portalAdvanceAction(token: string, legId: string, to: LegState, note?: string, seal?: string | null): Promise<ActionResult<{ state: string }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { portalAdvance } = await import("@/domain/carrier-portal");
    const leg = await portalAdvance(c.tenantId, c.carrierId, legId, to, note ?? null, seal ?? null);
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

export async function portalPodAction(token: string, legId: string, form: FormData): Promise<ActionResult<{ count: number }>> {
  const c = await carrierFromToken(token);
  if (!c) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("pick the POD file · elige el archivo del POD"), { name: "ValidationError", field: "file" });
    const { portalUploadPod } = await import("@/domain/carrier-portal");
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const rows = await portalUploadPod(c.tenantId, c.carrierId, legId, { fileName: file.name || "pod.jpg", mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, data: { count: rows.length } };
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

// ---------- the partner carrier's driver (one leg) ----------

export async function carrierDriverStepAction(token: string, input: { lat?: number | null; lng?: number | null; accuracyM?: number | null; seal?: string | null; caja?: string | null }): Promise<ActionResult<{ state: string }>> {
  const t = await resolveToken(token, "carrier_driver");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask your dispatcher for a new one.", code: "not_found" };
  try {
    const { carrierDriverStep } = await import("@/domain/carrier-portal");
    const leg = await carrierDriverStep(t.ctx.tenantId, t.subjectId, input);
    return { ok: true, data: { state: leg.state } };
  } catch (e) {
    return toError(e);
  }
}

export async function carrierDriverPingAction(token: string, p: { lat: number; lng: number; accuracyM?: number | null; speedMph?: number | null; heading?: number | null }): Promise<ActionResult<{ ok: true }>> {
  const t = await resolveToken(token, "carrier_driver");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { carrierDriverPing } = await import("@/domain/carrier-portal");
    await carrierDriverPing(t.ctx.tenantId, t.subjectId, p);
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}

/** The caja / seal photo at a border-yard drop, from the partner driver's link. */
export async function carrierDriverCajaPhotoAction(token: string, form: FormData): Promise<ActionResult<{ id: string }>> {
  const t = await resolveToken(token, "carrier_driver");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("take the photo first · toma la foto primero"), { name: "ValidationError", field: "file" });
    const { db } = await import("@/db/client");
    const { legs } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [l] = await db.select({ carrierId: legs.carrierId }).from(legs).where(eq(legs.id, t.subjectId)).limit(1);
    if (!l?.carrierId) return { ok: false, error: "invalid link", code: "not_found" };
    const { portalUploadCajaPhoto } = await import("@/domain/carrier-portal");
    const mime = file.type || "image/jpeg";
    const row = await portalUploadCajaPhoto(t.ctx.tenantId, l.carrierId, t.subjectId, { fileName: file.name || "caja.jpg", mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    return toError(e);
  }
}

export async function carrierDriverPodAction(token: string, form: FormData): Promise<ActionResult<{ count: number }>> {
  const t = await resolveToken(token, "carrier_driver");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("take the photo first · toma la foto primero"), { name: "ValidationError", field: "file" });
    const { db } = await import("@/db/client");
    const { legs } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [l] = await db.select({ carrierId: legs.carrierId }).from(legs).where(eq(legs.id, t.subjectId)).limit(1);
    if (!l?.carrierId) return { ok: false, error: "invalid link", code: "not_found" };
    const { portalUploadPod } = await import("@/domain/carrier-portal");
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const rows = await portalUploadPod(t.ctx.tenantId, l.carrierId, t.subjectId, { fileName: file.name || "pod.jpg", mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, data: { count: rows.length } };
  } catch (e) {
    return toError(e);
  }
}

// ---------- customer portal ----------

async function customerFromToken(token: string) {
  const t = await resolveToken(token, "customer_portal");
  return t ? { tenantId: t.ctx.tenantId, customerId: t.subjectId } : null;
}

export async function portalRequestLoadAction(token: string, input: import("@/domain/customer-portal").LoadRequest): Promise<ActionResult<{ orderNumber: string }>> {
  const c = await customerFromToken(token);
  if (!c) return { ok: false, error: "This link is no longer valid. Ask your carrier contact for a new one.", code: "not_found" };
  try {
    const { portalRequestLoad } = await import("@/domain/customer-portal");
    const r = await portalRequestLoad(c.tenantId, c.customerId, input);
    return { ok: true, data: { orderNumber: r.order.orderNumber } };
  } catch (e) {
    return toError(e);
  }
}
