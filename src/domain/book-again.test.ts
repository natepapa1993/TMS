// Features: F-30.10
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { createOrder, copyOrder, shiftStops, splitLeg, getOrder, ValidationError } from "./orders";
import { portalRequestLoad, usualHandoffs } from "./customer-portal";
import { legTypeBetween } from "./zones";

const H = 3600_000;
let a: Awaited<ReturnType<typeof makeTenant>>;
let cust: string;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Again Carrier");
  cust = (await create(a, "customer", { name: "Sierra Madre", kind: "customer" })).id;
});

const mx3 = (at: Date) =>
  createOrder(a, {
    customerId: cust,
    rateCents: 320000,
    book: true,
    refs: { po: "PO-1", reference: "MLD-55120", rate_con: "RC-9" },
    stops: [
      { type: "pickup", name: "Planta Apodaca", country: "MX", address: { city: "Apodaca", state: "NL" }, windowStart: at, windowEnd: new Date(at.getTime() + 2 * H) },
      { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" } },
      { type: "yard", name: "Frontera yard Laredo", country: "US", address: { city: "Laredo", state: "TX" } },
      { type: "delivery", name: "DC San Antonio", country: "US", address: { city: "San Antonio", state: "TX" }, windowStart: new Date(at.getTime() + 30 * H) },
    ],
  });

describe("Book again asks for the new dates and drops the old load's references (M11)", () => {
  it("moves the stop times: pickup to the new pickup, delivery to the new delivery, the rest with the pickup", () => {
    const t0 = new Date("2026-09-28T13:00:00Z");
    const stops = [
      { windowStart: t0, windowEnd: new Date(t0.getTime() + 2 * H) },
      { windowStart: new Date(t0.getTime() + 6 * H), windowEnd: null },
      { windowStart: null, windowEnd: null },
      { windowStart: new Date(t0.getTime() + 30 * H), windowEnd: null },
    ];
    const pu = new Date("2026-10-05T14:00:00Z");
    const del = new Date("2026-10-06T20:00:00Z");
    const out = shiftStops(stops, pu, del);
    expect(out[0]).toEqual({ windowStart: pu, windowEnd: new Date(pu.getTime() + 2 * H) });
    expect(out[1].windowStart).toEqual(new Date(pu.getTime() + 6 * H));
    expect(out[2]).toEqual({ windowStart: null, windowEnd: null });
    expect(out[3]).toEqual({ windowStart: del, windowEnd: null });
    expect(shiftStops(stops, null, null).every((x) => !x.windowStart && !x.windowEnd)).toBe(true);
  });

  it("the new draft has the new dates, no PO, customer load # or rate con, and the same legs", async () => {
    const o = await mx3(new Date(Date.now() - 5 * 24 * H));
    const pu = new Date(Date.now() + 24 * H);
    const del = new Date(Date.now() + 50 * H);
    const c = await copyOrder(a, o.order.id, { pickupAt: pu, deliveryAt: del });
    expect(c.order.state).toBe("draft");
    expect(c.order.refs).toEqual({});
    expect(c.stops[0].windowStart).toEqual(pu);
    expect(c.stops[0].windowEnd).toEqual(new Date(pu.getTime() + 2 * H));
    expect(c.stops[3].windowStart).toEqual(del);
    expect(c.stops.map((s) => s.address?.city)).toEqual(["Apodaca", "Nuevo Laredo", "Laredo", "San Antonio"]);
    expect(c.legs.map((l) => l.type)).toEqual(["mx", "crossing", "us"]);
    await expect(copyOrder(a, o.order.id, { pickupAt: del, deliveryAt: pu })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("portal requests arrive legged like the customer's usual lane (M10)", () => {
  it("a request Apodaca → San Antonio from a customer who always goes via Patio NL and the Laredo yard gets MX / Crossing / US", async () => {
    await mx3(new Date(Date.now() - 10 * 24 * H));
    await mx3(new Date(Date.now() - 3 * 24 * H));
    expect((await usualHandoffs(a.tenantId, cust, "MX", "US")).map((s) => s.name)).toEqual(["Patio Nuevo Laredo", "Frontera yard Laredo"]);
    expect(await usualHandoffs(a.tenantId, cust, "US", "US")).toEqual([]);
    const r = await portalRequestLoad(a.tenantId, cust, { pickup: { name: "Planta Apodaca 2", city: "Apodaca", state: "NL", country: "MX" }, delivery: { name: "DC San Antonio", city: "San Antonio", state: "TX", country: "US" } });
    expect(r.stops.map((s) => s.type)).toEqual(["pickup", "border_yard", "yard", "delivery"]);
    expect(r.legs.map((l) => l.type)).toEqual(["mx", "crossing", "us"]);
  });

  it("a customer with no history keeps the two ends", async () => {
    const other = (await create(a, "customer", { name: "New Co", kind: "customer" })).id;
    const r = await portalRequestLoad(a.tenantId, other, { pickup: { name: "A", city: "Apodaca", country: "MX" }, delivery: { name: "B", city: "Dallas", country: "US" } });
    expect(r.legs).toHaveLength(1);
  });
});

describe("Split names both halves by the countries they run in (M24)", () => {
  it("a crossing split at the Mexican border yard is an MX leg and a crossing leg; a saved yard fills the stop", async () => {
    const o = await createOrder(a, { customerId: cust, rateCents: 200000, book: true, stops: [{ type: "pickup", name: "Planta Apodaca", country: "MX" }, { type: "delivery", name: "DC San Antonio", country: "US" }] });
    expect(o.legs[0].type).toBe("crossing");
    const patio = await create(a, "location", { name: "Patio Nuevo Laredo", kind: "border_yard", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" }, lat: "27.47", lng: "-99.55" });
    const r = await splitLeg(a, o.legs[0].id, { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", locationId: patio.id });
    expect(r.first.type).toBe("mx");
    expect(r.second.type).toBe("crossing");
    expect(r.stop.lat).toBe("27.47");
    expect(r.stop.address).toMatchObject({ city: "Nuevo Laredo" });
    const r2 = await splitLeg(a, r.second.id, { type: "yard", name: "Frontera yard", country: "US" });
    expect([r2.first.type, r2.second.type]).toEqual(["crossing", "us"]);
    expect((await getOrder(a, o.order.id)).legs.map((l) => l.type)).toEqual(["mx", "crossing", "us"]);
  });

  it("legTypeBetween (pure)", () => {
    const st = [{ country: "MX" }, { country: "MX" }, { country: "US" }, { country: "US" }];
    expect([legTypeBetween(st, 0, 1), legTypeBetween(st, 1, 2), legTypeBetween(st, 2, 3)]).toEqual(["mx", "crossing", "us"]);
    expect(legTypeBetween([{ country: "US" }, { country: "US" }], 0, 1)).toBe("domestic");
  });
});
