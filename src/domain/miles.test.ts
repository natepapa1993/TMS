// Features: F-30.9
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { legs as legsT } from "@/db/schema";
import { eq } from "drizzle-orm";
import { lookupCity, cityInText, placeOf, estimateMiles, legMiles, sumMiles, milesLabel } from "./miles";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, setLegMiles, updateStop, getOrder } from "./orders";
import { buildSettlement } from "./billing";
import { legPayLines } from "./pay-plans-pure";

const future = new Date(Date.now() + 365 * 86400_000);

describe("the built-in city list", () => {
  it("finds freight cities with or without accents, by state when two share a name", () => {
    expect(lookupCity("Querétaro")?.state).toBe("QRO");
    expect(lookupCity("queretaro")?.state).toBe("QRO");
    expect(lookupCity("SAN NICOLAS")?.city).toBe("San Nicolás de los Garza");
    expect(lookupCity("Mexico City")?.state).toBe("CDMX");
    expect(lookupCity("Canton", "MI")?.country).toBe("US");
    expect(lookupCity("Atlantis")).toBeNull();
  });

  it("reads a city out of a stop name, longest name first", () => {
    expect(cityInText("Patio Nuevo Laredo")?.city).toBe("Nuevo Laredo");
    expect(cityInText("Frontera yard Laredo")?.city).toBe("Laredo");
    expect(cityInText("Love's #312")).toBeNull();
  });

  it("uses a stop's own coordinates first, then its city, then its name", () => {
    expect(placeOf({ lat: "27.5", lng: "-99.5", address: { city: "Dallas" } })).toMatchObject({ lat: 27.5, exact: true });
    expect(placeOf({ address: { city: "Dallas", state: "TX" } })).toMatchObject({ exact: false });
    expect(placeOf({ name: "Planta Ramos Arizpe" })?.lat).toBeCloseTo(25.54, 1);
    expect(placeOf({ name: "Somewhere" })).toBeNull();
  });

  it("estimates road miles between stops (Laredo → Dallas is about 400)", () => {
    const mi = estimateMiles({ address: { city: "Laredo", state: "TX" } }, { address: { city: "Dallas", state: "TX" } })!;
    expect(mi).toBeGreaterThan(380);
    expect(mi).toBeLessThan(480);
    expect(estimateMiles({ address: { city: "Laredo" } }, { name: "Nowhere" })).toBeNull();
    expect(estimateMiles({ address: { city: "Laredo" } }, { address: { city: "Laredo" } })).toBeNull(); // the same spot says nothing
  });

  it("typed miles win; an estimate is labelled", () => {
    expect(legMiles({ plannedMiles: 410, estMiles: 432 })).toEqual({ miles: 410, est: false });
    expect(legMiles({ plannedMiles: null, estMiles: 432 })).toEqual({ miles: 432, est: true });
    expect(legMiles({ plannedMiles: null, estMiles: null })).toBeNull();
    expect(milesLabel(sumMiles([{ plannedMiles: 100, estMiles: null }, { plannedMiles: null, estMiles: 50 }]))).toBe("150 mi est.");
    expect(milesLabel(sumMiles([{ plannedMiles: 100, estMiles: 90 }]))).toBe("100 mi");
    expect(milesLabel(null)).toBe("—");
  });
});

describe("legs carry an estimate when nobody typed the miles (M15)", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  beforeEach(async () => {
    await truncateAll();
    a = await makeTenant("Miles Carrier");
  });

  it("a new load's legs get estimated miles from the stop cities; a city change re-estimates; typing miles wins", async () => {
    const cust = await create(a, "customer", { name: "Sierra Madre", kind: "customer" });
    const o = await createOrder(a, {
      customerId: cust.id,
      rateCents: 250000,
      stops: [
        { type: "pickup", name: "Planta Ramos Arizpe", country: "MX", address: { city: "Ramos Arizpe", state: "COAH" } },
        { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" } },
        { type: "yard", name: "Frontera yard", country: "US", address: { city: "Laredo", state: "TX" } },
        { type: "delivery", name: "DC Dallas", country: "US", address: { city: "Dallas", state: "TX" } },
      ],
    });
    const [mx, crossing, us] = o.legs;
    expect(mx.plannedMiles).toBeNull();
    expect(mx.estMiles).toBeGreaterThan(150); // Ramos Arizpe → Nuevo Laredo, ~190 road miles
    expect(crossing.estMiles).toBeGreaterThan(0);
    expect(us.estMiles).toBeGreaterThan(380);
    // the delivery moves to Houston: the US leg is estimated again
    const dallas = o.stops[3];
    await updateStop(a, dallas.id, { address: { city: "Houston", state: "TX" } });
    const after = (await getOrder(a, o.order.id)).legs.find((l) => l.id === us.id)!;
    expect(after.estMiles).not.toBe(us.estMiles);
    await setLegMiles(a, us.id, 355);
    const typed = (await getOrder(a, o.order.id)).legs.find((l) => l.id === us.id)!;
    expect(legMiles(typed)).toEqual({ miles: 355, est: false });
  });

  it("per-mile driver pay uses the estimate and says (est.) on the statement", async () => {
    const cust = await create(a, "customer", { name: "Acme", kind: "customer" });
    const t = await create(a, "truck", { unitNumber: "301", usPlate: "TX301", usPlateExpires: future });
    const d = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t.id, payType: "per_mile", payRateCents: 60 });
    const o = await createOrder(a, { customerId: cust.id, rateCents: 150000, book: true, stops: [{ type: "pickup", name: "Shipper", country: "US", address: { city: "Laredo", state: "TX" } }, { type: "delivery", name: "Receiver", country: "US", address: { city: "Dallas", state: "TX" } }] });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: t.id, driverId: d.id });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    const long = new Date(Date.now() - 10 * 3600_000);
    await db.update(legsT).set({ acceptedAt: long }).where(eq(legsT.id, leg));
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
    const est = (await getOrder(a, o.order.id)).legs[0].estMiles!;
    const from = new Date(Date.now() - 3 * 86400_000);
    const st = await buildSettlement(a, d.id, from, new Date(Date.now() + 86400_000));
    const line = st.lines.find((l) => l.kind === "leg")!;
    expect(line.qty).toBe(est);
    expect(line.description).toContain("(est.)");
    expect(line.source).toBe("estimated miles");
    expect(line.amountCents).toBe(est * 60);
  });

  it("pay plan lines label estimated loaded miles", () => {
    const lines = legPayLines({ rules: [{ kind: "per_loaded_mile", amount: 62, label: "" }], teamSplit: "half" } as never, { legId: "l", orderId: "o", orderNumber: "26-00001", seq: 1, type: "us", customerId: null, equipment: "53_dry", loadedMiles: 430, loadedMilesEst: true, emptyMiles: null, stops: 2, hours: 8, linehaulCents: 100000, billedCents: 100000, firstLegOfLoad: true, team: false });
    expect(lines[0].description).toContain("430 loaded mi (est.)");
    expect(lines[0].source).toBe("estimated miles");
  });
});
