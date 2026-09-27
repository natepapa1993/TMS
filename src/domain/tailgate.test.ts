// Features: F-12 F-5.11 tailgate / LTL — the plan's acceptance test: a Canton → Laredo southbound trip with five shipments from three customers, planned with capacity and LIFO, crosses with all five on one packet, deconsolidates, five invoices and one settlement with margin per shipment
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { orders, stops, flags } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import * as T from "./tailgate";
import * as B from "./billing";
import * as X from "./crossing";
import * as R from "./reports";
import { getOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, stampStop, pendingMidStop, ValidationError } from "./orders";
import { updateCompany } from "./company";
import { zonedDate } from "@/lib/time";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; magna: string; toyota: string; t2117: string; trailer: string; benjamin: string; martin: string; garza: string };
const pdf = Buffer.from("%PDF-1.4 fixture");

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: ["POD"] });
  const magna = await create(a, "customer", { name: "Magna", kind: "customer", termsDays: 45, requiredDocs: ["POD"] });
  const toyota = await create(a, "customer", { name: "Toyota", kind: "customer", termsDays: 30, requiredDocs: [] });
  const t2117 = await create(a, "truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future, scac: "TSEX", dtopsYear: new Date().getUTCFullYear(), dtopsConfirmation: "DT-1" });
  const trailer = await create(a, "trailer", { unitNumber: "10743", kind: "53_dry", lengthFt: 53, maxWeightLbs: 44000 });
  const benjamin = await create(a, "driver", { name: "Benjamín Xochihua", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: new Date(Date.now() + 120 * 86400_000), medicalExpires: future, licenseExpires: future, payType: "per_mile", payRateCents: 60, currentTruckId: t2117.id });
  const martin = await create(a, "driver", { name: "Martín Martínez", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t2117.id });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  f = { rxo: rxo.id, magna: magna.id, toyota: toyota.id, t2117: t2117.id, trailer: trailer.id, benjamin: benjamin.id, martin: martin.id, garza: garza.id };
});

describe("legsForStops", () => {
  it("cuts same-country runs into one leg and a US yard → MX border yard into the crossing, both directions", () => {
    expect(T.legsForStops([{ type: "pickup", country: "US" }, { type: "pickup", country: "US" }, { type: "delivery", country: "US" }])).toEqual([{ type: "domestic", from: 0, to: 2 }]);
    expect(T.legsForStops([{ type: "pickup", country: "US" }, { type: "yard", country: "US" }, { type: "border_yard", country: "MX" }, { type: "delivery", country: "MX" }, { type: "delivery", country: "MX" }])).toEqual([
      { type: "us", from: 0, to: 1 },
      { type: "crossing", from: 1, to: 2 },
      { type: "mx", from: 2, to: 4 },
    ]);
    expect(T.legsForStops([{ type: "pickup", country: "MX" }, { type: "border_yard", country: "MX" }, { type: "yard", country: "US" }, { type: "delivery", country: "US" }])).toEqual([
      { type: "mx", from: 0, to: 1 },
      { type: "crossing", from: 1, to: 2 },
      { type: "us", from: 2, to: 3 },
    ]);
    expect(() => T.legsForStops([{ type: "pickup", country: "US" }, { type: "delivery", country: "MX" }])).toThrow(/yard/);
    expect(() => T.legsForStops([{ type: "pickup", country: "US" }])).toThrow(/two stops/);
  });
});

describe("tailgate trip (acceptance)", () => {
  it("Canton → Laredo → Monterrey with five shipments from three customers: capacity + LIFO, one crossing with every shipment's docs, deconsolidation, five invoices, one settlement, margin per shipment", async () => {
    await updateCompany(a, { fuelCostCentsPerMile: 50 });
    const trip = await T.createTrip(a, {
      equipment: "53_dry",
      stops: [
        { type: "pickup", name: "Canton dock", country: "US", address: { city: "Canton", state: "MI" } },
        { type: "pickup", name: "Toledo supplier", country: "US", address: { city: "Toledo", state: "OH" } },
        { type: "yard", name: "Laredo yard", country: "US", address: { city: "Laredo", state: "TX" } },
        { type: "border_yard", name: "Santa Fe yard", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" } },
        { type: "delivery", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" } },
        { type: "delivery", name: "Saltillo plant", country: "MX", address: { city: "Saltillo", state: "COAH" } },
      ],
    });
    expect(trip.order.kind).toBe("trip");
    expect(trip.legs.map((l) => l.type)).toEqual(["us", "crossing", "mx"]);
    const [canton, toledo, , , mty, saltillo] = trip.stops;

    // five shipments; the fifth would push the trailer over 44,000 lb → refused; a lighter one fits
    const s1 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 120000, refs: { po: "PO-1" }, pickupStopId: canton.id, deliveryStopId: mty.id, pieces: 10, weightLbs: 12000, linearFt: 12 });
    const s2 = await T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 90000, refs: { po: "PO-2" }, pickupStopId: canton.id, deliveryStopId: saltillo.id, pieces: 8, weightLbs: 10000, linearFt: 10 });
    const s3 = await T.addShipment(a, trip.order.id, { customerId: f.toyota, rateCents: 60000, refs: { po: "PO-3" }, pickupStopId: toledo.id, deliveryStopId: mty.id, pieces: 4, weightLbs: 8000, linearFt: 8 });
    const s4 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 50000, refs: { po: "PO-4" }, pickupStopId: toledo.id, deliveryStopId: saltillo.id, pieces: 6, weightLbs: 8000, linearFt: 8 });
    await expect(T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 40000, pickupStopId: canton.id, deliveryStopId: mty.id, weightLbs: 9000, linearFt: 6 })).rejects.toThrow(/will not fit.*lb/);
    const s5 = await T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 40000, refs: { po: "PO-5" }, pickupStopId: canton.id, deliveryStopId: mty.id, pieces: 3, weightLbs: 4000, linearFt: 6 });
    await expect(T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 1, pickupStopId: mty.id, deliveryStopId: canton.id })).rejects.toThrow(/after pickup/);
    // a shipment is an order: its own number, customer, rate, stops copied from the trip
    const sh1 = await getOrder(a, s1.id);
    expect(sh1.order.kind).toBe("shipment");
    expect(sh1.order.tripId).toBe(trip.order.id);
    expect(sh1.legs).toHaveLength(0);
    expect(sh1.stops.map((x) => x.name)).toEqual(["Canton dock", "Planta Monterrey"]);

    // capacity: 42,000 lb peak on 44,000; 44 ft of 53; LIFO: Saltillo shipments (off last) load first
    const cap = await T.capacity(a, trip.order.id);
    expect(cap.peak).toMatchObject({ weightLbs: 42000, linearFt: 44 });
    expect(cap.capacity.linearFt).toBe(53); // default 53' until the trailer is assigned
    expect(cap.fillPct).toBe(83);
    expect(cap.perStop.map((x) => [x.name, x.on.length, x.off.length, x.afterWeightLbs])).toEqual([
      ["Canton dock", 3, 0, 26000],
      ["Toledo supplier", 2, 0, 42000],
      ["Laredo yard", 0, 0, 42000],
      ["Santa Fe yard", 0, 0, 42000],
      ["Planta Monterrey", 0, 3, 18000],
      ["Saltillo plant", 0, 2, 0],
    ]);
    const ships = await T.tripShipments(a, trip.order.id);
    expect(ships.map((x) => [x.orderNumber, x.loadSeq])).toEqual([
      [s2.orderNumber, 1], // Saltillo, on at Canton → nose
      [s4.orderNumber, 2], // Saltillo, on at Toledo
      [s1.orderNumber, 3],
      [s5.orderNumber, 4],
      [s3.orderNumber, 5], // Monterrey, on at Toledo → tail
    ]);

    // book: shipments follow
    await expect(T.bookTrip(a, (await T.createTrip(a, { stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] })).order.id)).rejects.toThrow(/at least one shipment/);
    await T.bookTrip(a, trip.order.id);
    expect((await getOrder(a, s1.id)).order.state).toBe("booked");
    // the trailer on the leg tightens capacity to its own numbers
    const usLeg = trip.legs[0].id;
    await planLeg(a, usLeg, { kind: "truck", truckId: f.t2117, driverId: f.martin }, { plannedMiles: 1500 });
    await db.update((await import("@/db/schema")).legs).set({ trailerId: f.trailer }).where(eq((await import("@/db/schema")).legs.id, usLeg));
    expect((await T.capacity(a, trip.order.id)).capacity).toMatchObject({ source: "trailer 10743", weightLbs: 44000, linearFt: 53 });
    // run the US leg: shipments go in_transit as their pickup stop departs, in stop order
    await dispatchLeg(a, usLeg);
    await acceptLeg(a, usLeg);
    expect((await getOrder(a, s3.id)).order.state).toBe("dispatched");
    await advanceLeg(a, usLeg, "en_route_to_pickup");
    await advanceLeg(a, usLeg, "at_pickup");
    await advanceLeg(a, usLeg, "loaded"); // departs Canton
    expect((await getOrder(a, s1.id)).order.state).toBe("in_transit");
    expect((await getOrder(a, s3.id)).order.state).toBe("dispatched"); // Toledo not yet
    await db.update(stops).set({ arrivedAt: new Date(), departedAt: new Date() }).where(eq(stops.id, toledo.id)); // the middle pickup's clocks (driver app / dispatcher)
    await advanceLeg(a, usLeg, "en_route");
    await advanceLeg(a, usLeg, "at_delivery");
    await advanceLeg(a, usLeg, "completed"); // at the Laredo yard
    expect((await getOrder(a, s3.id)).order.state).toBe("in_transit");
    await expect(T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 1, pickupStopId: canton.id, deliveryStopId: mty.id })).rejects.toThrow(/already left/);

    // the crossing lists every shipment's docs; one held shipment drops out of the gate (partial release)
    const c = (await X.crossingBoard(a)).find((x) => x.c.orderId === trip.order.id)!.c;
    await X.markArrivedYard(a, c.id);
    let page = await X.crossingPage(a, c.id);
    const shipReqs = page.crossing.requirements.filter((r) => r.code.startsWith("shipment:"));
    expect(shipReqs).toHaveLength(5);
    expect(shipReqs.map((r) => r.label)).toContain(`Shipment docs · Magna · ${s2.orderNumber} (PO-2)`);
    await T.holdShipment(a, s4.id, "no commercial invoice from RXO yet");
    expect((await getOrder(a, s4.id)).order.state).toBe("exception");
    page = await X.crossingPage(a, c.id);
    expect(page.crossing.requirements.filter((r) => r.code.startsWith("shipment:"))).toHaveLength(4);
    expect((await db.select().from(flags).where(and(eq(flags.orderId, trip.order.id), eq(flags.code, "shipment_held")))).length).toBe(1);
    // each remaining shipment's paperwork on the crossing, then the rest of the packet
    for (const sh of [s1, s2, s3, s5]) await X.uploadDocument(a, c.id, { code: `shipment:${sh.id}`, fileName: `inv-${sh.orderNumber}.pdf`, mimeType: "application/pdf", bytes: pdf, extract: false });
    page = await X.crossingPage(a, c.id);
    expect(page.crossing.requirements.filter((r) => r.code.startsWith("shipment:")).every((r) => r.status === "present")).toBe(true);
    // the crossing itself: our unit, the B-1 team, the usual documents
    const xLeg = trip.legs[1].id;
    await planLeg(a, xLeg, { kind: "truck", truckId: f.t2117, driverId: f.benjamin }, { plannedMiles: 20 });
    await T.releaseShipment(a, s4.id); // paperwork arrived: it crosses after all
    page = await X.crossingPage(a, c.id);
    expect(page.crossing.requirements.filter((r) => r.code.startsWith("shipment:"))).toHaveLength(5);
    await X.uploadDocument(a, c.id, { code: `shipment:${s4.id}`, fileName: "inv-4.pdf", mimeType: "application/pdf", bytes: pdf, extract: false });
    const manifest = await T.manifestPdf(a, trip.order.id);
    expect((await PDFDocument.load(manifest)).getPageCount()).toBeGreaterThanOrEqual(1);

    // deconsolidate: the MX leg delivers Monterrey then Saltillo; shipments deliver stop by stop
    const mxLeg = trip.legs[2].id; // beyond the border zone: brown plates cannot go, a Mexican carrier takes it
    await expect(planLeg(a, mxLeg, { kind: "truck", truckId: f.t2117, driverId: f.benjamin })).rejects.toThrow(/brown plates/);
    await planLeg(a, mxLeg, { kind: "carrier", carrierId: f.garza, carrierRateCents: 60000 });
    await dispatchLeg(a, xLeg);
    await acceptLeg(a, xLeg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"] as const) await advanceLeg(a, xLeg, st);
    await advanceLeg(a, xLeg, "completed");
    await dispatchLeg(a, mxLeg);
    await acceptLeg(a, mxLeg, "carrier");
    await advanceLeg(a, mxLeg, "en_route_to_pickup", { source: "carrier" });
    await advanceLeg(a, mxLeg, "at_pickup", { source: "carrier" });
    await advanceLeg(a, mxLeg, "loaded", { source: "carrier" });
    await advanceLeg(a, mxLeg, "en_route", { source: "carrier" });
    await db.update(stops).set({ arrivedAt: new Date(), departedAt: new Date() }).where(eq(stops.id, mty.id)); // Monterrey: three off
    await db.transaction((tx) => T.syncShipmentStates(tx, a, trip.order.id));
    expect((await getOrder(a, s1.id)).order.state).toBe("delivered");
    expect((await getOrder(a, s2.id)).order.state).toBe("in_transit"); // Saltillo still ahead
    await advanceLeg(a, mxLeg, "at_delivery", { source: "carrier" });
    await advanceLeg(a, mxLeg, "completed", { source: "carrier" });
    expect((await getOrder(a, trip.order.id)).order.state).toBe("delivered");
    await B.syncCarrierBills(a);
    for (const sh of [s1, s2, s3, s4, s5]) expect((await getOrder(a, sh.id)).order.state).toBe("delivered");

    // five invoices, one per shipment, each with its own rate; the trip itself never bills
    for (const sh of [s1, s2, s4]) await B.uploadOrderDocument(a, sh.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    const queue = await B.billingQueue(a);
    expect(queue.map((q) => q.order.orderNumber).sort()).toEqual([s1, s2, s3, s4, s5].map((x) => x.orderNumber).sort());
    expect(queue.find((q) => q.order.id === s5.id)?.docsComplete).toBe(false); // Magna wants a POD
    await B.uploadOrderDocument(a, s5.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    const invoices = [];
    for (const sh of [s1, s2, s3, s4, s5]) invoices.push(await B.issueInvoice(a, (await B.createInvoice(a, [sh.id])).id));
    expect(invoices.map((i) => i.totalCents)).toEqual([120000, 90000, 60000, 50000, 40000]);
    expect(new Set(invoices.map((i) => i.number)).size).toBe(5);

    // one settlement for the team's week carries the trip's legs; margin per shipment by weight share
    const { start, end } = B.weekOf(new Date());
    let st = await B.buildSettlement(a, f.benjamin, start, end);
    expect(st.lines.filter((l) => l.kind === "leg")).toHaveLength(1); // the crossing; the MX leg is the carrier's
    st = await B.settlementTransition(a, st.id, "reviewed");
    await B.settlementTransition(a, st.id, "approved");
    let st2 = await B.buildSettlement(a, f.martin, start, end);
    st2 = await B.settlementTransition(a, st2.id, "reviewed");
    await B.settlementTransition(a, st2.id, "approved");
    const pnl1 = await B.orderPnl(a, s1.id);
    expect(pnl1.share).toBeCloseTo(12000 / 42000, 5);
    const tripMiles = 1500 + 20; // our trucks' legs; the carrier's leg is its bill
    const tripFuel = tripMiles * 50;
    const tripPay = 1500 * 62 + 20 * 60;
    const carrier = 60000;
    expect(pnl1.fuel).toBe(Math.round(tripFuel * (12000 / 42000)));
    expect(pnl1.driverPay).toBe(Math.round(tripPay * (12000 / 42000)));
    expect(pnl1.carrierCost).toBe(Math.round(carrier * (12000 / 42000)));
    expect(pnl1.margin).toBe(120000 - pnl1.driverPay - pnl1.fuel - pnl1.carrierCost);
    const shares = await T.costShares(a, trip.order.id);
    expect([...shares.values()].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    // the trip page and the reports see five loads, all revenue, the costs once
    const tp = await T.tripPage(a, trip.order.id);
    expect(tp.shipments.filter((x) => x.invoice)).toHaveLength(5);
    expect(tp.shipments.filter((x) => x.pod)).toHaveLength(4); // Toyota did not need one
    const period = { from: zonedDate(new Date(Date.now() - 2 * 86400_000), "America/Detroit"), to: zonedDate(new Date(Date.now() + 86400_000), "America/Detroit") };
    const dash = await R.dashboard(a, period);
    expect(dash.loads).toBe(5);
    expect(dash.revenueCents).toBe(360000);
    expect(Math.abs(dash.marginCents - (360000 - tripFuel - tripPay - carrier))).toBeLessThanOrEqual(3); // rounding across five shares
    const byTruck = await R.breakdown(a, "truck", period);
    expect(byTruck).toHaveLength(1);
    expect(byTruck[0].loads).toBe(5);
    expect(byTruck[0].revenueCents).toBe(360000);
    expect(Math.abs(byTruck[0].costCents - (tripFuel + tripPay + carrier))).toBeLessThanOrEqual(3);
    expect((await T.listTrips(a))[0]).toMatchObject({ shipments: 5, revenueCents: 360000, weightLbs: 42000, from: "Canton dock", to: "Saltillo plant" });
  });

  it("remove a shipment before it is on the truck; hold rules; a shipment can only be held while it can move", async () => {
    const trip = await T.createTrip(a, { stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] });
    const [pa, pb] = trip.stops;
    const s1 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 1000, pickupStopId: pa.id, deliveryStopId: pb.id, weightLbs: 100, linearFt: 4 });
    const s2 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 1000, pickupStopId: pa.id, deliveryStopId: pb.id, weightLbs: 100, linearFt: 4 });
    await expect(T.removeShipment(a, s1.id, "")).rejects.toBeInstanceOf(ValidationError);
    await T.removeShipment(a, s1.id, "customer pulled it");
    expect((await getOrder(a, s1.id)).order.state).toBe("cancelled");
    expect((await T.tripShipments(a, trip.order.id)).find((x) => x.id === s2.id)?.loadSeq).toBe(1);
    await expect(T.holdShipment(a, s1.id, "x")).rejects.toThrow(/cannot be held/);
    const [row] = await db.select().from(orders).where(eq(orders.id, s2.id));
    expect(row.loadSeq).toBe(1);
  });

  it("a stop in between is clocked (arrived, then left) before the delivery; the shipment picked there goes in transit when the truck leaves it", async () => {
    const trip = await T.createTrip(a, { stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "pickup", name: "Toledo", country: "US" }, { type: "delivery", name: "Laredo", country: "US" }] });
    const [canton, toledo, laredo] = trip.stops;
    const s1 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 1000, pickupStopId: canton.id, deliveryStopId: laredo.id, weightLbs: 100, linearFt: 4 });
    const s2 = await T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 900, pickupStopId: toledo.id, deliveryStopId: laredo.id, weightLbs: 100, linearFt: 4 });
    await T.bookTrip(a, trip.order.id);
    const leg = trip.legs[0];
    await planLeg(a, leg.id, { kind: "truck", truckId: f.t2117, driverId: f.martin });
    await dispatchLeg(a, leg.id);
    await acceptLeg(a, leg.id);
    // too early: the truck is not en route yet
    await expect(stampStop(a, leg.id, toledo.id, "arrived")).rejects.toThrow(/en route/);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, leg.id, st, { source: "driver_app" });
    expect((await getOrder(a, s1.id)).order.state).toBe("in_transit");
    expect((await getOrder(a, s2.id)).order.state).toBe("dispatched"); // still waiting at Toledo
    // "next" while en route clocks Toledo instead of the delivery
    const stopsNow = () => db.select().from(stops).where(eq(stops.orderId, trip.order.id)).orderBy(stops.seq);
    expect(pendingMidStop({ ...leg, state: "en_route" }, await stopsNow())).toMatchObject({ which: "arrived", stop: { name: "Toledo" } });
    await advanceLeg(a, leg.id, "next", { source: "driver_app" });
    let now = await stopsNow();
    expect(now[1].arrivedAt).toBeTruthy();
    expect(now[1].departedAt).toBeNull();
    expect((await getOrder(a, trip.order.id)).legs[0].state).toBe("en_route");
    await expect(stampStop(a, leg.id, toledo.id, "arrived")).rejects.toThrow(/already arrived/);
    await advanceLeg(a, leg.id, "next", { source: "driver_app" }); // left Toledo
    now = await stopsNow();
    expect(now[1].departedAt).toBeTruthy();
    expect((await getOrder(a, s2.id)).order.state).toBe("in_transit");
    expect(pendingMidStop({ ...leg, state: "en_route" }, now)).toBeNull();
    // the next "next" is the delivery
    await advanceLeg(a, leg.id, "next", { source: "driver_app" });
    expect((await getOrder(a, trip.order.id)).legs[0].state).toBe("at_delivery");
    await advanceLeg(a, leg.id, "next", { source: "driver_app" });
    expect((await getOrder(a, s1.id)).order.state).toBe("delivered");
    expect((await getOrder(a, s2.id)).order.state).toBe("delivered");
    // the shipment's own stop copies carry Toledo's clocks
    const own = await db.select().from(stops).where(eq(stops.orderId, s2.id)).orderBy(stops.seq);
    expect(own[0].arrivedAt?.getTime()).toBe(now[1].arrivedAt?.getTime());
    expect(own[0].departedAt?.getTime()).toBe(now[1].departedAt?.getTime());
  });

  it("a POD photo from the driver app at a trip stop lands on every shipment getting off there, and nowhere a shipment isn't", async () => {
    const { driverUploadPhoto, driverToday } = await import("./tracking");
    const { documents } = await import("@/db/schema");
    const trip = await T.createTrip(a, { stops: [{ type: "pickup", name: "Canton", country: "US" }, { type: "delivery", name: "Toledo", country: "US" }, { type: "delivery", name: "Laredo", country: "US" }] });
    const [canton, toledo, laredo] = trip.stops;
    const s1 = await T.addShipment(a, trip.order.id, { customerId: f.rxo, rateCents: 1000, pickupStopId: canton.id, deliveryStopId: laredo.id, weightLbs: 100, linearFt: 4 });
    const s2 = await T.addShipment(a, trip.order.id, { customerId: f.magna, rateCents: 900, pickupStopId: canton.id, deliveryStopId: toledo.id, weightLbs: 100, linearFt: 4 });
    const s3 = await T.addShipment(a, trip.order.id, { customerId: f.toyota, rateCents: 800, pickupStopId: canton.id, deliveryStopId: toledo.id, weightLbs: 100, linearFt: 4 });
    await T.bookTrip(a, trip.order.id);
    const leg = trip.legs[0];
    await planLeg(a, leg.id, { kind: "truck", truckId: f.t2117, driverId: f.martin });
    await dispatchLeg(a, leg.id);
    await acceptLeg(a, leg.id);
    const jpg = Buffer.from("jpg fixture");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, leg.id, st, { source: "driver_app" });
    await advanceLeg(a, leg.id, "next", { source: "driver_app" }); // arrived Toledo
    let today = await driverToday(a.tenantId, f.martin);
    expect(today.current!.docs.pod).toBe(false);
    const rows = await driverUploadPhoto(a.tenantId, f.martin, leg.id, { code: "POD", fileName: "toledo.jpg", mimeType: "image/jpeg", bytes: jpg });
    expect(rows.map((r) => r.subjectId).sort()).toEqual([s2.id, s3.id].sort());
    today = await driverToday(a.tenantId, f.martin);
    expect(today.current!.docs.pod).toBe(true); // both Toledo shipments have one
    await advanceLeg(a, leg.id, "next", { source: "driver_app" }); // left Toledo
    await expect(driverUploadPhoto(a.tenantId, f.martin, leg.id, { code: "POD", fileName: "x.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toThrow(/arrived at the delivery/);
    await advanceLeg(a, leg.id, "next", { source: "driver_app" }); // at Laredo
    today = await driverToday(a.tenantId, f.martin);
    expect(today.current!.docs.pod).toBe(false); // Laredo's shipment has none yet
    await driverUploadPhoto(a.tenantId, f.martin, leg.id, { code: "POD", fileName: "laredo.jpg", mimeType: "image/jpeg", bytes: jpg });
    const pods = await db.select({ subjectId: documents.subjectId, fileName: documents.fileName }).from(documents).where(eq(documents.code, "POD"));
    expect(pods.find((p) => p.subjectId === s1.id)!.fileName).toBe("laredo.jpg");
    expect(pods.filter((p) => p.subjectId === trip.order.id).length).toBe(0); // never on the trip itself: trips don't bill
    // the POD gate for billing is satisfied per shipment
    await advanceLeg(a, leg.id, "next", { source: "driver_app" });
    const { billingQueue } = await import("./billing");
    const q = await billingQueue(a);
    expect(q.filter((r) => r.docsComplete).map((r) => r.order.id).sort()).toEqual([s1.id, s2.id, s3.id].sort());
  });
});
