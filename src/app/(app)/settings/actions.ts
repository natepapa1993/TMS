"use server";

import { revalidatePath } from "next/cache";
import { act, type ActionResult } from "@/lib/action";
import { coerce, KIND_META } from "@/data/fields";
import { create, update, archive, restore, type RecordKind, ValidationErrorLike } from "@/data/records";
import { previewImport, commitImport, type ImportPreview } from "@/data/import";
import { setTruckOos, setTruckActive } from "@/domain/orders";
import { hashPassword } from "@/lib/auth";
import { requirePermission } from "@/lib/context";
import { db } from "@/db/client";
import { ediPartners } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export type SaveResult = ActionResult<{ id: string }> & { errors?: Record<string, string> };

export async function saveRecord(kind: RecordKind, id: string | null, raw: Record<string, string>, expectedUpdatedAt?: string): Promise<SaveResult> {
  const { values, errors, ok } = coerce(kind, raw, { partial: !!id });
  if (!ok) return { ok: false, error: Object.values(errors)[0], errors, code: "validation" };
  if (kind === "user" && raw.password) values.passwordHash = await hashPassword(raw.password);
  const r = await act(async (ctx) => {
    const row = id ? await update(ctx, kind, id, values, expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined) : await create(ctx, kind, values);
    return { id: row.id as string };
  });
  if (r.ok) {
    revalidatePath(`/settings/${KIND_META[kind].path}`);
    revalidatePath("/fleet");
    revalidatePath("/dispatch");
    revalidatePath("/compliance");
    // compliance re-evaluates on every record / rule save (spec §6.1)
    await act(async (ctx) => {
      const C = await import("@/domain/compliance");
      if (kind === "driver" || kind === "truck" || kind === "trailer" || kind === "carrier") await C.evaluateSubject(ctx, kind, r.data.id);
      if (kind === "documentType") await C.evaluateAll(ctx);
    });
  } else if (r.code === "duplicate") {
    const uniq = ValidationErrorLike(kind);
    return { ...r, errors: uniq ? { [uniq]: r.error } : undefined };
  }
  return r;
}

export async function archiveRecord(kind: RecordKind, id: string) {
  const r = await act(async (ctx) => archive(ctx, kind, id));
  if (r.ok) revalidatePath(`/settings/${KIND_META[kind].path}`);
  return r;
}

export async function restoreRecord(kind: RecordKind, id: string) {
  const r = await act(async (ctx) => restore(ctx, kind, id));
  if (r.ok) revalidatePath(`/settings/${KIND_META[kind].path}`);
  return r;
}

export async function previewImportAction(kind: RecordKind, text: string, mapping?: Record<string, string>): Promise<ActionResult<ImportPreview>> {
  return act(async (ctx) => previewImport(ctx, kind, text, mapping));
}

export async function commitImportAction(kind: RecordKind, fileName: string, text: string, mapping: Record<string, string>) {
  const r = await act(async (ctx) => commitImport(ctx, kind, fileName, text, mapping));
  if (r.ok) revalidatePath(`/settings/${KIND_META[kind].path}`);
  return r;
}

export async function truckOosAction(truckId: string, reason: string, until?: string) {
  const r = await act(async (ctx) => setTruckOos(ctx, truckId, reason, until ? new Date(until) : null));
  if (r.ok) {
    revalidatePath("/fleet");
    revalidatePath("/dispatch");
    revalidatePath("/settings/trucks");
  }
  return r;
}

export async function truckActiveAction(truckId: string) {
  const r = await act(async (ctx) => setTruckActive(ctx, truckId));
  if (r.ok) {
    revalidatePath("/fleet");
    revalidatePath("/dispatch");
    revalidatePath("/settings/trucks");
  }
  return r;
}

export async function saveCompanyAction(values: { name: string; timeZone: string; fuelCostPerMile: string; qb?: Record<string, string>; dispatchPhone?: string }) {
  const r = await act(async (ctx) => {
    const { updateCompany } = await import("@/domain/company");
    const cpm = values.fuelCostPerMile.trim() ? Math.round(Number(values.fuelCostPerMile.replace(/[$,\s]/g, "")) * 100) : null;
    if (values.fuelCostPerMile.trim() && !Number.isFinite(cpm)) throw Object.assign(new Error("Fuel cost must be an amount per mile"), { name: "ValidationError", field: "fuelCostPerMile" });
    return updateCompany(ctx, { name: values.name, timeZone: values.timeZone, fuelCostCentsPerMile: cpm, qb: values.qb, dispatchPhone: values.dispatchPhone });
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

export async function revokeCarrierPortalAction(carrierId: string) {
  const r = await act(async (ctx) => {
    const { revokeCarrierPortal } = await import("@/domain/carrier-portal");
    await revokeCarrierPortal(ctx, carrierId);
    return { ok: true };
  });
  if (r.ok) revalidatePath(`/settings/carriers/${carrierId}`);
  return r;
}

export async function revokeCustomerPortalAction(customerId: string) {
  const r = await act(async (ctx) => {
    const { revokeCustomerPortal } = await import("@/domain/customer-portal");
    await revokeCustomerPortal(ctx, customerId);
    return { ok: true };
  });
  if (r.ok) revalidatePath(`/settings/customers/${customerId}`);
  return r;
}

// ---------- EDI VAN mailbox ----------

export async function saveMailboxAction(partnerId: string, values: { enabled: boolean; host: string; port: number; username: string; password: string; privateKey: string; inbox: string; outbox: string; extension: string }) {
  const r = await act(async (ctx) => {
    const { saveMailbox } = await import("@/domain/edi-mailbox");
    return saveMailbox(ctx, partnerId, values);
  });
  if (r.ok) revalidatePath(`/settings/edi-partners/${partnerId}`);
  return r;
}

export async function testMailboxAction(partnerId: string) {
  return act(async (ctx) => {
    const { testMailbox } = await import("@/domain/edi-mailbox");
    return testMailbox(ctx, partnerId);
  });
}

export async function pollMailboxAction(partnerId: string) {
  const r = await act(async (ctx) => {
    requirePermission(ctx, "settings.edit");
    const { pollMailbox } = await import("@/domain/edi-mailbox");
    const [p] = await db.select({ tenantId: ediPartners.tenantId }).from(ediPartners).where(and(eq(ediPartners.id, partnerId), eq(ediPartners.tenantId, ctx.tenantId))).limit(1);
    if (!p) throw Object.assign(new Error("EDI partner not found"), { name: "NotFoundError" });
    return pollMailbox(partnerId);
  });
  if (r.ok) {
    revalidatePath(`/settings/edi-partners/${partnerId}`);
    revalidatePath("/edi");
    revalidatePath("/dispatch");
  }
  return r;
}

export async function revokeDriverAppAction(driverId: string) {
  const r = await act(async (ctx) => {
    const { revokeTokensFor } = await import("@/lib/tokens");
    const { writeAudit } = await import("@/lib/audit");
    const { db } = await import("@/db/client");
    await revokeTokensFor(ctx, "driver_app", driverId);
    await writeAudit(db, ctx, "driver", driverId, "update", { driverApp: { from: "link", to: "revoked" } }, "driver app link revoked");
    return { ok: true };
  });
  if (r.ok) revalidatePath(`/settings/drivers/${driverId}`);
  return r;
}
