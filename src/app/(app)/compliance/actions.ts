"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as C from "@/domain/compliance";
import type { SubjectKind } from "@/domain/compliance";
import { parseDate } from "@/data/fields";

const touch = (kind?: SubjectKind, id?: string) => {
  revalidatePath("/compliance");
  revalidatePath("/dispatch");
  revalidatePath("/fleet");
  if (kind && id) revalidatePath(`/settings/${{ driver: "drivers", truck: "trucks", trailer: "trailers", carrier: "carriers" }[kind]}/${id}`);
};

export async function uploadSubjectDocAction(kind: SubjectKind, subjectId: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("pick a file"), { name: "ValidationError", field: "file" });
    const expires = String(form.get("expiresAt") ?? "");
    const issued = String(form.get("issuedAt") ?? "");
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const doc = await C.uploadSubjectDocument(ctx, kind, subjectId, { documentTypeId: String(form.get("documentTypeId") ?? ""), fileName: file.name, mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()), expiresAt: expires ? parseDate(expires) : null, issuedAt: issued ? parseDate(issued) : null, number: String(form.get("number") ?? "") || null, notes: String(form.get("notes") ?? "") || null });
    return { id: doc.id };
  });
  if (r.ok) touch(kind, subjectId);
  return r;
}

export async function snoozeAction(kind: SubjectKind, subjectId: string, itemKey: string, until: string, reason: string) {
  const r = await act((ctx) => C.snooze(ctx, kind, subjectId, itemKey, new Date(until), reason));
  if (r.ok) touch(kind, subjectId);
  return r;
}

export async function overrideDispatchAction(kind: SubjectKind, subjectId: string, reason: string) {
  const r = await act((ctx) => C.overrideDispatch(ctx, kind, subjectId, reason));
  if (r.ok) touch(kind, subjectId);
  return r;
}

export async function runComplianceAction() {
  const r = await act((ctx) => C.evaluateAll(ctx));
  if (r.ok) touch();
  return r;
}

export async function saveIncidentAction(id: string | null, v: { occurredAt: string; kind: string; driverId: string; truckId: string; trailerId: string; location: string; description: string; dotRecordable: boolean; injuries: boolean; towAway: boolean; policeReport: string; claimNumber: string; status: string }) {
  const r = await act((ctx) => C.saveIncident(ctx, id, { ...v, occurredAt: new Date(v.occurredAt), driverId: v.driverId || null, truckId: v.truckId || null, trailerId: v.trailerId || null, location: v.location || null, policeReport: v.policeReport || null, claimNumber: v.claimNumber || null }));
  if (r.ok) revalidatePath("/compliance/incidents");
  return r;
}

/** Read the chosen file with the AI extractor before it is uploaded: expiry, number, holder, for the person to confirm. */
export async function readSubjectDocAction(kind: SubjectKind, typeName: string, form: FormData) {
  return act(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw Object.assign(new Error("pick a file first"), { name: "ValidationError", field: "file" });
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    return C.readSubjectDocument(ctx, kind, typeName, { fileName: file.name, mimeType: mime, bytes: Buffer.from(await file.arrayBuffer()) });
  });
}
