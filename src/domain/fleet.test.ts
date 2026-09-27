// Features: F-3.9 trailers board: on a load now (by leg or by the crossing's caja), last dropped where, idle days
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import { setCrossingDetails, ensureCrossingsForOrder, crossingBoard } from "./crossing";
import { trailerBoard } from "./fleet";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
});

describe("trailer board", () => {
  it("free, on a load by leg, on a crossing by caja number, then last seen with idle days", async () => {
    const rxo = await create(a, "customer", { name: "RXO", kind: "broker" });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future, mxPlate: "MX2104", mxPlateClass: "blue", mxPlateExpires: future });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "DUAL", licenseExpires: future, medicalExpires: future, mxLicenseExpires: future, fastExpires: future, currentTruckId: t2104.id });
    const c1 = await create(a, "trailer", { unitNumber: "10743", kind: "53_dry", lengthFt: 53 });
    const c2 = await create(a, "trailer", { unitNumber: "10750", kind: "53_dry" });
    let b = await trailerBoard(a);
    expect(b.map((r) => [r.unitNumber, r.now, r.last, r.idleDays])).toEqual([["10743", null, null, null], ["10750", null, null, null]]);

    // 10743 on a domestic leg by assignment
    const o = await createOrder(a, { customerId: rxo.id, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id, trailerId: c1.id });
    b = await trailerBoard(a);
    expect(b[0]).toMatchObject({ unitNumber: "10743", now: { orderNumber: o.order.orderNumber, legType: "Domestic", route: "Laredo Yard → Toyota" } });
    // delivered a week ago → free, last seen at Toyota, idle 7 days
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    const ago = new Date(Date.now() - 7 * 86400_000);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st, { at: ago });
    b = await trailerBoard(a);
    const r1 = b.find((r) => r.unitNumber === "10743")!;
    expect(r1.now).toBeNull();
    expect(r1.last).toMatchObject({ orderNumber: o.order.orderNumber, where: "Toyota" });
    expect(r1.idleDays).toBe(7);
    expect(r1.loads).toBe(1);

    // 10750 named as the caja on a crossing → on that load, by number alone
    const x = await createOrder(a, { customerId: rxo.id, rateCents: 285000, stops: [{ type: "pickup", name: "Planta", country: "MX" }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }, { type: "delivery", name: "GM", country: "US" }], book: true });
    await ensureCrossingsForOrder(a, x.order.id);
    const [xc] = await crossingBoard(a);
    await setCrossingDetails(a, xc.c.id, { trailerNumber: "10750" });
    b = await trailerBoard(a);
    expect(b[0]).toMatchObject({ unitNumber: "10750", now: { orderNumber: x.order.orderNumber, legType: "Crossing", route: "Santa Fe → Laredo" } });
    expect(b[1].unitNumber).toBe("10743"); // idle ones after busy ones
    expect((await create(a, "trailer", { unitNumber: "10751", kind: "48_dry" })).id).toBeTruthy();
    expect((await trailerBoard(a)).map((r) => r.unitNumber)).toEqual(["10750", "10743", "10751"]);
    void c2;
  });
});
