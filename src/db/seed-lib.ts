import { db } from "./client";
import { users } from "./schema";
import { eq } from "drizzle-orm";
import { createTenantWithOwner } from "@/lib/auth";
import { create } from "@/data/records";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "@/domain/orders";
import type { Ctx } from "@/lib/context";

/**
 * Demo tenant for the first open (spec §10 "day-one" data). Idempotent: skips if the tenant exists.
 * Sign in: demo@crossline.local / crossline-demo-2026
 */
const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@crossline.local";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "crossline-demo-2026";
const days = (n: number) => new Date(Date.now() + n * 86400_000);

export async function seedDemo(): Promise<"created" | "exists"> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing) {
    console.log(`seed: ${DEMO_EMAIL} already exists, nothing to do`);
    return "exists";
  }
  const { tenantId, userId } = await createTenantWithOwner({ tenantName: "Demo Carrier", slug: "demo", ownerName: "Demo Owner", email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const ctx: Ctx = { tenantId, userId, role: "owner" };

  const entity = await create(ctx, "billingEntity", { legalName: "Demo Carrier LLC", country: "US", invoicePrefix: "DC", isDefault: true, terms: "Net 30", taxId: "00-0000000" });
  const port = await create(ctx, "port", { name: "Laredo / Nuevo Laredo", usCity: "Laredo", usState: "TX", mxCity: "Nuevo Laredo", mxState: "TAMPS", bridges: [{ name: "World Trade Bridge", fast: true }, { name: "Colombia Solidarity Bridge", fast: true }] });
  await create(ctx, "location", { name: "Laredo Yard", kind: "yard", country: "US", address: { line1: "1 Yard Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" }, portId: port.id });
  await create(ctx, "location", { name: "Santa Fe Yard", kind: "border_yard", country: "MX", address: { line1: "Blvd. Santa Fe", city: "Nuevo Laredo", state: "TAMPS", country: "MX" }, portId: port.id });
  await create(ctx, "location", { name: "Planta Monterrey", kind: "shipper", country: "MX", address: { line1: "Av. Industrial 100", city: "Apodaca", state: "NL", country: "MX" } });
  await create(ctx, "location", { name: "GM Arlington", kind: "consignee", country: "US", address: { line1: "2525 E Abram St", city: "Arlington", state: "TX", postalCode: "76010", country: "US" } });

  const t2117 = await create(ctx, "truck", { unitNumber: "2117", usPlate: "RC59022", usPlateState: "TX", usPlateExpires: days(200), mxPlate: "35ES3A", mxPlateClass: "brown", mxPlateExpires: days(150), entityId: entity.id, dotInspectionExpires: days(90), eldProvider: "Motive" });
  const t2109 = await create(ctx, "truck", { unitNumber: "2109", usPlate: "TX2109", usPlateState: "TX", usPlateExpires: days(300), mxPlate: "MX2109", mxPlateClass: "blue", mxPlateExpires: days(300), entityId: entity.id, dotInspectionExpires: days(20), eldProvider: "Motive" });
  const t2104 = await create(ctx, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateState: "TX", usPlateExpires: days(300), entityId: entity.id, dotInspectionExpires: days(250), eldProvider: "Motive" });
  await create(ctx, "truck", { unitNumber: "2121", usPlate: "TX2121", usPlateState: "TX", usPlateExpires: days(300), mxPlate: "MX2121", mxPlateClass: "brown", mxPlateExpires: days(300), status: "oos", oosReason: "Turbo — at the shop", oosUntil: days(3) });
  await create(ctx, "trailer", { unitNumber: "10743", kind: "53_dry", lengthFt: 53, usPlate: "TR10743" });
  await create(ctx, "trailer", { unitNumber: "10750", kind: "53_dry", lengthFt: 53, usPlate: "TR10750" });

  const benja = await create(ctx, "driver", { name: "Benjamín Xochihua", driverType: "B1", phone: "+52 867 000 0001", mxLicenseNumber: "MX-0001", mxLicenseExpires: days(400), fastExpires: days(500), visaType: "B-1/B-2", i94Until: days(120), medicalExpires: days(300), licenseExpires: days(400), currentTruckId: t2117.id });
  await create(ctx, "driver", { name: "Martín Martínez", driverType: "B1", phone: "+52 867 000 0002", mxLicenseNumber: "MX-0002", mxLicenseExpires: days(400), fastExpires: days(45), visaType: "B-1/B-2", i94Until: days(120), medicalExpires: days(300), licenseExpires: days(400), currentTruckId: t2117.id });
  const reyes = await create(ctx, "driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003", licenseNumber: "TX-0003", licenseState: "TX", licenseClass: "A", licenseExpires: days(500), medicalExpires: days(200), currentTruckId: t2104.id });
  await create(ctx, "driver", { name: "Alejandro Cruz", driverType: "DUAL", phone: "+1 956 000 0004", licenseNumber: "TX-0004", licenseState: "TX", licenseClass: "A", licenseExpires: days(500), medicalExpires: days(200), mxLicenseExpires: days(300), fastExpires: days(300), currentTruckId: t2109.id });

  const rxo = await create(ctx, "customer", { name: "RXO", kind: "broker", country: "US", termsDays: 30, billingEmail: "ap@example.com", trackingRequirement: "edi214", knowledgeMd: "Wants a tracking link on every load. POD within 24h." });
  await create(ctx, "ediPartner", { customerId: rxo.id, theirId: "RXO", theirQualifier: "ZZ", ourId: "DEMO", ourQualifier: "02", scac: "DEMO", usage: "T", send214: true, send210: true, accept204: true, autoCreateOrders: true, delivery: "pickup", enabled: true });
  const magna = await create(ctx, "customer", { name: "Magna", kind: "customer", country: "US", termsDays: 45, billingEmail: "ap@example.com", trackingRequirement: "portal" });
  const garza = await create(ctx, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", rfc: "TGA010203AB1", caat: "CAAT-1", caatExpires: days(200), tenderChannel: "whatsapp", whatsapp: "+52 81 000 0000", dispatchEmail: "despacho@example.com" });
  await create(ctx, "carrier", { name: "Lone Star Freight", country: "US", kind: "us", mcNumber: "MC-000001", dotNumber: "0000001", tenderChannel: "email", dispatchEmail: "dispatch@example.com" });
  await create(ctx, "carrierRate", { carrierId: garza.id, originZone: "Monterrey, NL", destinationZone: "Santa Fe Yard, Nuevo Laredo", equipment: "53_dry", rateCents: 45000, currency: "USD", fuelRule: "included" });
  await create(ctx, "customsBroker", { name: "Agencia Aduanal Demo", country: "MX", patente: "0000" });
  await create(ctx, "customsBroker", { name: "Demo US Brokerage", country: "US", filerCode: "ABC" });
  for (const [name, appliesTo, blocks] of [["Licencia federal", "driver", true], ["FAST card", "driver", true], ["Medical card", "driver", true], ["Annual inspection", "truck", false], ["Insurance certificate", "carrier", true]] as const)
    await create(ctx, "documentType", { name, appliesTo, tracksExpiry: true, alertDays: [30, 7], required: true, blocksDispatch: blocks });

  const stops = (pickup: string, delivery: string, offset: number) => [
    { type: "pickup" as const, name: pickup, country: "MX", address: { city: "Apodaca", state: "NL", country: "MX" }, windowStart: days(offset), windowEnd: days(offset + 0.2) },
    { type: "border_yard" as const, name: "Santa Fe Yard", country: "MX", address: { city: "Nuevo Laredo", state: "TAMPS", country: "MX" } },
    { type: "yard" as const, name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX", country: "US" } },
    { type: "delivery" as const, name: delivery, country: "US", address: { city: "Arlington", state: "TX", country: "US" }, windowStart: days(offset + 1), windowEnd: days(offset + 1.3) },
  ];
  // 1: pending
  await createOrder(ctx, { customerId: rxo.id, rateCents: 285000, refs: { rate_con: "RC-77812", po: "PO-4471" }, stops: stops("Planta Monterrey", "GM Arlington", 1), book: true, cargoNote: "26 pallets auto parts · 38,400 lb" });
  // 2: planned (MX leg with Garza, crossing with 2117)
  const o2 = await createOrder(ctx, { customerId: magna.id, rateCents: 310000, refs: { shipment: "MG-20931" }, stops: stops("Magna Ramos Arizpe", "Magna Arlington", 0.5), book: true });
  await planLeg(ctx, o2.legs[0].id, { kind: "carrier", carrierId: garza.id, carrierRateCents: 45000 });
  await planLeg(ctx, o2.legs[1].id, { kind: "truck", truckId: t2117.id, driverId: benja.id });
  // 3: dispatched & moving
  const o3 = await createOrder(ctx, { customerId: rxo.id, rateCents: 295000, refs: { rate_con: "RC-77790" }, stops: stops("Planta Monterrey", "GM Arlington", 0), book: true });
  await planLeg(ctx, o3.legs[0].id, { kind: "carrier", carrierId: garza.id, carrierRateCents: 45000 });
  await dispatchLeg(ctx, o3.legs[0].id);
  await acceptLeg(ctx, o3.legs[0].id, "carrier");
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(ctx, o3.legs[0].id, st, { source: "carrier" });
  // 4: delivered domestic
  const o4 = await createOrder(ctx, { customerId: rxo.id, rateCents: 180000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US", address: { city: "San Antonio", state: "TX", country: "US" } }], book: true });
  await planLeg(ctx, o4.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
  await dispatchLeg(ctx, o4.legs[0].id);
  await acceptLeg(ctx, o4.legs[0].id);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(ctx, o4.legs[0].id, st, { source: "driver_app", verified: true });

  console.log(`seed: demo tenant ready → sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  return "created";
}
