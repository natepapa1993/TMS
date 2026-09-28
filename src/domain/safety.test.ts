// Features: F-25.1 F-25.2 F-25.3 F-25.4
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { flags, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as C from "./compliance";
import * as S from "./safety";
import { dqLines, daStanding, perDraw, pick, randomRequirement, postAccidentDuty, basicOf, basicMeasures, timeWeight, clearinghouseDuty, oosRates } from "./safety-rules";
import { createOrder, planLeg, candidatesForLeg } from "./orders";

const DAY = 86400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const now = new Date("2026-09-28T15:00:00Z");

describe("qualification file rules", () => {
  it("hire prerequisites are missing until done; 30-day items come due from hire; annual items run 12 months from the last one", () => {
    const hire = new Date(now.getTime() - 40 * DAY);
    const lines = dqLines({ driverType: "CDL", licenseState: "TX", hireDate: hire }, [{ itemKey: "application", completedAt: hire, notRequired: false, createdAt: hire }, { itemKey: "mvr_annual", completedAt: new Date(now.getTime() - 350 * DAY), notRequired: false, createdAt: hire }], null, now);
    const by = (k: string) => lines.find((l) => l.key === k)!;
    expect(by("application").status).toBe("ok");
    expect(by("road_test").status).toBe("missing");
    expect(by("road_test").blocks).toBe(true);
    expect(by("prior_employers").status).toBe("expired"); // 30 days after hire passed
    expect(by("mvr_hire").status).toBe("expired");
    expect(by("mvr_annual").status).toBe("expiring"); // due in 15 days
    expect(by("annual_review").status).toBe("ok"); // due a year after hire
    expect(by("pre_employment_test").status).toBe("missing");
  });
  it("names the record for the licence's country, counts a full query for the annual one, and takes the negative pre-employment test from the program", () => {
    const b1 = dqLines({ driverType: "B1", hireDate: now }, [], null, now);
    expect(b1.find((l) => l.key === "mvr_hire")!.label).toBe("LIFIS record (licencia federal) at hire");
    const on = dqLines({ driverType: "CDL", licenseState: "on", hireDate: now }, [{ itemKey: "clearinghouse_full", completedAt: now, notRequired: false, createdAt: now }], now.toISOString(), now);
    expect(on.find((l) => l.key === "mvr_annual")!.label).toBe("Annual Driver's abstract");
    expect(on.find((l) => l.key === "clearinghouse_annual")!.completedAt).toBe(now.toISOString());
    expect(on.find((l) => l.key === "pre_employment_test")!.status).toBe("ok");
    const exempt = dqLines({ driverType: "CDL", hireDate: now }, [{ itemKey: "pre_employment_test", completedAt: null, notRequired: true, note: "382.301(b): tested within 30 days in a DOT program", createdAt: now }], null, now);
    expect(exempt.find((l) => l.key === "pre_employment_test")!.status).toBe("ok");
  });
});

describe("drug & alcohol rules", () => {
  const t = (over: Partial<Parameters<typeof daStanding>[0][number]>) => ({ id: Math.random().toString(), driverId: "d", reason: "random", substance: "drug", result: "negative", collectedAt: now, resultAt: now, ...over });
  it("a positive or a refusal holds the driver until a negative return-to-duty test; follow-ups count after it", () => {
    const pos = t({ result: "positive", resultAt: new Date(now.getTime() - 60 * DAY) });
    expect(daStanding([pos]).prohibited).toBe(true);
    const rtd = t({ reason: "return_to_duty", result: "negative", resultAt: new Date(now.getTime() - 20 * DAY), followUpPlanned: 6 });
    const fu = t({ reason: "follow_up", result: "negative", resultAt: new Date(now.getTime() - 5 * DAY) });
    const st = daStanding([fu, rtd, pos]);
    expect(st.prohibited).toBe(false);
    expect(st.followUp).toEqual({ done: 1, planned: 6 });
    expect(daStanding([t({ reason: "return_to_duty", resultAt: new Date(now.getTime() - 90 * DAY) }), pos]).prohibited).toBe(true); // an old RTD doesn't lift a newer positive
  });
  it("who reports what to the Clearinghouse: the employer files alcohol ≥ 0.04, refusals and the RTD negative; the MRO files drug positives", () => {
    expect(clearinghouseDuty(t({ result: "refusal" }))).toMatch(/refusal/);
    expect(clearinghouseDuty(t({ substance: "alcohol", result: "positive" }))).toMatch(/alcohol/);
    expect(clearinghouseDuty(t({ result: "positive" }))).toBeNull();
    expect(clearinghouseDuty(t({ reason: "return_to_duty" }))).toMatch(/return-to-duty/);
  });
  it("random: the annual rate spread over the draws, rounded up; the year's requirement is the rate × the average pool", () => {
    expect(perDraw(10, 50, 4)).toBe(2); // 1.25 → 2
    expect(perDraw(10, 10, 4)).toBe(1);
    expect(perDraw(3, 50, 1)).toBe(2);
    expect(perDraw(0, 50, 4)).toBe(0);
    expect(randomRequirement([{ poolSize: 10, drugRate: 50, alcoholRate: 10 }, { poolSize: 14, drugRate: 50, alcoholRate: 10 }])).toEqual({ avgPool: 12, drug: 6, alcohol: 2 });
    let i = 0;
    const seq = [0, 0, 0, 0, 0];
    expect(pick(["a", "b", "c", "d"], 2, () => seq[i++] ?? 0)).toHaveLength(2);
    expect(new Set(pick(["a", "b", "c", "d"], 9, (m) => m - 1))).toEqual(new Set(["a", "b", "c", "d"]));
  });
  it("post-accident testing: a fatality always; otherwise a citation with an injury or a tow-away; alcohol by 8 h, drugs by 32 h", () => {
    const at = "2026-09-28T10:00:00.000Z";
    expect(postAccidentDuty({ kind: "accident", occurredAt: at, fatality: true })!.alcoholBy).toBe("2026-09-28T18:00:00.000Z");
    expect(postAccidentDuty({ kind: "accident", occurredAt: at, citation: true, towAway: true })!.drugBy).toBe("2026-09-29T18:00:00.000Z");
    expect(postAccidentDuty({ kind: "accident", occurredAt: at, towAway: true })).toBeNull(); // no citation
    expect(postAccidentDuty({ kind: "cargo", occurredAt: at, fatality: true })).toBeNull();
  });
});

describe("inspections and the BASICs", () => {
  it("files a violation under its BASIC by CFR part", () => {
    expect(basicOf("395.8(e)")).toBe("hos");
    expect(basicOf("49 CFR 393.9")).toBe("vehicle");
    expect(basicOf("392.2-SLLS3")).toBe("unsafe");
    expect(basicOf("392.4(a)")).toBe("substances");
    expect(basicOf("391.41(a)")).toBe("fitness");
    expect(basicOf("177.817")).toBe("hm");
    expect(basicOf("CVOR 12")).toBeNull();
  });
  it("time-weights, caps at 30 per inspection, adds 2 for OOS, counts only US inspections and leaves removed violations out", () => {
    expect([timeWeight(new Date(now.getTime() - 30 * DAY), now), timeWeight(new Date(now.getTime() - 300 * DAY), now), timeWeight(new Date(now.getTime() - 600 * DAY), now), timeWeight(new Date(now.getTime() - 800 * DAY), now)]).toEqual([3, 2, 1, 0]);
    const v = (basic: "hos" | "vehicle", severity: number, oos = false, removed = false) => ({ code: "x", description: "x", basic, severity, oos, unit: basic === "hos" ? ("driver" as const) : ("vehicle" as const), removed });
    const list = [
      { id: "1", inspectedAt: new Date(now.getTime() - 30 * DAY), country: "US", level: 1, hazmat: false, violations: [v("hos", 7, true), v("vehicle", 6)] },
      { id: "2", inspectedAt: new Date(now.getTime() - 300 * DAY), country: "US", level: 3, hazmat: false, violations: [] },
      { id: "3", inspectedAt: new Date(now.getTime() - 30 * DAY), country: "CA", level: 1, hazmat: false, violations: [v("hos", 10, true)] },
      { id: "4", inspectedAt: new Date(now.getTime() - 30 * DAY), country: "US", level: 1, hazmat: false, violations: [v("vehicle", 10), v("vehicle", 10), v("vehicle", 10, true), v("vehicle", 5, false, true)] },
    ];
    const m = basicMeasures(list, [], 4, now);
    const hos = m.find((x) => x.key === "hos")!;
    expect(hos.inspections).toBe(3); // levels 1, 3, 1 in the US
    expect(hos.measure).toBe(Math.round(((3 * 9) / (3 + 2 + 3)) * 100) / 100);
    const veh = m.find((x) => x.key === "vehicle")!;
    expect(veh.inspections).toBe(2); // level 3 doesn't look at the vehicle
    expect(veh.measure).toBe(Math.round(((3 * 6 + 3 * 30) / 6) * 100) / 100); // 32 capped at 30
    const crash = basicMeasures([], [{ occurredAt: new Date(now.getTime() - 10 * DAY), kind: "accident", dotRecordable: true, injuries: true, towAway: true }, { occurredAt: new Date(now.getTime() - 10 * DAY), kind: "accident", dotRecordable: true, injuries: false, towAway: true, preventable: "not_preventable" }], 2, now).find((x) => x.key === "crash")!;
    expect(crash.measure).toBe(3); // 3 × 2 / 2 units; the not-preventable one is out
    const oos = oosRates(list, now);
    expect(oos.find((o) => o.country === "US")!.driver).toEqual({ inspections: 3, oos: 1, rate: 1 / 3 });
    expect(oos.find((o) => o.country === "CA")!.driver.oos).toBe(1);
  });
});

let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { d1: string; d2: string; t1: string; cust: string };
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Safety Carrier");
  const t1 = await create(a, "truck", { unitNumber: "101", usPlate: "TX101", usPlateExpires: days(300), dotInspectionExpires: days(300) });
  const d1 = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseState: "TX", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-10), currentTruckId: t1.id });
  const d2 = await create(a, "driver", { name: "Ana Torres", driverType: "CDL", licenseState: "ON", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-400) });
  const cust = await create(a, "customer", { name: "Acme", kind: "customer" });
  f = { d1: d1.id, d2: d2.id, t1: t1.id, cust: cust.id };
});

describe("the qualification file in compliance", () => {
  it("a missing prerequisite shows as missing; with 'missing dates block' on it stops dispatch; recording it clears; not-required needs a reason", async () => {
    let st = await C.evaluateSubject(a, "driver", f.d1);
    expect(st.missing).toContain("Road test certificate (or CDL in lieu)");
    expect(st.dispatchable).toBe(true);
    await C.setMissingDatesBlock(a, true);
    st = await C.evaluateSubject(a, "driver", f.d1);
    expect(st.dispatchable).toBe(false);
    for (const k of ["application", "road_test", "clearinghouse_full"]) await S.recordDq(a, f.d1, k, { completedAt: days(-9) });
    await expect(S.recordDq(a, f.d1, "pre_employment_test", { notRequired: true })).rejects.toThrow(/382.301/);
    await S.addTest(a, { driverId: f.d1, reason: "pre_employment", substance: "drug", collectedAt: days(-12), result: "negative" });
    st = await C.evaluateSubject(a, "driver", f.d1);
    expect(st.dispatchable).toBe(true);
    expect(st.missing).not.toContain("Pre-employment drug test (negative)");
    await expect(S.recordDq(a, f.d1, "road_test", { completedAt: days(5) })).rejects.toThrow(/future/);
    await expect(S.recordDq({ ...a, role: "dispatcher" }, f.d1, "road_test", { completedAt: days(-1) })).rejects.toThrow(/permission/);
    const ov = await S.dqOverview(a);
    expect(ov.find((d) => d.id === f.d1)!.missing).toBe(0);
  });
});

describe("drug & alcohol program", () => {
  it("draws from the pool, records results; a refusal holds the driver (not overridable), flags the load for dispatch without the reason, and leaves a Clearinghouse to-do", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d1 });
    const draw = await S.drawRandom(a, { period: "2026-Q4", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 }, (m) => m - 1);
    expect(draw.poolSize).toBe(2);
    expect(draw.drug).toHaveLength(1);
    expect(draw.alcohol).toHaveLength(1);
    await expect(S.drawRandom(a, { period: "2026-Q4", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/already drawn/);
    await expect(S.drawRandom({ ...a, role: "dispatcher" }, { period: "2026-Q3", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/permission/);
    let prog = await S.daProgram(a, 2026);
    expect(prog.open).toBe(2);
    expect(prog.required).toEqual({ avgPool: 2, drug: 1, alcohol: 1 });
    const sel = prog.tests.find((t) => t.driverId === f.d1) ?? prog.tests[0];
    // make sure the refusal lands on the driver with the planned leg
    const mine = sel.driverId === f.d1 ? sel : (await S.addTest(a, { driverId: f.d1, reason: "reasonable_suspicion", substance: "drug" }));
    await S.recordResult(a, mine.id, { result: "refusal" });
    const st = await C.statusFor(a, "driver", f.d1);
    expect(st.dispatchable).toBe(false);
    expect(st.expired).toEqual(["Safety hold"]);
    await expect(C.overrideDispatch(a, "driver", f.d1, "need him today")).rejects.toThrow(/cannot override/);
    const fl = await db.select().from(flags).where(eq(flags.orderId, o.order.id));
    expect(fl.map((x) => x.code)).toContain("safety_hold");
    expect(fl.find((x) => x.code === "safety_hold")!.detail).not.toMatch(/refus|drug|alcohol/i);
    const cands = await candidatesForLeg(a, o.legs[0].id);
    expect(cands.find((c) => c.truckId === f.t1)?.findings.some((x) => x.code === "compliance_block" && !x.overridable && x.message.includes("Safety hold"))).toBe(true);
    prog = await S.daProgram(a, 2026);
    expect(prog.duties.map((d) => d.duty)).toEqual([expect.stringMatching(/refusal/)]);
    expect(prog.holds.map((h) => h.name)).toEqual(["Daniel Reyes"]);
    await S.markClearinghouseReported(a, mine.id);
    // return to duty after the SAP: at least 6 follow-ups
    await expect(S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: days(0), result: "negative", followUpPlanned: 3 })).rejects.toThrow(/at least 6/);
    await S.addTest(a, { driverId: f.d1, reason: "return_to_duty", substance: "drug", collectedAt: days(0), result: "negative", followUpPlanned: 6 });
    expect((await C.statusFor(a, "driver", f.d1)).dispatchable).toBe(true);
    prog = await S.daProgram(a, 2026);
    expect(prog.holds[0].followUp).toEqual({ done: 0, planned: 6 });
    await expect(S.daProgram({ ...a, role: "dispatcher" }, 2026)).rejects.toThrow(/permission/);
  });
  it("a fatal accident owes post-accident tests until they're recorded against it", async () => {
    const inc = await C.saveIncident(a, null, { occurredAt: days(0), kind: "accident", driverId: f.d2, description: "Rear-ended at the light", citation: true, towAway: true });
    expect(inc.dotRecordable).toBe(true);
    let prog = await S.daProgram(a, new Date().getUTCFullYear());
    expect(prog.postAccident).toHaveLength(1);
    expect(prog.postAccident[0]).toMatchObject({ driver: "Ana Torres", alcoholDone: false, drugDone: false });
    await S.addTest(a, { driverId: f.d2, reason: "post_accident", substance: "alcohol", incidentId: inc.id, collectedAt: days(0), result: "negative" });
    prog = await S.daProgram(a, new Date().getUTCFullYear());
    expect(prog.postAccident[0]).toMatchObject({ alcoholDone: true, drugDone: false });
  });
});

describe("inspections", () => {
  it("logs an inspection with violations filed under their BASIC; an OOS on a load flags it; a driver's points roll up", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    await expect(S.saveInspection(a, null, { inspectedAt: days(-1), country: "US", level: 1, violations: [] })).rejects.toThrow(/driver or the unit/);
    await expect(S.saveInspection(a, null, { inspectedAt: days(-1), country: "US", level: 1, driverId: f.d1, violations: [{ code: "395.8(e)", description: "False log", severity: 0 }] })).rejects.toThrow(/severity/);
    await expect(S.saveInspection(a, null, { inspectedAt: days(-1), country: "US", level: 1, driverId: f.d1, violations: [{ code: "ABC", description: "?", severity: 3 }] })).rejects.toThrow(/BASIC/);
    const i = await S.saveInspection(a, null, { inspectedAt: days(-3), country: "US", jurisdiction: "tx", level: 1, driverId: f.d1, truckId: f.t1, orderId: o.order.id, reportNumber: "TX1234567", violations: [{ code: "395.8(e)", description: "False report of driver's record of duty status", severity: 7, oos: true }, { code: "393.9", description: "Inoperable lamp", severity: 6 }] });
    expect(i.jurisdiction).toBe("TX");
    expect(i.violations.map((v) => [v.basic, v.unit])).toEqual([["hos", "driver"], ["vehicle", "vehicle"]]);
    expect((await db.select().from(flags).where(eq(flags.orderId, o.order.id))).map((x) => x.code)).toEqual(["roadside_oos"]);
    await S.saveInspection(a, null, { inspectedAt: days(-40), country: "CA", jurisdiction: "ON", level: 2, driverId: f.d2, violations: [] });
    const b = await S.inspectionsBoard(a);
    expect(b.list).toHaveLength(2);
    expect(b.measures.find((m) => m.key === "hos")!.measure).toBe(Math.round(((3 * 9) / 3) * 100) / 100);
    expect(b.drivers[0]).toMatchObject({ driverId: f.d1, inspections: 1, oos: 1, points: 27 });
    expect(b.oos.find((x) => x.country === "CA")).toMatchObject({ inspections: 1, clean: 1 });
    const file = await S.driverSafetyFile(a, f.d1);
    expect(file.inspections).toHaveLength(1);
    expect(file.da).not.toBeNull();
    expect((await S.driverSafetyFile({ ...a, role: "dispatcher" }, f.d1)).da).toBeNull(); // confidential
  });
});

describe("overrides log", () => {
  it("lists a 24-hour paperwork override and a dispatch override with who, what and why", async () => {
    await db.update(tenants).set({ settings: {} }).where(eq(tenants.id, a.tenantId));
    await C.setMissingDatesBlock(a, true);
    await C.overrideDispatch(a, "driver", f.d1, "Road test done today, paper on the way");
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d2 }, { override: true, reason: "Ana's file is in the mail" }).catch(() => null);
    const log = await S.overrideLog(a);
    expect(log.find((r) => r.kind === "paperwork" && r.subject === "Daniel Reyes")).toMatchObject({ reason: "Road test done today, paper on the way", href: `/settings/drivers/${f.d1}` });
    const leg = log.find((r) => r.subject.startsWith("Load"));
    expect(leg).toBeDefined();
    expect(leg!.what).toContain("Ana Torres");
    expect(leg!.reason).toBe("Ana's file is in the mail");
    expect(S.overridesCsv(log).split("\n")[0]).toBe("When (UTC),Who,Kind,Subject,What,Reason");
  });
});
