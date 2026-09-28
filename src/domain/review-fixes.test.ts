// Features: F-3 F-7 F-6 fixes from the dispatcher / safety / billing review
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { crossings, legs as legsT, payItems, incidents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, updateStop, getOrder } from "./orders";
import { stopTimeProblems } from "./zones";
import * as B from "./billing";
import { crossingBoard } from "./crossing";
import { saveIncident, overrideDispatch, evaluateSubject, snooze, unsnooze, setMissingDatesBlock, statusFor } from "./compliance";
import { update } from "@/data/records";

/** statements for this week can only be approved once it has ended */
const afterWeek = new Date(Date.now() + 8 * 86400_000);

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; t2: string; jose: string; ana: string };
const at = (h: number) => new Date(Date.now() + h * 3600_000);

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Review Carrier");
  const cust = await create(a, "customer", { name: "Acme", kind: "broker" });
  const t1 = await create(a, "truck", { unitNumber: "103", usPlate: "TX103", usPlateExpires: future });
  const t2 = await create(a, "truck", { unitNumber: "104", usPlate: "TX104", usPlateExpires: future });
  const jose = await create(a, "driver", { name: "Jose Garcia", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id, payType: "per_mile", payRateCents: 60 });
  const ana = await create(a, "driver", { name: "Ana Cruz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2.id });
  f = { cust: cust.id, t1: t1.id, t2: t2.id, jose: jose.id, ana: ana.id };
});

const load = (from: Date, to: Date, stops?: { type: "pickup" | "delivery" | "border_yard" | "yard"; name: string; country: string; windowStart?: Date }[]) =>
  createOrder(a, { customerId: f.cust, rateCents: 100000, stops: stops ?? [{ type: "pickup", name: "Laredo", country: "US", windowStart: from }, { type: "delivery", name: "Dallas DC", country: "US", windowStart: to }], book: true });

describe("stop times", () => {
  it("a stop can't be scheduled before the one ahead of it, or end before it starts", () => {
    expect(stopTimeProblems([{ windowStart: "2026-09-30T13:00:00Z" }, { windowStart: "2026-09-29T13:00:00Z" }])).toEqual(["stop 2 is scheduled before stop 1"]);
    expect(stopTimeProblems([{ windowStart: "2026-09-30T13:00:00Z", windowEnd: "2026-09-30T12:00:00Z" }])).toEqual(["stop 1: the window ends before it starts"]);
    expect(stopTimeProblems([{ windowStart: "2026-09-29T13:00:00Z" }, {}, { windowStart: "2026-09-30T13:00:00Z" }])).toEqual([]);
  });
  it("an appointment change keeps its time; a change out of order is refused", async () => {
    const o = await load(at(24), at(48));
    const del = o.stops[1];
    const after = await updateStop(a, del.id, { windowStart: new Date("2027-01-05T00:00:00Z") });
    expect(after.windowStart!.toISOString()).toBe("2027-01-05T00:00:00.000Z");
    await expect(updateStop(a, del.id, { windowStart: at(1) })).rejects.toThrow(/before stop 1/);
  });
});

describe("double booking", () => {
  it("a truck already on an overlapping load needs a confirmed reason; a dispatcher can give it; no overlap, no question", async () => {
    const first = await load(at(2), at(20));
    await planLeg(a, first.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.jose });
    const second = await load(at(10), at(30));
    await expect(planLeg(a, second.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.jose })).rejects.toThrow(/unit 103 is on 26-00001 until/);
    const dispatcher = { ...a, role: "dispatcher" as const };
    const ok = await planLeg(dispatcher, second.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.jose }, { override: true, reason: "relay at Dallas, finishes early" });
    expect(ok.leg.truckId).toBe(f.t1);
    const later = await load(at(30), at(40));
    await expect(planLeg(a, later.legs[0].id, { kind: "truck", truckId: f.t2, driverId: f.ana })).resolves.toBeTruthy();
  });
  it("a paperwork block needs Safety or the owner to override, not dispatch", async () => {
    await db.update((await import("@/db/schema")).drivers).set({ fastExpires: null }).where(eq((await import("@/db/schema")).drivers.id, f.ana));
    const dispatcher = { ...a, role: "dispatcher" as const };
    const safety = { ...a, role: "compliance" as const };
    await expect(overrideDispatch(dispatcher, "driver", f.ana, "need her today")).rejects.toThrow(/lacks permission compliance.override/);
    await expect(overrideDispatch(safety, "driver", f.ana, "renewal on file, uploading tonight")).resolves.toBeTruthy();
  });
});

describe("crossings follow their leg", () => {
  it("a crossing leg that's done clears the crossing on the board, attributed to the system", async () => {
    const o = await load(at(0), at(0), [
      { type: "pickup", name: "Apodaca", country: "MX", windowStart: at(-30) },
      { type: "border_yard", name: "NLD yard", country: "MX" },
      { type: "yard", name: "Laredo yard", country: "US" },
      { type: "delivery", name: "San Antonio", country: "US", windowStart: at(5) },
    ]);
    const xing = o.legs.find((l) => l.type === "crossing")!;
    await db.update(legsT).set({ state: "completed", completedAt: at(-2) }).where(eq(legsT.id, xing.id));
    const rows = await crossingBoard(a);
    const row = rows.find((r) => r.c.legId === xing.id)!;
    expect(row.c.state).toBe("cleared");
    const [c] = await db.select().from(crossings).where(eq(crossings.legId, xing.id));
    expect(c.updatedBy).toBeNull();
  });
});

describe("pay items land on the next statement built", () => {
  it("the Monday run for last week includes items added today; a one-off is done once a paid statement carries it", async () => {
    const o = await load(at(-72), at(-60));
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.jose }, { plannedMiles: 500, override: true, reason: "past" });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    for (const s of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, s, { at: at(-60) });
    await B.addPayItem(a, f.jose, { kind: "advance", description: "Cash advance", amountCents: 20000 });
    await B.addPayItem(a, f.jose, { kind: "deduction", description: "ELD fee", amountCents: 2500, recurring: true });
    await B.addPayItem(a, f.jose, { kind: "reimbursement", description: "Lumper", amountCents: 12000 });
    const start = new Date(Date.now() - 7 * 86400_000);
    const st = await B.buildSettlement(a, f.jose, start, new Date());
    expect(st.lines.map((l) => [l.description, l.amountCents])).toEqual(expect.arrayContaining([["Cash advance", -20000], ["ELD fee", -2500], ["Lumper", 12000]]));
    expect(st.netCents).toBe(30000 - 20000 - 2500 + 12000);
    for (const to of ["reviewed", "approved"] as const) await B.settlementTransition(a, st.id, to, { now: afterWeek });
    await B.settlementTransition(a, st.id, "paid", { method: "ach", reference: "ACH-9", now: afterWeek });
    const items = await db.select().from(payItems).where(eq(payItems.driverId, f.jose));
    expect(Object.fromEntries(items.map((i) => [i.description, i.active]))).toEqual({ "Cash advance": false, "ELD fee": true, Lumper: false });
    // a week with only the ELD fee and no pay makes no statement: the fee waits for one with pay
    await expect(B.buildSettlement(a, f.jose, new Date(), new Date(Date.now() + 7 * 86400_000))).rejects.toThrow(/no pay for the week/);
    expect((await getOrder(a, o.order.id)).order.state).toBe("delivered");
  });
});

describe("incidents", () => {
  it("an accident with an injury or a tow-away is DOT-recordable", async () => {
    const r = await saveIncident(a, null, { occurredAt: new Date("2026-09-21T19:32:00Z"), kind: "accident", description: "Backed into a post", towAway: true });
    expect(r.dotRecordable).toBe(true);
    expect(r.occurredAt.toISOString()).toBe("2026-09-21T19:32:00.000Z");
    const again = await saveIncident(a, r.id, { ...r, claimNumber: "CLM-1" });
    expect(again.occurredAt.toISOString()).toBe("2026-09-21T19:32:00.000Z");
    const [row] = await db.select().from(incidents).where(eq(incidents.id, r.id));
    expect(row.claimNumber).toBe("CLM-1");
  });
});

describe("safety controls", () => {
  it("a snooze quiets the reminder but never lifts a block; it can be ended early", async () => {
    await db.update((await import("@/db/schema")).drivers).set({ medicalExpires: new Date(Date.now() - 86400_000) }).where(eq((await import("@/db/schema")).drivers.id, f.ana));
    let st = await evaluateSubject(a, "driver", f.ana);
    expect(st.dispatchable).toBe(false);
    st = await snooze(a, "driver", f.ana, "field:medicalExpires", new Date(Date.now() + 10 * 86400_000), "renewal booked");
    expect(st.items.find((i) => i.key === "field:medicalExpires")!.status).toBe("snoozed");
    expect(st.dispatchable).toBe(false);
    expect(st.expired).toEqual(["Medical card"]);
    st = await unsnooze(a, "driver", f.ana, "field:medicalExpires");
    expect(st.items.find((i) => i.key === "field:medicalExpires")!.status).toBe("expired");
  });
  it("a blank required date blocks only once the company turns it on; an optional blank date is 'not on file', not ok", async () => {
    const st = await evaluateSubject(a, "truck", f.t1);
    expect(st.items.find((i) => i.key === "field:dotInspectionExpires")!.status).toBe("missing");
    expect(st.dispatchable).toBe(true);
    expect((await evaluateSubject(a, "driver", f.jose)).items.find((i) => i.key === "field:fastExpires")!.status).toBe("na");
    await expect(setMissingDatesBlock({ ...a, role: "dispatcher" }, true)).rejects.toThrow(/compliance.override/);
    await setMissingDatesBlock(a, true);
    const after = await statusFor(a, "truck", f.t1);
    expect(after.dispatchable).toBe(false);
    const o = await load(at(2), at(20));
    await expect(planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.jose })).rejects.toThrow(/Annual inspection missing/);
  });
  it("only Safety changes licence and inspection dates and the document rules", async () => {
    const dispatcher = { ...a, role: "dispatcher" as const };
    await expect(update(dispatcher, "driver", f.ana, { licenseExpires: new Date("2030-01-01") })).rejects.toThrow(/Licen[cs]e expires is kept by Safety/);
    await expect(update(dispatcher, "driver", f.ana, { phone: "+1 956 555 0199" })).resolves.toBeTruthy();
    await expect(create(dispatcher, "documentType", { name: "MEC", appliesTo: "driver" })).rejects.toThrow(/lacks permission compliance.edit/);
    await expect(update({ ...a, role: "compliance" as const }, "driver", f.ana, { licenseExpires: new Date("2030-01-01") })).resolves.toBeTruthy();
  });
  it("a US carrier with no MC# or DOT# needs Safety to vouch for it; low liability limits are flagged", async () => {
    const lone = await create(a, "carrier", { name: "Lone Star", country: "US", kind: "us", dispatchEmail: "d@ls.test" });
    const o = await load(at(2), at(20));
    await expect(planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: lone.id })).rejects.toThrow(/no MC# or DOT# on file/);
    await expect(planLeg({ ...a, role: "dispatcher" }, o.legs[0].id, { kind: "carrier", carrierId: lone.id }, { override: true, reason: "trust me" })).rejects.toThrow(/compliance.override/);
    await update(a, "carrier", lone.id, { mcNumber: "123456", autoLiabilityCents: 50_000_000 });
    await expect(planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: lone.id })).rejects.toThrow(/under the \$750,000 minimum/);
    await update(a, "carrier", lone.id, { autoLiabilityCents: 100_000_000 });
    await expect(planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: lone.id })).resolves.toBeTruthy();
  });
});
