// Features: F-30.7
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { invoices, carrierBills, settlements, charges } from "@/db/schema";
import { newId } from "@/lib/ids";
import { homeFor } from "@/lib/home";
import { ownerToday, byCurrency } from "./today";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import { scorecard } from "./carrier-portal";

const H = 3600_000;
const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Today Carrier");
});

describe("role home pages (owner #6, billing #44)", () => {
  it("each role starts on its own page", () => {
    expect(homeFor("owner")).toBe("/today");
    expect(homeFor("billing")).toBe("/billing");
    expect(homeFor("compliance")).toBe("/compliance");
    expect(homeFor("dispatcher")).toBe("/dispatch");
    expect(homeFor("mx_office")).toBe("/crossing");
    expect(homeFor(undefined)).toBe("/dispatch");
  });
});

describe("the owner's Today page", () => {
  it("never adds pesos to dollars", () => {
    expect(byCurrency([{ currency: "MXN", cents: 5_310_000 }, { currency: "USD", cents: 100 }, { currency: "USD", cents: 250 }, { currency: "CAD", cents: 0 }])).toEqual([
      { currency: "USD", cents: 350, count: 2 },
      { currency: "MXN", cents: 5_310_000, count: 1 },
    ]);
  });

  it("cash in and out per currency, approvals waiting, loads in trouble, trucks with nothing tomorrow", async () => {
    const cust = await create(a, "customer", { name: "Sierra Madre", kind: "customer" });
    const carrier = await create(a, "carrier", { name: "Transportes del Norte", country: "MX" });
    const t1 = await create(a, "truck", { unitNumber: "201", usPlate: "TX201", usPlateExpires: future });
    const d1 = await create(a, "driver", { name: "Rafael Mendoza", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
    const soon = new Date(Date.now() + 2 * H);
    await db.insert(invoices).values([
      { id: newId(), tenantId: a.tenantId, entityId: "e", customerId: cust.id, number: "FF-1", state: "sent", currency: "USD", totalCents: 250000, paidCents: 50000, dueAt: new Date(Date.now() - 5 * 86400_000) },
      { id: newId(), tenantId: a.tenantId, entityId: "e", customerId: cust.id, number: "FF-2", state: "sent", currency: "MXN", totalCents: 5_310_000, dueAt: new Date(Date.now() - 86400_000) },
      { id: newId(), tenantId: a.tenantId, entityId: "e", customerId: cust.id, number: "FF-3", state: "paid", currency: "USD", totalCents: 99999, paidCents: 99999, dueAt: new Date(Date.now() - 86400_000) },
    ]);
    const o = await createOrder(a, { customerId: cust.id, rateCents: 180000, book: true, stops: [{ type: "pickup", name: "Shipper", country: "US", address: { city: "Laredo", state: "TX" }, windowStart: soon }, { type: "delivery", name: "DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(Date.now() + 12 * H) }] });
    await db.insert(carrierBills).values({ id: newId(), tenantId: a.tenantId, carrierId: carrier.id, orderId: o.order.id, legId: o.legs[0].id, state: "approved", currency: "MXN", expectedCents: 900000, approvedCents: 900000 });
    await db.insert(settlements).values({ id: newId(), tenantId: a.tenantId, driverId: d1.id, periodStart: new Date(Date.now() - 7 * 86400_000), periodEnd: new Date(), state: "approved", currency: "USD", netCents: 95480 });
    await db.insert(charges).values({ id: newId(), tenantId: a.tenantId, orderId: o.order.id, kind: "detention", description: "Detention", rateCents: 18750, amountCents: 18750, approvalState: "pending", source: "manual" });

    const d = await ownerToday(a);
    expect(d.cashIn!.overdue).toEqual([
      { currency: "USD", cents: 200000, count: 1 },
      { currency: "MXN", cents: 5_310_000, count: 1 },
    ]);
    expect(d.cashOut!.carrierBills).toEqual([{ currency: "MXN", cents: 900000, count: 1 }]);
    expect(d.cashOut!.driverPay).toEqual([{ currency: "USD", cents: 95480, count: 1 }]);
    expect(d.approvals.accessorials).toBe(1);
    expect(d.loads.noTruckSoon).toBe(1); // picks up in 2 h with nobody on it
    expect(d.trucksEmptyTomorrow).toBe(1); // 201 has no next load
    // billing sees money; Safety does not
    const safety = await ownerToday({ ...a, role: "compliance" });
    expect(safety.cashIn).toBeNull();
    expect(safety.billing).toBeNull();
  });

  it("a late load and a truck with its next load are counted right", async () => {
    const cust = await create(a, "customer", { name: "Acme", kind: "customer" });
    const t1 = await create(a, "truck", { unitNumber: "201", usPlate: "TX201", usPlateExpires: future });
    const d1 = await create(a, "driver", { name: "Rafael Mendoza", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
    const late = await createOrder(a, { customerId: cust.id, rateCents: 1000, book: true, stops: [{ type: "pickup", name: "A", country: "US", windowStart: new Date(Date.now() - 3 * H) }, { type: "delivery", name: "B", country: "US", windowStart: new Date(Date.now() + 5 * H) }] });
    await planLeg(a, late.legs[0].id, { kind: "truck", truckId: t1.id, driverId: d1.id });
    await dispatchLeg(a, late.legs[0].id);
    let d = await ownerToday(a);
    expect(d.loads.late).toBe(1);
    expect(d.trucksEmptyTomorrow).toBe(1); // frees up after this delivery with nothing next
    const next = await createOrder(a, { customerId: cust.id, rateCents: 1000, book: true, stops: [{ type: "pickup", name: "C", country: "US", windowStart: new Date(Date.now() + 26 * H) }, { type: "delivery", name: "D", country: "US", windowStart: new Date(Date.now() + 30 * H) }] });
    await planLeg(a, next.legs[0].id, { kind: "truck", truckId: t1.id, driverId: d1.id });
    d = await ownerToday(a);
    expect(d.trucksEmptyTomorrow).toBe(0);
  });
});

describe("carrier scorecard counts what they run now (m20)", () => {
  it("a carrier on a load shows it, not '0 loads'", async () => {
    const cust = await create(a, "customer", { name: "Acme", kind: "customer" });
    const carrier = await create(a, "carrier", { name: "Bluewater Carriers", country: "US", mcNumber: "MC1" });
    const o = await createOrder(a, { customerId: cust.id, rateCents: 1000, book: true, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] });
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: carrier.id, carrierRateCents: 500 });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id, "carrier");
    await advanceLeg(a, o.legs[0].id, "en_route_to_pickup");
    const sc = await scorecard(a, carrier.id);
    expect(sc.loads).toBe(0);
    expect(sc.running).toBe(1);
  });
});
