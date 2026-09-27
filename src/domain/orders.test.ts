// Features: F-1.5 F-2.1 F-2.2 F-2.3 F-3.1 F-3.2 F-11.1 F-11.2 F-11.3 F-11.4 F-11.5 F-15 F-16 F-2.9 F-2.10 F-5.13 F-2.11 F-2.12 F-3.10
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { auditLog, legEvents, flags, stops as stopsTable } from "@/db/schema";
import { and, eq, asc, sql } from "drizzle-orm";
import {
  createOrder,
  bookOrder,
  cancelOrder,
  holdOrder,
  releaseOrder,
  planLeg,
  unplanLeg,
  dispatchLeg,
  acceptLeg,
  declineLeg,
  advanceLeg,
  splitLeg,
  setTruckOos,
  setTruckActive,
  setLegDrivers,
  candidatesForLeg,
  board,
  getOrder,
  updateOrder,
  updateStop,
  addStop,
  removeStop,
  moveStop,
  ValidationError,
  EligibilityError,
  NotFoundError,
} from "./orders";
import { TransitionError } from "./states";
import { PermissionError } from "@/lib/context";

// F-2 orders, F-3 dispatch, F-11.1–11.3, T1 (order → dispatch → delivered), T2 (eligibility), T20 (isolation)

const future = new Date(Date.now() + 365 * 86400_000);
const past = new Date(Date.now() - 86400_000);

let a: Awaited<ReturnType<typeof makeTenant>>;
let fleet: { t2117: string; t2109: string; t2104: string; benja: string; martin: string; reyes: string; garza: string; rxo: string };

async function seedFleet(ctx: typeof a) {
  const t2117 = await create(ctx, "truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future });
  const t2109 = await create(ctx, "truck", { unitNumber: "2109", usPlate: "TX1", mxPlate: "MX1", mxPlateClass: "blue", usPlateExpires: future, mxPlateExpires: future });
  const t2104 = await create(ctx, "truck", { unitNumber: "2104", usPlate: "TX2", usPlateExpires: future });
  const benja = await create(ctx, "driver", { name: "Benjamín Xochihua", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future, currentTruckId: t2117.id });
  const martin = await create(ctx, "driver", { name: "Martín Martínez", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future });
  const reyes = await create(ctx, "driver", { name: "D. Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
  const garza = await create(ctx, "carrier", { name: "Transportes Garza", country: "MX", rfc: "TGA010203AB1", caatExpires: future });
  const rxo = await create(ctx, "customer", { name: "RXO", kind: "broker", termsDays: 30 });
  return { t2117: t2117.id, t2109: t2109.id, t2104: t2104.id, benja: benja.id, martin: martin.id, reyes: reyes.id, garza: garza.id, rxo: rxo.id };
}

const crossBorderStops = [
  { type: "pickup" as const, name: "Planta Monterrey", country: "MX" },
  { type: "border_yard" as const, name: "Santa Fe Yard", country: "MX" },
  { type: "yard" as const, name: "Laredo Yard", country: "US" },
  { type: "delivery" as const, name: "GM Arlington", country: "US" },
];

async function crossBorderOrder(ctx: typeof a, extra: Record<string, unknown> = {}) {
  return createOrder(ctx, { customerId: fleet.rxo, rateCents: 285000, stops: crossBorderStops, book: true, ...extra });
}

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7 Expedite");
  fleet = await seedFleet(a);
});

describe("order creation (F-2.1)", () => {
  it("numbers orders YY-NNNNN per tenant and cuts legs from the stops as entered", async () => {
    const yy = String(new Date().getFullYear()).slice(-2);
    const o1 = await createOrder(a, { customerId: fleet.rxo, rateCents: 1000, stops: crossBorderStops });
    const o2 = await createOrder(a, { customerId: fleet.rxo, rateCents: 1000, stops: crossBorderStops });
    expect(o1.order.orderNumber).toBe(`${yy}-00001`);
    expect(o2.order.orderNumber).toBe(`${yy}-00002`);
    expect(o1.order.legTemplate).toBe("stops");
    expect(o1.legs.map((l) => l.type)).toEqual(["mx", "crossing", "us"]); // hand-offs at the two yards
    expect(o1.legs.map((l) => l.state)).toEqual(["unassigned", "unassigned", "unassigned"]);
    expect(o1.stops.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(o1.legs[0].fromStopId).toBe(o1.stops[0].id);
    expect(o1.legs[2].toStopId).toBe(o1.stops[3].id);
    const b = await makeTenant("Other Carrier");
    const other = await createOrder(b, { customerId: null, brokerId: null, rateTbd: true, stops: crossBorderStops });
    expect(other.order.orderNumber).toBe(`${yy}-00001`);
  });

  it("numbering survives concurrent creation", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "A" }, { type: "delivery", name: "B" }] })));
    const numbers = results.map((r) => r.order.orderNumber).sort();
    expect(new Set(numbers).size).toBe(8);
  });

  it("any number of stops: pickups and drops ride one leg; a hand-off starts the next; a leg that changes country is the crossing — Canada too", async () => {
    const o = await createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "Dallas", country: "US" }, { type: "delivery", name: "Detroit", country: "US" }] });
    expect(o.legs.map((l) => l.type)).toEqual(["domestic"]);
    const multi = await createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "pickup", name: "Toledo", country: "US" }, { type: "delivery", name: "Columbus", country: "US" }, { type: "delivery", name: "Cincinnati", country: "US" }] });
    expect(multi.legs.map((l) => [l.type, l.fromStopId, l.toStopId])).toEqual([["domestic", multi.stops[0].id, multi.stops[3].id]]);
    const ca = await createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "delivery", name: "Windsor", country: "CA" }, { type: "delivery", name: "Toronto", country: "CA" }] });
    expect(ca.legs.map((l) => l.type)).toEqual(["crossing"]); // one truck straight through
    const caHand = await createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "yard", name: "Windsor yard", country: "CA" }, { type: "delivery", name: "Toronto", country: "CA" }] });
    expect(caHand.legs.map((l) => l.type)).toEqual(["crossing", "ca"]);
    // a template can still be asked for by name, and must fit
    await expect(createOrder(a, { rateTbd: true, template: "mx_crossing_us", stops: [{ type: "pickup", name: "A" }, { type: "delivery", name: "B" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createOrder(a, { rateTbd: true, stops: [{ type: "pickup", name: "A" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createOrder(a, { rateCents: -5, stops: crossBorderStops })).rejects.toBeInstanceOf(ValidationError);
  });

  it("draft → booked needs a customer and a rate (or TBD)", async () => {
    const o = await createOrder(a, { stops: crossBorderStops });
    await expect(bookOrder(a, o.order.id)).rejects.toThrow(/customer/);
    await updateOrder(a, o.order.id, { customerId: fleet.rxo });
    await expect(bookOrder(a, o.order.id)).rejects.toThrow(/rate/);
    await updateOrder(a, o.order.id, { rateTbd: true });
    expect((await bookOrder(a, o.order.id)).state).toBe("booked");
  });

  it("a driver role cannot create orders; a dispatcher can", async () => {
    const d = await makeTenant("X", "driver");
    await expect(createOrder(d, { rateTbd: true, stops: crossBorderStops })).rejects.toBeInstanceOf(PermissionError);
    const disp = await makeTenant("Y", "dispatcher");
    const o = await createOrder(disp, { rateTbd: true, stops: crossBorderStops });
    expect(o.order.state).toBe("draft");
  });
});

describe("planning & eligibility (F-3, T2)", () => {
  it("cannot plan a draft order's leg", async () => {
    const o = await createOrder(a, { customerId: fleet.rxo, rateTbd: true, stops: crossBorderStops });
    await expect(planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja })).rejects.toBeInstanceOf(TransitionError);
  });

  it("brown-plate 2117 with B-1 team plans the crossing; the same team is hard-blocked on the US leg", async () => {
    const o = await crossBorderOrder(a);
    const crossing = o.legs[1];
    const r = await planLeg(a, crossing.id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja, coDriverId: fleet.martin });
    expect(r.leg.state).toBe("planned");
    expect(r.leg.coDriverId).toBe(fleet.martin);
    const us = o.legs[2];
    const err = await planLeg(a, us.id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja }, { override: true, reason: "try anyway" }).catch((e) => e);
    expect(err).toBeInstanceOf(EligibilityError);
    expect(err.hardBlocked).toBe(true);
    expect(err.findings.map((f: { code: string }) => f.code)).toContain("b1_domestic");
  });

  it("brown plates cannot run interior Mexico even with override; a Mexican carrier can", async () => {
    const o = await crossBorderOrder(a);
    const mx = o.legs[0];
    await expect(planLeg(a, mx.id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja }, { override: true, reason: "x" })).rejects.toBeInstanceOf(EligibilityError);
    const r = await planLeg(a, mx.id, { kind: "carrier", carrierId: fleet.garza, carrierRateCents: 45000 });
    expect(r.leg.assigneeKind).toBe("carrier");
    expect(r.leg.carrierRateCents).toBe(45000);
  });

  it("a Mexican carrier cannot be planned on the US leg", async () => {
    const o = await crossBorderOrder(a);
    await expect(planLeg(a, o.legs[2].id, { kind: "carrier", carrierId: fleet.garza })).rejects.toBeInstanceOf(EligibilityError);
  });

  it("an overridable finding needs the override flag, a reason, and the override permission — and is audited", async () => {
    const o = await crossBorderOrder(a);
    const mx = o.legs[0];
    // CDL driver on interior Mexico with a blue-plate truck = overridable red
    const e1 = await planLeg(a, mx.id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.reyes }).catch((e) => e);
    expect(e1).toBeInstanceOf(EligibilityError);
    expect(e1.hardBlocked).toBe(false);
    await expect(planLeg(a, mx.id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.reyes }, { override: true })).rejects.toBeInstanceOf(ValidationError);
    const disp = { ...a, role: "dispatcher" as const };
    await expect(planLeg(disp, mx.id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.reyes }, { override: true, reason: "customer approved" })).rejects.toBeInstanceOf(PermissionError);
    const r = await planLeg(a, mx.id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.reyes }, { override: true, reason: "customer approved" });
    expect(r.leg.state).toBe("planned");
    const overrides = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.action, "override")));
    expect(overrides.length).toBe(1);
    expect(overrides[0].note).toBe("customer approved");
  });

  it("expired FAST card blocks the crossing; an OOS truck blocks everything", async () => {
    const o = await crossBorderOrder(a);
    const tired = await create(a, "driver", { name: "Old FAST", driverType: "B1", mxLicenseExpires: future, fastExpires: past, i94Until: future, medicalExpires: future, licenseExpires: future });
    await expect(planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: tired.id })).rejects.toBeInstanceOf(EligibilityError);
    await setTruckOos(a, fleet.t2104, "brakes");
    await expect(planLeg(a, o.legs[2].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes })).rejects.toBeInstanceOf(EligibilityError);
    await setTruckActive(a, fleet.t2104);
    expect((await planLeg(a, o.legs[2].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes })).leg.state).toBe("planned");
  });

  it("unplan clears the assignment and returns the leg to Pending", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    const l = await unplanLeg(a, o.legs[1].id, "driver sick");
    expect(l.state).toBe("unassigned");
    expect(l.truckId).toBeNull();
    expect(l.driverId).toBeNull();
  });

  it("re-planning a planned leg swaps the assignment without a state change", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    const r = await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.martin });
    expect(r.leg.state).toBe("planned");
    expect(r.leg.truckId).toBe(fleet.t2109);
    const evs = await db.select().from(legEvents).where(eq(legEvents.legId, o.legs[1].id));
    expect(evs.length).toBe(1); // one transition only
  });

  it("ranked candidates: green & free first, hard-blocked last, every row has a reason", async () => {
    const o = await crossBorderOrder(a);
    const c = await candidatesForLeg(a, o.legs[1].id); // crossing
    expect(c.map((x) => x.unitNumber)).toEqual(["2117", "2109", "2104"]);
    expect(c[0].ok).toBe(true);
    expect(c[0].reason).toMatch(/free, Benjamín/);
    expect(c[1].findings.map((f) => f.code)).toContain("no_driver");
    expect(c[2].hardBlocked).toBe(true);
    expect(c[2].reason).toMatch(/no Mexican plate/);
    // once 2117 is busy it drops below a free green truck
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    const o2 = await crossBorderOrder(a);
    const c2 = await candidatesForLeg(a, o2.legs[1].id);
    expect(c2[0].unitNumber).toBe("2109");
    expect(c2.find((x) => x.unitNumber === "2117")!.reason).toContain(o.order.orderNumber);
  });
});

describe("building the load stop by stop", () => {
  it("before dispatch: add, move and remove stops freely; legs are cut again and a leg with the same two ends keeps its assignment", async () => {
    const o = await createOrder(a, { customerId: fleet.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "delivery", name: "Chicago", country: "US" }], book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    // a second pickup in the middle: still one leg, same ends → keeps the truck
    let g = await addStop(a, o.order.id, 1, { type: "pickup", name: "Toledo", country: "US" });
    expect(g.stops.map((x) => [x.seq, x.name])).toEqual([[1, "Canton"], [2, "Toledo"], [3, "Chicago"]]);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0].id).toBe(o.legs[0].id);
    expect(g.legs[0].truckId).toBe(fleet.t2104);
    // a drop at the end: the leg's far end changes → a new unassigned leg replaces it
    g = await addStop(a, o.order.id, 3, { type: "delivery", name: "Milwaukee", country: "US" });
    expect(g.stops.map((x) => x.name)).toEqual(["Canton", "Toledo", "Chicago", "Milwaukee"]);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0].state).toBe("unassigned");
    // reorder, then remove
    g = await moveStop(a, o.order.id, g.stops[2].id, 1);
    expect(g.stops.map((x) => x.name)).toEqual(["Canton", "Toledo", "Milwaukee", "Chicago"]);
    g = await removeStop(a, o.order.id, g.stops.find((x) => x.name === "Toledo")!.id);
    expect(g.stops.map((x) => [x.seq, x.name])).toEqual([[1, "Canton"], [2, "Milwaukee"], [3, "Chicago"]]);
    await expect(removeStop(a, o.order.id, g.stops[0].id).then(() => removeStop(a, o.order.id, g.stops[1].id))).rejects.toThrow(/at least two stops/);
    // a hand-off yard and a Canadian delivery: three legs, the crossing gets its workbench
    const x = await createOrder(a, { customerId: fleet.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "delivery", name: "Toronto", country: "CA" }], book: true });
    expect(x.legs.map((l) => l.type)).toEqual(["crossing"]);
    g = await addStop(a, x.order.id, 1, { type: "yard", name: "Detroit yard", country: "US" });
    expect(g.legs.map((l) => l.type)).toEqual(["us", "crossing"]);
    const { crossings } = await import("@/db/schema");
    const xs = await db.select().from(crossings).where(eq(crossings.orderId, x.order.id));
    expect(xs.map((c) => c.legId)).toEqual([g.legs[1].id]);
  });

  it("once a leg is out: a drop can be added or removed inside a leg ahead of the truck; a hand-off, a reached stop or a leg end cannot", async () => {
    const o = await createOrder(a, { customerId: fleet.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "delivery", name: "Chicago", country: "US" }], book: true });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup"] as const) await advanceLeg(a, leg, st);
    let g = await addStop(a, o.order.id, 1, { type: "delivery", name: "Gary", country: "US" });
    expect(g.stops.map((x) => x.name)).toEqual(["Canton", "Gary", "Chicago"]);
    expect(g.legs[0].id).toBe(leg);
    expect(g.legs[0].state).toBe("at_pickup");
    await expect(addStop(a, o.order.id, 0, { type: "pickup", name: "Before", country: "US" })).rejects.toThrow(/after the last stop the truck reached/);
    await expect(addStop(a, o.order.id, 2, { type: "yard", name: "Yard", country: "US" })).rejects.toThrow(/splitting the leg/);
    await expect(removeStop(a, o.order.id, g.stops[2].id)).rejects.toThrow(/where a leg starts or ends/);
    await expect(removeStop(a, o.order.id, g.stops[0].id)).rejects.toThrow(/already reached/);
    g = await removeStop(a, o.order.id, g.stops[1].id);
    expect(g.stops.map((x) => x.name)).toEqual(["Canton", "Chicago"]);
    // delivered loads are final
    for (const st of ["loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
    await expect(addStop(a, o.order.id, 1, { type: "delivery", name: "Late", country: "US" })).rejects.toThrow(/final/);
  });
});

describe("Canada (who may run where)", () => {
  it("cabotage both ways, plates by country, and a Mexican carrier never runs in Canada", async () => {
    const { checkDriver, checkTruck, checkCarrierZone } = await import("./eligibility");
    const zUS = { type: "domestic" as const, countries: ["US" as const] };
    const zCA = { type: "ca" as const, countries: ["CA" as const] };
    const zX = { type: "crossing" as const, countries: ["US" as const, "CA" as const] };
    const codes = (f: { code: string }[]) => f.map((x) => x.code);
    const cdl = { id: "1", name: "Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, fastExpires: future };
    const can = { id: "2", name: "Tremblay", driverType: "CA", licenseExpires: future, medicalExpires: future, fastExpires: future };
    const b1 = { id: "3", name: "Xochihua", driverType: "B1", licenseExpires: future, medicalExpires: future, fastExpires: future, i94Until: future };
    expect(codes(checkDriver(cdl, zX))).toEqual([]);
    expect(codes(checkDriver(cdl, zCA))).toEqual(["cabotage_canada"]);
    expect(codes(checkDriver(can, zX))).toEqual([]);
    expect(codes(checkDriver(can, zCA))).toEqual([]);
    expect(codes(checkDriver(can, zUS))).toEqual(["cabotage_us"]);
    expect(codes(checkDriver(b1, zCA))).toContain("b1_canada");
    expect(codes(checkDriver(b1, zX))).toContain("b1_canada");
    expect(codes(checkDriver({ ...cdl, fastExpires: past }, zX))).toEqual(["fast_expired"]);
    expect(codes(checkTruck({ id: "t", unitNumber: "9", caPlate: "AB12", caPlateExpires: future }, zX))).toEqual([]); // a Canadian plate runs both
    expect(codes(checkTruck({ id: "t", unitNumber: "9" }, zCA))).toEqual(["no_us_plate"]);
    expect(codes(checkTruck({ id: "t", unitNumber: "9", caPlate: "AB12", caPlateExpires: past }, zCA))).toEqual(["ca_plate_expired"]);
    expect(codes(checkCarrierZone({ name: "Garza", country: "MX" }, zX))).toEqual(["mx_carrier_canada"]);
    expect(codes(checkCarrierZone({ name: "Maple", country: "CA" }, zUS))).toEqual(["cabotage_us"]);
    expect(codes(checkCarrierZone({ name: "Lone Star", country: "US" }, zCA))).toEqual(["cabotage_canada"]);
    expect(codes(checkCarrierZone({ name: "Maple", country: "CA" }, zX))).toEqual([]);
    // through planLeg: the zone comes from the load's stops
    const o = await createOrder(a, { customerId: fleet.rxo, rateCents: 1000, stops: [{ type: "pickup", name: "Windsor", country: "CA" }, { type: "delivery", name: "Toronto", country: "CA" }], book: true });
    await expect(planLeg(a, o.legs[0].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes })).rejects.toThrow(/cabotage/);
  });
});

describe("dispatch → delivered (T1)", () => {
  it("walks a cross-border order through every leg and derives the order state", async () => {
    const o = await crossBorderOrder(a);
    const [mx, crossing, us] = o.legs;
    await planLeg(a, mx.id, { kind: "carrier", carrierId: fleet.garza, carrierRateCents: 45000 });
    await planLeg(a, crossing.id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja, coDriverId: fleet.martin });
    await planLeg(a, us.id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    expect((await getOrder(a, o.order.id)).order.state).toBe("booked");

    await dispatchLeg(a, mx.id);
    expect((await getOrder(a, o.order.id)).order.state).toBe("dispatched");
    await acceptLeg(a, mx.id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, mx.id, st, { source: "carrier" });
    let g = await getOrder(a, o.order.id);
    expect(g.legs[0].state).toBe("completed");
    expect(g.legs[0].completedAt).not.toBeNull();
    expect(g.order.state).toBe("in_transit");
    expect(g.stops[0].departedAt).not.toBeNull();
    expect(g.stops[1].arrivedAt).not.toBeNull();

    await dispatchLeg(a, crossing.id);
    await advanceLeg(a, crossing.id, "next", { source: "driver_app" }); // accepted
    let cur = "accepted";
    while (cur !== "completed") cur = (await advanceLeg(a, crossing.id, "next", { source: "driver_app", verified: true, lat: "27.5", lng: "-99.5" })).state;
    await dispatchLeg(a, us.id);
    await acceptLeg(a, us.id);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, us.id, st, { source: "gps", verified: true });

    g = await getOrder(a, o.order.id);
    expect(g.order.state).toBe("delivered");
    expect(g.order.deliveredAt).not.toBeNull();
    const evs = await db.select().from(legEvents).where(eq(legEvents.orderId, o.order.id)).orderBy(asc(legEvents.recordedAt));
    expect(evs.filter((e) => e.source === "gps" && e.verified).length).toBe(6);
    expect(evs.filter((e) => e.legId === crossing.id && e.lat === "27.5").length).toBeGreaterThan(0);
  });

  it("seal continuity: the seal applied at a stop must be the seal found at the next; a difference is a red flag, a corrected number clears it", async () => {
    const o = await crossBorderOrder(a);
    const [mx, crossing, us] = o.legs;
    await planLeg(a, mx.id, { kind: "carrier", carrierId: fleet.garza, carrierRateCents: 45000 });
    await planLeg(a, crossing.id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja, coDriverId: fleet.martin });
    await planLeg(a, us.id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    await dispatchLeg(a, mx.id);
    await acceptLeg(a, mx.id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup"] as const) await advanceLeg(a, mx.id, st, { source: "carrier" });
    await advanceLeg(a, mx.id, "loaded", { source: "carrier", seal: " MX-4471 " }); // sealed at the plant
    for (const st of ["en_route"] as const) await advanceLeg(a, mx.id, st, { source: "carrier" });
    await advanceLeg(a, mx.id, "at_delivery", { source: "carrier", seal: "MX-4471" }); // intact at the border yard
    await advanceLeg(a, mx.id, "completed", { source: "carrier" });
    let g = await getOrder(a, o.order.id);
    expect(g.stops[0].sealOut).toBe("MX-4471");
    expect(g.stops[1].sealIn).toBe("MX-4471");
    expect((await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "seal_mismatch")))).length).toBe(0);
    // the crossing driver finds a different seal at the Laredo yard
    await dispatchLeg(a, crossing.id);
    await advanceLeg(a, crossing.id, "next", { source: "driver_app" });
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, crossing.id, st, { source: "driver_app" });
    await advanceLeg(a, crossing.id, "at_delivery", { source: "driver_app", seal: "mx-9999" });
    let f = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "seal_mismatch")));
    expect(f.length).toBe(1);
    expect(f[0].level).toBe("red");
    expect(f[0].title).toBe("Seal MX-4471 applied at Planta Monterrey; mx-9999 found at Laredo Yard");
    expect(f[0].clearedAt).toBeNull();
    const evs = await db.select().from(legEvents).where(and(eq(legEvents.orderId, o.order.id), eq(legEvents.kind, "flag")));
    expect(evs.some((e) => e.note?.includes("Seal mismatch at Laredo Yard"))).toBe(true);
    // a typo: the office corrects the number on the stop and the flag clears; case does not matter
    g = await getOrder(a, o.order.id);
    await updateStop(a, g.stops[2].id, { sealIn: "mx-4471" });
    f = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "seal_mismatch")));
    expect(f[0].clearedAt).not.toBeNull();
    // a genuine break stays: a new seal applied at the yard, read right downstream
    await advanceLeg(a, crossing.id, "completed", { source: "driver_app", seal: "US-100" });
    await dispatchLeg(a, us.id);
    await acceptLeg(a, us.id);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, us.id, st);
    await advanceLeg(a, us.id, "at_delivery", { seal: "US-100" });
    expect((await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "seal_mismatch"), sql`cleared_at is null`))).length).toBe(0);
  });

  it("cannot dispatch an unplanned leg, cannot skip forward steps, cannot go backwards", async () => {
    const o = await crossBorderOrder(a);
    await expect(dispatchLeg(a, o.legs[1].id)).rejects.toBeInstanceOf(TransitionError);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o.legs[1].id);
    await expect(advanceLeg(a, o.legs[1].id, "loaded")).rejects.toBeInstanceOf(TransitionError);
    await acceptLeg(a, o.legs[1].id);
    await advanceLeg(a, o.legs[1].id, "en_route_to_pickup");
    await expect(advanceLeg(a, o.legs[1].id, "accepted")).rejects.toBeInstanceOf(TransitionError);
    await expect(advanceLeg(a, o.legs[1].id, "planned" as never)).rejects.toBeInstanceOf(TransitionError);
  });

  it("decline returns the leg to Pending with a red flag and keeps the reason", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o.legs[1].id);
    const l = await declineLeg(a, o.legs[1].id, "hours out");
    expect(l.state).toBe("declined");
    expect(l.declineReason).toBe("hours out");
    const f = await db.select().from(flags).where(eq(flags.legId, o.legs[1].id));
    expect(f[0].code).toBe("declined");
    const b = await board(a);
    expect(b[0].stage).toBe("pending");
    // re-plan from declined with another truck
    const r = await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.martin });
    expect(r.leg.state).toBe("planned");
    expect(r.leg.declineReason).toBeNull();
  });

  it("hold blocks dispatch until release; release recomputes the state", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await expect(holdOrder(a, o.order.id, "rate con missing")).rejects.toBeInstanceOf(TransitionError); // booked can't be held
    await dispatchLeg(a, o.legs[1].id);
    await planLeg(a, o.legs[2].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    await holdOrder(a, o.order.id, "rate con missing");
    await expect(dispatchLeg(a, o.legs[2].id)).rejects.toThrow(/on hold/);
    expect((await getOrder(a, o.order.id)).order.holdReason).toBe("rate con missing");
    const rel = await releaseOrder(a, o.order.id);
    expect(rel.state).toBe("dispatched");
    expect(rel.holdReason).toBeNull();
    expect((await dispatchLeg(a, o.legs[2].id)).state).toBe("dispatched");
  });

  it("cancel needs a reason, refuses while a leg is moving, and cancels open legs", async () => {
    const o = await crossBorderOrder(a);
    await expect(cancelOrder(a, o.order.id, "")).rejects.toBeInstanceOf(ValidationError);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o.legs[1].id);
    await acceptLeg(a, o.legs[1].id);
    await advanceLeg(a, o.legs[1].id, "en_route_to_pickup");
    await expect(cancelOrder(a, o.order.id, "customer cancelled")).rejects.toThrow(/moving/);
    const o2 = await crossBorderOrder(a);
    await planLeg(a, o2.legs[1].id, { kind: "truck", truckId: fleet.t2109, driverId: fleet.martin });
    const c = await cancelOrder(a, o2.order.id, "customer cancelled");
    expect(c.state).toBe("cancelled");
    const g = await getOrder(a, o2.order.id);
    expect(g.legs.every((l) => l.state === "cancelled")).toBe(true);
    await expect(updateOrder(a, o2.order.id, { rateCents: 1 })).rejects.toThrow(/read-only/);
  });
});

describe("split, unit OOS, team swap (F-11.1–11.3)", () => {
  it("split inserts a stop and a second Pending leg; the first half keeps its assignment", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[2].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    const r = await splitLeg(a, o.legs[2].id, { type: "yard", name: "San Antonio Yard", country: "US" });
    expect(r.first.truckId).toBe(fleet.t2104);
    expect(r.first.toStopId).toBe(r.stop.id);
    expect(r.second.state).toBe("unassigned");
    expect(r.second.fromStopId).toBe(r.stop.id);
    expect(r.second.seq).toBe(4);
    const g = await getOrder(a, o.order.id);
    expect(g.stops.map((x) => x.name)).toEqual(["Planta Monterrey", "Santa Fe Yard", "Laredo Yard", "San Antonio Yard", "GM Arlington"]);
    expect(g.stops.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(g.legs.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(g.legs[3].toStopId).toBe(g.stops[4].id);
    await expect(splitLeg(a, o.legs[2].id, { type: "yard", name: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("unit OOS: planned and sent legs go back to Pending; a moving leg gets a red flag", async () => {
    const o1 = await crossBorderOrder(a);
    const o2 = await crossBorderOrder(a);
    const o3 = await crossBorderOrder(a);
    await planLeg(a, o1.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await planLeg(a, o2.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o2.legs[1].id);
    await planLeg(a, o3.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o3.legs[1].id);
    await acceptLeg(a, o3.legs[1].id);
    await advanceLeg(a, o3.legs[1].id, "en_route_to_pickup");
    const r = await setTruckOos(a, fleet.t2117, "blown turbo");
    expect(r.unplanned.length).toBe(2);
    expect(r.flagged.length).toBe(1);
    expect(r.unplanned.every((l) => l.state === "unassigned" && l.truckId === null)).toBe(true);
    expect((await getOrder(a, o2.order.id)).order.state).toBe("booked");
    expect((await getOrder(a, o3.order.id)).legs[1].state).toBe("en_route_to_pickup");
    const f = await db.select().from(flags).where(eq(flags.orderId, o3.order.id));
    expect(f[0].code).toBe("truck_oos");
    const b = await board(a);
    expect(b.find((x) => x.order.id === o3.order.id)!.openFlags.length).toBe(1);
    await expect(setTruckOos(a, fleet.t2117, "")).rejects.toBeInstanceOf(ValidationError);
  });

  it("team swap re-runs eligibility: a CDL co-driver on the crossing is fine, a B-1 on the US leg is not", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    const r = await setLegDrivers(a, o.legs[1].id, { coDriverId: fleet.martin });
    expect(r.leg.coDriverId).toBe(fleet.martin);
    await expect(setLegDrivers(a, o.legs[1].id, { coDriverId: fleet.benja })).rejects.toThrow(/same person/);
    await planLeg(a, o.legs[2].id, { kind: "truck", truckId: fleet.t2104, driverId: fleet.reyes });
    await expect(setLegDrivers(a, o.legs[2].id, { coDriverId: fleet.benja })).rejects.toBeInstanceOf(EligibilityError);
  });
});

describe("board & isolation (F-2.3, T20)", () => {
  it("board groups by next actionable leg: pending / planned / dispatched / delivered", async () => {
    const pending = await crossBorderOrder(a);
    const planned = await crossBorderOrder(a);
    await planLeg(a, planned.legs[0].id, { kind: "carrier", carrierId: fleet.garza });
    const dispatched = await crossBorderOrder(a);
    await planLeg(a, dispatched.legs[0].id, { kind: "carrier", carrierId: fleet.garza });
    await dispatchLeg(a, dispatched.legs[0].id);
    const b = await board(a);
    const stage = (id: string) => b.find((x) => x.order.id === id)!.stage;
    expect(stage(pending.order.id)).toBe("pending");
    expect(stage(planned.order.id)).toBe("planned");
    expect(stage(dispatched.order.id)).toBe("dispatched");
    expect(b.find((x) => x.order.id === planned.order.id)!.legs[0].carrierName).toBe("Transportes Garza");
    // once the MX leg completes and the crossing is still unassigned, the order is back in Pending for the dispatcher
    await acceptLeg(a, dispatched.legs[0].id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, dispatched.legs[0].id, st, { source: "carrier" });
    expect((await board(a)).find((x) => x.order.id === dispatched.order.id)!.stage).toBe("pending");
  });

  it("another tenant cannot see, plan, or advance this tenant's order", async () => {
    const o = await crossBorderOrder(a);
    const b = await makeTenant("Intruder");
    await expect(getOrder(b, o.order.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(planLeg(b, o.legs[1].id, { kind: "truck", truckId: fleet.t2117 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(advanceLeg(b, o.legs[1].id, "next")).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelOrder(b, o.order.id, "x")).rejects.toBeInstanceOf(NotFoundError);
    expect((await board(b)).length).toBe(0);
    // and b cannot use a's truck by id
    const ob = await createOrder(b, { rateTbd: true, stops: crossBorderStops, book: false });
    await bookOrder(b, ob.order.id).catch(() => null);
    await expect(planLeg(b, ob.legs[1].id, { kind: "truck", truckId: fleet.t2117 })).rejects.toThrow();
  });

  it("every write leaves an audit row", async () => {
    const o = await crossBorderOrder(a);
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: fleet.t2117, driverId: fleet.benja });
    await dispatchLeg(a, o.legs[1].id);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.entityId, o.legs[1].id)));
    expect(rows.map((r) => r.action).sort()).toEqual(["assign", "dispatch", "transition", "transition"]);
    const orderRows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, a.tenantId), eq(auditLog.entityId, o.order.id)));
    expect(orderRows.map((r) => r.action)).toContain("create");
    expect(orderRows.filter((r) => r.action === "transition").length).toBe(2); // draft→booked, booked→dispatched
    const st = await db.select().from(stopsTable).where(eq(stopsTable.orderId, o.order.id));
    expect(st.length).toBe(4);
  });
});

describe("book it again", () => {
  it("copies customer, rate, equipment, stops and legs into a new draft; windows, load references and assignments start over", async () => {
    const { copyOrder, cancelOrder } = await import("./orders");
    const o = await createOrder(a, { customerId: fleet.rxo, rateCents: 285000, refs: { rate_con: "RC-1", po: "PO-1", reference: "lane-A" }, cargoNote: "26 pallets", stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" }, windowStart: new Date(), contact: "Ana", notes: "gate 3" }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }, { type: "delivery", name: "GM Arlington", country: "US", windowEnd: new Date() }], book: true });
    const c = await copyOrder(a, o.order.id);
    expect(c.order.id).not.toBe(o.order.id);
    expect(c.order.state).toBe("draft");
    expect(c.order.source).toBe("copy");
    expect(c.order.sourceRef).toBe(o.order.orderNumber);
    expect(c.order).toMatchObject({ customerId: fleet.rxo, rateCents: 285000, equipment: o.order.equipment, cargoNote: "26 pallets" });
    expect(c.order.refs).toEqual({ reference: "lane-A" }); // the rate con and PO belonged to the old load
    expect(c.stops.map((st) => [st.type, st.name, st.contact, st.notes])).toEqual(o.stops.map((st) => [st.type, st.name, st.contact, st.notes]));
    expect(c.stops.every((st) => !st.windowStart && !st.windowEnd && !st.arrivedAt)).toBe(true);
    expect(c.legs.map((l) => l.type)).toEqual(o.legs.map((l) => l.type));
    expect(c.legs.every((l) => l.state === "unassigned")).toBe(true);
    // a cancelled original can still be copied; a trip cannot
    await cancelOrder(a, o.order.id, "customer pulled it");
    expect((await copyOrder(a, o.order.id)).order.state).toBe("draft");
  });
});

describe("carrier lane rates", () => {
  it("the rate on file for the carrier and lane prefills the tender; the newest wins; expired and other-equipment ones are skipped", async () => {
    const { suggestCarrierRate, zoneMatches } = await import("./orders");
    expect(zoneMatches("Monterrey, NL", { name: "Planta Monterrey", address: { city: "Apodaca", state: "NL" } })).toBe(true);
    expect(zoneMatches("Santa Fe Yard, Nuevo Laredo", { name: "Santa Fe Yard", address: { city: "Nuevo Laredo", state: "TAMPS" } })).toBe(true);
    expect(zoneMatches("Saltillo", { name: "Planta Monterrey", address: { city: "Apodaca", state: "NL" } })).toBe(false);
    const o = await createOrder(a, { customerId: fleet.rxo, rateCents: 285000, stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Apodaca", state: "NL" } }, { type: "border_yard", name: "Santa Fe Yard", country: "MX", address: { city: "Nuevo Laredo", state: "TAMPS" } }, { type: "yard", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "GM Arlington", country: "US" }], book: true });
    expect(await suggestCarrierRate(a, o.legs[0].id, fleet.garza)).toBeNull();
    await create(a, "carrierRate", { carrierId: fleet.garza, originZone: "Monterrey, NL", destinationZone: "Santa Fe Yard", rateCents: 45000, currency: "USD", fuelRule: "included" });
    await create(a, "carrierRate", { carrierId: fleet.garza, originZone: "Monterrey", destinationZone: "Nuevo Laredo", equipment: "53_dry", rateCents: 47000, currency: "USD", fuelRule: "pct", fuelValue: 12 });
    await create(a, "carrierRate", { carrierId: fleet.garza, originZone: "Monterrey", destinationZone: "Nuevo Laredo", rateCents: 99000, validTo: new Date(Date.now() - 86400_000) });
    await create(a, "carrierRate", { carrierId: fleet.garza, originZone: "Monterrey", destinationZone: "Nuevo Laredo", equipment: "53_reefer", rateCents: 88000 });
    const r = await suggestCarrierRate(a, o.legs[0].id, fleet.garza);
    expect(r).toMatchObject({ rateCents: 47000, fuelRule: "pct", fuelValue: 12, lane: "Monterrey → Nuevo Laredo" });
    // the US leg has no lane on file for a Mexican carrier
    expect(await suggestCarrierRate(a, o.legs[2].id, fleet.garza)).toBeNull();
  });
});
