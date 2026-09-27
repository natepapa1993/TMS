// Features: F-20.6
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { positions } from "@/db/schema";
import { newId } from "@/lib/ids";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import { assetMap } from "./asset-map";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Map Carrier");
});

const ping = (p: Partial<typeof positions.$inferInsert> & { lat: string; lng: string; at: Date }) => db.insert(positions).values({ id: newId(), tenantId: a.tenantId, source: "eld", ...p });

describe("asset map", () => {
  it("each truck at its newest position, moving / stopped / stale, with its load and next stop; carriers on our loads too", async () => {
    const cust = await create(a, "customer", { name: "Acme", kind: "broker" });
    const t1 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX1", usPlateExpires: future });
    const t2 = await create(a, "truck", { unitNumber: "2117", usPlate: "TX2", usPlateExpires: future });
    const t3 = await create(a, "truck", { unitNumber: "2120", usPlate: "TX3", usPlateExpires: future });
    await create(a, "truck", { unitNumber: "2130", usPlate: "TX4", usPlateExpires: future });
    const dan = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
    const carrier = await create(a, "carrier", { name: "Partner Freight", country: "US", kind: "us" });
    const o = await createOrder(a, { customerId: cust.id, rateCents: 1, book: true, stops: [{ type: "pickup", name: "Shipper Canton", country: "US", address: { city: "Canton", state: "MI" } }, { type: "delivery", name: "DC Columbus", country: "US", address: { city: "Columbus", state: "OH" } }] });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: t1.id, driverId: dan.id });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, o.legs[0].id, st);
    const o2 = await createOrder(a, { customerId: cust.id, rateCents: 1, book: true, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "Plant Toledo", country: "US", address: { city: "Toledo", state: "OH" } }] });
    await planLeg(a, o2.legs[0].id, { kind: "carrier", carrierId: carrier.id }, { override: true, reason: "test" });
    await dispatchLeg(a, o2.legs[0].id);

    const now = new Date();
    await ping({ truckId: t1.id, lat: "41.00", lng: "-83.00", at: new Date(now.getTime() - 3600_000), speedMph: 60 });
    await ping({ truckId: t1.id, lat: "40.50", lng: "-82.90", at: new Date(now.getTime() - 60_000), speedMph: 58, heading: 180 }); // newest
    await ping({ truckId: t2.id, lat: "42.30", lng: "-83.48", at: new Date(now.getTime() - 30 * 60_000), speedMph: 0 });
    await ping({ truckId: t3.id, lat: "32.50", lng: "-99.70", at: new Date(now.getTime() - 20 * 3600_000), speedMph: 55 });
    await ping({ legId: o2.legs[0].id, orderId: o2.order.id, lat: "41.60", lng: "-83.50", at: new Date(now.getTime() - 5 * 60_000), speedMph: 40, source: "carrier" as never });

    const m = await assetMap(a, now);
    const by = Object.fromEntries(m.units.map((u) => [u.label, u]));
    expect([by["2104"].status, by["2104"].lat, by["2104"].heading]).toEqual(["moving", 40.5, 180]);
    expect(by["2104"].driver).toBe("Daniel Reyes");
    expect(by["2104"].load).toMatchObject({ orderNumber: o.order.orderNumber, next: "Columbus, OH" });
    expect(by["2117"].status).toBe("stopped");
    expect(by["2120"].status).toBe("stale");
    expect(by["Partner Freight"]).toMatchObject({ kind: "carrier", status: "moving" });
    expect(by["Partner Freight"].load?.next).toBe("A");
    expect(m.unplaced.map((u) => u.label)).toEqual(["2130"]);
  });

  it("another company's positions never show", async () => {
    const b = await makeTenant("Other");
    const t = await create(b, "truck", { unitNumber: "9999", usPlate: "X", usPlateExpires: future });
    await db.insert(positions).values({ id: newId(), tenantId: b.tenantId, source: "eld", truckId: t.id, lat: "40", lng: "-83", at: new Date() });
    expect((await assetMap(a)).units).toEqual([]);
  });
});
