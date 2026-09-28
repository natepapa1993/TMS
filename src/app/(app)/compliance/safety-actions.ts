"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as S from "@/domain/safety";
import { parseDate } from "@/data/fields";
import type { Violation } from "@/db/schema";

const touch = (driverId?: string | null) => {
  revalidatePath("/compliance");
  revalidatePath("/compliance/drivers");
  revalidatePath("/compliance/drug-alcohol");
  revalidatePath("/compliance/inspections");
  revalidatePath("/dispatch");
  if (driverId) {
    revalidatePath(`/compliance/drivers/${driverId}`);
    revalidatePath(`/settings/drivers/${driverId}`);
  }
};
const bad = (message: string, field: string) => Object.assign(new Error(message), { name: "ValidationError", field });
/** A date picked in a form is a calendar day: keep it on that day (noon UTC). A datetime keeps its instant. */
const when = (v: FormDataEntryValue | string | null | undefined) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDate(s) : new Date(s);
};

export async function recordDqAction(driverId: string, itemKey: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    const f = file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"), bytes: Buffer.from(await file.arrayBuffer()) } : null;
    const row = await S.recordDq(ctx, driverId, itemKey, { completedAt: when(form.get("completedAt")), notRequired: form.get("notRequired") === "1", note: String(form.get("note") ?? ""), file: f });
    return { id: row.id };
  });
  if (r.ok) touch(driverId);
  return r;
}

export type TestForm = { driverId: string; reason: string; substance: string; incidentId?: string; collectedAt?: string; result?: string; specimenId?: string; collector?: string; mro?: string; followUpPlanned?: string; note?: string };

export async function addTestAction(v: TestForm) {
  const r = await act(async (ctx) => {
    const row = await S.addTest(ctx, { ...v, incidentId: v.incidentId || null, collectedAt: when(v.collectedAt), followUpPlanned: v.followUpPlanned ? Number(v.followUpPlanned) : null });
    return { id: row.id };
  });
  if (r.ok) touch(v.driverId);
  return r;
}

export async function recordResultAction(testId: string, v: { collectedAt?: string; result: string; specimenId?: string; collector?: string; mro?: string; followUpPlanned?: string; note?: string }) {
  const r = await act(async (ctx) => {
    const row = await S.recordResult(ctx, testId, { ...v, collectedAt: v.collectedAt === undefined ? undefined : when(v.collectedAt), followUpPlanned: v.followUpPlanned ? Number(v.followUpPlanned) : undefined });
    return { driverId: row.driverId };
  });
  if (r.ok) touch(r.data.driverId);
  return r;
}

export async function clearinghouseReportedAction(testId: string, at: string) {
  const r = await act(async (ctx) => {
    const d = when(at);
    if (!d) throw bad("the date you reported it", "at");
    const row = await S.markClearinghouseReported(ctx, testId, d);
    return { driverId: row.driverId };
  });
  if (r.ok) touch(r.data.driverId);
  return r;
}

export async function drawRandomAction(v: { period: string; drugRate: string; alcoholRate: string; drawsPerYear: string }) {
  const r = await act((ctx) => S.drawRandom(ctx, { period: v.period, drugRate: Number(v.drugRate), alcoholRate: Number(v.alcoholRate), drawsPerYear: Number(v.drawsPerYear) }));
  if (r.ok) touch();
  return r;
}

export type InspectionForm = { inspectedAt: string; reportNumber: string; country: string; jurisdiction: string; level: string; hazmat: boolean; driverId: string; truckId: string; trailerId: string; orderId: string; location: string; dataQs: string; note: string; driverOosUntil: string; oosReleaseReason?: string; violations: { code: string; description: string; basic: string; severity: string; oos: boolean; unit: string; on: string; removed: boolean }[] };

export async function saveInspectionAction(id: string | null, v: InspectionForm) {
  const r = await act(async (ctx) => {
    const at = when(v.inspectedAt);
    if (!at) throw bad("when was the inspection?", "inspectedAt");
    const row = await S.saveInspection(ctx, id, { ...v, inspectedAt: at, level: Number(v.level), driverOosUntil: when(v.driverOosUntil), violations: v.violations.map((x) => ({ ...x, basic: (x.basic || undefined) as Violation["basic"] | undefined, severity: x.severity === "" ? undefined : Number(x.severity), unit: (x.unit || undefined) as Violation["unit"] | undefined, on: (x.on || undefined) as Violation["on"] })) });
    return { id: row.id, driverId: row.driverId };
  });
  if (r.ok) touch(r.data.driverId);
  return r;
}

export async function deleteInspectionAction(id: string, reason?: string) {
  const r = await act((ctx) => S.deleteInspection(ctx, id, reason));
  if (r.ok) touch();
  return r;
}

/** Safety certifies the repair after a vehicle out-of-service order: the unit is back in service. */
export async function signOffRepairAction(inspectionId: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    const f = file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"), bytes: Buffer.from(await file.arrayBuffer()) } : null;
    const raw = String(form.get("at") ?? "").trim();
    const row = await S.signOffRepair(ctx, inspectionId, { note: String(form.get("note") ?? ""), at: when(raw), dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(raw), file: f });
    return { id: row.id, driverId: row.driverId };
  });
  if (r.ok) {
    touch(r.data.driverId);
    revalidatePath("/fleet");
    revalidatePath("/dispatch/planner");
  }
  return r;
}
