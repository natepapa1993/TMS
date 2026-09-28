// Features: F-30.1 F-30.2
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { stops as stopsT, drivers as driversT, flags as flagsT } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { reachability, spokenTime, DEADHEAD_MPH } from "./planner-rules";
import { rankForLeg, plannerData } from "./planner";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, clearFlag, EligibilityError, candidatesForLeg } from "./orders";
import { addCheckCall } from "./check-calls";
import { mergeCallEtas, alertsOf } from "./board-buckets";

const future = new Date(Date.now() + 365 * 86400_000);
const H = 3600_000;

describe("can the truck make the pickup (pure)", () => {
  const now = new Date("2026-09-28T13:00:00Z"); // Mon 8 AM in Laredo
  const zone = "America/Chicago";

  it("arrives in time: ready", () => {
    const r = reachability({ now, freeAt: null, deadheadMi: 100, pickupStart: new Date(now.getTime() + 6 * H), pickupEnd: null, zone });
    expect(r.status).toBe("ok");
    expect(r.arriveAt!.getTime()).toBe(now.getTime() + (100 / DEADHEAD_MPH) * H + 30 * 60_000);
    expect(r.message).toBeNull();
  });

  it("1,789 empty miles for a pickup at 6 PM today: can't make it, says when it would arrive", () => {
    const r = reachability({ now, freeAt: new Date(now.getTime() + 6 * H), deadheadMi: 1789, pickupStart: new Date(now.getTime() + 10 * H), pickupEnd: null, zone });
    expect(r.status).toBe("late");
    expect(r.message).toMatch(/^Can't make it — arrives ~\w+ \d{1,2}(:\d{2})? (AM|PM), pickup today 6 PM$/);
  });

  it("a window counts until it closes", () => {
    const r = reachability({ now, freeAt: null, deadheadMi: 250, pickupStart: new Date(now.getTime() + 2 * H), pickupEnd: new Date(now.getTime() + 8 * H), zone });
    expect(r.status).toBe("ok");
  });

  it("a pickup already past is the load's problem", () => {
    const r = reachability({ now, freeAt: null, deadheadMi: 10, pickupStart: new Date(now.getTime() - H), pickupEnd: null, zone });
    expect(r.status).toBe("past");
    expect(r.message).toMatch(/Pickup time passed/);
  });

  it("no pickup time or no distance: nothing to say", () => {
    expect(reachability({ now, freeAt: null, deadheadMi: 10, pickupStart: null, pickupEnd: null, zone }).status).toBe("unknown");
    expect(reachability({ now, freeAt: null, deadheadMi: null, pickupStart: new Date(now.getTime() + H), pickupEnd: null, zone }).status).toBe("unknown");
  });

  it("a driver short of hours takes a 10-hour break first (fresh ELD hours only)", () => {
    const pickup = new Date(now.getTime() + 9 * H);
    const tired = reachability({ now, freeAt: null, deadheadMi: 300, pickupStart: pickup, pickupEnd: null, zone, hos: { driveMin: 60, shiftMin: 200, at: now } });
    expect(tired.needsBreak).toBe(true);
    expect(tired.status).toBe("late");
    expect(tired.message).toContain("10-h break");
    const rested = reachability({ now, freeAt: null, deadheadMi: 300, pickupStart: pickup, pickupEnd: null, zone, hos: { driveMin: 600, shiftMin: 800, at: now } });
    expect(rested.status).toBe("ok");
    const stale = reachability({ now, freeAt: null, deadheadMi: 300, pickupStart: pickup, pickupEnd: null, zone, hos: { driveMin: 60, shiftMin: 60, at: new Date(now.getTime() - 20 * H) } });
    expect(stale.needsBreak).toBe(false);
  });

  it("speaks times on the stop's clock", () => {
    expect(spokenTime(new Date("2026-09-29T20:00:00Z"), zone, now)).toBe("tomorrow 3 PM");
    expect(spokenTime(new Date("2026-09-30T14:30:00Z"), zone, now)).toBe("Wed 9:30 AM");
  });
});

describe("ranking trucks for a load (M5) and breakdowns (M7)", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  let f: { cust: string; near: string; far: string; ana: string; dan: string };
  beforeEach(async () => {
    await truncateAll();
    a = await makeTenant("Reach Carrier");
    const cust = await create(a, "customer", { name: "Acme", kind: "broker" });
    const near = await create(a, "truck", { unitNumber: "203", usPlate: "TX203", usPlateExpires: future });
    const far = await create(a, "truck", { unitNumber: "208", usPlate: "TX208", usPlateExpires: future });
    const ana = await create(a, "driver", { name: "Ana Cruz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: near.id });
    const dan = await create(a, "driver", { name: "Dan Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: far.id });
    f = { cust: cust.id, near: near.id, far: far.id, ana: ana.id, dan: dan.id };
  });

  /** A delivered load that leaves a truck at a city: that's where it comes free. */
  const parkAt = async (truckId: string, driverId: string, city: string, state: string) => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 1000, book: true, stops: [{ type: "pickup", name: `Start ${city}`, country: "US", address: { city, state } }, { type: "delivery", name: `End ${city}`, country: state === "ON" ? "CA" : "US", address: { city, state } }] });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId, driverId });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
  };
  const loadAt = async (hoursFromNow: number) =>
    createOrder(a, { customerId: f.cust, rateCents: 150000, book: true, stops: [{ type: "pickup", name: "Shipper San Antonio", country: "US", address: { city: "San Antonio", state: "TX" }, windowStart: new Date(Date.now() + hoursFromNow * H) }, { type: "delivery", name: "DC Dallas", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(Date.now() + (hoursFromNow + 8) * H) }] });

  it("a truck 1,700 miles away is not 'Ready' for a pickup in 6 hours: it says when it would arrive and sinks", async () => {
    await parkAt(f.near, f.ana, "Laredo", "TX");
    await parkAt(f.far, f.dan, "Mississauga", "ON");
    const o = await loadAt(6);
    const ranked = await rankForLeg(a, o.legs[0].id);
    expect(ranked[0].unitNumber).toBe("203");
    expect(ranked[0].reach?.status).toBe("ok");
    const far = ranked.find((c) => c.unitNumber === "208")!;
    expect(far.reach?.status).toBe("late");
    expect(far.reason).toMatch(/^Can't make it — arrives ~/);
    expect(far.deadheadMi).toBeGreaterThan(1500);
    expect(far.score).toBeGreaterThan(ranked[0].score);
  });

  it("a pickup already in the past is flagged for the load, not blamed on a truck", async () => {
    const o = await loadAt(-2);
    const ranked = await rankForLeg(a, o.legs[0].id);
    expect(ranked.every((c) => c.pickupPassed)).toBe(true);
    expect(ranked[0].reach?.message).toMatch(/Pickup time passed/);
  });

  it("the planner's loads carry the pickup's zone and window close for the same check", async () => {
    const o = await loadAt(30);
    await db.update(stopsT).set({ windowEnd: new Date(Date.now() + 32 * H) }).where(and(eq(stopsT.orderId, o.order.id), eq(stopsT.type, "pickup")));
    const p = await plannerData(a);
    const l = p.legs.find((x) => x.orderId === o.order.id)!;
    expect(l.from.zone).toBe("America/Chicago");
    expect(l.from.until).not.toBeNull();
    expect(l.from.lat).not.toBeNull(); // from the built-in city list: San Antonio
  });

  it("uses the driver's ELD hours when they are fresh", async () => {
    await parkAt(f.near, f.ana, "Laredo", "TX");
    await db.update(driversT).set({ hosDriveMin: 30, hosShiftMin: 30, hosCycleMin: 600, hosAt: new Date() }).where(eq(driversT.id, f.ana));
    const o = await loadAt(5); // Laredo → San Antonio ~ 3 h: fine with hours, not after a 10-h break
    const r = (await rankForLeg(a, o.legs[0].id)).find((c) => c.unitNumber === "203")!;
    expect(r.reach?.status).toBe("late");
    expect(r.reason).toContain("10-h break");
  });

  it("a Breakdown check call flags the load and takes the truck out until someone clears it", async () => {
    const o1 = await loadAt(2);
    const leg = o1.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.near, driverId: f.ana });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await advanceLeg(a, leg, "en_route_to_pickup");
    await addCheckCall(a, o1.order.id, { status: "breakdown", location: "Love's #312, Cotulla TX", note: "blown turbo" });
    const [flag] = await db.select().from(flagsT).where(and(eq(flagsT.orderId, o1.order.id), eq(flagsT.code, "breakdown"), isNull(flagsT.clearedAt)));
    expect(flag.level).toBe("red");
    expect(flag.data).toMatchObject({ truckId: f.near });
    // the planner: unavailable, with the reason
    const p = await plannerData(a);
    const t = p.trucks.find((x) => x.truckId === f.near)!;
    expect(t.status).toBe("unavailable");
    expect(t.why).toMatch(/^Unavailable — breakdown on /);
    // the ranked list: blocked, no override
    const o2 = await loadAt(20);
    const c = (await candidatesForLeg(a, o2.legs[0].id)).find((x) => x.truckId === f.near)!;
    expect(c.hardBlocked).toBe(true);
    expect(c.reason).toMatch(/broken down/);
    await expect(planLeg(a, o2.legs[0].id, { kind: "truck", truckId: f.near, driverId: f.ana }, { override: true, reason: "try" })).rejects.toBeInstanceOf(EligibilityError);
    // fixed: clear the flag, the truck is back
    await clearFlag(a, flag.id, "turbo replaced");
    const back = (await candidatesForLeg(a, o2.legs[0].id)).find((x) => x.truckId === f.near)!;
    expect(back.hardBlocked).toBe(false);
    expect((await plannerData(a)).trucks.find((x) => x.truckId === f.near)!.status).not.toBe("unavailable");
  });
});

describe("the dispatcher's ETA drives Late and At risk (M6)", () => {
  const appt = "2026-09-28T12:00:00.000Z"; // 7 AM CDT
  const row = (arrived: string | null = null) => ({
    order: { id: "o1", state: "dispatched" },
    stage: "dispatched",
    legs: [{ id: "l1", state: "en_route", truckId: "t1", fromStopId: "s1", toStopId: "s2" }],
    stops: [
      { id: "s1", seq: 1, type: "pickup", name: "Shipper", windowStart: "2026-09-27T12:00:00.000Z", windowEnd: null, arrivedAt: "2026-09-27T12:00:00.000Z", departedAt: "2026-09-27T14:00:00.000Z" },
      { id: "s2", seq: 2, type: "delivery", name: "Receiver", windowStart: appt, windowEnd: null, arrivedAt: arrived },
    ],
    tenders: [],
    openFlags: [],
  });
  const ctx = (etas: Record<string, { at: string; late: boolean }>) => ({ now: new Date("2026-09-28T09:00:00Z").getTime(), etas, lastPing: () => new Date("2026-09-28T08:55:00Z").toISOString(), today: () => "x", dayOf: () => "y" });

  it("a check call ETA after the appointment makes the load Late even when the GPS says on time", () => {
    const gps = { l1: { at: "2026-09-28T11:00:00.000Z", stopName: "Receiver", miles: 60, late: false, positionAt: "2026-09-28T08:00:00.000Z", source: "gps" as const } };
    const merged = mergeCallEtas([row()], gps, { o1: { at: "2026-09-28T08:30:00.000Z", etaAt: "2026-09-28T16:00:00.000Z", legId: "l1" } });
    expect(merged.l1).toMatchObject({ source: "check_call", late: true, at: "2026-09-28T16:00:00.000Z" });
    expect(alertsOf(row(), ctx(merged)).has("late")).toBe(true);
    expect(alertsOf(row(), ctx(gps)).has("late")).toBe(false);
  });

  it("an ETA just inside the appointment is At risk", () => {
    const merged = mergeCallEtas([row()], {}, { o1: { at: "2026-09-28T08:30:00.000Z", etaAt: "2026-09-28T11:30:00.000Z", legId: "l1" } });
    const a = alertsOf(row(), ctx(merged));
    expect(a.has("late")).toBe(false);
    expect(a.has("at_risk")).toBe(true);
  });

  it("a newer GPS position replaces the dispatcher's ETA; an arrival ends it", () => {
    const gps = { l1: { at: "2026-09-28T11:00:00.000Z", stopName: "Receiver", miles: 60, late: false, positionAt: "2026-09-28T08:45:00.000Z", source: "gps" as const } };
    expect(mergeCallEtas([row()], gps, { o1: { at: "2026-09-28T08:30:00.000Z", etaAt: "2026-09-28T16:00:00.000Z", legId: "l1" } }).l1.source).toBe("gps");
    expect(mergeCallEtas([row("2026-09-28T08:50:00.000Z")], {}, { o1: { at: "2026-09-28T08:30:00.000Z", etaAt: "2026-09-28T16:00:00.000Z", legId: "l1" } }).l1).toBeUndefined();
  });

  it("a call from before the truck left the previous stop does not count for the next one", () => {
    expect(mergeCallEtas([row()], {}, { o1: { at: "2026-09-27T13:00:00.000Z", etaAt: "2026-09-28T16:00:00.000Z", legId: "l1" } }).l1).toBeUndefined();
  });
});
