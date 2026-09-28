// Features: F-34.1
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { createOrder, planLeg, dispatchLeg, advanceLeg } from "./orders";
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
