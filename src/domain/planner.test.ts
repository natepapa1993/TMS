// Features: F-20.4 F-20.5
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, candidatesForLeg, EligibilityError } from "./orders";
import { addEvent, deleteEvent, plannerData, deadhead } from "./planner";
import { db } from "@/db/client";
import { stops as stopsT, trucks as trucksT } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const future = new Date(Date.now() + 365 * 86400_000);
const day = (n: number, h = 8) => {
  const d = new Date();
  d.setUTCHours(h, 0, 0, 0);
  return new Date(d.getTime() + n * 86400_000);
};
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; t2: string; dan: string; ana: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Planner Carrier");
  const cust = await create(a, "customer", { name: "Acme Logistics", kind: "broker" });
  const t1 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const t2 = await create(a, "truck", { unitNumber: "2117", usPlate: "TX2117", usPlateExpires: future });
  const dan = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
  const ana = await create(a, "driver", { name: "Ana Cruz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2.id });
  f = { cust: cust.id, t1: t1.id, t2: t2.id, dan: dan.id, ana: ana.id };
});

const load = async (n: number, extra: { pickupCity?: string } = {}) => {
  const o = await createOrder(a, {
    customerId: f.cust,
    rateCents: 150000,
    book: true,
    stops: [
      { type: "pickup", name: "Shipper Canton", country: "US", address: { city: extra.pickupCity ?? "Canton", state: "MI" }, windowStart: day(n, 12) } as never,
      { type: "delivery", name: "DC Columbus", country: "US", address: { city: "Columbus", state: "OH" }, windowStart: day(n, 20), windowEnd: day(n, 22) } as never,
    ],
  });
  // coordinates as a verified arrival would have learned them
  await db.update(stopsT).set({ lat: "42.30", lng: "-83.48" }).where(and(eq(stopsT.orderId, o.order.id), eq(stopsT.type, "pickup")));
  await db.update(stopsT).set({ lat: "39.96", lng: "-82.99" }).where(and(eq(stopsT.orderId, o.order.id), eq(stopsT.type, "delivery")));
  return o;
};

describe("time off and repairs", () => {
  it("validates and removes events", async () => {
    await expect(addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "vacation", startsAt: day(2), endsAt: day(1) })).rejects.toThrow(/end after/);
    await expect(addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "party", startsAt: day(1), endsAt: day(2) })).rejects.toThrow(/kind/);
    await expect(addEvent(a, { subjectKind: "driver", subjectId: "nope", kind: "vacation", startsAt: day(1), endsAt: day(2) })).rejects.toThrow();
    const { id } = await addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "vacation", startsAt: day(1), endsAt: day(3) });
    await deleteEvent(a, id);
    const p = await plannerData(a);
    expect(p.drivers.find((d) => d.driverId === f.dan)!.events).toEqual([]);
  });

  it("a driver on vacation in the leg's window needs an override; the ranked list says why", async () => {
    await addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "vacation", startsAt: day(1, 0), endsAt: day(4, 0), note: "family" });
    const o = await load(2);
    const leg = o.legs[0].id;
    const err = await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.dan }).catch((e) => e);
    expect(err).toBeInstanceOf(EligibilityError);
    expect(String(err.message)).toMatch(/vacation/);
    const cands = await candidatesForLeg(a, leg);
    expect(cands[0].unitNumber).toBe("2117"); // Ana is free; Daniel sinks
    expect(cands.find((c) => c.unitNumber === "2104")!.reason).toMatch(/vacation/);
    // with an override it goes through
    await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.dan }, { override: true, reason: "he agreed to run it" });
  });

  it("a truck in the shop blocks the truck, soft home time only warns", async () => {
    await addEvent(a, { subjectKind: "truck", subjectId: f.t2, kind: "repair", startsAt: day(1, 0), endsAt: day(3, 0) });
    await addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "home_time", startsAt: day(2, 0), endsAt: day(2, 23), hard: false });
    const o = await load(2);
    await expect(planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t2, driverId: f.ana })).rejects.toThrow(/in the shop/);
    const ok = await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.dan });
    expect(ok.leg.state).toBe("planned");
  });
});

describe("planner data", () => {
  it("open legs to cover; drivers with when and where they come free and what is next", async () => {
    const running = await load(0);
    const leg = running.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.dan });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await advanceLeg(a, leg, "en_route_to_pickup");
    const later = await load(3);
    await planLeg(a, later.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.dan });
    const open = await load(1);
    await addEvent(a, { subjectKind: "driver", subjectId: f.ana, kind: "sick", startsAt: new Date(Date.now() - 3600_000), endsAt: day(1, 6) });

    const p = await plannerData(a);
    expect(p.legs.map((l) => l.orderNumber)).toEqual([open.order.orderNumber, later.order.orderNumber]);
    expect(p.legs.find((l) => l.orderNumber === later.order.orderNumber)!.assigned).toBe("2104 · Daniel Reyes");
    const dan = p.drivers.find((d) => d.driverId === f.dan)!;
    expect(dan.status).toBe("on_load");
    expect(dan.current?.orderNumber).toBe(running.order.orderNumber);
    expect(dan.next?.orderNumber).toBe(later.order.orderNumber);
    expect(dan.availableIn).toBe("Columbus, OH");
    const ana = p.drivers.find((d) => d.driverId === f.ana)!;
    expect(ana.status).toBe("off");
    expect(new Date(ana.availableAt!).getTime()).toBe(day(1, 6).getTime());
    // deadhead from Columbus to the Canton pickup
    const dh = deadhead(dan, p.legs[0]);
    expect(dh).toBeGreaterThan(150);
    expect(dh).toBeLessThan(260);
  });

  it("by truck: solo or team with each driver's licence type, and available / on a load / waiting on crossing / unavailable with the reason", async () => {
    const t3 = await create(a, "truck", { unitNumber: "2120", usPlate: "TX2120", usPlateExpires: future });
    const t4 = await create(a, "truck", { unitNumber: "2130", usPlate: "TX2130", usPlateExpires: future });
    await create(a, "truck", { unitNumber: "2140", usPlate: "TX2140", usPlateExpires: future });
    const ram = await create(a, "driver", { name: "Ramiro Lozano", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t3.id });
    const sof = await create(a, "driver", { name: "Sofía Lozano", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t3.id });
    await create(a, "driver", { name: "Óscar Peña", driverType: "B1", visaType: "B1", mxLicenseNumber: "LF-1", mxLicenseExpires: future, i94Until: future, currentTruckId: t4.id });
    await db.update(trucksT).set({ status: "oos", oosReason: "brake chamber" }).where(eq(trucksT.id, f.t2));
    // the team is booked on the US leg of a load whose freight is still in Mexico
    const x = await createOrder(a, { customerId: f.cust, rateCents: 285000, book: true, template: "mx_crossing_us", stops: [{ type: "pickup", name: "MTY", country: "MX" }, { type: "border_yard", name: "Nuevo Laredo", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }] } as never);
    const us = x.legs.find((l) => l.type === "us")!;
    await planLeg(a, us.id, { kind: "truck", truckId: t3.id, driverId: ram.id, coDriverId: sof.id }, { override: true, reason: "test" });

    const p = await plannerData(a);
    const by = (u: string) => p.trucks.find((t) => t.unit === u)!;
    expect(p.trucks.map((t) => t.unit)).toEqual(["2104", "2117", "2120", "2130", "2140"]);
    expect(by("2104")).toMatchObject({ status: "available", team: false, crew: [{ name: "Daniel Reyes", driverType: "CDL" }] });
    expect(by("2117")).toMatchObject({ status: "unavailable", why: "Out of service — brake chamber" });
    expect(by("2120")).toMatchObject({ status: "waiting_crossing", team: true });
    expect(by("2120").crew.map((c) => c.name).sort()).toEqual(["Ramiro Lozano", "Sofía Lozano"]);
    expect(by("2120").why).toMatch(/Mexican side/);
    expect(by("2130")).toMatchObject({ status: "available", crew: [{ name: "Óscar Peña", driverType: "B1" }] });
    expect(by("2140")).toMatchObject({ status: "unavailable", why: "No driver in this truck", crew: [] });

    // time off now makes a truck unavailable, and says until when
    await addEvent(a, { subjectKind: "driver", subjectId: f.dan, kind: "vacation", startsAt: new Date(Date.now() - 3600_000), endsAt: day(3, 0) });
    const q = await plannerData(a);
    expect(q.trucks.find((t) => t.unit === "2104")).toMatchObject({ status: "unavailable" });
    expect(q.trucks.find((t) => t.unit === "2104")!.why).toMatch(/^Vacation until /);
  });
});

