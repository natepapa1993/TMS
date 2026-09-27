// Features: F-21.3
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { charges, legs as legsT } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder } from "./orders";
import { ensureCharges } from "./billing";
import { fscValue, mondayOf, saveFuelTable, setFuelPrice, fuelPriceFor, listFuel, deleteFuelTable, suggestCustomerRate, routeMiles } from "./rates";

let a: Awaited<ReturnType<typeof makeTenant>>;
let cust: string;
const MTY = { name: "Planta Monterrey", address: { city: "Apodaca", state: "NL" } };
const LRD = { name: "Laredo Yard", address: { city: "Laredo", state: "TX" } };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Rates Carrier");
  cust = (await create(a, "customer", { name: "Acme", kind: "shipper" })).id;
});

describe("fuel tables", () => {
  it("finds the band for a price; Monday of a week", () => {
    const bands = [
      { from: 300, to: 305, value: 2000 },
      { from: 305, to: 310, value: 2050 },
      { from: 310, to: null, value: 2100 },
    ];
    expect(fscValue(bands, 299)).toBeNull();
    expect(fscValue(bands, 304)).toBe(2000);
    expect(fscValue(bands, 305)).toBe(2050);
    expect(fscValue(bands, 900)).toBe(2100);
    expect(mondayOf("2026-09-27")).toBe("2026-09-21"); // a Sunday
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
  });
  it("rejects overlapping bands; one default; weekly price replaces and carries forward", async () => {
    await expect(saveFuelTable(a, { name: "Bad", method: "pct", bands: [{ from: 300, to: 310, value: 1 }, { from: 305, to: 320, value: 2 }] })).rejects.toThrow(/overlap/);
    const t1 = await saveFuelTable(a, { name: "DOE", method: "pct", isDefault: true, bands: [{ from: 300, to: 400, value: 2000 }] });
    await saveFuelTable(a, { name: "Other", method: "per_mile", isDefault: true, bands: [{ from: 0, to: null, value: 45 }] });
    let { tables } = await listFuel(a);
    expect(tables.filter((t) => t.isDefault).map((t) => t.name)).toEqual(["Other"]);
    await setFuelPrice(a, "2026-09-23", 385);
    await setFuelPrice(a, "2026-09-25", 389); // same week: replaces
    const { prices } = await listFuel(a);
    expect(prices.map((p) => [p.weekOf, p.priceCents])).toEqual([["2026-09-21", 389]]);
    expect((await fuelPriceFor(a.tenantId, "2026-10-05"))?.priceCents).toBe(389); // no newer week: last one holds
    expect(await fuelPriceFor(a.tenantId, "2026-09-01")).toBeNull();
    await expect(setFuelPrice(a, "2026-09-23", 5)).rejects.toThrow(/between/);
    await deleteFuelTable(a, t1.id);
    ({ tables } = await listFuel(a));
    expect(tables.map((t) => t.name)).toEqual(["Other"]);
  });
});

describe("customer lane rates", () => {
  it("flat lane with a fuel percent; equipment-specific wins; nothing for another lane", async () => {
    await create(a, "customerRate", { customerId: cust, originZone: "Monterrey NL", destinationZone: "Laredo TX", rateType: "flat", rateCents: 150000, currency: "USD", fuelRule: "pct", fuelValue: 20 });
    await create(a, "customerRate", { customerId: cust, originZone: "Apodaca", destinationZone: "Laredo", equipment: "53_reefer", rateType: "flat", rateCents: 190000, currency: "USD", fuelRule: "included" });
    const any = await suggestCustomerRate(a, { customerId: cust, equipment: "53_dry", from: MTY, to: LRD, date: "2026-09-28" });
    expect(any).toMatchObject({ rateType: "flat", rateCents: 150000, fuel: { rule: "pct", pct: 20 } });
    const reefer = await suggestCustomerRate(a, { customerId: cust, equipment: "53_reefer", from: MTY, to: LRD, date: "2026-09-28" });
    expect(reefer?.rateCents).toBe(190000);
    expect(await suggestCustomerRate(a, { customerId: cust, equipment: "53_dry", from: LRD, to: MTY, date: "2026-09-28" })).toBeNull();
  });
  it("per mile with a minimum; fuel from the default table at the week's price", async () => {
    await create(a, "customerRate", { customerId: cust, originZone: "Laredo", destinationZone: "Monterrey", rateType: "per_mile", rateCents: 250, minimumCents: 90000, currency: "USD", fuelRule: "table" });
    let r = await suggestCustomerRate(a, { customerId: cust, from: LRD, to: MTY, miles: 150, date: "2026-09-28" });
    expect(r).toMatchObject({ rateType: "per_mile", unitCents: 250, rateCents: 90000, minimumApplied: true, fuel: { rule: "included" } });
    expect(r?.fuel.note).toMatch(/no default fuel table/);
    await saveFuelTable(a, { name: "DOE", method: "per_mile", isDefault: true, bands: [{ from: 350, to: 400, value: 48 }, { from: 400, to: null, value: 55 }] });
    r = await suggestCustomerRate(a, { customerId: cust, from: LRD, to: MTY, miles: 500, date: "2026-09-28" });
    expect(r?.fuel.note).toMatch(/no diesel price/);
    await setFuelPrice(a, "2026-09-28", 389);
    r = await suggestCustomerRate(a, { customerId: cust, from: LRD, to: MTY, miles: 500, date: "2026-09-30" });
    expect(r).toMatchObject({ rateCents: 125000, minimumApplied: false, fuel: { rule: "per_mile", centsPerMile: 48 } });
    r = await suggestCustomerRate(a, { customerId: cust, from: LRD, to: MTY, miles: null, date: "2026-09-30" });
    expect(r?.rateCents).toBeNull();
  });
  it("route miles from saved locations", async () => {
    const l1 = await create(a, "location", { name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" }, lat: "27.5306", lng: "-99.4803" });
    const l2 = await create(a, "location", { name: "Planta Monterrey", country: "MX", address: { city: "Apodaca", state: "NL" }, lat: "25.7817", lng: "-100.1886" });
    const mi = await routeMiles(a, [l1.id, l2.id]);
    expect(mi).toBeGreaterThan(140);
    expect(mi).toBeLessThan(190);
    expect(await routeMiles(a, [l1.id, null])).toBeNull();
  });
});

describe("fuel on the invoice", () => {
  it("per-mile fuel bills cents × the rated miles, or the legs' planned miles", async () => {
    const o = await createOrder(a, { customerId: cust, rateCents: 125000, rateType: "per_mile", rateUnitCents: 250, rateQty: 500, fuelRule: "per_mile", fuelCentsPerMile: 48, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }] });
    const c = await ensureCharges(a, o.order.id);
    expect(c.find((x) => x.kind === "fuel")).toMatchObject({ qty: 500, unit: "mi", rateCents: 48, amountCents: 24000 });
    const o2 = await createOrder(a, { customerId: cust, rateCents: 100000, fuelRule: "per_mile", fuelCentsPerMile: 50, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }] });
    await db.update(legsT).set({ plannedMiles: 430 }).where(eq(legsT.orderId, o2.order.id));
    await ensureCharges(a, o2.order.id);
    const fuel = (await db.select().from(charges).where(eq(charges.orderId, o2.order.id))).find((x) => x.kind === "fuel");
    expect(fuel?.amountCents).toBe(21500);
  });
  it("a load keeps the contract it was priced from; a foreign rate id is refused", async () => {
    const cr = await create(a, "customerRate", { customerId: cust, originZone: "Laredo", destinationZone: "Dallas", rateType: "flat", rateCents: 90000, currency: "USD", fuelRule: "included" });
    const o = await createOrder(a, { customerId: cust, rateCents: 90000, customerRateId: cr.id, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }] });
    expect(o.order.customerRateId).toBe(cr.id);
    const b = await makeTenant("Other Carrier");
    await expect(createOrder(b, { rateCents: 1, customerRateId: cr.id, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] })).rejects.toThrow(/not found|customer rate/i);
  });
});
