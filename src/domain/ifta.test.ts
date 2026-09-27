// Features: F-21.5
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { legs as legsT, positions, iftaMiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder } from "./orders";
import { jurisdictionAt, splitSegment, jurisdictionCode, IFTA_MEMBERS } from "./ifta-geo";
import { quarterOf, quarterDates, previousQuarter, iftaReturn, computeMiles, addTripMiles, deleteTripMiles, addFuelPurchase, importFuelPurchases, setRates, copyRatesFrom, iftaReport, iftaCsv } from "./ifta";

const LAREDO = { lat: 27.5306, lng: -99.4803 };
const SAN_ANTONIO = { lat: 29.4241, lng: -98.4936 };
const OKC = { lat: 35.4676, lng: -97.5164 };
const MTY = { lat: 25.6866, lng: -100.3161 };
const DETROIT = { lat: 42.3314, lng: -83.0458 };
const LONDON_ON = { lat: 42.9849, lng: -81.2453 };

describe("jurisdictions, pure", () => {
  it("finds the state, province or Mexico at a point", () => {
    expect(jurisdictionAt(LAREDO.lat, LAREDO.lng)).toBe("TX");
    expect(jurisdictionAt(OKC.lat, OKC.lng)).toBe("OK");
    expect(jurisdictionAt(MTY.lat, MTY.lng)).toBe("MX");
    expect(jurisdictionAt(DETROIT.lat, DETROIT.lng)).toBe("MI");
    expect(jurisdictionAt(LONDON_ON.lat, LONDON_ON.lng)).toBe("ON");
    expect(jurisdictionAt(45.5017, -73.5673)).toBe("QC"); // Montreal
    expect(jurisdictionAt(30, -140)).toBeNull(); // Pacific
    expect(IFTA_MEMBERS.has("TX") && IFTA_MEMBERS.has("ON") && !IFTA_MEMBERS.has("MX") && !IFTA_MEMBERS.has("AK")).toBe(true);
  });
  it("splits a line's miles where it crosses a border", () => {
    const tx = splitSegment(LAREDO, SAN_ANTONIO, 157);
    expect(Object.keys(tx)).toEqual(["TX"]);
    expect(tx.TX).toBeCloseTo(157);
    const r = splitSegment(SAN_ANTONIO, OKC, 470);
    expect(r.TX / 470).toBeGreaterThan(0.65);
    expect(r.OK / 470).toBeGreaterThan(0.1);
    expect(r.TX + r.OK).toBeCloseTo(470);
    const x = splitSegment(MTY, LAREDO, 150);
    expect(x.MX).toBeGreaterThan(100);
    expect(x.TX).toBeGreaterThan(1);
  });
  it("reads what people type", () => {
    expect(jurisdictionCode("Texas")).toBe("TX");
    expect(jurisdictionCode("québec")).toBe("QC");
    expect(jurisdictionCode("NL")).toBe("NL");
    expect(jurisdictionCode("NL", "MX")).toBe("MX");
    expect(jurisdictionCode("Nuevo León")).toBe("MX");
    expect(jurisdictionCode("Narnia")).toBeNull();
  });
  it("quarters", () => {
    expect(quarterOf("2026-09-27")).toBe("2026Q3");
    expect(quarterDates("2026Q4")).toEqual({ start: "2026-10-01", end: "2027-01-01" });
    expect(previousQuarter("2026Q1")).toBe("2025Q4");
    expect(() => quarterDates("2026Q5")).toThrow();
  });
  it("the return: MPG from all gallons, tax on net taxable gallons, credit where more was bought, surcharge on taxable gallons", () => {
    const r = iftaReturn({ TX: 6000, OK: 2000, MX: 2000 }, { TX: 1500, OK: 0, MX: 500 }, { TX: { rateE4: 2000, surchargeE4: null }, OK: { rateE4: 1900, surchargeE4: 500 } });
    expect(r.mpg).toBe(5); // 10,000 mi / 2,000 gal
    const tx = r.rows.find((x) => x.jurisdiction === "TX")!;
    expect([tx.taxableGallons, tx.paidGallons, tx.netGallons, tx.taxCents]).toEqual([1200, 1500, -300, -6000]); // a $60 credit
    const ok = r.rows.find((x) => x.jurisdiction === "OK")!;
    expect(ok.taxCents).toBe(400 * 19 + 400 * 5); // $76 tax + $20 surcharge
    expect(r.rows.find((x) => x.jurisdiction === "MX")!.member).toBe(false);
    expect(r.taxDueCents).toBe(-6000 + 9600);
    expect(r.iftaMiles).toBe(8000);
    expect(r.missingRates).toEqual([]);
  });
});

let a: Awaited<ReturnType<typeof makeTenant>>;
let truck: string;
let cust: string;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("IFTA Carrier");
  truck = (await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104" })).id;
  cust = (await create(a, "customer", { name: "Acme", kind: "customer" })).id;
});

describe("miles and fuel for a quarter", () => {
  it("GPS where there is any, the legs' route elsewhere; trip-sheet miles kept across recomputes", async () => {
    const lar = await create(a, "location", { name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" }, lat: String(LAREDO.lat), lng: String(LAREDO.lng) });
    const okc = await create(a, "location", { name: "OKC DC", country: "US", address: { city: "Oklahoma City", state: "OK" }, lat: String(OKC.lat), lng: String(OKC.lng) });
    const done = new Date("2026-08-10T18:00:00Z");
    // a leg with no GPS: Laredo → OKC, 610 planned miles
    const o = await createOrder(a, { customerId: cust, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", locationId: lar.id, country: "US" }, { type: "delivery", name: "OKC DC", locationId: okc.id, country: "US" }], book: true });
    await db.update(legsT).set({ state: "completed", truckId: truck, plannedMiles: 610, completedAt: done }).where(eq(legsT.id, o.legs[0].id));
    // a leg with stops in two states and no coordinates: split evenly with a warning
    const o2 = await createOrder(a, { customerId: cust, rateCents: 100000, stops: [{ type: "pickup", name: "Somewhere", address: { state: "TX" }, country: "US" }, { type: "delivery", name: "Elsewhere", address: { state: "LA" }, country: "US" }], book: true });
    await db.update(legsT).set({ state: "completed", truckId: truck, plannedMiles: 300, completedAt: done }).where(eq(legsT.id, o2.legs[0].id));
    // GPS on another day: Laredo → San Antonio in pings; its leg is not estimated again
    const o3 = await createOrder(a, { customerId: cust, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "SA", country: "US" }], book: true });
    await db.update(legsT).set({ state: "completed", truckId: truck, plannedMiles: 157, completedAt: new Date("2026-08-12T20:00:00Z") }).where(eq(legsT.id, o3.legs[0].id));
    const t0 = new Date("2026-08-12T14:00:00Z").getTime();
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      await db.insert(positions).values({ id: `p${i}`, tenantId: a.tenantId, at: new Date(t0 + i * 15 * 60_000), source: "driver_app", truckId: truck, legId: o3.legs[0].id, lat: String(LAREDO.lat + (SAN_ANTONIO.lat - LAREDO.lat) * f), lng: String(LAREDO.lng + (SAN_ANTONIO.lng - LAREDO.lng) * f) });
    }
    await addTripMiles(a, { truckId: truck, date: "2026-08-20", jurisdiction: "tx", miles: 42, note: "to the shop" });
    const r = await computeMiles(a, "2026Q3");
    expect(r.legsFromGps).toBe(1);
    expect(r.legsEstimated).toBe(2);
    expect(r.legMiles).toBe(910);
    expect(r.gpsMiles).toBeGreaterThan(125);
    expect(r.gpsMiles).toBeLessThan(145); // straight line between pings
    expect(r.warnings.join(" ")).toMatch(/TX → LA split evenly/);
    await computeMiles(a, "2026Q3"); // idempotent; the trip sheet stays
    const rows = await db.select().from(iftaMiles).where(eq(iftaMiles.tenantId, a.tenantId));
    expect(rows.filter((x) => x.source === "trip_sheet").length).toBe(1);
    const rep = await iftaReport(a, "2026Q3");
    const by = Object.fromEntries(rep.rows.map((x) => [x.jurisdiction, x.miles]));
    expect(by.OK).toBeGreaterThan(90); // OKC is ~120 mi past the Red River on that line
    expect(by.TX).toBeGreaterThan(480);
    expect(by.LA).toBe(150);
    expect(rep.totalMiles).toBeCloseTo(910 + 42 + r.gpsMiles, -1);
    expect(rep.sources.trip_sheet).toBe(42);
    expect(rep.warnings.join(" ")).toMatch(/no fuel/);
    const trip = rows.find((x) => x.source === "trip_sheet")!;
    await expect(deleteTripMiles(a, rows.find((x) => x.source !== "trip_sheet")!.id)).rejects.toThrow(/recomputing/);
    await deleteTripMiles(a, trip.id);
  });

  it("fuel entered and imported from a card sheet; DEF not taxable; duplicates and strangers skipped; rates and the return", async () => {
    await addFuelPurchase(a, { truckId: truck, purchasedAt: "2026-07-05", jurisdiction: "Texas", gallons: 150, amountCents: 60000 });
    await addFuelPurchase(a, { truckId: truck, purchasedAt: "2026-07-06", jurisdiction: "NL", country: "MX", liters: 378.541 }); // 100 gal in Mexico
    await expect(addFuelPurchase(a, { purchasedAt: "2026-07-06", jurisdiction: "Atlantis", gallons: 10 })).rejects.toThrow(/not a state/);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Transactions");
    ws.addRow(["Tran Date", "Unit", "Location Name", "City", "State/Prov", "Item", "Qty", "Amount", "Invoice"]);
    ws.addRow(["07/10/2026", "2104", "Pilot 123", "Oklahoma City", "OK", "ULSD", "100", "380.00", "A1"]);
    ws.addRow(["07/10/2026", "2104", "Pilot 123", "Oklahoma City", "OK", "DEF", "5", "20.00", "A2"]);
    ws.addRow(["07/11/2026", "9999", "Love's", "Dallas", "TX", "ULSD", "80", "300.00", "A3"]);
    ws.addRow(["07/12/2026", "2104", "Love's", "Dallas", "TX", "Scale ticket", "1", "13.00", "A4"]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = await importFuelPurchases(a, { fileName: "efs.xlsx", bytes });
    expect(imp.added).toBe(2);
    expect(imp.skipped.map((x) => x.reason)).toEqual(["unit 9999 is not one of your trucks", "not fuel (Scale ticket)"]);
    expect((await importFuelPurchases(a, { fileName: "efs.xlsx", bytes })).skipped.filter((x) => x.reason === "already on file").length).toBe(2);

    await addTripMiles(a, { truckId: truck, date: "2026-07-15", jurisdiction: "TX", miles: 1200 });
    await addTripMiles(a, { truckId: truck, date: "2026-07-16", jurisdiction: "OK", miles: 300 });
    await addTripMiles(a, { truckId: truck, date: "2026-07-17", jurisdiction: "MX", miles: 500 });
    await setRates(a, "2026Q2", [{ jurisdiction: "TX", rate: 0.2 }, { jurisdiction: "OK", rate: 0.19 }]);
    expect((await copyRatesFrom(a, "2026Q3", "2026Q2")).copied).toBe(2);
    await setRates(a, "2026Q3", [{ jurisdiction: "OK", rate: 0.2, surcharge: 0.01 }]);
    await expect(setRates(a, "2026Q3", [{ jurisdiction: "MX", rate: 0.1 }])).rejects.toThrow(/not an IFTA jurisdiction/);
    const rep = await iftaReport(a, "2026Q3");
    expect(rep.totalGallons).toBe(350); // 150 TX + 100 MX + 100 OK; DEF out
    expect(rep.defGallons).toBe(5);
    expect(rep.mpg).toBeCloseTo(2000 / 350, 2);
    const tx = rep.rows.find((x) => x.jurisdiction === "TX")!;
    expect(tx.taxableGallons).toBeCloseTo(1200 / rep.mpg!, 0);
    expect(tx.taxCents).toBe(Math.round(((1200 / rep.mpg! - 150) * 2000) / 100)); // ≈ 60 net gallons × $0.20
    const ok = rep.rows.find((x) => x.jurisdiction === "OK")!;
    expect(ok.rate).toBe(0.2);
    expect(ok.surcharge).toBe(0.01);
    expect(rep.perTruck).toEqual([{ truckId: truck, unit: "2104", miles: 2000, gallons: 350, mpg: rep.mpg }]);
    expect(rep.warnings.join(" ")).not.toMatch(/MPG looks wrong/); // 5.71 MPG is plausible
    const csv = iftaCsv(rep);
    expect(csv.split("\n")[0]).toContain("Net taxable gallons");
    expect(csv).toContain("MX,no,500");
  });
});
