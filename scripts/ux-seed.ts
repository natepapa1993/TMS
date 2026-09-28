/**
 * UX review data: a fictional cross-border carrier with a realistic week — loads in every stage, trucks
 * and drivers (some paperwork expiring), partner carriers, invoices, fuel. For local review only; never
 * run against production. Usage: tsx scripts/ux-seed.ts <tag> (creates owner@<tag>.test, dispatch@…,
 * billing@…, safety@… with password "Review-2026!").
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  if (/railway|rlwy|amazonaws/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to seed a hosted database");
  const tag = process.argv[2] ?? "review";
  const { db } = await import("@/db/client");
  const s = await import("@/db/schema");
  const { createTenantWithOwner, hashPassword } = await import("@/lib/auth");
  const { newId } = await import("@/lib/ids");
  const { create } = await import("@/data/records");
  const O = await import("@/domain/orders");
  const B = await import("@/domain/billing");
  const { recordPosition } = await import("@/domain/tracking");
  const { saveIncident, evaluateAll } = await import("@/domain/compliance");
  const { addFuelPurchase } = await import("@/domain/ifta");
  const { PDFDocument, StandardFonts } = await import("pdf-lib");

  const pw = "Review-2026!";
  const { tenantId, userId } = await createTenantWithOwner({ tenantName: `Rio Bravo Test Freight (${tag})`, slug: `rbt-${tag}-${Date.now().toString(36)}`, ownerName: "Olivia Owner", email: `owner@${tag}.test`, password: pw, timeZone: "America/Chicago" });
  for (const [role, name, email] of [["dispatcher", "Diego Dispatch", `dispatch@${tag}.test`], ["billing", "Bianca Billing", `billing@${tag}.test`], ["compliance", "Sam Safety", `safety@${tag}.test`]] as const)
    await db.insert(s.users).values({ id: newId(), tenantId, email, name, role, passwordHash: await hashPassword(pw), createdBy: userId, updatedBy: userId });
  const a = { tenantId, userId, role: "owner" as const };
  const day = 86400_000;
  const now = Date.now();
  const future = (d: number) => new Date(now + d * day);

  const pdfDoc = async (title: string) => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([612, 792]).drawText(title, { x: 60, y: 700, size: 18, font: f });
    return Buffer.from(await d.save());
  };

  // ---- company
  await create(a, "billingEntity", { legalName: "Rio Bravo Test Freight LLC", dba: "Rio Bravo Test", country: "US", invoicePrefix: "RBT", nextInvoiceNumber: 1001, isDefault: true, taxId: "00-0000000", mcNumber: "000000", dotNumber: "0000000", remitTo: { line1: "100 Test Yard Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" } });
  const loc = async (name: string, kind: string, country: string, city: string, state: string, lat: number, lng: number) => (await create(a, "location", { name, kind, country, address: { city, state, country }, lat: String(lat), lng: String(lng) })).id;
  const L = {
    yardLRD: await loc("Laredo Yard (test)", "yard", "US", "Laredo", "TX", 27.5306, -99.4803),
    borderNLD: await loc("Nuevo Laredo Border Yard (test)", "border_yard", "MX", "Nuevo Laredo", "TAMPS", 27.4764, -99.5164),
    mty: await loc("Planta Apodaca (test)", "customer", "MX", "Apodaca", "NL", 25.7817, -100.1886),
    saltillo: await loc("Saltillo Assembly (test)", "customer", "MX", "Ramos Arizpe", "COAH", 25.5428, -100.9737),
    dallas: await loc("Dallas DC (test)", "customer", "US", "Dallas", "TX", 32.7767, -96.797),
    sa: await loc("San Antonio Plant (test)", "customer", "US", "San Antonio", "TX", 29.4241, -98.4936),
    detroit: await loc("Detroit Warehouse (test)", "customer", "US", "Detroit", "MI", 42.3314, -83.0458),
    toronto: await loc("Mississauga DC (test)", "customer", "CA", "Mississauga", "ON", 43.589, -79.6441),
    chicago: await loc("Joliet Crossdock (test)", "customer", "US", "Joliet", "IL", 41.525, -88.0817),
  };

  const cust = async (name: string, kind: string, email: string, extra: Record<string, unknown> = {}) => (await create(a, "customer", { name, kind, country: "US", billingEmail: email, termsDays: 30, ...extra })).id;
  const C = {
    acme: await cust("Acme Test Logistics", "broker", "ap@acme-logistics.test", { requiredDocs: ["POD", "RATE_CON"], requiredRefs: ["PO"] }),
    north: await cust("Northstar Test Brokerage", "broker", "billing@northstar.test", { requiredDocs: ["POD"], invoiceMode: "summary" }),
    auto: await cust("Autopartes Test SA de CV", "customer", "cxp@autopartes.test", { requiredDocs: ["POD", "BOL"], country: "MX" }),
    fresh: await cust("Fresh Test Produce", "customer", "ap@freshtest.test", { requiredDocs: ["POD"], invoiceDelivery: "portal", portalUrl: "https://portal.freshtest.test" }),
  };
  const carrier = async (name: string, country: string, kind: string) => (await create(a, "carrier", { name, country, kind, dispatchEmail: `dispatch@${name.split(" ")[0].toLowerCase()}.test`, caatExpires: future(200) })).id;
  const K = { mx: await carrier("Transportes Test del Norte", "MX", "mx"), us: await carrier("Lone Test Star Freight", "US", "us"), xing: await carrier("Puente Test Drayage", "MX", "crossing") };

  const truck = async (unit: string, extra: Record<string, unknown> = {}) => (await create(a, "truck", { unitNumber: unit, usPlate: `TX${unit}`, usPlateExpires: future(300), mxPlate: `MX${unit}`, year: 2022, make: "Freightliner", model: "Cascadia", ...extra })).id;
  const T = { t101: await truck("101"), t102: await truck("102"), t103: await truck("103"), t104: await truck("104", { usPlateExpires: future(9) }), t105: await truck("105"), t106: await truck("106"), t107: await truck("107") };
  const trailer = async (unit: string) => (await create(a, "trailer", { unitNumber: unit, kind: "53_dry", lengthFt: 53, usPlate: `TR${unit}` })).id;
  const R = { r1: await trailer("5301"), r2: await trailer("5302"), r3: await trailer("5303"), r4: await trailer("5304") };
  let phoneSeq = 100; // one phone per driver: WhatsApp replies are matched by number
  const driver = async (name: string, truckId: string | null, extra: Record<string, unknown> = {}) => (await create(a, "driver", { name, driverType: "CDL", phone: `+1 956 555 0${phoneSeq++}`, licenseExpires: future(400), medicalExpires: future(300), currentTruckId: truckId, payType: "per_mile", payRateCents: 62, ...extra })).id;
  const D = {
    daniel: await driver("Daniel Test Reyes", T.t101),
    maria: await driver("Maria Test Lopez", T.t102),
    jose: await driver("Jose Test Garcia", T.t103, { medicalExpires: future(12) }),
    luis: await driver("Luis Test Hernandez", T.t104),
    ana: await driver("Ana Test Cruz", T.t105, { licenseExpires: future(-3) }),
    carlos: await driver("Carlos Test Vega", T.t107),
    pedro: await driver("Pedro Test Ramirez", T.t106, { driverType: "B1", visaType: "B1", mxLicenseNumber: "MXL-0001", mxLicenseExpires: future(200) }),
  };

  // ---- loads
  const made: { num: string; state: string }[] = [];
  type St = { type: "pickup" | "delivery" | "border_yard" | "yard"; name: string; locationId: string; country: string; windowStart?: Date };
  const st = (type: St["type"], id: string, name: string, country: string, windowStart?: Date): St => ({ type, name, locationId: id, country, windowStart });
  const walk = async (legId: string, to: "dispatched" | "in_transit" | "completed", t0: number) => {
    await O.dispatchLeg(a, legId);
    if (to === "dispatched") return;
    await O.acceptLeg(a, legId);
    const at = (h: number) => new Date(t0 + h * 3600_000);
    await O.advanceLeg(a, legId, "en_route_to_pickup", { at: at(0) });
    await O.advanceLeg(a, legId, "at_pickup", { at: at(1) });
    await O.advanceLeg(a, legId, "loaded", { at: at(3) });
    await O.advanceLeg(a, legId, "en_route", { at: at(3.2) });
    if (to === "in_transit") return;
    await O.advanceLeg(a, legId, "at_delivery", { at: at(9) });
    await O.advanceLeg(a, legId, "completed", { at: at(10) });
  };
  const load = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`[seed] ${label}: ${(e as Error).message}`);
    }
  };
  const truckFor = (t: string, d: string, r?: string) => ({ kind: "truck" as const, truckId: t, driverId: d, trailerId: r ?? null });
  const ov = { override: true, reason: "seed data" };

  // 5 open loads waiting for trucks (today / tomorrow)
  for (const [i, [cid, from, to, rate]] of ([[C.acme, L.yardLRD, L.dallas, 180000], [C.north, L.sa, L.detroit, 420000], [C.fresh, L.yardLRD, L.chicago, 360000], [C.acme, L.dallas, L.sa, 95000], [C.north, L.detroit, L.toronto, 150000]] as const).entries()) {
    await load(`open ${i}`, async () => {
      const names: Record<string, [string, string]> = { [L.yardLRD]: ["Laredo Yard (test)", "US"], [L.dallas]: ["Dallas DC (test)", "US"], [L.sa]: ["San Antonio Plant (test)", "US"], [L.detroit]: ["Detroit Warehouse (test)", "US"], [L.chicago]: ["Joliet Crossdock (test)", "US"], [L.toronto]: ["Mississauga DC (test)", "CA"] };
      const o = await O.createOrder(a, { customerId: cid, rateCents: rate, refs: { po: `PO-${4400 + i}`, reference: `LD${88100 + i}` }, freight: [{ commodity: "Auto parts", pieces: 22, weightLb: 38000 }], stops: [st("pickup", from, names[from][0], names[from][1], future(i < 2 ? 0.3 : 1)), st("delivery", to, names[to][0], names[to][1], future(i < 2 ? 1.5 : 2.5))], book: true });
      made.push({ num: o.order.orderNumber, state: "open" });
    });
  }
  // a draft load
  await load("draft", async () => {
    const o = await O.createOrder(a, { customerId: C.auto, rateCents: null, rateTbd: true, stops: [st("pickup", L.saltillo, "Saltillo Assembly (test)", "MX"), st("delivery", L.dallas, "Dallas DC (test)", "US")] });
    made.push({ num: o.order.orderNumber, state: "draft" });
  });

  // cross-border loads MX → US: MX leg by partner carrier, crossing, US leg on our truck
  const xb = async (i: number, stage: "dispatched" | "in_transit" | "completed") =>
    load(`xborder ${i}`, async () => {
      const o = await O.createOrder(a, { customerId: C.auto, rateCents: 285000, refs: { po: `AP-77${i}`, reference: `MX${5500 + i}` }, freight: [{ commodity: "Wire harnesses", pieces: 26, weightLb: 31000 }], stops: [st("pickup", L.mty, "Planta Apodaca (test)", "MX", future(-1)), st("border_yard", L.borderNLD, "Nuevo Laredo Border Yard (test)", "MX"), st("yard", L.yardLRD, "Laredo Yard (test)", "US"), st("delivery", L.sa, "San Antonio Plant (test)", "US", future(1))], book: true });
      const [mx, crossing, us] = o.legs;
      await O.planLeg(a, mx.id, { kind: "carrier", carrierId: K.mx, carrierRateCents: 45000 }, { ...ov, plannedMiles: 150 });
      await walk(mx.id, stage === "dispatched" ? "in_transit" : "completed", now - 2 * day);
      if (stage === "dispatched") {
        made.push({ num: o.order.orderNumber, state: "MX leg rolling" });
        return;
      }
      await O.planLeg(a, crossing.id, { kind: "carrier", carrierId: K.xing, carrierRateCents: 25000 }, { ...ov, plannedMiles: 8 });
      await walk(crossing.id, "completed", now - 1.5 * day);
      await O.planLeg(a, us.id, truckFor(i % 2 ? T.t101 : T.t102, i % 2 ? D.daniel : D.maria, R.r1), { ...ov, plannedMiles: 157 });
      await walk(us.id, stage, now - day);
      made.push({ num: o.order.orderNumber, state: `cross-border ${stage}` });
    });
  await xb(1, "dispatched");
  await xb(2, "in_transit");
  await xb(3, "completed");

  // US loads in transit with GPS pings
  const lanes: [string, string, string, string, number, string, string][] = [
    [C.acme, L.yardLRD, "Laredo Yard (test)", L.dallas, 430, T.t103, D.jose],
    [C.north, L.sa, "San Antonio Plant (test)", L.detroit, 1560, T.t107, D.carlos],
  ];
  for (const [i, [cid, from, fromName, to, miles, t, d]] of lanes.entries()) {
    await load(`transit ${i}`, async () => {
      const toName = to === L.dallas ? "Dallas DC (test)" : "Detroit Warehouse (test)";
      const o = await O.createOrder(a, { customerId: cid, rateCents: miles * 260, refs: { po: `PO-55${i}` }, stops: [st("pickup", from, fromName, "US", future(-0.5)), st("delivery", to, toName, "US", future(1))], book: true });
      await O.planLeg(a, o.legs[0].id, truckFor(t, d, R.r2), { ...ov, plannedMiles: miles });
      await walk(o.legs[0].id, "in_transit", now - 8 * 3600_000);
      const [fl, fg] = from === L.yardLRD ? [27.5306, -99.4803] : [29.4241, -98.4936];
      const [tl, tg] = to === L.dallas ? [32.7767, -96.797] : [42.3314, -83.0458];
      for (let k = 0; k <= 6; k++) await recordPosition(a, { source: "driver_app", at: new Date(now - (6 - k) * 3600_000), lat: fl + ((tl - fl) * k) / 14, lng: fg + ((tg - fg) * k) / 14, truckId: t, driverId: d, legId: o.legs[0].id, speedMph: 62 });
      made.push({ num: o.order.orderNumber, state: "in transit" });
    });
  }
  // dispatched, not yet rolling
  await load("dispatched", async () => {
    const o = await O.createOrder(a, { customerId: C.fresh, rateCents: 210000, refs: { po: "FR-9001" }, stops: [st("pickup", L.yardLRD, "Laredo Yard (test)", "US", future(0.2)), st("delivery", L.chicago, "Joliet Crossdock (test)", "US", future(2))], book: true });
    await O.planLeg(a, o.legs[0].id, truckFor(T.t104, D.luis, R.r3), { ...ov, plannedMiles: 1250 });
    await walk(o.legs[0].id, "dispatched", now);
    made.push({ num: o.order.orderNumber, state: "dispatched" });
  });

  // delivered loads for billing: some complete, some missing paperwork
  const delivered: string[] = [];
  for (let i = 0; i < 6; i++) {
    await load(`delivered ${i}`, async () => {
      const cid = [C.acme, C.north, C.north, C.fresh, C.acme, C.north][i];
      const o = await O.createOrder(a, { customerId: cid, rateCents: [180000, 150000, 165000, 240000, 175000, 90000][i], refs: { po: `PO-66${i}`, reference: `LD9${i}000` }, stops: [st("pickup", L.yardLRD, "Laredo Yard (test)", "US", future(-4 + i * 0.3)), st("delivery", L.dallas, "Dallas DC (test)", "US")], book: true });
      await O.planLeg(a, o.legs[0].id, truckFor([T.t101, T.t102, T.t103, T.t107, T.t101, T.t102][i], [D.daniel, D.maria, D.jose, D.carlos, D.daniel, D.maria][i]), { ...ov, plannedMiles: 430 });
      await walk(o.legs[0].id, "completed", now - (4 - i * 0.4) * day);
      if (i !== 4) await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: `POD ${o.order.orderNumber}.pdf`, mimeType: "application/pdf", bytes: await pdfDoc(`POD ${o.order.orderNumber}`) });
      if (i === 0 || i === 5) await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: `Rate con ${o.order.orderNumber}.pdf`, mimeType: "application/pdf", bytes: await pdfDoc(`Rate confirmation ${o.order.orderNumber}`) });
      delivered.push(o.order.id);
      made.push({ num: o.order.orderNumber, state: i === 4 ? "delivered, no POD" : "delivered" });
    });
  }
  // two invoiced (one paid), one partner-carrier load delivered (carrier bill)
  await load("invoiced", async () => {
    const inv = await B.createInvoice(a, [delivered[0]]);
    await B.issueInvoice(a, inv.id, { issuedAt: new Date(now - 40 * day) });
    await B.sendInvoice(a, inv.id);
  });
  await load("paid", async () => {
    const inv = await B.createInvoice(a, [delivered[3]]);
    const iss = await B.issueInvoice(a, inv.id, { issuedAt: new Date(now - 10 * day) });
    await B.recordReceipt(a, inv.id, { amountCents: iss.totalCents, method: "ach", reference: "ACH-TEST-1" });
  });
  await load("carrier load", async () => {
    const o = await O.createOrder(a, { customerId: C.acme, rateCents: 200000, refs: { po: "PO-7700" }, stops: [st("pickup", L.dallas, "Dallas DC (test)", "US", future(-3)), st("delivery", L.chicago, "Joliet Crossdock (test)", "US")], book: true });
    await O.planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: K.us, carrierRateCents: 150000 }, { ...ov, plannedMiles: 920 });
    await walk(o.legs[0].id, "completed", now - 3 * day);
    await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "POD.pdf", mimeType: "application/pdf", bytes: await pdfDoc("POD") });
    made.push({ num: o.order.orderNumber, state: "delivered by partner carrier" });
  });

  // safety & fuel
  await load("incident", async () => {
    await saveIncident(a, null, { occurredAt: new Date(now - 6 * day), kind: "accident", driverId: D.jose, truckId: T.t103, location: "I-35 NB mm 18, Laredo TX", description: "Backing into dock, trailer scraped the post. No injuries.", dotRecordable: false, injuries: false, towAway: false, status: "open" });
  });
  for (const [j, g, dd] of [["TX", 180, 5], ["TX", 150, 12], ["OK", 120, 20], ["MI", 140, 25]] as const)
    await load("fuel", async () => {
      await addFuelPurchase(a, { truckId: T.t101, purchasedAt: new Date(now - dd * day).toISOString().slice(0, 10), jurisdiction: j, gallons: g, amountCents: g * 385 });
    });
  await load("compliance", async () => {
    await evaluateAll(a);
  });

  console.log(JSON.stringify({ tenant: `Rio Bravo Test Freight (${tag})`, password: pw, logins: [`owner@${tag}.test`, `dispatch@${tag}.test`, `billing@${tag}.test`, `safety@${tag}.test`], loads: made }, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
