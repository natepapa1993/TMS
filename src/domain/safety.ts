import { and, eq, desc, gte, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { DA_REASONS, DA_RESULTS, type DaReason, type DaResult, type Violation } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";
import { evaluateSubject, isBuiltIn } from "./compliance";
import { DQ_ITEMS, dqLines, daStanding, clearinghouseDuty, randomRequirement, perDraw, pick, postAccidentDuty, basicOf, unitOf, basicMeasures, oosRates, driverPoints, BASICS, periodStart, lookupViolation, roadsideOos, oosReleaseNeedsReason, repairInstant } from "./safety-rules";
import { zonedDate } from "@/lib/time";

/**
 * Safety depth: the driver qualification file, the drug & alcohol program, roadside inspections with the
 * BASICs, and one log of every override. Rules live in safety-rules.ts; this file reads and writes.
 */

async function loadDriver(ctx: Ctx, driverId: string) {
  const [d] = await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!d) throw new NotFoundError("driver", driverId);
  return d;
}

async function storeFile(ctx: Ctx, subjectId: string, code: string, file: { fileName: string; mimeType: string; bytes: Buffer }, subjectKind: "driver" | "truck" | "trailer" = "driver") {
  if (!file.bytes?.length) throw new ValidationError("empty file", "file");
  if (file.bytes.length > 15 * 1024 * 1024) throw new ValidationError("file is over 15 MB", "file");
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.mimeType)) throw new ValidationError("PDF, JPG or PNG only", "file");
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: file.mimeType, sizeBytes: file.bytes.length, bytes: file.bytes }).returning({ id: s.documentBlobs.id });
  const [doc] = await db.insert(s.documents).values({ id: newId(), tenantId: ctx.tenantId, documentTypeId: null, code, subjectKind, subjectId, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: "upload", status: "present", createdBy: ctx.userId, updatedBy: ctx.userId }).returning({ id: s.documents.id });
  return doc.id;
}

// ---------- the driver qualification file ----------

export type DqInput = { completedAt?: Date | null; notRequired?: boolean; note?: string | null; file?: { fileName: string; mimeType: string; bytes: Buffer } | null };

/** Record a DQ item done on a date (with the paper, when there is one), or not required for this driver with why. */
export async function recordDq(ctx: Ctx, driverId: string, itemKey: string, input: DqInput) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  const def = DQ_ITEMS.find((d) => d.key === itemKey);
  if (!def) throw new ValidationError("unknown qualification item", "itemKey");
  const driver = await loadDriver(ctx, driverId);
  const note = input.note?.trim() || null;
  if (input.notRequired) {
    if (!note) throw new ValidationError(itemKey === "pre_employment_test" ? "say which exception of 382.301(b) applies" : "say why it isn't required for this driver", "note");
  } else {
    if (!input.completedAt || Number.isNaN(input.completedAt.getTime())) throw new ValidationError("the date it was done", "completedAt");
    if (input.completedAt.getTime() > Date.now() + 86400_000) throw new ValidationError("that date is in the future", "completedAt");
  }
  const documentId = input.file ? await storeFile(ctx, driverId, `dq:${itemKey}`, input.file) : null;
  const row = { id: newId(), tenantId: ctx.tenantId, driverId, itemKey, completedAt: input.notRequired ? null : input.completedAt!, notRequired: !!input.notRequired, note, documentId, createdBy: ctx.userId };
  await db.insert(s.dqRecords).values(row);
  await writeAudit(db, ctx, "driver", driverId, "update", { [def.label({ driverType: driver.driverType, licenseState: driver.licenseState })]: { from: null, to: input.notRequired ? "not required" : row.completedAt!.toISOString().slice(0, 10) } }, note ?? undefined);
  await evaluateSubject(ctx, "driver", driverId);
  return row;
}

/** Every driver's file at a glance: how many items are ok, due, overdue, missing. */
export async function dqOverview(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const [drivers, records, tests] = await Promise.all([
    db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))).orderBy(s.drivers.name),
    db.select().from(s.dqRecords).where(eq(s.dqRecords.tenantId, ctx.tenantId)),
    db.select().from(s.daTests).where(eq(s.daTests.tenantId, ctx.tenantId)),
  ]);
  return drivers.map((d) => {
    const lines = dqLines(d, records.filter((r) => r.driverId === d.id), daStanding(tests.filter((t) => t.driverId === d.id)).preEmploymentNegativeAt);
    return { id: d.id, name: d.name, driverType: d.driverType, hireDate: d.hireDate, lines, missing: lines.filter((l) => l.status === "missing").length, overdue: lines.filter((l) => l.status === "expired").length, due: lines.filter((l) => l.status === "expiring").length };
  });
}

// ---------- drug & alcohol ----------


export type DaTestInput = { driverId: string; reason: string; substance: string; incidentId?: string | null; collectedAt?: Date | null; result?: string; specimenId?: string | null; collector?: string | null; mro?: string | null; followUpPlanned?: number | null; note?: string | null };

function checkResult(result: string, collectedAt: Date | null | undefined) {
  if (!(DA_RESULTS as readonly string[]).includes(result)) throw new ValidationError("pick a result", "result");
  if (["negative", "negative_dilute", "positive"].includes(result) && !collectedAt) throw new ValidationError("when was the specimen collected?", "collectedAt");
  if (collectedAt && collectedAt.getTime() > Date.now() + 3600_000) throw new ValidationError("the collection time is in the future", "collectedAt");
}

/** A test ordered or done outside a random draw: pre-employment, post-accident, reasonable suspicion, return-to-duty, follow-up. */
export async function addTest(ctx: Ctx, input: DaTestInput) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  if (!(DA_REASONS as readonly string[]).includes(input.reason)) throw new ValidationError("pick why the test is done", "reason");
  if (input.reason === "random") throw new ValidationError("random tests come from a draw", "reason");
  if (input.substance !== "drug" && input.substance !== "alcohol") throw new ValidationError("drug or alcohol", "substance");
  if (input.reason === "pre_employment" && input.substance === "alcohol") throw new ValidationError("pre-employment alcohol tests are optional and not tracked here; record the drug test", "substance");
  const driver = await loadDriver(ctx, input.driverId);
  const result = (input.result || "pending") as DaResult;
  checkResult(result, input.collectedAt);
  if (input.reason === "return_to_duty" && input.followUpPlanned != null && (input.followUpPlanned < 6 || input.followUpPlanned > 60)) throw new ValidationError("the SAP sets at least 6 follow-up tests in the first 12 months (40.307)", "followUpPlanned");
  if (input.incidentId) {
    const [inc] = await db.select({ id: s.incidents.id }).from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), eq(s.incidents.id, input.incidentId))).limit(1);
    if (!inc) throw new NotFoundError("incident", input.incidentId);
  }
  const [row] = await db
    .insert(s.daTests)
    .values({ id: newId(), tenantId: ctx.tenantId, driverId: driver.id, reason: input.reason as DaReason, substance: input.substance, incidentId: input.incidentId ?? null, collectedAt: input.collectedAt ?? null, result, resultAt: result !== "pending" ? new Date() : null, specimenId: input.specimenId?.trim() || null, collector: input.collector?.trim() || null, mro: input.mro?.trim() || null, followUpPlanned: input.reason === "return_to_duty" ? (input.followUpPlanned ?? null) : null, note: input.note?.trim() || null, createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning();
  await writeAudit(db, ctx, "da_test", row.id, "create", undefined, `${input.reason.replace(/_/g, " ")} ${input.substance} test`);
  await afterResult(ctx, row);
  return row;
}

/** The result comes in (or a selected driver was collected, or refused). */
export async function recordResult(ctx: Ctx, testId: string, input: { collectedAt?: Date | null; result: string; specimenId?: string | null; collector?: string | null; mro?: string | null; followUpPlanned?: number | null; note?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  const [t] = await db.select().from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.id, testId))).limit(1);
  if (!t) throw new NotFoundError("test", testId);
  const collectedAt = input.collectedAt === undefined ? t.collectedAt : input.collectedAt;
  checkResult(input.result, collectedAt);
  if (input.result === "selected") throw new ValidationError("pick a result", "result");
  const [row] = await db
    .update(s.daTests)
    .set({ collectedAt, result: input.result as DaResult, resultAt: input.result === "pending" ? null : new Date(), specimenId: input.specimenId === undefined ? t.specimenId : input.specimenId?.trim() || null, collector: input.collector === undefined ? t.collector : input.collector?.trim() || null, mro: input.mro === undefined ? t.mro : input.mro?.trim() || null, followUpPlanned: t.reason === "return_to_duty" && input.followUpPlanned !== undefined ? input.followUpPlanned : t.followUpPlanned, note: input.note === undefined ? t.note : input.note?.trim() || null, updatedAt: new Date(), updatedBy: ctx.userId })
    .where(eq(s.daTests.id, t.id))
    .returning();
  await writeAudit(db, ctx, "da_test", t.id, "update", { result: { from: t.result, to: row.result } });
  await afterResult(ctx, row);
  return row;
}

/** A positive or a refusal puts the driver on a safety hold: compliance re-runs and dispatch is told to reassign (without the reason). */
async function afterResult(ctx: Ctx, t: typeof s.daTests.$inferSelect) {
  await evaluateSubject(ctx, "driver", t.driverId);
  if (t.result !== "positive" && t.result !== "refusal") return;
  const driver = await loadDriver(ctx, t.driverId);
  const legs = await db
    .select({ id: s.legs.id, orderId: s.legs.orderId })
    .from(s.legs)
    .where(and(eq(s.legs.tenantId, ctx.tenantId), sql`(${s.legs.driverId} = ${t.driverId} or ${s.legs.coDriverId} = ${t.driverId})`, inArray(s.legs.state, ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"])));
  for (const l of legs) await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: l.orderId, legId: l.id, code: "safety_hold", level: "red", title: `${driver.name} is on a safety hold`, detail: "Safety has taken the driver off safety-sensitive work. Put another driver on the leg; ask Safety, not the driver, for details.", owner: "dispatch" });
}

export async function markClearinghouseReported(ctx: Ctx, testId: string, at = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  const [row] = await db.update(s.daTests).set({ clearinghouseReportedAt: at, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.id, testId))).returning();
  if (!row) throw new NotFoundError("test", testId);
  await writeAudit(db, ctx, "da_test", testId, "update", { clearinghouse: { from: null, to: at.toISOString().slice(0, 10) } });
  return row;
}

/** Drivers in the random pool: active, not archived, not already on a hold (they are in the return-to-duty process). */
async function poolFor(ctx: Ctx) {
  const [drivers, tests] = await Promise.all([db.select({ id: s.drivers.id, name: s.drivers.name, status: s.drivers.status }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt))), db.select().from(s.daTests).where(eq(s.daTests.tenantId, ctx.tenantId))]);
  return drivers.filter((d) => d.status !== "inactive" && !daStanding(tests.filter((t) => t.driverId === d.id)).prohibited);
}

/**
 * A random draw (382.305): every driver in the pool has the same chance each time; the annual rate is spread
 * over the year's draws. Drug and alcohol picks are separate, so one driver can be picked for both.
 */
export async function drawRandom(ctx: Ctx, input: { period: string; drugRate: number; alcoholRate: number; drawsPerYear: number }, rand: (max: number) => number = randomInt, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  const period = input.period.trim();
  const starts = periodStart(period);
  if (!starts) throw new ValidationError("a period like 2026-Q4 or 2026-11", "period");
  // a selection is made during the period it covers (382.305(k)): drawing next quarter's names now would warn them
  if (starts.getTime() > now.getTime()) throw new ValidationError(`${period} starts ${starts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} — draw it then`, "period");
  if (![1, 2, 4, 12].includes(input.drawsPerYear)) throw new ValidationError("draw 1, 2, 4 or 12 times a year", "drawsPerYear");
  if (!(input.drugRate >= 0 && input.drugRate <= 100 && input.alcoholRate >= 0 && input.alcoholRate <= 100)) throw new ValidationError("rates are annual percentages", "drugRate");
  const [dup] = await db.select({ id: s.daDraws.id }).from(s.daDraws).where(and(eq(s.daDraws.tenantId, ctx.tenantId), eq(s.daDraws.period, period))).limit(1);
  if (dup) throw new ValidationError(`${period} is already drawn`, "period");
  const pool = await poolFor(ctx);
  if (!pool.length) throw new ValidationError("no drivers in the pool", "period");
  const drugCount = perDraw(pool.length, input.drugRate, input.drawsPerYear);
  const alcoholCount = perDraw(pool.length, input.alcoholRate, input.drawsPerYear);
  const drug = pick(pool, drugCount, rand);
  const alcohol = pick(pool, alcoholCount, rand);
  const drawId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(s.daDraws).values({ id: drawId, tenantId: ctx.tenantId, period, drawnAt: now, poolSize: pool.length, poolDriverIds: pool.map((p) => p.id), drugRate: input.drugRate, alcoholRate: input.alcoholRate, drawsPerYear: input.drawsPerYear, drugCount, alcoholCount, drawnBy: ctx.userId });
    const rows = [...drug.map((d) => ({ d, substance: "drug" as const })), ...alcohol.map((d) => ({ d, substance: "alcohol" as const }))];
    if (rows.length) await tx.insert(s.daTests).values(rows.map(({ d, substance }) => ({ id: newId(), tenantId: ctx.tenantId, driverId: d.id, reason: "random" as const, substance, drawId, selectedAt: now, result: "selected" as const, createdBy: ctx.userId, updatedBy: ctx.userId })));
    await writeAudit(tx, ctx, "da_draw", drawId, "create", undefined, `${period}: pool ${pool.length}, ${drugCount} drug / ${alcoholCount} alcohol`);
  });
  return { drawId, period, poolSize: pool.length, drug: drug.map((d) => d.name), alcohol: alcohol.map((d) => d.name) };
}

/** The program for a year: draws, what the rates require, what's done, holds, Clearinghouse to-dos, post-accident tests owed. */
export async function daProgram(ctx: Ctx, year: number) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  const [draws, tests, drivers, incidents] = await Promise.all([
    db.select().from(s.daDraws).where(and(eq(s.daDraws.tenantId, ctx.tenantId), sql`${s.daDraws.period} like ${`${year}-%`}`)).orderBy(s.daDraws.period),
    db.select().from(s.daTests).where(eq(s.daTests.tenantId, ctx.tenantId)).orderBy(desc(s.daTests.createdAt)),
    db.select({ id: s.drivers.id, name: s.drivers.name, archivedAt: s.drivers.archivedAt }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
    db.select().from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), isNull(s.incidents.archivedAt), gte(s.incidents.occurredAt, new Date(Date.now() - 30 * 86400_000)))),
  ]);
  const name = new Map(drivers.map((d) => [d.id, d.name]));
  const inYear = (t: (typeof tests)[number]) => {
    const w = t.collectedAt ?? t.selectedAt ?? t.createdAt;
    return w >= from && w < to;
  };
  const req = randomRequirement(draws);
  const doneRandom = (sub: string) => tests.filter((t) => inYear(t) && t.reason === "random" && t.substance === sub && !["selected", "pending", "cancelled"].includes(t.result)).length;
  const standing = drivers.filter((d) => !d.archivedAt).map((d) => ({ id: d.id, name: d.name, ...daStanding(tests.filter((t) => t.driverId === d.id)) }));
  const duties = tests.filter((t) => !t.clearinghouseReportedAt && clearinghouseDuty(t)).map((t) => ({ id: t.id, driver: name.get(t.driverId) ?? "?", duty: clearinghouseDuty(t)!, at: (t.resultAt ?? t.createdAt).toISOString() }));
  const postAccident = incidents
    .map((i) => ({ i, duty: postAccidentDuty(i) }))
    .filter((x) => x.duty && x.i.driverId)
    .map(({ i, duty }) => {
      const mine = tests.filter((t) => t.incidentId === i.id);
      return { incidentId: i.id, driverId: i.driverId!, driver: name.get(i.driverId!) ?? "?", occurredAt: i.occurredAt.toISOString(), ...duty!, alcoholDone: mine.some((t) => t.substance === "alcohol"), drugDone: mine.some((t) => t.substance === "drug") };
    });
  return {
    year,
    // the roster an auditor asks for: who was in the pool at each draw, and who was picked
    draws: draws.map((d) => ({ ...d, pool: d.poolDriverIds.map((id) => ({ id, name: name.get(id) ?? "(removed driver)" })).sort((p, q) => p.name.localeCompare(q.name)), selected: tests.filter((t) => t.drawId === d.id).map((t) => ({ name: name.get(t.driverId) ?? "?", substance: t.substance, result: t.result })) })),
    required: req,
    done: { drug: doneRandom("drug"), alcohol: doneRandom("alcohol") },
    tests: tests.filter((t) => inYear(t) || t.result === "selected" || t.result === "pending").map((t) => ({ ...t, driver: name.get(t.driverId) ?? "?", duty: clearinghouseDuty(t) })),
    open: tests.filter((t) => t.result === "selected" || t.result === "pending").length,
    holds: standing.filter((x) => x.prohibited || x.followUp).map((x) => ({ id: x.id, name: x.name, prohibited: x.prohibited, followUp: x.followUp, since: x.violation ? (x.violation.resultAt ?? x.violation.createdAt).toISOString() : null })),
    duties,
    postAccident,
    pool: (await poolFor(ctx)).length,
  };
}

/** One driver's tests, for the safety file (owner and Safety only). */
export async function driverTests(ctx: Ctx, driverId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "safety.confidential");
  const tests = await db.select().from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.driverId, driverId))).orderBy(desc(s.daTests.createdAt));
  return { tests: tests.map((t) => ({ ...t, duty: t.clearinghouseReportedAt ? null : clearinghouseDuty(t) })), standing: daStanding(tests) };
}

// ---------- roadside inspections ----------

export type InspectionInput = { inspectedAt: Date; reportNumber?: string | null; country: string; jurisdiction?: string | null; level: number; hazmat?: boolean; driverId?: string | null; truckId?: string | null; trailerId?: string | null; orderId?: string | null; location?: string | null; violations: Partial<Violation>[]; dataQs?: string; note?: string | null; driverOosUntil?: Date | null; /** why an out-of-service finding is taken off without a repair (data entry error, DataQs…) */ oosReleaseReason?: string | null };

/**
 * A roadside inspection. US violations need their BASIC and SMS weight (the common codes fill in from the
 * table); Canadian and Mexican ones are kept as written — code, description, OOS — and stay out of SMS.
 * An out-of-service finding takes effect: a vehicle OOS takes the truck or trailer out of service until a
 * repair is signed off on the inspection (396.9(c)–(d)); a driver OOS makes the driver unavailable until
 * the time on the order.
 */
export async function saveInspection(ctx: Ctx, id: string | null, input: InspectionInput) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  if (!input.inspectedAt || Number.isNaN(input.inspectedAt.getTime())) throw new ValidationError("when was the inspection?", "inspectedAt");
  if (input.inspectedAt.getTime() > Date.now() + 86400_000) throw new ValidationError("the inspection date is in the future", "inspectedAt");
  if (!["US", "CA", "MX"].includes(input.country)) throw new ValidationError("country: US, CA or MX", "country");
  if (!(input.level >= 1 && input.level <= 7)) throw new ValidationError("CVSA level 1 to 7", "level");
  if (!input.driverId && !input.truckId && !input.trailerId) throw new ValidationError("the driver or the unit inspected", "driverId");
  if (!["none", "filed", "accepted", "denied"].includes(input.dataQs ?? "none")) throw new ValidationError("DataQs status", "dataQs");
  const us = input.country === "US";
  const violations: Violation[] = input.violations
    .filter((v) => v.code?.trim() || v.description?.trim())
    .map((v, i) => {
      const code = (v.code ?? "").trim();
      if (!code) throw new ValidationError(`violation ${i + 1}: the code (e.g. 395.8(e))`, `violations.${i}.code`);
      const known = us ? lookupViolation(code) : null;
      const basic = (v.basic || known?.basic || (us ? basicOf(code) : null) || null) as Violation["basic"];
      const on = v.on === "truck" || v.on === "trailer" ? v.on : undefined;
      if (!us) {
        // Canada (CVOR / NSC) and Mexico (SCT): no BASIC, no SMS weight — record what the report says
        const severity = v.severity == null || String(v.severity) === "" ? 0 : Number(v.severity);
        return { code, description: (v.description ?? "").trim() || code, basic: basic && BASICS.some((b) => b.key === basic) ? basic : null, severity: Number.isFinite(severity) ? Math.max(0, Math.min(10, Math.round(severity))) : 0, oos: !!v.oos, unit: v.unit === "driver" || v.unit === "vehicle" ? v.unit : basic ? unitOf(basic) : "driver", ...(on ? { on } : {}), removed: !!v.removed };
      }
      if (!basic || !BASICS.some((b) => b.key === basic)) throw new ValidationError(`violation ${i + 1}: pick its BASIC`, `violations.${i}.basic`);
      const severity = Number(v.severity == null || String(v.severity) === "" ? (known?.severity ?? 0) : v.severity);
      if (!(severity >= 1 && severity <= 10)) throw new ValidationError(`violation ${i + 1}: severity weight 1–10 (as SMS lists it)`, `violations.${i}.severity`);
      return { code, description: (v.description ?? "").trim() || known?.description || code, basic, severity: Math.round(severity), oos: !!v.oos, unit: v.unit === "driver" || v.unit === "vehicle" ? v.unit : unitOf(basic), ...(on ? { on } : {}), removed: !!v.removed };
    });
  const oos = roadsideOos({ violations, truckId: input.truckId, trailerId: input.trailerId, driverId: input.driverId });
  const driverOosUntil = oos.driver.length ? (input.driverOosUntil ?? null) : null;
  if (oos.driver.length && !driverOosUntil) throw new ValidationError("the driver is out of service until when? (from the OOS order: 10 h off duty, 34 h, until the medical card…)", "driverOosUntil");
  if (driverOosUntil && driverOosUntil.getTime() <= input.inspectedAt.getTime()) throw new ValidationError("the out-of-service order ends after the inspection", "driverOosUntil");
  const values = { inspectedAt: input.inspectedAt, reportNumber: input.reportNumber?.trim() || null, country: input.country, jurisdiction: input.jurisdiction?.trim().toUpperCase() || null, level: input.level, hazmat: !!input.hazmat, driverId: input.driverId || null, truckId: input.truckId || null, trailerId: input.trailerId || null, orderId: input.orderId || null, location: input.location?.trim() || null, violations, dataQs: input.dataQs ?? "none", note: input.note?.trim() || null, driverOosUntil };
  let row: typeof s.inspections.$inferSelect;
  if (id) {
    const [before] = await db.select().from(s.inspections).where(and(eq(s.inspections.tenantId, ctx.tenantId), eq(s.inspections.id, id))).limit(1);
    if (!before) throw new NotFoundError("inspection", id);
    // unticking OOS (or removing the finding) puts a unit or driver back to work without a repair: say why, on the record
    const release = oosReleaseNeedsReason(before, values);
    const reason = input.oosReleaseReason?.trim() || release.defaultReason;
    if (release.released && !reason) throw new ValidationError("Why is the out-of-service finding coming off without a repair? (data entry error, DataQs accepted…)", "oosReleaseReason");
    [row] = await db.update(s.inspections).set({ ...values, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.inspections.id, id)).returning();
    await writeAudit(db, ctx, "inspection", id, "update");
    if (release.released) await writeAudit(db, ctx, "inspection", id, "override", { oos: { from: "out of service", to: "finding removed" } }, reason!);
    // the driver or units changed on the edit: release whatever this inspection held before
    await applyRoadsideOos(ctx, row, before);
    return row;
  }
  [row] = await db.insert(s.inspections).values({ id: newId(), tenantId: ctx.tenantId, ...values, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
  await writeAudit(db, ctx, "inspection", row.id, "create", undefined, `${values.jurisdiction ?? values.country} level ${values.level}: ${violations.length ? `${violations.length} violation(s)${violations.some((v) => v.oos) ? ", OOS" : ""}` : "clean"}`);
  // an out-of-service driver or unit can't move until the defect is fixed: tell dispatch on the load
  if (values.orderId && violations.some((v) => v.oos && !v.removed)) await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: values.orderId, code: "roadside_oos", level: "red", title: "Placed out of service at a roadside inspection", detail: violations.filter((v) => v.oos).map((v) => `${v.code} ${v.description}`).join("; "), owner: "safety" });
  await applyRoadsideOos(ctx, row, null);
  return row;
}

const oosLabel = (i: { jurisdiction: string | null; country: string; reportNumber: string | null }, vs: Violation[]) => `Roadside OOS (${[i.jurisdiction ?? i.country, i.reportNumber].filter(Boolean).join(" ")}): ${vs.map((v) => `${v.code} ${v.description}`).join("; ")}`;

/**
 * Make an inspection's out-of-service findings real (and undo them when an edit or a DataQs removal takes
 * them away): the truck or trailer out of service until the repair sign-off, the driver off until the
 * order's end as Safety time off (never a schedule call dispatch can wave through).
 */
async function applyRoadsideOos(ctx: Ctx, i: typeof s.inspections.$inferSelect, before: typeof s.inspections.$inferSelect | null) {
  const oos = roadsideOos(i);
  const { setTruckOos } = await import("./orders");
  // the truck
  for (const truckId of new Set([before?.truckId, i.truckId].filter((x): x is string => !!x))) {
    const [t] = await db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, truckId))).limit(1);
    if (!t) continue;
    const hold = truckId === i.truckId && oos.truck.length > 0 && !i.repair;
    if (hold && t.oosInspectionId !== i.id) {
      await setTruckOos(ctx, truckId, oosLabel(i, oos.truck));
      await db.update(s.trucks).set({ oosInspectionId: i.id }).where(eq(s.trucks.id, truckId));
    } else if (!hold && t.oosInspectionId === i.id) {
      await db.update(s.trucks).set({ status: "active", oosReason: null, oosUntil: null, oosInspectionId: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.trucks.id, truckId));
      await writeAudit(db, ctx, "truck", truckId, "update", { status: { from: "oos", to: "active" } }, i.repair ? `Repair signed off by ${i.repair.byName}: ${i.repair.note}` : "Roadside out-of-service finding removed");
    }
  }
  // the trailer
  for (const trailerId of new Set([before?.trailerId, i.trailerId].filter((x): x is string => !!x))) {
    const [t] = await db.select().from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), eq(s.trailers.id, trailerId))).limit(1);
    if (!t) continue;
    const hold = trailerId === i.trailerId && oos.trailer.length > 0 && !i.repair;
    if (hold && t.oosInspectionId !== i.id) {
      const reason = oosLabel(i, oos.trailer);
      await db.update(s.trailers).set({ status: "oos", oosReason: reason, oosInspectionId: i.id, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.trailers.id, trailerId));
      await writeAudit(db, ctx, "trailer", trailerId, "update", { status: { from: t.status, to: "oos" } }, reason);
    } else if (!hold && t.oosInspectionId === i.id) {
      await db.update(s.trailers).set({ status: "active", oosReason: null, oosInspectionId: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.trailers.id, trailerId));
      await writeAudit(db, ctx, "trailer", trailerId, "update", { status: { from: "oos", to: "active" } }, i.repair ? `Repair signed off by ${i.repair.byName}: ${i.repair.note}` : "Roadside out-of-service finding removed");
    }
  }
  // the driver: Safety time off from the inspection until the order ends (one per inspection, found by its start)
  const starts = before?.inspectedAt ?? i.inspectedAt;
  const drivers = new Set([before?.driverId, i.driverId].filter((x): x is string => !!x));
  for (const driverId of drivers) {
    const [ev] = await db.select().from(s.assetEvents).where(and(eq(s.assetEvents.tenantId, ctx.tenantId), eq(s.assetEvents.subjectKind, "driver"), eq(s.assetEvents.subjectId, driverId), eq(s.assetEvents.kind, "oos"), eq(s.assetEvents.startsAt, starts), isNull(s.assetEvents.archivedAt))).limit(1);
    const hold = driverId === i.driverId && oos.driver.length > 0 && i.driverOosUntil;
    const note = oosLabel(i, oos.driver);
    if (hold && ev) await db.update(s.assetEvents).set({ startsAt: i.inspectedAt, endsAt: i.driverOosUntil!, note, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.assetEvents.id, ev.id));
    else if (hold) {
      await db.insert(s.assetEvents).values({ id: newId(), tenantId: ctx.tenantId, subjectKind: "driver", subjectId: driverId, kind: "oos", startsAt: i.inspectedAt, endsAt: i.driverOosUntil!, hard: true, note, createdBy: ctx.userId, updatedBy: ctx.userId });
      await writeAudit(db, ctx, "driver", driverId, "update", undefined, `Out of service until ${i.driverOosUntil!.toISOString()}: ${note}`);
    } else if (ev) await db.update(s.assetEvents).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.assetEvents.id, ev.id));
  }
}

/**
 * The repair after a vehicle out-of-service order, certified (396.9(d)): who, when, what was done, with the
 * repair order attached. The truck or trailer comes back into service with it — and only with it.
 */
export async function signOffRepair(ctx: Ctx, inspectionId: string, input: { note: string; at?: Date | null; dateOnly?: boolean; file?: { fileName: string; mimeType: string; bytes: Buffer } | null }, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  const [i] = await db.select().from(s.inspections).where(and(eq(s.inspections.tenantId, ctx.tenantId), eq(s.inspections.id, inspectionId))).limit(1);
  if (!i) throw new NotFoundError("inspection", inspectionId);
  const oos = roadsideOos(i);
  if (!oos.truck.length && !oos.trailer.length) throw new ValidationError("this inspection didn't put a truck or trailer out of service");
  if (i.repair) throw new ValidationError(`the repair was signed off by ${i.repair.byName} on ${i.repair.at.slice(0, 10)}`);
  const note = input.note?.trim();
  if (!note) throw new ValidationError("what was repaired, and by whom (shop, mechanic)", "note");
  const { tenantZone } = await import("./company");
  const zone = await tenantZone(ctx.tenantId);
  const given = input.at ?? now;
  // "Repaired on <the inspection's day>": the same-day roadside fix, after the inspection (not midnight before it)
  const at = repairInstant(given, i.inspectedAt, { dateOnly: !!input.dateOnly, sameDay: zonedDate(given, zone) === zonedDate(i.inspectedAt, zone) || given.toISOString().slice(0, 10) === zonedDate(i.inspectedAt, zone), now });
  if (at.getTime() < i.inspectedAt.getTime()) throw new ValidationError("the repair comes after the inspection — same day is fine, at or after the inspection's time", "at");
  if (at.getTime() > now.getTime() + 3600_000) throw new ValidationError("the repair time is in the future", "at");
  const unitKind = oos.truck.length ? "truck" : "trailer";
  const documentId = input.file ? await storeFile(ctx, (unitKind === "truck" ? i.truckId : i.trailerId)!, `repair:${i.id}`, input.file, unitKind) : null;
  const [me] = ctx.userId ? await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, ctx.userId)).limit(1) : [];
  const repair = { by: ctx.userId ?? "system", byName: me?.name ?? "system", at: at.toISOString(), note, documentId };
  const [row] = await db.update(s.inspections).set({ repair, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.inspections.id, i.id)).returning();
  await writeAudit(db, ctx, "inspection", i.id, "update", { repair: { from: null, to: note } }, `Repair signed off by ${repair.byName}`);
  await applyRoadsideOos(ctx, row, i);
  return row;
}

/** Units still out of service from a roadside inspection, waiting for the repair sign-off. */
export async function openRoadsideOos(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const [trucks, trailers] = await Promise.all([
    db.select({ id: s.trucks.id, unit: s.trucks.unitNumber, reason: s.trucks.oosReason, inspectionId: s.trucks.oosInspectionId }).from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), sql`${s.trucks.oosInspectionId} is not null`)),
    db.select({ id: s.trailers.id, unit: s.trailers.unitNumber, reason: s.trailers.oosReason, inspectionId: s.trailers.oosInspectionId }).from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), sql`${s.trailers.oosInspectionId} is not null`)),
  ]);
  return [...trucks.map((t) => ({ ...t, kind: "truck" as const })), ...trailers.map((t) => ({ ...t, kind: "trailer" as const }))];
}

export async function deleteInspection(ctx: Ctx, id: string, reason?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  const [was] = await db.select().from(s.inspections).where(and(eq(s.inspections.tenantId, ctx.tenantId), eq(s.inspections.id, id))).limit(1);
  if (!was) throw new NotFoundError("inspection", id);
  // removing an inspection whose OOS order was never repaired releases the unit: that needs a reason too
  const release = oosReleaseNeedsReason(was, { violations: [] });
  if (release.released && !reason?.trim()) throw new ValidationError("This inspection still holds a unit or driver out of service. Say why it's being removed (logged by mistake, wrong unit…)", "oosReleaseReason");
  const [row] = await db.update(s.inspections).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.inspections.tenantId, ctx.tenantId), eq(s.inspections.id, id))).returning();
  if (!row) throw new NotFoundError("inspection", id);
  await writeAudit(db, ctx, "inspection", id, "archive", undefined, reason?.trim() || undefined);
  if (release.released) await writeAudit(db, ctx, "inspection", id, "override", { oos: { from: "out of service", to: "inspection removed" } }, reason!.trim());
  await applyRoadsideOos(ctx, { ...row, violations: [] }, row); // logged by mistake: whatever it held is released
}

/** The inspections board: the list, the BASIC measures, OOS rates, and drivers by points. */
export async function inspectionsBoard(ctx: Ctx, filter: { driverId?: string; truckId?: string } = {}, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const since = new Date(now.getTime() - 3 * 365 * 86400_000);
  const where = [eq(s.inspections.tenantId, ctx.tenantId), isNull(s.inspections.archivedAt), gte(s.inspections.inspectedAt, since)];
  if (filter.driverId) where.push(eq(s.inspections.driverId, filter.driverId));
  if (filter.truckId) where.push(eq(s.inspections.truckId, filter.truckId));
  const [list, crashes, trucks] = await Promise.all([
    db.select().from(s.inspections).where(and(...where)).orderBy(desc(s.inspections.inspectedAt)),
    db.select().from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), isNull(s.incidents.archivedAt), gte(s.incidents.occurredAt, new Date(now.getTime() - 2 * 365 * 86400_000)))),
    db.select({ id: s.trucks.id }).from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), isNull(s.trucks.archivedAt))),
  ]);
  return { list, measures: basicMeasures(list, filter.driverId || filter.truckId ? [] : crashes, trucks.length, now), oos: oosRates(list, now), drivers: driverPoints(list, now), powerUnits: trucks.length };
}

// ---------- the overrides log ----------

export type OverrideRow = { id: string; at: string; who: string; kind: "paperwork" | "dispatch" | "crossing" | "rate_con"; subject: string; href: string | null; what: string; reason: string };

/** Every override in the window: who waved what through, on which load or subject, and why. */
export async function overrideLog(ctx: Ctx, opts: { days?: number; kind?: string } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const since = new Date(Date.now() - (opts.days ?? 90) * 86400_000);
  const rows = await db.select().from(s.auditLog).where(and(eq(s.auditLog.tenantId, ctx.tenantId), eq(s.auditLog.action, "override"), gte(s.auditLog.at, since))).orderBy(desc(s.auditLog.at)).limit(1000);
  const ids = (e: string) => [...new Set(rows.filter((r) => r.entity === e).map((r) => r.entityId))];
  const [users, legs, crossings, orders, drivers, trucks, trailers, carriers, insp] = await Promise.all([
    db.select({ id: s.users.id, name: s.users.name }).from(s.users).where(eq(s.users.tenantId, ctx.tenantId)),
    ids("leg").length ? db.select({ id: s.legs.id, orderId: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), inArray(s.legs.id, ids("leg")))) : [],
    ids("crossing").length ? db.select({ id: s.crossings.id, orderId: s.crossings.orderId }).from(s.crossings).where(and(eq(s.crossings.tenantId, ctx.tenantId), inArray(s.crossings.id, ids("crossing")))) : [],
    db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), gte(s.orders.createdAt, new Date(since.getTime() - 365 * 86400_000)))),
    db.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
    db.select({ id: s.trucks.id, name: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
    db.select({ id: s.trailers.id, name: s.trailers.unitNumber }).from(s.trailers).where(eq(s.trailers.tenantId, ctx.tenantId)),
    db.select({ id: s.carriers.id, name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.tenantId, ctx.tenantId)),
    ids("inspection").length ? db.select({ id: s.inspections.id, country: s.inspections.country, jurisdiction: s.inspections.jurisdiction, reportNumber: s.inspections.reportNumber, truckId: s.inspections.truckId, trailerId: s.inspections.trailerId, driverId: s.inspections.driverId }).from(s.inspections).where(and(eq(s.inspections.tenantId, ctx.tenantId), inArray(s.inspections.id, ids("inspection")))) : [],
  ]);
  const m = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const U = m(users), L = m(legs), X = m(crossings), O = m(orders), D = m(drivers), T = m(trucks), R = m(trailers), C = m(carriers), I = m(insp);
  const load = (orderId: string | undefined) => (orderId ? { subject: `Load ${O.get(orderId)?.orderNumber ?? ""}`.trim(), href: `/orders/${orderId}` } : { subject: "Load", href: null });
  const names = (ch: Record<string, { to: unknown }> | null) =>
    [ch?.driverId && D.get(String(ch.driverId.to))?.name, ch?.coDriverId && D.get(String(ch.coDriverId.to))?.name, ch?.truckId && `unit ${T.get(String(ch.truckId.to))?.name ?? ""}`, ch?.trailerId && `trailer ${R.get(String(ch.trailerId.to))?.name ?? ""}`, ch?.carrierId && C.get(String(ch.carrierId.to))?.name].filter(Boolean).join(", ");
  const out: OverrideRow[] = rows.map((r) => {
    const ch = (r.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null;
    const base = { id: r.id, at: r.at.toISOString(), who: r.userId ? (U.get(r.userId)?.name ?? "someone") : "system", reason: r.note ?? "" };
    if (r.entity === "leg") {
      const msgs = Array.isArray(ch?.messages?.to) ? (ch!.messages.to as string[]) : [];
      const codes = Array.isArray(ch?.findings?.to) ? (ch!.findings.to as string[]) : [];
      const paperwork = codes.some((c) => c !== "schedule_conflict" && !c.startsWith("event_") && c !== "no_driver");
      const who = names(ch);
      return { ...base, kind: paperwork ? "paperwork" : "dispatch", ...load(L.get(r.entityId)?.orderId), what: `${who ? `${who}: ` : ""}${msgs.length ? msgs.join("; ") : codes.join(", ").replace(/_/g, " ")}` } as OverrideRow;
    }
    if (r.entity === "crossing") return { ...base, kind: "crossing", ...load(X.get(r.entityId)?.orderId), what: ch?.check ? "Crossing document check" : "Crossing eligibility" } as OverrideRow;
    if (r.entity === "order") return { ...base, kind: "rate_con", ...load(r.entityId), what: "Charges accepted against the rate con" } as OverrideRow;
    if (r.entity === "inspection") {
      const i = I.get(r.entityId);
      const unit = i ? [i.truckId && `unit ${T.get(i.truckId)?.name ?? ""}`, i.trailerId && `trailer ${R.get(i.trailerId)?.name ?? ""}`, i.driverId && D.get(i.driverId)?.name].filter(Boolean).join(", ") : "";
      return { ...base, kind: "paperwork", subject: `Inspection ${i ? [i.jurisdiction ?? i.country, i.reportNumber].filter(Boolean).join(" ") : ""}`.trim(), href: "/compliance/inspections", what: `Roadside out-of-service finding removed without a repair${unit ? ` (${unit})` : ""}` } as OverrideRow;
    }
    const label = r.entity === "driver" ? D.get(r.entityId)?.name : r.entity === "truck" ? `Unit ${T.get(r.entityId)?.name ?? ""}` : r.entity === "trailer" ? `Trailer ${R.get(r.entityId)?.name ?? ""}` : r.entity === "carrier" ? C.get(r.entityId)?.name : r.entityId;
    const path = { driver: "drivers", truck: "trucks", trailer: "trailers", carrier: "carriers" }[r.entity as "driver"];
    return { ...base, kind: "paperwork", subject: label ?? r.entity, href: path ? `/settings/${path}/${r.entityId}` : null, what: "24-hour dispatch override on a blocked record" } as OverrideRow;
  });
  return opts.kind ? out.filter((o) => o.kind === opts.kind) : out;
}

export function overridesCsv(rows: OverrideRow[]) {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [["When (UTC)", "Who", "Kind", "Subject", "What", "Reason"], ...rows.map((r) => [r.at, r.who, r.kind, r.subject, r.what, r.reason])].map((l) => l.map(q).join(",")).join("\n");
}

// ---------- one driver's safety file ----------

/** Everything an auditor asks for about one driver, on one page. D&A only for owner and Safety. */
export async function driverSafetyFile(ctx: Ctx, driverId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const driver = await loadDriver(ctx, driverId);
  const confidential = can(ctx, "safety.confidential");
  const [records, tests, insp, incidents, status, docs] = await Promise.all([
    db.select().from(s.dqRecords).where(and(eq(s.dqRecords.tenantId, ctx.tenantId), eq(s.dqRecords.driverId, driverId))).orderBy(desc(s.dqRecords.createdAt)),
    db.select().from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.driverId, driverId))).orderBy(desc(s.daTests.createdAt)),
    inspectionsBoard(ctx, { driverId }),
    db.select().from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), eq(s.incidents.driverId, driverId), isNull(s.incidents.archivedAt))).orderBy(desc(s.incidents.occurredAt)),
    db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, "driver"), eq(s.complianceStatus.subjectId, driverId))).limit(1),
    db.select({ id: s.documents.id, code: s.documents.code, fileName: s.documents.fileName }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "driver"), eq(s.documents.subjectId, driverId), sql`${s.documents.code} like 'dq:%'`)),
  ]);
  const standing = daStanding(tests);
  const lines = dqLines(driver, records, standing.preEmploymentNegativeAt);
  const items = status[0]?.items ?? [];
  return {
    driver,
    dq: lines.map((l) => ({ ...l, history: records.filter((r) => r.itemKey === l.key).map((r) => ({ at: (r.completedAt ?? r.createdAt).toISOString(), notRequired: r.notRequired, note: r.note, file: docs.find((d) => d.id === r.documentId) ?? null })) })),
    credentials: items.filter((i) => !isBuiltIn(i.key) || i.key.startsWith("field:")).filter((i) => !i.key.startsWith("da:")),
    dispatchable: status[0]?.dispatchable ?? true,
    da: confidential ? { tests: tests.map((t) => ({ ...t, duty: t.clearinghouseReportedAt ? null : clearinghouseDuty(t) })), standing } : null,
    inspections: insp.list,
    points: insp.drivers[0] ?? null,
    incidents: incidents.map((i) => ({ ...i, postAccident: postAccidentDuty(i) })),
    overrides: (await overrideLog(ctx, { days: 365 })).filter((o) => o.href === `/settings/drivers/${driverId}` || o.what.includes(driver.name)),
  };
}

/** Post-accident duty for the incidents board (whether tests are recorded only shows to owner and Safety). */
export async function incidentDuties(ctx: Ctx, incidentIds: string[]) {
  assertCtx(ctx);
  if (!incidentIds.length || !can(ctx, "safety.confidential")) return new Map<string, { alcohol: boolean; drug: boolean }>();
  const tests = await db.select({ incidentId: s.daTests.incidentId, substance: s.daTests.substance }).from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), inArray(s.daTests.incidentId, incidentIds)));
  const out = new Map<string, { alcohol: boolean; drug: boolean }>();
  for (const id of incidentIds) out.set(id, { alcohol: tests.some((t) => t.incidentId === id && t.substance === "alcohol"), drug: tests.some((t) => t.incidentId === id && t.substance === "drug") });
  return out;
}


// ---------- registers for an auditor (CSV, dates as YYYY-MM-DD) ----------

const csvq = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

async function nameMaps(ctx: Ctx) {
  const [drivers, trucks, trailers] = await Promise.all([
    db.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
    db.select({ id: s.trucks.id, name: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
    db.select({ id: s.trailers.id, name: s.trailers.unitNumber }).from(s.trailers).where(eq(s.trailers.tenantId, ctx.tenantId)),
  ]);
  const m = (xs: { id: string; name: string }[]) => (id: string | null) => (id ? (xs.find((x) => x.id === id)?.name ?? "") : "");
  return { driver: m(drivers), truck: m(trucks), trailer: m(trailers) };
}

/** Every roadside inspection, one line per violation (a clean one gets one line), with the repair sign-off. */
export async function inspectionsCsv(ctx: Ctx, years = 3) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const since = new Date(Date.now() - years * 365 * 86400_000);
  const [list, n] = await Promise.all([db.select().from(s.inspections).where(and(eq(s.inspections.tenantId, ctx.tenantId), isNull(s.inspections.archivedAt), gte(s.inspections.inspectedAt, since))).orderBy(desc(s.inspections.inspectedAt)), nameMaps(ctx)]);
  const head = ["Date", "Country", "State / province", "CVSA level", "Report #", "Driver", "Truck", "Trailer", "Violation", "Description", "BASIC", "SMS weight", "Out of service", "Removed (DataQs)", "DataQs", "Driver OOS until", "Repair signed off", "Repair by", "Repair note"];
  const lines = [head];
  for (const i of list) {
    const base = [ymd(i.inspectedAt), i.country, i.jurisdiction ?? "", String(i.level), i.reportNumber ?? "", n.driver(i.driverId), n.truck(i.truckId), n.trailer(i.trailerId)];
    const tail = [i.dataQs, i.driverOosUntil ? i.driverOosUntil.toISOString() : "", ymd(i.repair?.at), i.repair?.byName ?? "", i.repair?.note ?? ""];
    const vs = i.violations.length ? i.violations : [null];
    for (const v of vs) lines.push([...base, v?.code ?? "clean", v?.description ?? "", v?.basic ? (BASICS.find((b) => b.key === v.basic)?.label ?? v.basic) : "", v?.basic ? String(v.severity) : "", v?.oos ? "yes" : "", v?.removed ? "yes" : "", ...tail]);
  }
  return lines.map((l) => l.map(csvq).join(",")).join("\n");
}

/** The accident register (49 CFR 390.15): every incident, recordable ones marked, 3 years. */
export async function accidentRegisterCsv(ctx: Ctx, years = 3) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const since = new Date(Date.now() - years * 365 * 86400_000);
  const [list, n] = await Promise.all([db.select().from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), isNull(s.incidents.archivedAt), gte(s.incidents.occurredAt, since))).orderBy(desc(s.incidents.occurredAt)), nameMaps(ctx)]);
  const head = ["Date", "Time (UTC)", "Kind", "DOT recordable", "Location", "Driver", "Truck", "Trailer", "Injuries", "Fatality", "Tow-away", "Citation", "Preventable", "Police report", "Claim #", "Status", "What happened"];
  const lines = [head, ...list.map((i) => [ymd(i.occurredAt), i.occurredAt.toISOString().slice(11, 16), i.kind.replace(/_/g, " "), i.dotRecordable ? "yes" : "no", i.location ?? "", n.driver(i.driverId), n.truck(i.truckId), n.trailer(i.trailerId), i.injuries ? "yes" : "no", i.fatality ? "yes" : "no", i.towAway ? "yes" : "no", i.citation ? "yes" : "no", i.preventable === "preventable" ? "yes" : i.preventable === "not_preventable" ? "no" : "", i.policeReport ?? "", i.claimNumber ?? "", i.status, i.description])];
  return lines.map((l) => l.map(csvq).join(",")).join("\n");
}
