"use server";

import { revalidatePath } from "next/cache";
import { act, type ActionResult } from "@/lib/action";
import { coerce, KIND_META } from "@/data/fields";
import { create, update, archive, restore, type RecordKind, ValidationErrorLike } from "@/data/records";
import { previewImport, commitImport, type ImportPreview } from "@/data/import";
import { setTruckOos, setTruckActive } from "@/domain/orders";
import { hashPassword } from "@/lib/auth";

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
