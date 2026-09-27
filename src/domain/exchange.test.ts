// Features: F-16 carrier-to-carrier exchange — a tender to a partner on Crossline lands on their board; their acceptance, driver, milestones, positions, POD and invoice come back
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { flags, tenders as tendersTable, positions, documents, carrierBills, customers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, advanceLeg, getOrder, board, ValidationError } from "./orders";
import { sendTender, respondToTender, expireTenders } from "./tenders";
import { recordPosition, trackingView } from "./tracking";
import * as B from "./billing";
import * as X from "./exchange";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>; // 24:7 — tenders the MX leg
let b: Awaited<ReturnType<typeof makeTenant>>; // Transportes Garza — a carrier that is also on Crossline
let f: { rxo: string; garza: string; bTruck: string; bDriver: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7 Expedite");
  b = await makeTenant("Transportes Garza");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  await create(b, "billingEntity", { legalName: "Transportes Garza SA de CV", country: "MX", invoicePrefix: "TGZ", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", requiredDocs: [] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "despacho@garza.test", caatExpires: future });
  const bTruck = await create(b, "truck", { unitNumber: "MX-77", mxPlate: "88AB1C", mxPlateClass: "blue", mxPlateExpires: future, usPlate: "TX9", usPlateExpires: future });
  const bDriver = await create(b, "driver", { name: "Pedro Ruiz", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, phone: "+52 81 555 0101", currentTruckId: bTruck.id });
  f = { rxo: rxo.id, garza: garza.id, bTruck: bTruck.id, bDriver: bDriver.id };
});

const mxOrder = () => createOrder(a, { customerId: f.rxo, rateCents: 285000, refs: { po: "4500991" }, stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" }, windowStart: new Date(Date.now() + 86400_000) }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }, { type: "delivery", name: "GM Arlington", country: "US" }], book: true });

describe("linking", () => {
  it("each company has one exchange code; a carrier record links to the partner by it; not to yourself, not to nonsense", async () => {
    const code = await X.exchangeCode(b);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(await X.exchangeCode(b)).toBe(code);
    expect(await X.exchangeCode(a)).not.toBe(code);
    await expect(X.linkCarrier(a, f.garza, "NOPE1234")).rejects.toBeInstanceOf(ValidationError);
    await expect(X.linkCarrier(a, f.garza, await X.exchangeCode(a))).rejects.toThrow(/your own code/);
    const r = await X.linkCarrier(a, f.garza, code.toLowerCase());
    expect(r.partnerName).toBe("Transportes Garza");
    const { get } = await import("@/data/records");
    expect((await get(a, "carrier", f.garza)).exchangeTenantId).toBe(b.tenantId);
    await X.unlinkCarrier(a, f.garza);
    expect((await get(a, "carrier", f.garza)).exchangeTenantId).toBeNull();
  });
});

describe("the load on the partner's board", () => {
  it("a tender to a linked carrier is a draft on their board with the offer; accepting there books it and accepts our tender; driver, milestones, positions, POD and invoice come back", async () => {
    await X.linkCarrier(a, f.garza, await X.exchangeCode(b));
    const o = await mxOrder();
    const mx = o.legs[0].id;
    const t = await sendTender(a, mx, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 120, message: "Ask for gate 3" });
    expect(t.to).toBe("despacho@garza.test"); // the email still goes; the board is on top
    // the partner: a customer for us, a draft order from the tender, the offer flag
    const custs = await db.select().from(customers).where(eq(customers.tenantId, b.tenantId));
    expect(custs.map((c) => [c.name, c.exchangeTenantId])).toEqual([["24:7 Expedite", a.tenantId]]);
    let offers = await X.exchangeOffers(b);
    expect(offers).toHaveLength(1);
    expect(offers[0].title).toBe("Load offer from 24:7 Expedite · USD 450.00");
    expect(offers[0].detail).toContain("Ask for gate 3");
    const theirs = await getOrder(b, offers[0].orderId);
    expect(theirs.order).toMatchObject({ state: "draft", source: "exchange", rateCents: 45000, customerId: custs[0].id, equipment: o.order.equipment });
    expect(theirs.order.refs).toEqual({ reference: `${o.order.orderNumber} leg 1`, po: "4500991" });
    expect(theirs.stops.map((st) => [st.name, st.country, st.type])).toEqual([["Planta Monterrey", "MX", "pickup"], ["Santa Fe", "MX", "border_yard"]]);
    expect(theirs.legs).toHaveLength(1);
    expect(theirs.legs[0].type).toBe("mx");
    expect((await board(b)).find((r) => r.order.id === theirs.order.id)?.openFlags.map((x) => x.code)).toEqual(["exchange_offer"]);
    // nothing of it in a third company
    const c = await makeTenant("Third");
    expect(await X.exchangeOffers(c)).toEqual([]);

    // decline needs a reason; accept books their load and accepts our tender without a driver name yet
    await expect(X.answerOffer(b, theirs.order.id, false, "")).rejects.toBeInstanceOf(ValidationError);
    const ans = await X.answerOffer(b, theirs.order.id, true);
    expect(ans.state).toBe("accepted");
    expect((await getOrder(b, theirs.order.id)).order.state).toBe("booked");
    expect(await X.exchangeOffers(b)).toEqual([]);
    let ours = await getOrder(a, o.order.id);
    expect(ours.legs[0].state).toBe("accepted");
    let [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, t.tender.id));
    expect(tender.state).toBe("accepted");
    expect(tender.driverName).toBe("assigned on Crossline");
    expect(await X.partnerSide(a, t.tender.id)).toMatchObject({ orderNumber: theirs.order.orderNumber, state: "booked", partner: "Transportes Garza" });
    await expect(X.answerOffer(b, theirs.order.id, true)).rejects.toThrow(/already accepted/);

    // they plan their truck and driver: our tender learns who is coming
    const tl = theirs.legs[0].id;
    await planLeg(b, tl, { kind: "truck", truckId: f.bTruck, driverId: f.bDriver });
    [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, t.tender.id));
    expect(tender).toMatchObject({ driverName: "Pedro Ruiz", driverPhone: "+52 81 555 0101", unitNumber: "MX-77" });
    // their milestones move our leg, one clock at a time
    await dispatchLeg(b, tl);
    await advanceLeg(b, tl, "next", { source: "driver_app" }); // accepted
    await advanceLeg(b, tl, "en_route_to_pickup", { source: "driver_app" });
    ours = await getOrder(a, o.order.id);
    expect(ours.legs[0].state).toBe("en_route_to_pickup");
    await advanceLeg(b, tl, "at_pickup", { source: "driver_app", verified: true, lat: "25.68", lng: "-100.31" });
    await advanceLeg(b, tl, "loaded", { source: "driver_app" });
    ours = await getOrder(a, o.order.id);
    expect(ours.legs[0].state).toBe("loaded");
    expect(ours.stops[0].arrivedAt).not.toBeNull();
    expect(ours.stops[0].departedAt).not.toBeNull();
    // their driver's positions are on our leg, for our customer's tracking page
    await recordPosition(b, { source: "driver_app", lat: 26.1, lng: -100.0, truckId: f.bTruck, legId: tl, place: "Carretera 85" });
    const ourPos = await db.select().from(positions).where(and(eq(positions.tenantId, a.tenantId), eq(positions.legId, mx)));
    expect(ourPos.map((p) => [p.source, p.place])).toEqual([["carrier", "Carretera 85"]]);
    expect((await trackingView(a.tenantId, o.order.id)).lastPosition?.place).toBe("Carretera 85");
    await advanceLeg(b, tl, "en_route", { source: "driver_app" });
    await advanceLeg(b, tl, "at_delivery", { source: "driver_app" });
    // their POD is our POD
    await B.uploadOrderDocument(b, theirs.order.id, { code: "POD", fileName: "pod-garza.jpg", mimeType: "image/jpeg", bytes: Buffer.from("jpg") });
    const ourDocs = await db.select().from(documents).where(and(eq(documents.tenantId, a.tenantId), eq(documents.subjectKind, "order"), eq(documents.subjectId, o.order.id)));
    expect(ourDocs.map((d) => [d.code, d.source, d.fileName])).toEqual([["POD", "exchange", "pod-garza.jpg"]]);
    await advanceLeg(b, tl, "completed", { source: "driver_app" });
    ours = await getOrder(a, o.order.id);
    expect(ours.legs[0].state).toBe("completed");
    expect(ours.legs[0].completedAt).not.toBeNull();
    expect((await getOrder(b, theirs.order.id)).order.state).toBe("delivered");
    const evs = (await (await import("./orders")).orderTimeline(a, o.order.id)).events;
    expect(evs.some((e) => e.note?.includes("from Transportes Garza's board"))).toBe(true);
    // their invoice is our carrier bill, received, and the three-way check has the POD
    const inv = await B.createInvoice(b, [theirs.order.id]);
    const issued = await B.issueInvoice(b, inv.id, {});
    const [bill] = await db.select().from(carrierBills).where(and(eq(carrierBills.tenantId, a.tenantId), eq(carrierBills.legId, mx)));
    expect(bill).toMatchObject({ state: "received", invoicedCents: 45000, carrierInvoiceNumber: issued.number, expectedCents: 45000 });
    const chk = await B.threeWay(a, bill.id);
    expect(chk.podPresent).toBe(true);
    expect(chk.invoiced).toBe(45000);
  });

  it("declining on their board sends it back with the reason; answering the emailed link books the mirror too; an expired or replaced tender takes the draft away", async () => {
    await X.linkCarrier(a, f.garza, await X.exchangeCode(b));
    const o = await mxOrder();
    const t1 = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 60 });
    let [offer] = await X.exchangeOffers(b);
    const d = await X.answerOffer(b, offer.orderId, false, "no unit tomorrow");
    expect(d.state).toBe("declined");
    expect((await getOrder(b, offer.orderId)).order.state).toBe("cancelled");
    const ours = await getOrder(a, o.order.id);
    expect(ours.legs[0].state).toBe("declined");
    const fl = await db.select().from(flags).where(and(eq(flags.tenantId, a.tenantId), eq(flags.legId, o.legs[0].id)));
    expect(fl.some((x) => x.title.includes("no unit tomorrow") || (x.detail ?? "").includes("no unit tomorrow"))).toBe(true);
    // re-tender: the old mirror is gone (cancelled), a new draft appears; answer it through the emailed link this time
    const t2 = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 47000, expiresInMinutes: 60 });
    expect(t2.tender.id).not.toBe(t1.tender.id);
    [offer] = await X.exchangeOffers(b);
    expect(offer.rateCents).toBe(47000);
    await respondToTender(t2.tender.token, { accept: true, name: "Luis", driverName: "Pedro Ruiz" });
    expect((await getOrder(b, offer.orderId)).order.state).toBe("booked");
    expect(await X.exchangeOffers(b)).toEqual([]);
    // a third tender on another order, left to expire: the draft goes away with it
    const o2 = await mxOrder();
    await sendTender(a, o2.legs[0].id, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 5 });
    const [offer3] = await X.exchangeOffers(b);
    expect((await expireTenders(new Date(Date.now() + 10 * 60_000))).expired).toBe(1);
    expect((await getOrder(b, offer3.orderId)).order.state).toBe("cancelled");
    expect(await X.exchangeOffers(b)).toEqual([]);
    // and a replaced tender (a second offer on the same leg) withdraws the first draft
    const o3 = await mxOrder();
    await sendTender(a, o3.legs[0].id, { carrierId: f.garza, rateCents: 40000, expiresInMinutes: 60 });
    const [first] = await X.exchangeOffers(b);
    await sendTender(a, o3.legs[0].id, { carrierId: f.garza, rateCents: 42000, expiresInMinutes: 60 });
    expect((await getOrder(b, first.orderId)).order.state).toBe("cancelled");
    const now = await X.exchangeOffers(b);
    expect(now).toHaveLength(1);
    expect(now[0].rateCents).toBe(42000);
  });

  it("impliedState maps the partner's legs onto our single leg", () => {
    const st = (states: string[], order = "in_transit") => X.impliedState(states.map((s, i) => ({ seq: i + 1, state: s as never })), order);
    expect(st(["planned"])).toBeNull();
    expect(st(["en_route_to_pickup"])).toBe("en_route_to_pickup");
    expect(st(["at_pickup"])).toBe("at_pickup");
    expect(st(["loaded"])).toBe("loaded");
    expect(st(["en_route"])).toBe("en_route");
    expect(st(["at_delivery"])).toBe("at_delivery");
    expect(st(["completed"], "delivered")).toBe("completed");
    expect(st(["completed", "planned", "planned"])).toBe("en_route"); // first leg done, more to go: to us it is moving
    expect(st(["completed", "en_route", "planned"])).toBe("en_route");
    expect(st(["completed", "completed", "at_delivery"])).toBe("at_delivery");
    expect(st(["completed", "completed", "completed"], "delivered")).toBe("completed");
  });
});
