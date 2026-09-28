"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as X from "@/domain/crossing";
import type { CrossingState } from "@/db/schema";

const touch = (id: string) => {
  revalidatePath(`/crossing/${id}`);
  revalidatePath("/crossing");
  revalidatePath("/dispatch");
};

export async function uploadDocAction(crossingId: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("pick a file"), { name: "ValidationError", field: "file" });
    const code = String(form.get("code") ?? "");
    const fields: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) if (k.startsWith("f_") && typeof v === "string" && v.trim()) fields[k.slice(2)] = v.trim();
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : /\.(jpe?g)$/i.test(file.name) ? "image/jpeg" : /\.png$/i.test(file.name) ? "image/png" : "application/octet-stream");
    const doc = await X.uploadDocument(ctx, crossingId, { code, fileName: file.name, mimeType: mime, bytes, fields, source: String(form.get("source") ?? "upload") });
    return { id: doc.id };
  });
  if (r.ok) touch(crossingId);
  return r;
}

export async function setFieldsAction(crossingId: string, documentId: string, fields: Record<string, string>, confirm: boolean) {
  const r = await act((ctx) => X.setDocumentFields(ctx, documentId, fields, confirm));
  if (r.ok) touch(crossingId);
  return r;
}

export async function extractAction(crossingId: string, documentId: string) {
  const r = await act((ctx) => X.extractDocumentFields(ctx, documentId));
  if (r.ok) touch(crossingId);
  return r;
}

export async function naAction(crossingId: string, code: string, reason: string) {
  const r = await act((ctx) => X.markNotApplicable(ctx, crossingId, code, reason));
  if (r.ok) touch(crossingId);
  return r;
}
export async function undoNaAction(crossingId: string, code: string) {
  const r = await act((ctx) => X.undoNotApplicable(ctx, crossingId, code));
  if (r.ok) touch(crossingId);
  return r;
}
export async function overrideCheckAction(crossingId: string, code: string, reason: string) {
  const r = await act((ctx) => X.overrideCheck(ctx, crossingId, code, reason));
  if (r.ok) touch(crossingId);
  return r;
}
export async function overrideEligibilityAction(crossingId: string, reason: string) {
  const r = await act((ctx) => X.overrideEligibility(ctx, crossingId, reason));
  if (r.ok) touch(crossingId);
  return r;
}
export async function setDetailsAction(crossingId: string, v: { trailerNumber?: string; sealNumber?: string; bridge?: string; portId?: string }) {
  const r = await act((ctx) => X.setCrossingDetails(ctx, crossingId, v));
  if (r.ok) touch(crossingId);
  return r;
}
export async function generateRetiroAction(crossingId: string, v: { yardName?: string; authorizedBy?: string }) {
  const r = await act((ctx) => X.generateCartaRetiro(ctx, crossingId, v));
  if (r.ok) touch(crossingId);
  return r;
}
export async function buildPacketAction(crossingId: string) {
  const r = await act((ctx) => X.buildPacket(ctx, crossingId));
  if (r.ok) touch(crossingId);
  return r;
}
export async function sendPacketAction(crossingId: string, opts: { dispatchLeg?: boolean } = {}) {
  const r = await act((ctx) => X.sendPacket(ctx, crossingId, opts));
  if (r.ok) touch(crossingId);
  return r;
}
export async function stepAction(crossingId: string, to: CrossingState, note?: string) {
  const r = await act((ctx) => X.step(ctx, crossingId, to, { source: "dispatcher", note }));
  if (r.ok) touch(crossingId);
  return r;
}
export async function holdCrossingAction(crossingId: string, reason: string) {
  const r = await act((ctx) => X.hold(ctx, crossingId, reason));
  if (r.ok) touch(crossingId);
  return r;
}
export async function releaseCrossingAction(crossingId: string) {
  const r = await act((ctx) => X.release(ctx, crossingId));
  if (r.ok) touch(crossingId);
  return r;
}
export async function returnedAction(crossingId: string, reason: string) {
  const r = await act((ctx) => X.markReturned(ctx, crossingId, reason));
  if (r.ok) touch(crossingId);
  return r;
}
export async function reverifyAction(crossingId: string) {
  const r = await act((ctx) => X.reverify(ctx, crossingId));
  if (r.ok) touch(crossingId);
  return r;
}
export async function arrivedYardAction(crossingId: string) {
  const r = await act((ctx) => X.markArrivedYard(ctx, crossingId, { source: "dispatcher" }));
  if (r.ok) touch(crossingId);
  return r;
}
export async function recomputeAction(crossingId: string) {
  const r = await act((ctx) => X.recompute(ctx, crossingId));
  if (r.ok) touch(crossingId);
  return r;
}
export async function openCrossingForLegAction(legId: string) {
  return act(async (ctx) => {
    const c = await X.ensureCrossing(ctx, legId);
    return { id: c.id };
  });
}
