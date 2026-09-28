// Features: F-34.1 F-34.2 F-34.3
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { createOrder, planLeg, dispatchLeg, advanceLeg, sendLeg, holdOrder } from "./orders";
import { sendTender } from "./tenders";
import { plannerData, rankForLeg } from "./planner";
import { availability, gapFor, type Booking } from "./planner-rules";
import * as X from "./crossing";
import { clearedCompletesLeg, crossingDriverNext } from "./crossing";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t211: string; ramiro: string; t212: string; arturo: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  const cust = await create(a, "customer", { name: "Linamar", kind: "shipper" });
  const t211 = await create(a, "truck", { unitNumber: "211", usPlate: "TX211", usPlateExpires: future });
  const ramiro = await create(a, "driver", { name: "Ramiro Lozano", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t211.id });
  const t212 = await create(a, "truck", { unitNumber: "212", usPlate: "TX212", mxPlate: "212-FF-2", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future });
  const arturo = await create(a, "driver", { name: "Arturo Garza", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future, currentTruckId: t212.id });
  f = { cust: cust.id, t211: t211.id, ramiro: ramiro.id, t212: t212.id, arturo: arturo.id };
});

const legState = async (id: string) => (await db.select({ state: s.legs.state }).from(s.legs).where(eq(s.legs.id, id)))[0].state;
const day = (n: number) => new Date(Date.now() + n * 86400_000);

/** Run the crossing leg with our truck to Loaded, the packet out, then the border steps to Cleared. */
async function crossAndClear(stops: Parameters<typeof createOrder>[1]["stops"]) {
  const o = await createOrder(a, { customerId: f.cust, rateCents: 195000, stops, book: true });
  const leg = o.legs.find((l) => l.type === "crossing")!;
  const mx = stops.some((x) => x.country === "MX");
  await planLeg(a, leg.id, mx ? { kind: "truck", truckId: f.t212, driverId: f.arturo } : { kind: "truck", truckId: f.t211, driverId: f.ramiro });
  await dispatchLeg(a, leg.id);
  for (const st of ["accepted", "en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, leg.id, st, { source: "driver_app" });
  const [c] = await db.select().from(s.crossings).where(eq(s.crossings.legId, leg.id));
  await db.update(s.crossings).set({ state: "packet_sent", packetSentAt: new Date() }).where(eq(s.crossings.id, c.id));
  for (const st of ["departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as const) await X.step(a, c.id, st, { source: "driver_app", seal: st === "cleared" ? "s-99" : null });
  return { o, leg, crossing: c };
}

describe("Cleared is not Delivered (F-34.1, owner N2)", () => {
  it("only a leg ending at a yard, border yard, transload, terminal or customs lot completes on Cleared", () => {
    for (const t of ["yard", "border_yard", "transload", "terminal", "customs"]) expect(clearedCompletesLeg(t)).toBe(true);
    for (const t of ["delivery", "pickup", null, undefined]) expect(clearedCompletesLeg(t)).toBe(false);
  });

  it("US → CA direct (Romulus → London ON): Cleared puts the leg en route to the consignee; the driver arrives and delivers there", async () => {
    const { o, leg } = await crossAndClear([
      { type: "pickup", name: "Magna Romulus", country: "US", address: { city: "Romulus", state: "MI" }, windowStart: day(1) },
      { type: "delivery", name: "Linamar London", country: "CA", address: { city: "London", state: "ON" }, windowStart: day(2) },
    ]);
    expect(o.legs).toHaveLength(1);
    expect(await legState(leg.id)).toBe("en_route");
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, o.order.id));
    expect(order.state).not.toBe("delivered");
    expect(crossingDriverNext("en_route", "cleared")).toEqual({ kind: "leg", to: "at_delivery" });
    const notes = await db.select().from(s.legEvents).where(and(eq(s.legEvents.legId, leg.id), eq(s.legEvents.kind, "note")));
    expect(notes.some((n) => /Cleared customs — en route to Linamar London · seal S-99/.test(n.note ?? ""))).toBe(true);
    await advanceLeg(a, leg.id, "at_delivery", { source: "driver_app" });
    await advanceLeg(a, leg.id, "completed", { source: "driver_app" });
    expect(await legState(leg.id)).toBe("completed");
    const [x] = await db.select().from(s.crossings).where(eq(s.crossings.legId, leg.id));
    expect(x.state).toBe("cleared");
  });

  it("CA → US direct (London ON → Detroit): Cleared is en route, not delivered", async () => {
    const { leg } = await crossAndClear([
      { type: "pickup", name: "Linamar London", country: "CA", address: { city: "London", state: "ON" }, windowStart: day(1) },
      { type: "delivery", name: "Ford Dearborn", country: "US", address: { city: "Dearborn", state: "MI" }, windowStart: day(2) },
    ]);
    expect(await legState(leg.id)).toBe("en_route");
  });

  it("MX → US to our Laredo yard: Cleared delivers the crossing leg at the yard", async () => {
    const { leg } = await crossAndClear([
      { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAMPS" }, windowStart: day(1) },
      { type: "yard", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } },
      { type: "delivery", name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: day(2) },
    ]);
    expect(await legState(leg.id)).toBe("completed");
  });

  it("MX → US straight to the consignee (Monterrey → Dallas through-trip): Cleared is en route to Dallas", async () => {
    const { leg } = await crossAndClear([
      { type: "pickup", name: "Ternium Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" }, windowStart: day(1) },
      { type: "delivery", name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: day(2) },
    ]);
    expect(await legState(leg.id)).toBe("en_route");
  });
});

describe("a carrier leg is Sent only through a tender (F-34.2, dispatch N1, M2)", () => {
  const usStops = () => [
    { type: "pickup" as const, name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" }, windowStart: day(1) },
    { type: "delivery" as const, name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: day(2) },
  ];
  const carrier = async (extra: Record<string, unknown> = {}) => (await create(a, "carrier", { name: "Lone Star Freight", country: "US", mcNumber: "MC1", dotNumber: "DOT1", ...extra })).id;
  const tenders = async (legId: string) => db.select().from(s.tenders).where(eq(s.tenders.legId, legId));
  const leg = async (id: string) => (await db.select().from(s.legs).where(eq(s.legs.id, id)))[0];

  it("Send on a planned carrier leg refuses to dispatch bare; our truck still goes straight to the driver", async () => {
    const lone = await carrier({ dispatchEmail: "d@lonestar.test" });
    const o = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: lone, carrierRateCents: 90000 });
    await expect(sendLeg(a, o.legs[0].id)).rejects.toThrow(/goes out with a tender/);
    expect((await leg(o.legs[0].id)).state).toBe("planned");
    const o2 = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    await planLeg(a, o2.legs[0].id, { kind: "truck", truckId: f.t211, driverId: f.ramiro });
    expect((await sendLeg(a, o2.legs[0].id)).state).toBe("dispatched");
  });

  it("WhatsApp with no number: a clear error on the WhatsApp field, nothing sent, the leg exactly as it was", async () => {
    const lone = await carrier();
    const o = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    // from Needs truck: stays Needs truck (not Planned on the carrier)
    const err = await sendTender(a, o.legs[0].id, { carrierId: lone, rateCents: 90000, channel: "whatsapp" }).catch((e) => e);
    expect(err.message).toMatch(/has no WhatsApp number/);
    expect(err.field).toBe("whatsapp");
    let l = await leg(o.legs[0].id);
    expect([l.state, l.carrierId]).toEqual(["unassigned", null]);
    // from Planned on the carrier (the panel's Send to carrier): stays Planned
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: lone, carrierRateCents: 90000 });
    await expect(sendTender(a, o.legs[0].id, { carrierId: lone, rateCents: 90000, channel: "whatsapp" })).rejects.toThrow(/WhatsApp/);
    l = await leg(o.legs[0].id);
    expect([l.state, l.carrierId]).toEqual(["planned", lone]);
    expect(await tenders(o.legs[0].id)).toHaveLength(0);
    // a number that can't be one is refused too
    await expect(sendTender(a, o.legs[0].id, { carrierId: lone, channel: "whatsapp", to: "12345" })).rejects.toThrow(/not a WhatsApp number/);
  });

  it("the number typed in the dialog is saved on the carrier and the tender goes", async () => {
    const lone = await carrier();
    const o = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    const r = await sendTender(a, o.legs[0].id, { carrierId: lone, rateCents: 90000, channel: "whatsapp", to: "+52 867 555 0101", saveContact: true });
    expect(r.to).toBe("+52 867 555 0101");
    const [c] = await db.select().from(s.carriers).where(eq(s.carriers.id, lone));
    expect(c.whatsapp).toBe("+52 867 555 0101");
    expect((await leg(o.legs[0].id)).state).toBe("dispatched");
    const [t] = await tenders(o.legs[0].id);
    expect([t.state, t.channel]).toEqual(["sent", "whatsapp"]);
  });

  it("Link only (read out on the phone): a real tender with a deadline and link, nothing messaged", async () => {
    const lone = await carrier();
    const o = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    const r = await sendTender(a, o.legs[0].id, { carrierId: lone, rateCents: 90000, channel: "manual", expiresInMinutes: 30 });
    expect(r.link).toMatch(/\/t\//);
    const [t] = await tenders(o.legs[0].id);
    expect([t.state, t.channel, t.sentTo]).toEqual(["sent", "manual", null]);
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(s.outbox).where(eq(s.outbox.subjectId, t.id))).toHaveLength(0);
  });

  it("a tender that fails after the leg was planned (the load went on hold) puts the leg back", async () => {
    const lone = await carrier({ dispatchEmail: "d@lonestar.test" });
    const o = await createOrder(a, { customerId: f.cust, rateCents: 150000, stops: usStops(), book: true });
    await holdOrder(a, o.order.id, "rate con missing");
    await expect(sendTender(a, o.legs[0].id, { carrierId: lone, rateCents: 90000 })).rejects.toThrow(/on hold/);
    const l = await leg(o.legs[0].id);
    expect([l.state, l.carrierId]).toEqual(["unassigned", null]);
    expect(await tenders(o.legs[0].id)).toHaveLength(0);
  });
});

describe("availability as time windows; ranking by fit, then empty miles (F-34.3, dispatch N3, M5)", () => {
  const H = 3600_000;
  const now = new Date("2026-09-28T17:00:00Z");
  const at = (h: number) => new Date(now.getTime() + h * H);
  const LAREDO = { lat: 27.5, lng: -99.5 };
  const DALLAS = { lat: 32.78, lng: -96.8 };
  const ATL = { lat: 33.75, lng: -84.39 };
  const bk = (o: Partial<Booking> & { legId: string }): Booking => ({ orderNumber: o.legId, legType: "us", state: "planned", moving: false, start: null, startBy: null, end: null, from: null, to: null, fromPlace: "", toPlace: "", fromZone: "America/Chicago", toZone: "America/Chicago", ...o });

  it("a truck empty today with a load on Wednesday is free now until Wednesday — not busy until its last load", () => {
    const wed = bk({ legId: "26-00048", start: at(63), startBy: at(64), end: at(80), from: DALLAS, to: ATL, fromPlace: "Dallas, TX" });
    const oct6 = bk({ legId: "26-00051", start: at(190), end: at(200), from: ATL, to: DALLAS });
    const av = availability([oct6, wed], now, { pt: DALLAS, place: "Dallas, TX", zone: "America/Chicago" });
    expect(av.busyNow).toBeNull();
    expect(av.freeFrom).toEqual(now);
    expect(av.until?.orderNumber).toBe("26-00048");
    expect(av.leaveBy!.getTime()).toBeLessThan(at(63).getTime());
    expect(av.upcoming.map((b) => b.orderNumber)).toEqual(["26-00048", "26-00051"]);
  });

  it("running now: free where and when it delivers; a pickup right after it chains into the busy stretch", () => {
    const run = bk({ legId: "A", state: "en_route", moving: true, start: at(-5), end: at(3), to: LAREDO, toPlace: "Laredo, TX" });
    const next = bk({ legId: "B", start: at(4), end: at(12), from: LAREDO, to: DALLAS, toPlace: "Dallas, TX" });
    const later = bk({ legId: "C", start: at(40), end: at(50), from: DALLAS });
    const av = availability([later, next, run], now, { pt: null, place: null, zone: null });
    expect(av.busyNow?.legId).toBe("A");
    expect(av.freeFrom).toEqual(at(12));
    expect(av.freePlace).toBe("Dallas, TX");
    expect(av.until?.legId).toBe("C");
    // sent with a pickup that's due now counts as running; a planned one next week does not
    expect(availability([bk({ legId: "S", state: "dispatched", start: at(-1), end: at(6) })], now, { pt: null, place: null, zone: null }).busyNow?.legId).toBe("S");
    expect(availability([bk({ legId: "W", state: "dispatched", start: at(70), end: at(80) })], now, { pt: null, place: null, zone: null }).busyNow).toBeNull();
  });

  it("the gap: comes free where the load before ends, and must still make the load after", () => {
    const before = bk({ legId: "B0", start: at(2), end: at(10), from: LAREDO, to: DALLAS, toPlace: "Dallas, TX" });
    const after = bk({ legId: "A1", start: at(30), startBy: at(31), from: DALLAS, fromPlace: "Dallas, TX" });
    const fits = gapFor([before, after], { start: at(14), end: at(20), to: DALLAS }, now, { pt: LAREDO, place: "Laredo", zone: null });
    expect([fits.before?.legId, fits.after?.legId, fits.freePlace, fits.makesNext]).toEqual(["B0", "A1", "Dallas, TX", true]);
    expect(fits.freeFrom).toEqual(at(10));
    // a delivery in Atlanta at hour 20 can't make a Dallas pickup at hour 31
    const tooFar = gapFor([before, after], { start: at(14), end: at(20), to: ATL }, now, { pt: LAREDO, place: "Laredo", zone: null });
    expect(tooFar.makesNext).toBe(false);
  });

  it("the planner: pre-planned loads next week keep trucks Available now, with the next loads listed", async () => {
    const t213 = await create(a, "truck", { unitNumber: "213", usPlate: "TX213", usPlateExpires: future });
    const kev = await create(a, "driver", { name: "Kevin Ortiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t213.id });
    const inDays = (d: number, h = 8) => new Date(Date.now() + d * 86400_000 + h * H);
    const mk = (d: number) => createOrder(a, { customerId: f.cust, rateCents: 150000, book: true, stops: [{ type: "pickup", name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: inDays(d) }, { type: "delivery", name: "Atlanta DC", country: "US", address: { city: "Atlanta", state: "GA" }, windowStart: inDays(d + 1) }] });
    const o1 = await mk(3);
    const o2 = await mk(8);
    await planLeg(a, o1.legs[0].id, { kind: "truck", truckId: t213.id, driverId: kev.id });
    await dispatchLeg(a, o1.legs[0].id); // sent ahead of time: still not running
    await planLeg(a, o2.legs[0].id, { kind: "truck", truckId: t213.id, driverId: kev.id });
    const p = await plannerData(a);
    const t = p.trucks.find((x) => x.unit === "213")!;
    expect(t.status).toBe("available");
    expect(t.until?.orderNumber).toBe(o1.order.orderNumber);
    expect(t.upcoming.map((u) => u.orderNumber)).toEqual([o1.order.orderNumber, o2.order.orderNumber]);
    expect(new Date(t.availableAt!).getTime()).toBeLessThan(Date.now() + 60_000);
    expect(p.trucks.filter((x) => x.status === "available").length).toBe(p.trucks.filter((x) => x.crew.length).length);
    // the driver view says the same
    expect(p.drivers.find((d) => d.name === "Kevin Ortiz")).toMatchObject({ status: "available", until: { orderNumber: o1.order.orderNumber } });
  });

  it("ranking: the truck at the pickup first, a far one that makes it next, a truck with no location after; one that can't make its next load sinks", async () => {
    const mkTruck = async (unit: string) => {
      const t = await create(a, "truck", { unitNumber: unit, usPlate: `TX${unit}`, usPlateExpires: future });
      const d = await create(a, "driver", { name: `Driver ${unit}`, driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t.id });
      return { t: t.id, d: d.id };
    };
    const at207 = await mkTruck("207");
    const at213 = await mkTruck("213");
    await mkTruck("Q316"); // no location: after the ones we can place
    const busy = await mkTruck("220");
    // park 207 in Detroit and 213 in Dallas: a delivered load each; 220 in Detroit too
    const park = async (x: { t: string; d: string }, city: string, state: string) => {
      const o = await createOrder(a, { customerId: f.cust, rateCents: 1000, book: true, stops: [{ type: "pickup", name: `S ${city}`, country: "US", address: { city, state } }, { type: "delivery", name: `E ${city}`, country: "US", address: { city, state } }] });
      await planLeg(a, o.legs[0].id, { kind: "truck", truckId: x.t, driverId: x.d });
      await dispatchLeg(a, o.legs[0].id);
      for (const st of ["accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
    };
    await park(at207, "Detroit", "MI");
    await park(at213, "Dallas", "TX");
    await park(busy, "Detroit", "MI");
    const pickupAt = new Date(Date.now() + 48 * H);
    const o = await createOrder(a, { customerId: f.cust, rateCents: 250000, book: true, stops: [{ type: "pickup", name: "Magna Detroit", country: "US", address: { city: "Detroit", state: "MI" }, windowStart: pickupAt }, { type: "delivery", name: "Linamar Chicago", country: "US", address: { city: "Chicago", state: "IL" }, windowStart: new Date(pickupAt.getTime() + 8 * H) }] });
    // 220 has a Laredo pickup 4 hours after this delivery: it can't do both
    const nx = await createOrder(a, { customerId: f.cust, rateCents: 1000, book: true, stops: [{ type: "pickup", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" }, windowStart: new Date(pickupAt.getTime() + 12 * H) }, { type: "delivery", name: "Dallas", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(pickupAt.getTime() + 22 * H) }] });
    await planLeg(a, nx.legs[0].id, { kind: "truck", truckId: busy.t, driverId: busy.d });
    const ranked = await rankForLeg(a, o.legs[0].id);
    const order = ranked.filter((c) => ["207", "213", "Q316", "220"].includes(c.unitNumber)).map((c) => c.unitNumber);
    expect(order).toEqual(["207", "213", "Q316", "220"]);
    const r220 = ranked.find((c) => c.unitNumber === "220")!;
    expect(r220.nextLoad).toMatchObject({ orderNumber: nx.order.orderNumber, makes: false });
    expect(r220.reason).toMatch(/^Can't make its next load/);
    expect(ranked.find((c) => c.unitNumber === "207")!.reason).toMatch(/^Free now/);
  });
});
