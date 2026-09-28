// Features: F-25.1 F-25.2 F-25.3 F-25.4
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get } from "@/data/records";
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
    const draw = await S.drawRandom(a, { period: "2026-Q3", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 }, (m) => m - 1);
    expect(draw.poolSize).toBe(2);
    expect(draw.drug).toHaveLength(1);
    expect(draw.alcohol).toHaveLength(1);
    await expect(S.drawRandom(a, { period: "2026-Q3", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/already drawn/);
    // who was in the pool is kept with the draw, by name on the program; next quarter can't be drawn early
    await expect(S.drawRandom(a, { period: "2099-Q1", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/2099-Q1 starts Jan 1, 2099/);
    expect((await S.daProgram(a, 2026)).draws.find((x) => x.period === "2026-Q3")!.pool.map((p) => p.name).sort()).toEqual(["Ana Torres", "Daniel Reyes"]);
    await expect(S.drawRandom({ ...a, role: "dispatcher" }, { period: "2026-Q2", drugRate: 50, alcoholRate: 10, drawsPerYear: 4 })).rejects.toThrow(/permission/);
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
    expect(cands.find((c) => c.truckId === f.t1)?.findings.some((x) => x.code === "compliance_block" && !x.overridable && x.message.includes("On a safety hold — ask Safety"))).toBe(true);
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
    await expect(S.saveInspection(a, null, { inspectedAt: days(-3), country: "US", level: 1, driverId: f.d1, violations: [{ code: "395.8(e)", description: "False log", severity: 7, oos: true }] })).rejects.toThrow(/out of service until when/);
    const i = await S.saveInspection(a, null, { inspectedAt: days(-3), country: "US", jurisdiction: "tx", level: 1, driverId: f.d1, truckId: f.t1, orderId: o.order.id, reportNumber: "TX1234567", driverOosUntil: new Date(days(-3).getTime() + 10 * 3600_000), violations: [{ code: "395.8(e)", description: "False report of driver's record of duty status", severity: 7, oos: true }, { code: "393.9", description: "Inoperable lamp", severity: 6 }] });
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
    // the drug test and the Clearinghouse query are the law: only the road test and application are left to vouch for
    await S.recordDq(a, f.d1, "clearinghouse_full", { completedAt: days(-9) });
    await S.addTest(a, { driverId: f.d1, reason: "pre_employment", substance: "drug", collectedAt: days(-12), result: "negative" });
    await S.recordDq(a, f.d2, "clearinghouse_full", { completedAt: days(-9) });
    await S.addTest(a, { driverId: f.d2, reason: "pre_employment", substance: "drug", collectedAt: days(-12), result: "negative" });
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

describe("hire prerequisites block by default (blocker 1)", () => {
  it("a new hire with no file is blocked whatever the blank-dates switch says; a pending pre-employment result reads plainly and nobody can override it", async () => {
    const co = await makeTenant("Past its grace", "owner", { dqGrace: false });
    const t = await create(co, "truck", { unitNumber: "Q216", usPlate: "TX216", usPlateExpires: days(300), dotInspectionExpires: days(300) });
    const diego = await create(co, "driver", { name: "Diego Ramírez", driverType: "CDL", licenseState: "TX", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-1), currentTruckId: t.id });
    let st = await C.statusFor(co, "driver", diego.id);
    expect(st.dispatchable).toBe(false); // switch is off, still blocked
    expect(st.blockers).toEqual(expect.arrayContaining(["No pre-employment drug test", "No Clearinghouse pre-employment query", "Employment application missing"]));
    await S.addTest(co, { driverId: diego.id, reason: "pre_employment", substance: "drug", collectedAt: days(-1), result: "pending" });
    for (const k of ["application", "road_test", "clearinghouse_full"]) await S.recordDq(co, diego.id, k, { completedAt: days(-1) });
    st = await C.statusFor(co, "driver", diego.id);
    expect(st.dispatchable).toBe(false);
    expect(st.blockers).toEqual(["Pre-employment drug test result not in"]);
    expect(st.hard).toBe(true);
    await expect(C.overrideDispatch(co, "driver", diego.id, "need him today")).rejects.toThrow(/cannot override Pre-employment drug test result not in/);
    // the picker never offers him as free: hard-blocked, with the plain reason
    const cust = await create(co, "customer", { name: "Acme", kind: "customer" });
    const o = await createOrder(co, { customerId: cust.id, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    const c = (await candidatesForLeg(co, o.legs[0].id)).find((x) => x.truckId === t.id)!;
    expect(c.hardBlocked).toBe(true);
    expect(c.reason).toBe("Diego Ramírez: Pre-employment drug test result not in");
    // …and the planner never shows the truck as available
    const { plannerData } = await import("./planner");
    expect((await plannerData(co)).trucks.find((x) => x.truckId === t.id)).toMatchObject({ status: "unavailable", why: "Diego: Pre-employment drug test result not in" });
    // the result comes back negative: dispatchable
    const test = (await S.driverTests(co, diego.id)).tests[0];
    await S.recordResult(co, test.id, { result: "negative" });
    st = await C.statusFor(co, "driver", diego.id);
    expect(st.dispatchable).toBe(true);
  });

  it("the application and road test can be vouched for by the owner (24 h override); the company can soften them but never the drug test", async () => {
    const co = await makeTenant("Past its grace", "owner", { dqGrace: false });
    const d = await create(co, "driver", { name: "Rosa", driverType: "CDL", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-1) });
    await S.recordDq(co, d.id, "clearinghouse_full", { completedAt: days(-1) });
    await S.addTest(co, { driverId: d.id, reason: "pre_employment", substance: "drug", collectedAt: days(-2), result: "negative" });
    let st = await C.statusFor(co, "driver", d.id);
    expect(st.dispatchable).toBe(false);
    expect(st.hard).toBe(false);
    await C.overrideDispatch(co, "driver", d.id, "application signed, scanning tonight");
    // warn-only for the road test and application: not blocked; a fixed item ignores the company setting
    await expect(C.setBlockLevels(co, { "dq:pre_employment_test": "warn" })).rejects.toThrow(/set by law/);
    await C.setBlockLevels(co, { "dq:application": "warn", "dq:road_test": "warn" });
    st = await C.statusFor(co, "driver", d.id);
    expect(st.dispatchable).toBe(true);
    await expect(C.setBlockLevels(co, { "da:status": "warn" })).rejects.toThrow(/set by law/);
  });

  it("a new company's 30-day grace lets blank files through — but not a pre-employment test waiting on its result", async () => {
    const co = await makeTenant("New company");
    const d = await create(co, "driver", { name: "Existing driver", driverType: "CDL", licenseExpires: days(400), medicalExpires: days(400) });
    let st = await C.statusFor(co, "driver", d.id);
    expect(st.dispatchable).toBe(true);
    expect(st.items.find((i) => i.key === "dq:application")!.graceUntil).toBeTruthy();
    await S.addTest(co, { driverId: d.id, reason: "pre_employment", substance: "drug", collectedAt: days(-1), result: "pending" });
    st = await C.statusFor(co, "driver", d.id);
    expect(st.blockers).toEqual(["Pre-employment drug test result not in"]);
    // Safety ends the grace: blank files block
    await S.recordResult(co, (await S.driverTests(co, d.id)).tests[0].id, { result: "negative" });
    await C.setDqGrace(co, null);
    st = await C.statusFor(co, "driver", d.id);
    expect(st.dispatchable).toBe(false);
    expect(st.blockers).toContain("No Clearinghouse pre-employment query");
  });
});

describe("roadside out-of-service orders take effect (blocker 5)", () => {
  const load = () => createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US", windowStart: days(0.5) }, { type: "delivery", name: "B", country: "US", windowStart: days(1) }], book: true });
  it("a vehicle OOS takes the truck out of service until Safety signs off the repair — not before, and not from the Fleet page", async () => {
    const tr = await create(a, "trailer", { unitNumber: "5401" });
    const i = await S.saveInspection(a, null, { inspectedAt: days(-0.1), country: "US", jurisdiction: "TX", level: 1, truckId: f.t1, trailerId: tr.id, reportNumber: "TXQA901", violations: [{ code: "393.47(e)", oos: true }] });
    expect(i.violations[0]).toMatchObject({ basic: "vehicle", severity: 4, description: "Clamp or roto-chamber brake out of adjustment", unit: "vehicle" }); // from the code table
    let t = await get(a, "truck", f.t1);
    expect(t).toMatchObject({ status: "oos", oosInspectionId: i.id });
    expect(String(t.oosReason)).toMatch(/Roadside OOS \(TX TXQA901\): 393.47\(e\)/);
    expect((await get(a, "trailer", tr.id)).status).toBe("active"); // found on the tractor
    const o = await load();
    const c = (await candidatesForLeg(a, o.legs[0].id)).find((x) => x.truckId === f.t1)!;
    expect(c.hardBlocked).toBe(true);
    expect(c.reason).toMatch(/out of service/);
    const { setTruckActive } = await import("./orders");
    await expect(setTruckActive(a, f.t1)).rejects.toThrow(/signs off the repair/);
    await expect(S.signOffRepair(a, i.id, { note: "" })).rejects.toThrow(/what was repaired/);
    await expect(S.signOffRepair({ ...a, role: "dispatcher" }, i.id, { note: "adjusted" })).rejects.toThrow(/permission/);
    const signed = await S.signOffRepair(a, i.id, { note: "Slack adjusters replaced, brakes adjusted — Laredo Truck Repair RO 5521", file: { fileName: "ro-5521.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF") } });
    expect(signed.repair).toMatchObject({ byName: "owner user", note: expect.stringContaining("RO 5521") });
    expect(signed.repair!.documentId).toBeTruthy();
    t = await get(a, "truck", f.t1);
    expect(t).toMatchObject({ status: "active", oosInspectionId: null });
    await expect(S.signOffRepair(a, i.id, { note: "again" })).rejects.toThrow(/signed off by/);
  });

  it("a trailer defect takes the trailer out; a DataQs removal releases it", async () => {
    const tr = await create(a, "trailer", { unitNumber: "5402" });
    const input = { inspectedAt: days(-1), country: "US", level: 2, truckId: f.t1, trailerId: tr.id, violations: [{ code: "393.75(a)", oos: true, on: "trailer" as const }] };
    const i = await S.saveInspection(a, null, input);
    expect((await get(a, "trailer", tr.id))).toMatchObject({ status: "oos", oosInspectionId: i.id });
    expect((await get(a, "truck", f.t1)).status).toBe("active");
    expect((await S.openRoadsideOos(a)).map((x) => [x.kind, x.unit])).toEqual([["trailer", "5402"]]);
    await S.saveInspection(a, i.id, { ...input, violations: [{ ...input.violations[0], removed: true }], dataQs: "accepted" });
    expect((await get(a, "trailer", tr.id))).toMatchObject({ status: "active", oosInspectionId: null });
  });

  it("a driver OOS makes the driver unavailable until the order ends: a Safety block nobody overrides, gone when the time is up", async () => {
    const until = days(2);
    await S.saveInspection(a, null, { inspectedAt: days(-0.2), country: "US", level: 3, driverId: f.d1, driverOosUntil: until, violations: [{ code: "395.3(a)(1)", oos: true }] });
    const o = await load();
    const c = (await candidatesForLeg(a, o.legs[0].id)).find((x) => x.truckId === f.t1)!;
    const f1 = c.findings.find((x) => x.code === "safety_oos_order")!;
    expect(f1).toMatchObject({ level: "red", overridable: false });
    expect(f1.message).toMatch(/Daniel Reyes: Safety — out-of-service order until/);
    expect(c.hardBlocked).toBe(true);
  });

  it("the registers export for an auditor with full dates: one line per violation with the repair sign-off; the accident register", async () => {
    const tr = await create(a, "trailer", { unitNumber: "5403" });
    const i = await S.saveInspection(a, null, { inspectedAt: new Date("2026-09-20T15:00:00Z"), country: "US", jurisdiction: "TX", level: 1, reportNumber: "TX9", driverId: f.d1, truckId: f.t1, trailerId: tr.id, violations: [{ code: "393.47(e)", oos: true, on: "trailer" }, { code: "393.9(a)" }] });
    await S.signOffRepair(a, i.id, { note: "brakes adjusted, RO 12", at: new Date("2026-09-21T10:00:00Z") });
    const csv = (await S.inspectionsCsv(a)).split("\n");
    expect(csv[0]).toMatch(/^Date,Country,State \/ province,CVSA level/);
    expect(csv).toHaveLength(3);
    expect(csv[1]).toMatch(/^2026-09-20,US,TX,1,TX9,Daniel Reyes,101,5403,393.47\(e\),Clamp or roto-chamber brake out of adjustment,Vehicle Maintenance,4,yes,,none,,2026-09-21,owner user,"brakes adjusted, RO 12"$/);
    const { saveIncident } = await import("./compliance");
    await saveIncident(a, null, { occurredAt: new Date("2026-09-28T11:15:00Z"), kind: "accident", driverId: f.d1, truckId: f.t1, description: "Tow-away, citation", towAway: true, citation: true, location: "Laredo, TX" });
    const reg = (await S.accidentRegisterCsv(a)).split("\n");
    expect(reg[1]).toBe("2026-09-28,11:15,accident,yes,\"Laredo, TX\",Daniel Reyes,101,,no,no,yes,yes,,,,open,\"Tow-away, citation\"");
  });

  it("Canadian and Mexican violations save as written, without a BASIC or an SMS weight, and stay out of the measures", async () => {
    const ca = await S.saveInspection(a, null, { inspectedAt: days(-2), country: "CA", jurisdiction: "on", level: 2, driverId: f.d1, violations: [{ code: "NSC 13 s.6", description: "Daily trip inspection report not carried", unit: "vehicle" }] });
    expect(ca.violations[0]).toMatchObject({ basic: null, severity: 0, unit: "vehicle" });
    const mx = await S.saveInspection(a, null, { inspectedAt: days(-2), country: "MX", level: 1, truckId: f.t1, violations: [{ code: "NOM-068", description: "Físico-mecánica vencida" }] });
    expect(mx.violations[0].basic).toBeNull();
    const b = await S.inspectionsBoard(a);
    expect(b.measures.every((m) => m.points === 0)).toBe(true);
  });
});

describe("Safety time off is a Safety block (dispatch M25)", () => {
  it("off for a licence renewal: only Safety or the owner can override it, and it never reads as a schedule conflict", async () => {
    const { addEvent } = await import("./planner");
    const { planLeg: plan, needsSafety } = await import("./orders");
    await addEvent(a, { subjectKind: "driver", subjectId: f.d2, kind: "credentials", startsAt: days(-1), endsAt: days(3), note: "Licence renewal at DPS" });
    await S.recordDq(a, f.d2, "clearinghouse_full", { completedAt: days(-9) });
    await S.addTest(a, { driverId: f.d2, reason: "pre_employment", substance: "drug", collectedAt: days(-12), result: "negative" });
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US", windowStart: days(0.5) }, { type: "delivery", name: "B", country: "US", windowStart: days(1) }], book: true });
    const err = await plan(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d2 }).catch((e) => e);
    const fnd = (err.findings as { code: string; message: string; overridable: boolean }[]).find((x) => x.code === "safety_credentials")!;
    expect(fnd.message).toMatch(/Ana Torres: Safety — licence \/ medical renewal until .* \(Licence renewal at DPS\)/);
    expect(needsSafety(fnd as never)).toBe(true);
    await expect(plan({ ...a, role: "dispatcher" }, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d2 }, { override: true, reason: "she'll be back" })).rejects.toThrow(/compliance.override/);
  });
});
