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

export type TestForm = { driverId: string; reason: string; substance: string; incidentId?: string; collectedAt?: string; result?: string; specimenId?: string; collector?: string; mro?: string; followUpPlanned?: string; followUpMonths?: string; note?: string; specimenType?: string; mroVerifiedAt?: string; observed?: boolean; sapName?: string; sapEvaluatedAt?: string; sapEducationDoneAt?: string };
type ResultForm = Omit<TestForm, "driverId" | "reason" | "substance" | "incidentId"> & { result: string };

const num = (v: string | undefined) => (v === undefined ? undefined : v.trim() ? Number(v) : null);
/** The test's details from the dialog: dates as instants, numbers as numbers; a field left out stays as it is. */
const details = (v: ResultForm) => ({
  specimenId: v.specimenId,
  collector: v.collector,
  mro: v.mro,
  note: v.note,
  specimenType: v.specimenType,
  observed: v.observed,
  sapName: v.sapName,
  followUpPlanned: num(v.followUpPlanned),
  followUpMonths: num(v.followUpMonths),
  collectedAt: v.collectedAt === undefined ? undefined : when(v.collectedAt),
  mroVerifiedAt: v.mroVerifiedAt === undefined ? undefined : when(v.mroVerifiedAt),
  sapEvaluatedAt: v.sapEvaluatedAt === undefined ? undefined : when(v.sapEvaluatedAt),
  sapEducationDoneAt: v.sapEducationDoneAt === undefined ? undefined : when(v.sapEducationDoneAt),
});
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as Partial<T>;

export async function addTestAction(v: TestForm) {
  const r = await act(async (ctx) => {
    const d = details({ ...v, result: v.result ?? "pending" });
    const row = await S.addTest(ctx, { ...defined(d), driverId: v.driverId, reason: v.reason, substance: v.substance, result: v.result, incidentId: v.incidentId || null, collectedAt: d.collectedAt ?? null, followUpPlanned: d.followUpPlanned ?? null, followUpMonths: d.followUpMonths ?? null, mroVerifiedAt: d.mroVerifiedAt ?? null, sapEvaluatedAt: d.sapEvaluatedAt ?? null, sapEducationDoneAt: d.sapEducationDoneAt ?? null });
    return { id: row.id };
  });
  if (r.ok) touch(v.driverId);
  return r;
}

export async function recordResultAction(testId: string, v: ResultForm) {
  const r = await act(async (ctx) => {
    const row = await S.recordResult(ctx, testId, { ...defined(details(v)), result: v.result } as Parameters<typeof S.recordResult>[2]);
    return { driverId: row.driverId };
  });
  if (r.ok) touch(r.data.driverId);
  return r;
}

/** The CCF, the MRO letter or the breath test form, kept with the test (confidential like the result). */
export async function attachTestDocumentAction(testId: string, form: FormData) {
  const r = await act(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw bad("pick the file", "file");
    return S.attachTestDocument(ctx, testId, { fileName: file.name, mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"), bytes: Buffer.from(await file.arrayBuffer()) });
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
