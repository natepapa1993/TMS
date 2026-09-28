// Features: F-25.2 F-25.3 F-25.4 F-25.7
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get } from "@/data/records";
import { parseDate } from "@/data/fields";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import * as S from "./safety";
import { repairInstant, oosReleaseNeedsReason, lookupViolation, followUpSchedule, rtdProblem, overlappingDraw } from "./safety-rules";
import * as C from "./compliance";

// Safety round-2 retest fixes: same-day repair sign-off (N1), a reason to take an OOS finding off (N3), 393.9 (N11)

const DAY = 86400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { d1: string; t1: string; tr: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Round Two Carrier");
  await db.update(tenants).set({ timeZone: "America/Chicago" }).where(eq(tenants.id, a.tenantId));
  const t1 = await create(a, "truck", { unitNumber: "Q317", dotInspectionExpires: days(300) });
  const tr = await create(a, "trailer", { unitNumber: "Q5501", inspectionExpires: days(300) });
  const d1 = await create(a, "driver", { name: "Fernando Aguilar", driverType: "CDL", licenseState: "TX", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-100) });
  f = { d1: d1.id, t1: t1.id, tr: tr.id };
});

describe("same-day roadside repair sign-off (safety N1)", () => {
  // TX level 1 at 1:10 PM CDT; the mechanic fixes it on the spot
  const inspectedAt = new Date("2026-09-20T18:10:00Z");
  const brake = () => S.saveInspection(a, null, { inspectedAt, country: "US", jurisdiction: "TX", level: 1, truckId: f.t1, reportNumber: "TXQA2-0101", violations: [{ code: "393.47(e)", oos: true }] });

  it("'Repaired on' the inspection's day is accepted: signed off after the inspection, not at midnight before it", async () => {
    const i = await brake();
    const signed = await S.signOffRepair(a, i.id, { note: "brake adjusted at the scale", at: parseDate("2026-09-20"), dateOnly: true }, new Date("2026-09-20T20:30:00Z"));
    expect(signed.repair!.at).toBe("2026-09-20T20:30:00.000Z");
    expect((await get(a, "truck", f.t1)).status).toBe("active");
  });

  it("a repair time the same afternoon is accepted; before the inspection or tomorrow is refused", async () => {
    const i = await brake();
    const now = new Date("2026-09-20T21:00:00Z");
    await expect(S.signOffRepair(a, i.id, { note: "x", at: new Date("2026-09-20T17:00:00Z") }, now)).rejects.toThrow(/after the inspection/);
    await expect(S.signOffRepair(a, i.id, { note: "x", at: parseDate("2026-09-21"), dateOnly: true }, now)).rejects.toThrow(/in the future/);
    const ok = await S.signOffRepair(a, i.id, { note: "slack adjuster replaced", at: new Date("2026-09-20T19:45:00Z") }, now);
    expect(ok.repair!.at).toBe("2026-09-20T19:45:00.000Z");
  });

  it("repairInstant: a date alone on the inspection's day becomes now, or the inspection's time if now is later than a day", () => {
    const at = parseDate("2026-09-20")!;
    expect(repairInstant(at, inspectedAt, { dateOnly: true, sameDay: true, now: new Date("2026-09-20T19:00:00Z") }).toISOString()).toBe("2026-09-20T19:00:00.000Z");
    expect(repairInstant(at, inspectedAt, { dateOnly: true, sameDay: true, now: new Date("2026-09-25T19:00:00Z") }).toISOString()).toBe(inspectedAt.toISOString());
    expect(repairInstant(at, inspectedAt, { dateOnly: false, sameDay: true, now: new Date() })).toBe(at);
    expect(repairInstant(parseDate("2026-09-19")!, inspectedAt, { dateOnly: true, sameDay: false, now: new Date() }).toISOString().slice(0, 10)).toBe("2026-09-19");
  });
});

describe("taking an OOS finding off needs a reason (safety N3)", () => {
  const input = () => ({ inspectedAt: days(-0.2), country: "CA", jurisdiction: "ON", level: 2, truckId: f.t1, reportNumber: "ONQA2-0202", violations: [{ code: "NSC 11", description: "Brake out of adjustment", unit: "vehicle" as const, oos: true }] });

  it("unticking OOS on an edit is refused without a reason; with one the unit comes back and the overrides log says why", async () => {
    const i = await S.saveInspection(a, null, input());
    expect((await get(a, "truck", f.t1)).status).toBe("oos");
    const unticked = { ...input(), violations: [{ ...input().violations[0], oos: false }] };
    await expect(S.saveInspection(a, i.id, unticked)).rejects.toThrow(/Why is the out-of-service finding coming off/);
    expect((await get(a, "truck", f.t1)).status).toBe("oos");
    await S.saveInspection(a, i.id, { ...unticked, oosReleaseReason: "Data entry error — it wasn't OOS on the report" });
    expect((await get(a, "truck", f.t1)).status).toBe("active");
    const log = await S.overrideLog(a);
    expect(log[0]).toMatchObject({ kind: "paperwork", subject: "Inspection ON ONQA2-0202", reason: "Data entry error — it wasn't OOS on the report" });
    expect(log[0].what).toMatch(/removed without a repair \(unit Q317\)/);
  });

  it("deleting the violation or the whole inspection needs a reason too; editing other fields doesn't", async () => {
    const i = await S.saveInspection(a, null, input());
    await S.saveInspection(a, i.id, { ...input(), location: "Hwy 401 Windsor" }); // nothing released
    await expect(S.saveInspection(a, i.id, { ...input(), violations: [] })).rejects.toThrow(/Why/);
    await expect(S.deleteInspection(a, i.id)).rejects.toThrow(/Say why/);
    await S.deleteInspection(a, i.id, "Logged on the wrong truck");
    expect((await get(a, "truck", f.t1)).status).toBe("active");
    expect((await S.overrideLog(a))[0].reason).toBe("Logged on the wrong truck");
  });

  it("after a repair sign-off nothing is released, so no reason; a DataQs acceptance is its own reason", () => {
    const v = { code: "393.47(e)", description: "", basic: "vehicle" as const, severity: 4, oos: true, unit: "vehicle" as const };
    expect(oosReleaseNeedsReason({ violations: [v], repair: { at: "x" } }, { violations: [] }).released).toBe(false);
    expect(oosReleaseNeedsReason({ violations: [v] }, { violations: [{ ...v, removed: true }], dataQs: "accepted" })).toEqual({ released: true, defaultReason: "DataQs accepted — violation removed" });
    expect(oosReleaseNeedsReason({ violations: [v] }, { violations: [{ ...v, removed: true }], dataQs: "filed" })).toEqual({ released: true, defaultReason: null });
  });
});

describe("the violation table (safety N11)", () => {
  it("393.9 as typed finds the lamp violation", () => {
    expect(lookupViolation("393.9")).toMatchObject({ basic: "vehicle", severity: 6 });
    expect(lookupViolation("49 CFR 393.9")).toMatchObject({ severity: 6 });
    expect(lookupViolation("393.47")).toBeNull(); // several paragraphs with different weights: not guessed
  });
});

describe("return to duty needs the SAP on the record and an observed test (safety #16)", () => {
  const refuse = async () => {
    const t = await S.addTest(a, { driverId: f.d1, reason: "reasonable_suspicion", substance: "drug" });
    await S.recordResult(a, t.id, { result: "refusal" });
    expect((await C.statusFor(a, "driver", f.d1)).dispatchable).toBe(false);
  };
  const sap = () => ({ sapName: "Dr. R. Salinas, SAP", sapEvaluatedAt: new Date(), sapEducationDoneAt: new Date(), observed: true, followUpPlanned: 6, followUpMonths: 12 });

  it("a negative RTD 30 minutes after a refusal, with no SAP, is refused and the hold stays", async () => {
    await refuse();
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "negative", followUpPlanned: 6 })).rejects.toThrow(/Name the SAP/);
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "negative", ...sap(), sapEducationDoneAt: null })).rejects.toThrow(/education or treatment/);
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "negative", ...sap(), observed: false })).rejects.toThrow(/direct observation/);
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "negative", ...sap(), followUpMonths: null })).rejects.toThrow(/months/);
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "negative", ...sap(), sapEvaluatedAt: new Date(Date.now() - 3 * DAY) })).rejects.toThrow(/after the violation/);
    expect((await C.statusFor(a, "driver", f.d1)).dispatchable).toBe(false);
  });

  it("an RTD ordered first (pending) and completed with the SAP details lifts the hold; the follow-ups become dated to-dos", async () => {
    await refuse();
    const rtd = await S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: new Date(), result: "pending" });
    await expect(S.recordResult(a, rtd.id, { result: "negative" })).rejects.toThrow(/SAP/);
    await S.recordResult(a, rtd.id, { result: "negative", ...sap(), specimenType: "urine", mroVerifiedAt: new Date() });
    expect((await C.statusFor(a, "driver", f.d1)).dispatchable).toBe(true);
    const t = (await S.driverTests(a, f.d1)).tests.find((x) => x.id === rtd.id)!;
    expect(t).toMatchObject({ sapName: "Dr. R. Salinas, SAP", observed: true, followUpPlanned: 6, followUpMonths: 12, specimenType: "urine" });
    const standing = (await S.driverTests(a, f.d1)).standing;
    expect(standing.followUp!.schedule).toHaveLength(6);
    expect(standing.followUp!.nextDue).toBe(standing.followUp!.schedule[0]);
    const prog = await S.daProgram(a, new Date().getUTCFullYear());
    expect(prog.followUpsDue).toEqual([]); // the first is due in 2 months, not yet a to-do
  });

  it("the schedule: 6 in the first 12 months, the rest spread over the plan", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const six = followUpSchedule(start, 6, 12).map((d) => d.slice(0, 10));
    expect(six).toHaveLength(6);
    expect(six[0] >= "2026-02-28" && six[0] <= "2026-03-02").toBe(true);
    expect(six[5].slice(0, 7)).toBe("2027-01");
    const twelve = followUpSchedule(start, 12, 48);
    expect(twelve.filter((d) => d < "2027-01-02")).toHaveLength(6);
    expect(twelve[11].slice(0, 7)).toBe("2030-01");
    expect(rtdProblem({ id: "x", driverId: "d", reason: "return_to_duty", substance: "alcohol", result: "negative", collectedAt: new Date(), resultAt: null, sapName: "S", sapEvaluatedAt: new Date(), sapEducationDoneAt: new Date(), followUpPlanned: 6, followUpMonths: 12 }, null)).toBeNull(); // breath alcohol isn't observed
  });

  it("the test keeps its papers (confidential), the MRO date and the specimen", async () => {
    const t = await S.addTest(a, { driverId: f.d1, reason: "pre_employment", substance: "drug", collectedAt: new Date(Date.now() - 2 * DAY), result: "negative", specimenType: "oral_fluid", mroVerifiedAt: new Date() });
    await expect(S.addTest(a, { driverId: f.d1, reason: "post_accident", substance: "alcohol", collectedAt: new Date(), result: "negative", specimenType: "urine" })).rejects.toThrow(/breath or oral fluid/);
    await expect(S.addTest(a, { driverId: f.d1, reason: "pre_employment", substance: "drug", collectedAt: new Date(), result: "negative", mroVerifiedAt: new Date(Date.now() - 5 * DAY) })).rejects.toThrow(/after the collection/);
    await S.attachTestDocument(a, t.id, { fileName: "ccf.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") });
    await expect(S.attachTestDocument({ ...a, role: "dispatcher" }, t.id, { fileName: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF") })).rejects.toThrow(/permission/);
    const mine = (await S.driverTests(a, f.d1)).tests.find((x) => x.id === t.id)!;
    expect(mine.docs.map((d) => d.fileName)).toEqual(["ccf.pdf"]);
    expect(mine.specimenType).toBe("oral_fluid");
    // the paper isn't one of the driver's documents dispatch sees
    expect((await C.subjectDocuments(a, "driver", f.d1)).length).toBe(0);
  });
});

describe("D&A validation (safety N10)", () => {
  it("a collection can't be in the future, before the selection or before the accident", async () => {
    await expect(S.addTest(a, { driverId: f.d1, reason: "reasonable_suspicion", substance: "drug", collectedAt: new Date(Date.now() + 20 * 60_000), result: "pending" })).rejects.toThrow(/in the future/);
    const draw = await S.drawRandom(a, { period: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`, drugRate: 100, alcoholRate: 0, drawsPerYear: 12 });
    expect(draw.drug).toHaveLength(1);
    const sel = (await S.driverTests(a, f.d1)).tests.find((t) => t.reason === "random")!;
    await expect(S.recordResult(a, sel.id, { collectedAt: new Date(sel.selectedAt!.getTime() - 20 * 60_000), result: "pending" })).rejects.toThrow(/before the driver was selected/);
    await S.recordResult(a, sel.id, { collectedAt: new Date(), result: "pending" });
    const { saveIncident } = await import("./compliance");
    const inc = await saveIncident(a, null, { occurredAt: new Date(Date.now() - 60 * 60_000), kind: "accident", driverId: f.d1, description: "Tow-away", citation: true, towAway: true });
    await expect(S.addTest(a, { driverId: f.d1, reason: "post_accident", substance: "alcohol", incidentId: inc.id, collectedAt: new Date(Date.now() - 2 * 60 * 60_000), result: "negative" })).rejects.toThrow(/before the accident/);
  });

  it("monthly and quarterly draws can't cover the same period", async () => {
    expect(overlappingDraw("2026-09", ["2026-Q3"])).toBe("2026-Q3");
    expect(overlappingDraw("2026-Q3", ["2026-07"])).toBe("2026-07");
    expect(overlappingDraw("2026-10", ["2026-Q3"])).toBeNull();
    const y = new Date().getUTCFullYear();
    const q = Math.floor(new Date().getUTCMonth() / 3) + 1;
    const month = `${y}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    await S.drawRandom(a, { period: `${y}-Q${q}`, drugRate: 50, alcoholRate: 10, drawsPerYear: 4 });
    await expect(S.drawRandom(a, { period: month, drugRate: 50, alcoholRate: 10, drawsPerYear: 12 })).rejects.toThrow(/already covers part of/);
    await expect(S.drawRandom(a, { period: month, drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/12 draws a year|already covers/);
  });
});

describe("a new unit with no annual inspection isn't silently dispatchable (safety N14)", () => {
  it("added after the company's first month: blocked until the inspection is on file; units typed in during setup follow the blank-dates switch", async () => {
    const setupUnit = await create(a, "truck", { unitNumber: "OLD1" });
    expect((await C.evaluateSubject(a, "truck", setupUnit.id)).dispatchable).toBe(true);
    // the company is two months old now; OLD1 was typed in during its first weeks
    await db.update(tenants).set({ createdAt: new Date(Date.now() - 60 * DAY) }).where(eq(tenants.id, a.tenantId));
    const { trucks } = await import("@/db/schema");
    await db.update(trucks).set({ createdAt: new Date(Date.now() - 50 * DAY) }).where(eq(trucks.id, setupUnit.id));
    expect((await C.evaluateSubject(a, "truck", setupUnit.id)).dispatchable).toBe(true);
    const q316 = await create(a, "truck", { unitNumber: "Q316" });
    let st = await C.evaluateSubject(a, "truck", q316.id);
    expect(st.dispatchable).toBe(false);
    expect(C.forLeg(st, null).blockers).toEqual(["Annual inspection: none on file for this new unit (396.17)"]);
    const q5501 = await create(a, "trailer", { unitNumber: "Q5502" });
    expect((await C.evaluateSubject(a, "trailer", q5501.id)).dispatchable).toBe(false);
    const { update } = await import("@/data/records");
    await update(a, "truck", q316.id, { dotInspectionExpires: days(300) });
    st = await C.evaluateSubject(a, "truck", q316.id);
    expect(st.dispatchable).toBe(true);
  });
});

describe("new blocking rules start with the 14-day grace (safety N9)", () => {
  it("a rule from quick-add (no Required box) and one made required later both get it; the board shows it without blocking", async () => {
    const { withNewRuleGrace } = await import("./compliance-rules");
    const { create: mk, update, get: getRec } = await import("@/data/records");
    const quick = await mk(a, "documentType", withNewRuleGrace({ name: "IRP cab card QA2", appliesTo: "truck", tracksExpiry: true, blockLevel: "override" }));
    expect(quick.graceUntil).toBeInstanceOf(Date);
    const plain = await mk(a, "documentType", { name: "Permit book", appliesTo: "truck", tracksExpiry: false, blockLevel: "warn" });
    const before = await getRec(a, "documentType", plain.id);
    await update(a, "documentType", plain.id, withNewRuleGrace({ required: true, blockLevel: "hard", graceUntil: null }, new Date(), before));
    expect((await getRec(a, "documentType", plain.id)).graceUntil).toBeInstanceOf(Date);
    const st = await C.evaluateSubject(a, "truck", f.t1);
    expect(st.dispatchable).toBe(true);
    expect(st.items.find((i) => i.label === "Permit book")!.graceUntil).toBeTruthy();
  });
});
