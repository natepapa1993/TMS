import { and, eq, sql } from "drizzle-orm";
import { db } from "./client";
import * as s from "./schema";
import { newId } from "@/lib/ids";
import { zonedDate } from "@/lib/time";
import type { Ctx } from "@/lib/context";

/**
 * The demo company: a fictional Laredo cross-border carrier with a normal working day on the board —
 * loads waiting for trucks, tenders out, trucks rolling with GPS and check calls, a crossing in progress,
 * deliveries, a billing queue, invoices in every state, payments, settlements, a factor, the safety file.
 *
 * It lives in its own company (slug "crossline-demo") with its own logins, so a real company is never
 * touched. It is rebuilt each morning so "today" is always today. It never sends email or WhatsApp
 * (the outbox skips companies flagged demo). Turned on with DEMO_COMPANY=1 and DEMO_PASSWORD; turned
 * off by removing DEMO_COMPANY, and removed entirely with removeDemoCompany().
 */

export const DEMO_SLUG = "crossline-demo";
const TZ = "America/Chicago";
const DOMAIN = "frontera-demo.example";
export const DEMO_LOGINS = [
  ["owner", "Olivia Ortega", `owner@${DOMAIN}`],
  ["dispatcher", "Diego Salinas", `dispatch@${DOMAIN}`],
  ["billing", "Bianca Reyna", `billing@${DOMAIN}`],
  ["compliance", "Samuel Guerra", `safety@${DOMAIN}`],
] as const;

async function demoTenant() {
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.slug, DEMO_SLUG)).limit(1);
  if (!t) return null;
  // only a company this module created (flagged demo) is ever wiped or removed
  if ((t.settings as Record<string, unknown> | null)?.demo !== true) throw new Error(`company "${t.name}" holds the demo slug but is not flagged demo: left alone`);
  return t;
}

let building: Promise<string> | null = null;

/** Delete every row the demo company owns, except its logins (and the company row itself). */
async function wipe(tenantId: string) {
  const tables = (await db.execute(sql`
    select table_name as t from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id' and table_name not in ('users', 'tenants')
  `)) as unknown as { t: string }[];
  await db.transaction(async (tx) => {
    for (const { t } of tables) await tx.execute(sql`delete from ${sql.identifier(t)} where tenant_id = ${tenantId}`);
  });
}

/** Build (or rebuild for today) the demo company. Idempotent per day unless forced. */
export async function ensureDemoCompany(opts: { force?: boolean; now?: Date } = {}): Promise<string> {
  // startup and the morning refresh can meet; one build at a time
  if (building) return building;
  building = ensure(opts).finally(() => (building = null));
  return building;
}

async function ensure(opts: { force?: boolean; now?: Date }): Promise<string> {
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) return "DEMO_PASSWORD is not set (10+ characters): demo company not built";
  const now = opts.now ?? new Date();
  const today = zonedDate(now, TZ);
  let t = await demoTenant();
  if (t && !opts.force && (t.settings as Record<string, unknown> | null)?.demoBuiltFor === today) return `demo company is up to date (${today})`;
  const { hashPassword } = await import("@/lib/auth");
  const hash = await hashPassword(password);
  if (!t) {
    const tenantId = newId();
    await db.insert(s.tenants).values({ id: tenantId, name: "Frontera Freight (demo)", slug: DEMO_SLUG, timeZone: TZ, settings: { demo: true } });
    for (const [role, name, email] of DEMO_LOGINS) {
      const [clash] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email)).limit(1);
      if (clash) continue;
      await db.insert(s.users).values({ id: newId(), tenantId, email, name, role, passwordHash: hash });
    }
    t = (await demoTenant())!;
  } else {
    await wipe(t.id);
    // the password follows DEMO_PASSWORD
    for (const [, , email] of DEMO_LOGINS) await db.update(s.users).set({ passwordHash: hash }).where(and(eq(s.users.tenantId, t.id), eq(s.users.email, email)));
  }
  await db.update(s.tenants).set({ settings: { demo: true, dispatchPhone: "+1 956 555 0142" }, timeZone: TZ, name: "Frontera Freight (demo)" }).where(eq(s.tenants.id, t.id));
  const [owner] = await db.select({ id: s.users.id }).from(s.users).where(and(eq(s.users.tenantId, t.id), eq(s.users.role, "owner"))).limit(1);
  const ctx: Ctx = { tenantId: t.id, userId: owner?.id ?? null, role: "owner" };
  const log = await build(ctx, now);
  await db.update(s.tenants).set({ settings: { demo: true, dispatchPhone: "+1 956 555 0142", demoBuiltFor: today } }).where(eq(s.tenants.id, t.id));
  return `demo company built for ${today}: ${log.ok} steps ok${log.failed.length ? `, ${log.failed.length} skipped (${log.failed.slice(0, 5).join("; ")})` : ""}`;
}

/** Remove the demo company and its logins entirely. */
export async function removeDemoCompany() {
  const t = await demoTenant();
  if (!t) return "no demo company";
  await wipe(t.id);
  await db.delete(s.users).where(eq(s.users.tenantId, t.id));
  await db.delete(s.tenants).where(eq(s.tenants.id, t.id));
  return "demo company removed";
}

/** Each morning (after 4 am in Laredo) the demo company is rebuilt for the new day. */
export async function refreshDemoIfDue(now = new Date()) {
  if (process.env.DEMO_COMPANY !== "1") return null;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: TZ }).format(now)) % 24;
  if (hour < 4) return null;
  return ensureDemoCompany({ now });
}

// ------------------------------------------------------------------------------------------------

async function build(a: Ctx, nowDate: Date) {
  const { create } = await import("@/data/records");
  const O = await import("@/domain/orders");
  const B = await import("@/domain/billing");
  const { recordPosition, driverMessage } = await import("@/domain/tracking");
  const { addCheckCall } = await import("@/domain/check-calls");
  const { sendTender } = await import("@/domain/tenders");
  const X = await import("@/domain/crossing");
  const { saveIncident, evaluateAll } = await import("@/domain/compliance");
  const S = await import("@/domain/safety");
  const { addFuelPurchase } = await import("@/domain/ifta");
  const { addEvent } = await import("@/domain/planner");
  const { applyPayment } = await import("@/domain/cash");
  const F = await import("@/domain/factoring");
  const { settlementRun, approveSettlements, paySettlements } = await import("@/domain/settlement-run");
  const { portalRequestLoad } = await import("@/domain/customer-portal");
  const { PDFDocument, StandardFonts } = await import("pdf-lib");

  const now = nowDate.getTime();
  const H = 3600_000;
  const DAY = 24 * H;
  const at = (hoursFromNow: number) => new Date(now + hoursFromNow * H);
  // appointments land on round local times: today 10:00 etc. (Laredo is UTC-5 in September)
  const dayStart = new Date(`${zonedDate(nowDate, TZ)}T00:00:00-05:00`).getTime();
  const appt = (dayOffset: number, hour: number) => new Date(dayStart + dayOffset * DAY + hour * H);
  const log = { ok: 0, failed: [] as string[] };
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      log.ok++;
    } catch (e) {
      log.failed.push(`${label}: ${(e as Error).message.slice(0, 120)}`);
      console.warn(`[demo] ${label}: ${(e as Error).message}`);
    }
  };
  const pdf = async (title: string, lines: string[] = []) => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([612, 792]);
    p.drawText(title, { x: 60, y: 720, size: 18, font: f });
    lines.forEach((l, i) => p.drawText(l, { x: 60, y: 690 - i * 16, size: 11, font: f }));
    p.drawText("DEMO DOCUMENT — Frontera Freight (demo)", { x: 60, y: 60, size: 9, font: f });
    return Buffer.from(await d.save());
  };
  const ov = { override: true, reason: "demo data" };

  // ---------------- company, places, partners, fleet ----------------
  await create(a, "billingEntity", { legalName: "Frontera Freight LLC", dba: "Frontera Freight", country: "US", invoicePrefix: "FF", nextInvoiceNumber: 2401, isDefault: true, taxId: "00-0000000", mcNumber: "000000", dotNumber: "0000000", remitTo: { line1: "4100 Mines Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" }, factorName: "Summit Capital Factoring (demo)", factorEmail: `schedules@${DOMAIN}`, factorAdvanceBp: 9500, factorFeeBp: 250, factorRecourseDays: 90 });
  await create(a, "port", { name: "Laredo / Nuevo Laredo", usCity: "Laredo", usState: "TX", mxCity: "Nuevo Laredo", mxState: "TAMPS", bridges: ["World Trade Bridge", "Colombia Solidarity Bridge"], knowledgeMd: "World Trade Bridge: commercial, FAST lane open 24/7. Colombia: lighter lines at night." });
  const loc = async (name: string, kind: string, country: string, city: string, state: string, lat: number, lng: number, line1?: string) => (await create(a, "location", { name, kind, country, address: { line1, city, state, country }, lat: String(lat), lng: String(lng) })).id;
  const L = {
    yard: await loc("Frontera Yard — Laredo", "yard", "US", "Laredo", "TX", 27.5936, -99.4803, "4100 Mines Rd"),
    nld: await loc("Patio Nuevo Laredo", "border_yard", "MX", "Nuevo Laredo", "TAMPS", 27.4764, -99.5164),
    apodaca: await loc("Sierra Madre Components — Apodaca", "customer", "MX", "Apodaca", "NL", 25.7817, -100.1886),
    ramos: await loc("Norteño Assembly — Ramos Arizpe", "customer", "MX", "Ramos Arizpe", "COAH", 25.5428, -100.9737),
    queretaro: await loc("Bajío Plastics — Querétaro", "customer", "MX", "Querétaro", "QRO", 20.5888, -100.3899),
    sa: await loc("Alamo Auto Plant — San Antonio", "customer", "US", "San Antonio", "TX", 29.3309, -98.4936),
    dallas: await loc("Trinity DC — Dallas", "customer", "US", "Dallas", "TX", 32.7767, -96.797),
    houston: await loc("Bayou Cold Storage — Houston", "customer", "US", "Houston", "TX", 29.7604, -95.3698),
    joliet: await loc("Great Lakes Crossdock — Joliet", "customer", "US", "Joliet", "IL", 41.525, -88.0817),
    detroit: await loc("Motor City Parts — Detroit", "customer", "US", "Detroit", "MI", 42.3314, -83.0458),
    mississauga: await loc("Maple Leaf Distribution — Mississauga", "customer", "CA", "Mississauga", "ON", 43.589, -79.6441),
    atlanta: await loc("Peachtree Fulfillment — Atlanta", "customer", "US", "Atlanta", "GA", 33.749, -84.388),
  };
  const P: Record<string, { name: string; country: string; lat: number; lng: number; city: string; state: string }> = {
    [L.yard]: { name: "Frontera Yard — Laredo", country: "US", lat: 27.5936, lng: -99.4803, city: "Laredo", state: "TX" },
    [L.nld]: { name: "Patio Nuevo Laredo", country: "MX", lat: 27.4764, lng: -99.5164, city: "Nuevo Laredo", state: "TAMPS" },
    [L.apodaca]: { name: "Sierra Madre Components — Apodaca", country: "MX", lat: 25.7817, lng: -100.1886, city: "Apodaca", state: "NL" },
    [L.ramos]: { name: "Norteño Assembly — Ramos Arizpe", country: "MX", lat: 25.5428, lng: -100.9737, city: "Ramos Arizpe", state: "COAH" },
    [L.queretaro]: { name: "Bajío Plastics — Querétaro", country: "MX", lat: 20.5888, lng: -100.3899, city: "Querétaro", state: "QRO" },
    [L.sa]: { name: "Alamo Auto Plant — San Antonio", country: "US", lat: 29.3309, lng: -98.4936, city: "San Antonio", state: "TX" },
    [L.dallas]: { name: "Trinity DC — Dallas", country: "US", lat: 32.7767, lng: -96.797, city: "Dallas", state: "TX" },
    [L.houston]: { name: "Bayou Cold Storage — Houston", country: "US", lat: 29.7604, lng: -95.3698, city: "Houston", state: "TX" },
    [L.joliet]: { name: "Great Lakes Crossdock — Joliet", country: "US", lat: 41.525, lng: -88.0817, city: "Joliet", state: "IL" },
    [L.detroit]: { name: "Motor City Parts — Detroit", country: "US", lat: 42.3314, lng: -83.0458, city: "Detroit", state: "MI" },
    [L.mississauga]: { name: "Maple Leaf Distribution — Mississauga", country: "CA", lat: 43.589, lng: -79.6441, city: "Mississauga", state: "ON" },
    [L.atlanta]: { name: "Peachtree Fulfillment — Atlanta", country: "US", lat: 33.749, lng: -84.388, city: "Atlanta", state: "GA" },
  };
  type StopType = "pickup" | "delivery" | "border_yard" | "yard";
  const stop = (type: StopType, id: string, windowStart?: Date, windowEnd?: Date) => ({ type, name: P[id].name, locationId: id, country: P[id].country, address: { city: P[id].city, state: P[id].state, country: P[id].country }, windowStart, windowEnd });

  const cust = async (name: string, kind: string, email: string, extra: Record<string, unknown> = {}) => (await create(a, "customer", { name, kind, country: "US", billingEmail: email, termsDays: 30, contacts: [{ name: "Track & trace", email: `tracking@${email.split("@")[1]}` }], ...extra })).id;
  const C = {
    summit: await cust("Summit Logistics Group (demo)", "broker", `ap@summit.${DOMAIN}`, { requiredDocs: ["POD", "RATE_CON"], requiredRefs: ["PO"], billingAddress: { line1: "200 Commerce St", city: "Chicago", state: "IL", postalCode: "60606", country: "US" } }),
    northstar: await cust("Northstar Brokerage (demo)", "broker", `billing@northstar.${DOMAIN}`, { requiredDocs: ["POD"], invoiceMode: "summary", termsDays: 21 }),
    sierra: await cust("Sierra Madre Components (demo)", "customer", `cxp@sierra.${DOMAIN}`, { country: "MX", requiredDocs: ["POD", "BOL"], termsDays: 45 }),
    lonestar: await cust("Lone Star Produce Co. (demo)", "customer", `ap@lonestar.${DOMAIN}`, { requiredDocs: ["POD"], invoiceDelivery: "factor", detentionFreeMinutes: 120, detentionRateCents: 7500 }),
    maple: await cust("Maple Leaf Distribution (demo)", "customer", `payables@maple.${DOMAIN}`, { country: "CA", requiredDocs: ["POD"], termsDays: 30 }),
  };
  const carrier = async (name: string, country: string, kind: string, extra: Record<string, unknown> = {}) => (await create(a, "carrier", { name, country, kind, dispatchEmail: `dispatch@${name.split(" ")[0].toLowerCase()}.${DOMAIN}`, ...extra })).id;
  const K = {
    norte: await carrier("Transportes del Norte (demo)", "MX", "mx", { caatExpires: new Date(now + 200 * DAY), sctPermitExpires: new Date(now + 300 * DAY) }),
    puente: await carrier("Puente Drayage (demo)", "MX", "crossing", { caatExpires: new Date(now + 150 * DAY) }),
    prairie: await carrier("Prairie Wind Trucking (demo)", "US", "us", { mcNumber: "100100", dotNumber: "2001001", insurer: "Demo Mutual", autoLiabilityCents: 100_000_000, autoLiabilityExpires: new Date(now + 180 * DAY), cargoCoverageCents: 10_000_000, cargoInsuranceExpires: new Date(now + 180 * DAY) }),
    bluewater: await carrier("Bluewater Carriers (demo)", "US", "us", { mcNumber: "100200", dotNumber: "2001002", insurer: "Demo Mutual", autoLiabilityCents: 100_000_000, autoLiabilityExpires: new Date(now + 20 * DAY), cargoInsuranceExpires: new Date(now + 20 * DAY) }),
  };
  const fut = (d: number) => new Date(now + d * DAY);
  const truck = async (unit: string, extra: Record<string, unknown> = {}) => (await create(a, "truck", { unitNumber: unit, usPlate: `TX${unit}F`, usPlateExpires: fut(240), mxPlate: `${unit}-FF-${unit.slice(-1)}`, mxPlateExpires: fut(240), dotInspectionExpires: fut(150), year: 2023, make: "Freightliner", model: "Cascadia", ...extra })).id;
  const T: Record<string, string> = {};
  for (const u of ["201", "202", "203", "204", "205", "206", "207", "208", "209", "210"]) T[u] = await truck(u, u === "204" ? { usPlateExpires: fut(9) } : u === "209" ? { dotInspectionExpires: fut(-2) } : u === "210" ? { make: "Kenworth", model: "T680" } : {});
  const R: Record<string, string> = {};
  for (const [u, kind] of [["5301", "53_dry"], ["5302", "53_dry"], ["5303", "53_dry"], ["5304", "53_dry"], ["5305", "53_dry"], ["5306", "53_reefer"], ["5307", "53_reefer"], ["5308", "53_dry"], ["5309", "53_dry"], ["5310", "53_dry"]] as const) R[u] = (await create(a, "trailer", { unitNumber: u, kind, lengthFt: 53, usPlate: `TR${u}`, inspectionExpires: fut(u === "5305" ? 12 : 200) })).id;
  const driver = async (name: string, truckId: string | null, extra: Record<string, unknown> = {}) => (await create(a, "driver", { name, driverType: "CDL", phone: `+1 956 555 01${String(Math.floor(Math.random() * 90) + 10)}`, whatsapp: null, licenseState: "TX", licenseNumber: `TX${Math.floor(10000000 + Math.random() * 8999999)}`, licenseClass: "A", licenseExpires: fut(600), medicalExpires: fut(300), fastExpires: fut(500), currentTruckId: truckId, hireDate: fut(-400), payType: "per_mile", payRateCents: 62, ...extra })).id;
  const D = {
    rafael: await driver("Rafael Mendoza", T["201"]),
    marisol: await driver("Marisol Treviño", T["202"]),
    jorge: await driver("Jorge Villarreal", T["203"], { medicalExpires: fut(11) }),
    kevin: await driver("Kevin Walsh", T["204"], { payType: "pct", payRateCents: 2800 }),
    luz: await driver("Luz Cantú", T["205"]),
    arturo: await driver("Arturo Garza", T["206"], { driverType: "B1", visaType: "B1", licenseState: null, licenseNumber: null, mxLicenseNumber: "LF-2231987", mxLicenseExpires: fut(400), i94Until: fut(60) }),
    hector: await driver("Héctor Salazar", T["207"], { driverType: "DUAL", mxLicenseNumber: "LF-7718203", mxLicenseExpires: fut(250) }),
    priya: await driver("Priya Singh", T["208"], { licenseState: "ON", licenseNumber: "S4210-55012-81203" }),
    tomas: await driver("Tomás Ibarra", T["209"], { hireDate: fut(-12) }),
    denise: await driver("Denise Carter", T["210"], { licenseExpires: fut(-4) }),
  };
  const truckOf: Record<string, string> = { [D.rafael]: T["201"], [D.marisol]: T["202"], [D.jorge]: T["203"], [D.kevin]: T["204"], [D.luz]: T["205"], [D.arturo]: T["206"], [D.hector]: T["207"], [D.priya]: T["208"], [D.tomas]: T["209"], [D.denise]: T["210"] };
  const on = (d: string, trailer?: string) => ({ kind: "truck" as const, truckId: truckOf[d], driverId: d, trailerId: trailer ?? null });

  // ---------------- helpers for the day ----------------
  /** Walk a leg to a state with realistic stamps; t0 = when the truck started rolling to pickup. */
  const walk = async (legId: string, to: "dispatched" | "accepted" | "en_route_to_pickup" | "at_pickup" | "en_route" | "at_delivery" | "completed", t0: number, durH = 10) => {
    await O.dispatchLeg(a, legId);
    if (to === "dispatched") return;
    await O.acceptLeg(a, legId);
    if (to === "accepted") return;
    const t = (h: number) => new Date(t0 + h * H);
    await O.advanceLeg(a, legId, "en_route_to_pickup", { at: t(0) });
    if (to === "en_route_to_pickup") return;
    await O.advanceLeg(a, legId, "at_pickup", { at: t(1) });
    if (to === "at_pickup") return;
    await O.advanceLeg(a, legId, "loaded", { at: t(2.5) });
    await O.advanceLeg(a, legId, "en_route", { at: t(2.6) });
    if (to === "en_route") return;
    await O.advanceLeg(a, legId, "at_delivery", { at: t(durH) });
    if (to === "at_delivery") return;
    await O.advanceLeg(a, legId, "completed", { at: t(durH + 1.5) });
  };
  const ping = async (legId: string, d: string, from: string, to: string, share: number, hoursAgo: number, speed = 62) => {
    const f = P[from];
    const g = P[to];
    await recordPosition(a, { source: "driver_app", at: at(-hoursAgo), lat: f.lat + (g.lat - f.lat) * share, lng: f.lng + (g.lng - f.lng) * share, truckId: truckOf[d], driverId: d, legId, speedMph: speed });
  };
  const trail = async (legId: string, d: string, from: string, to: string, upTo: number, lastPingHoursAgo = 0.2) => {
    for (let k = 0; k <= 5; k++) await ping(legId, d, from, to, (upTo * k) / 5, lastPingHoursAgo + (5 - k) * 1.2, k === 5 ? 64 : 61);
  };
  const order = (customerId: string, rateCents: number | null, stops: ReturnType<typeof stop>[], extra: Record<string, unknown> = {}) => O.createOrder(a, { customerId, rateCents, stops, book: true, equipment: "53_dry", ...extra } as Parameters<typeof O.createOrder>[1]);
  const po = () => `PO-${Math.floor(400000 + Math.random() * 99999)}`;
  const addDocs = async (orderId: string, num: string, codes: string[]) => {
    for (const code of codes) await B.uploadOrderDocument(a, orderId, { code, fileName: `${code === "RATE_CON" ? "Rate con" : code} ${num}.pdf`, mimeType: "application/pdf", bytes: await pdf(`${code === "RATE_CON" ? "Rate confirmation" : code} — ${num}`, ["Frontera Freight (demo)"]) });
  };

  // ---------------- TODAY: loads that need a truck ----------------
  await step("needs truck: Laredo → Dallas", () => order(C.summit, 185000, [stop("pickup", L.yard, appt(0, 14), appt(0, 16)), stop("delivery", L.dallas, appt(1, 8))], { refs: { po: po(), reference: "SLG-771203" }, freight: [{ commodity: "Auto parts", pieces: 22, packaging: "pallets", weightLb: 38200 }] }));
  await step("needs truck: San Antonio → Atlanta", () => order(C.northstar, 410000, [stop("pickup", L.sa, appt(0, 18)), stop("delivery", L.atlanta, appt(2, 9))], { refs: { po: po() }, freight: [{ commodity: "Engine components", pieces: 18, packaging: "crates", weightLb: 41000 }] }));
  await step("needs truck: Houston reefer → Joliet", () => order(C.lonestar, 395000, [stop("pickup", L.houston, appt(1, 6)), stop("delivery", L.joliet, appt(2, 14))], { equipment: "53_reefer", refs: { po: po() }, freight: [{ commodity: "Avocados (34°F)", pieces: 24, packaging: "pallets", weightLb: 40100 }] }));
  await step("needs truck: Dallas → Laredo backhaul", () => order(C.summit, 120000, [stop("pickup", L.dallas, appt(1, 10)), stop("delivery", L.yard, appt(1, 20))], { refs: { po: po() } }));
  await step("needs truck: Detroit → Mississauga", () => order(C.maple, 165000, [stop("pickup", L.detroit, appt(1, 7)), stop("delivery", L.mississauga, appt(1, 15))], { refs: { po: po(), reference: "MLD-55120" }, freight: [{ commodity: "Brake assemblies", pieces: 16, packaging: "pallets", weightLb: 22000 }] }));
  // a cross-border load for tomorrow: nothing covered yet
  await step("needs trucks: Querétaro → Detroit", () => order(C.sierra, 520000, [stop("pickup", L.queretaro, appt(1, 8)), stop("border_yard", L.nld), stop("yard", L.yard), stop("delivery", L.detroit, appt(4, 8))], { refs: { po: po(), reference: "BJP-20931" }, freight: [{ commodity: "Injection-molded housings", pieces: 30, packaging: "gaylords", weightLb: 29000, hsCode: "3926.90" }] }));

  // ---------------- tendered to partners (waiting for an answer) ----------------
  await step("tendered: Laredo → Joliet to Prairie Wind", async () => {
    const o = await order(C.northstar, 360000, [stop("pickup", L.yard, appt(0, 20)), stop("delivery", L.joliet, appt(2, 12))], { refs: { po: po() } });
    await sendTender(a, o.legs[0].id, { carrierId: K.prairie, rateCents: 285000, channel: "email", expiresInMinutes: 45 });
  });
  await step("tendered: Dallas → Houston to Bluewater", async () => {
    const o = await order(C.summit, 98000, [stop("pickup", L.dallas, appt(1, 9)), stop("delivery", L.houston, appt(1, 16))], { refs: { po: po() } });
    await sendTender(a, o.legs[0].id, { carrierId: K.bluewater, rateCents: 76000, channel: "email", expiresInMinutes: 180, ...ov });
  });

  // ---------------- planned, not sent yet ----------------
  await step("planned: San Antonio → Dallas on 209, Tomás's next load", async () => {
    const o = await order(C.summit, 110000, [stop("pickup", L.sa, appt(1, 7)), stop("delivery", L.dallas, appt(1, 14))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, on(D.tomas, R["5303"]), { plannedMiles: 275, ...ov });
  });

  // ---------------- dispatched, picking up today ----------------
  await step("dispatched: Laredo → San Antonio on 209", async () => {
    const o = await order(C.summit, 90000, [stop("pickup", L.yard, appt(0, 15)), stop("delivery", L.sa, appt(0, 21))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, on(D.tomas, R["5303"]), { plannedMiles: 157, ...ov });
    await walk(o.legs[0].id, "accepted", now);
  });

  // ---------------- rolling now, with GPS and check calls ----------------
  await step("in transit: Laredo → Dallas on 203 (on time)", async () => {
    const o = await order(C.summit, 180000, [stop("pickup", L.yard, appt(0, 6)), stop("delivery", L.dallas, appt(0, 17))], { refs: { po: po(), reference: "SLG-771190" } });
    await O.planLeg(a, o.legs[0].id, on(D.jorge, R["5301"]), { plannedMiles: 430 });
    await walk(o.legs[0].id, "en_route", now - 6 * H);
    await trail(o.legs[0].id, D.jorge, L.yard, L.dallas, 0.62);
    await addCheckCall(a, o.order.id, { status: "on_time", note: "Past Cotulla, fueled at the Pilot", etaAt: appt(0, 16.5) });
  });
  await step("in transit: San Antonio → Detroit on 207 (late)", async () => {
    const o = await order(C.northstar, 425000, [stop("pickup", L.sa, appt(-1, 8)), stop("delivery", L.detroit, appt(1, 6))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, on(D.hector, R["5302"]), { plannedMiles: 1560 });
    await walk(o.legs[0].id, "en_route", now - 26 * H, 30);
    await trail(o.legs[0].id, D.hector, L.sa, L.detroit, 0.48);
    await addCheckCall(a, o.order.id, { status: "running_late", location: "I-30 E near Texarkana, AR", note: "Closure on I-30 — 3 h delay, customer told", etaAt: appt(1, 10) });
  });
  await step("in transit: Houston reefer → Joliet on 201 (no ping)", async () => {
    const o = await order(C.lonestar, 380000, [stop("pickup", L.houston, appt(-1, 14)), stop("delivery", L.joliet, appt(1, 9))], { equipment: "53_reefer", refs: { po: po() }, freight: [{ commodity: "Strawberries (34°F)", pieces: 22, packaging: "pallets", weightLb: 36800 }] });
    await O.planLeg(a, o.legs[0].id, on(D.rafael, R["5306"]), { plannedMiles: 1085 });
    await walk(o.legs[0].id, "en_route", now - 16 * H, 22);
    await trail(o.legs[0].id, D.rafael, L.houston, L.joliet, 0.55, 3.2);
    await addCheckCall(a, o.order.id, { status: "on_time", location: "US-59 N, Lufkin TX", tempF: 34, note: "Reefer at 34°F", at: at(-5) });
  });
  await step("at delivery: Dallas on 202 (detention running)", async () => {
    const o = await order(C.lonestar, 175000, [stop("pickup", L.yard, appt(-1, 20)), stop("delivery", L.dallas, appt(0, 5))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, on(D.marisol, R["5305"]), { plannedMiles: 430 });
    await walk(o.legs[0].id, "at_delivery", now - 13 * H, 9.5);
    await ping(o.legs[0].id, D.marisol, L.dallas, L.dallas, 1, 0.1, 0);
    await addCheckCall(a, o.order.id, { status: "at_receiver", location: "Trinity DC door 14", note: "On the door since 5:30, receiver slow — detention clock running" });
  });
  await step("Canada: Detroit → Mississauga on 208", async () => {
    const o = await order(C.maple, 190000, [stop("pickup", L.detroit, appt(0, 5)), stop("delivery", L.mississauga, appt(0, 13))], { refs: { po: po(), reference: "MLD-55107" } });
    await O.planLeg(a, o.legs[0].id, on(D.priya, R["5308"]), { plannedMiles: 235, ...ov });
    await walk(o.legs[0].id, "en_route", now - 5 * H, 7);
    await trail(o.legs[0].id, D.priya, L.detroit, L.mississauga, 0.7);
    await addCheckCall(a, o.order.id, { status: "at_border", location: "Ambassador Bridge, Windsor", note: "PARS cleared, rolling" });
  });
  await step("carrier: Dallas → Atlanta by Prairie Wind", async () => {
    const o = await order(C.summit, 310000, [stop("pickup", L.dallas, appt(-1, 9)), stop("delivery", L.atlanta, appt(1, 8))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: K.prairie, carrierRateCents: 245000 }, { plannedMiles: 780, ...ov });
    await walk(o.legs[0].id, "en_route", now - 20 * H, 20);
    await addCheckCall(a, o.order.id, { status: "on_time", location: "I-20 E, Shreveport LA", note: "Carrier dispatch: on schedule" });
  });

  // ---------------- cross-border: MX leg rolling, one at the border, one crossed ----------------
  const xb = async (label: string, stage: "mx_rolling" | "at_border" | "us_rolling", from: string, dest: string) =>
    step(label, async () => {
      const o = await order(C.sierra, 295000, [stop("pickup", from, appt(-1, 10)), stop("border_yard", L.nld), stop("yard", L.yard), stop("delivery", dest, appt(1, 10))], { refs: { po: po(), reference: `SMC-${Math.floor(10000 + Math.random() * 9999)}` }, freight: [{ commodity: "Wire harnesses", pieces: 26, packaging: "boxes on pallets", weightLb: 31000, hsCode: "8544.30" }] });
      const [mx, crossing, us] = o.legs;
      await O.planLeg(a, mx.id, { kind: "carrier", carrierId: K.norte, carrierRateCents: 48000 }, { plannedMiles: 150, ...ov });
      await walk(mx.id, stage === "mx_rolling" ? "en_route" : "completed", now - (stage === "mx_rolling" ? 3 : 10) * H, 4);
      const [c] = await db.select().from(s.crossings).where(and(eq(s.crossings.tenantId, a.tenantId), eq(s.crossings.legId, crossing.id))).limit(1);
      if (c) {
        await X.uploadDocument(a, c.id, { code: "carta_porte", fileName: "Carta porte.pdf", mimeType: "application/pdf", bytes: await pdf("Carta porte (demo)"), fields: {} });
        if (stage !== "mx_rolling") {
          await X.uploadDocument(a, c.id, { code: "doda", fileName: "DODA.pdf", mimeType: "application/pdf", bytes: await pdf("DODA (demo)"), fields: {} });
          await X.markArrivedYard(a, c.id, { at: at(-5) });
        }
      }
      if (stage === "mx_rolling") return;
      const box = stage === "at_border" ? R["5309"] : R["5310"];
      await O.planLeg(a, crossing.id, on(D.arturo, box), { plannedMiles: 8, ...ov });
      if (stage === "at_border") {
        await walk(crossing.id, "en_route", now - 2 * H, 3);
        await ping(crossing.id, D.arturo, L.nld, L.yard, 0.5, 0.3, 3);
        await addCheckCall(a, o.order.id, { status: "at_border", location: "World Trade Bridge, US side", note: "In the FAST lane, ~40 min" });
        return;
      }
      await walk(crossing.id, "completed", now - 7 * H, 2);
      await O.planLeg(a, us.id, on(D.kevin, box), { plannedMiles: 157, ...ov });
      await walk(us.id, "en_route", now - 3 * H, 4);
      await trail(us.id, D.kevin, L.yard, dest, 0.6);
    });
  await xb("cross-border: MX leg rolling", "mx_rolling", L.apodaca, L.sa);
  await xb("cross-border: at the bridge", "at_border", L.ramos, L.sa);
  await xb("cross-border: crossed, US leg rolling", "us_rolling", L.apodaca, L.sa);

  // ---------------- exceptions ----------------
  await step("breakdown: 205 on the shoulder", async () => {
    const o = await order(C.northstar, 215000, [stop("pickup", L.yard, appt(-1, 12)), stop("delivery", L.joliet, appt(1, 16))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, on(D.luz, R["5304"]), { plannedMiles: 1250, ...ov });
    await walk(o.legs[0].id, "en_route", now - 14 * H, 20);
    await ping(o.legs[0].id, D.luz, L.yard, L.joliet, 0.35, 0.5, 0);
    await addCheckCall(a, o.order.id, { status: "breakdown", location: "I-35 N mm 294, Waco TX", note: "Blown air line — road service ETA 2 h" });
  });
  await step("hold: customer paperwork", async () => {
    const o = await order(C.lonestar, 240000, [stop("pickup", L.sa, appt(0, 9)), stop("delivery", L.atlanta, appt(2, 9))], { refs: { po: po() } });
    await O.planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: K.bluewater, carrierRateCents: 190000 }, { plannedMiles: 990, ...ov });
    await walk(o.legs[0].id, "at_pickup", now - 3 * H);
    await O.holdOrder(a, o.order.id, "Customer re-issuing the commercial invoice — hold until it arrives");
  });
  await step("portal request (draft)", () => portalRequestLoad(a.tenantId, C.sierra, { pickup: { name: "Sierra Madre Components — Apodaca", city: "Apodaca", state: "NL", country: "MX", windowStart: appt(2, 8) }, delivery: { name: "Alamo Auto Plant — San Antonio", city: "San Antonio", state: "TX", country: "US" }, equipment: "53_dry", po: "SMC-REQ-9921", cargoNote: "22 pallets harnesses", contact: "Lucía, logística" }));
  await step("truck 210 OOS", () => O.setTruckOos(a, T["210"], "Annual inspection failed — brake chamber", fut(2)));
  await step("time off: Denise", () => addEvent(a, { subjectKind: "driver", subjectId: D.denise, kind: "other", startsAt: appt(0, 0), endsAt: appt(3, 0), hard: true, note: "Off until the licence renewal clears at DPS" }));

  // ---------------- delivered this week → the billing queue ----------------
  const delivered: { id: string; num: string }[] = [];
  const done = async (label: string, customerId: string, rate: number, from: string, to: string, d: string, daysAgo: number, docs: string[], miles: number) =>
    step(label, async () => {
      const o = await order(customerId, rate, [stop("pickup", from, new Date(now - (daysAgo + 1) * DAY)), stop("delivery", to, new Date(now - daysAgo * DAY))], { refs: { po: po(), reference: `REF-${Math.floor(100000 + Math.random() * 99999)}` } });
      await O.planLeg(a, o.legs[0].id, on(d), { plannedMiles: miles, ...ov });
      await walk(o.legs[0].id, "completed", now - (daysAgo + 1) * DAY, 9);
      await addDocs(o.order.id, o.order.orderNumber, docs);
      delivered.push({ id: o.order.id, num: o.order.orderNumber });
    });
  await done("delivered: ready", C.summit, 182000, L.yard, L.dallas, D.jorge, 2, ["POD", "RATE_CON"], 430);
  await done("delivered: ready 2", C.northstar, 152000, L.sa, L.dallas, D.marisol, 3, ["POD"], 275);
  await done("delivered: ready 3", C.northstar, 168000, L.yard, L.sa, D.rafael, 3, ["POD"], 157);
  await done("delivered: missing POD", C.summit, 176000, L.dallas, L.yard, D.kevin, 1, ["RATE_CON"], 430);
  await done("delivered: detention waiting", C.lonestar, 245000, L.houston, L.dallas, D.luz, 2, ["POD"], 240);
  await done("delivered: Canada", C.maple, 188000, L.detroit, L.mississauga, D.priya, 4, ["POD"], 235);
  await done("delivered: for invoicing", C.summit, 199000, L.yard, L.dallas, D.jorge, 6, ["POD", "RATE_CON"], 430);
  await done("delivered: for invoicing 2", C.sierra, 285000, L.yard, L.sa, D.hector, 7, ["POD", "BOL"], 157);
  await done("delivered: for invoicing 3", C.lonestar, 230000, L.houston, L.dallas, D.marisol, 8, ["POD"], 240);
  await done("delivered: for invoicing 4", C.maple, 176000, L.detroit, L.mississauga, D.priya, 9, ["POD"], 235);
  await done("delivered: for invoicing 5", C.summit, 205000, L.yard, L.dallas, D.rafael, 12, ["POD", "RATE_CON"], 430);
  await done("delivered: for invoicing 6", C.lonestar, 240000, L.houston, L.joliet, D.luz, 14, ["POD"], 1085);
  const dq = delivered.find((x) => delivered.indexOf(x) === 4);
  await step("detention waiting approval", async () => {
    if (dq) await B.addCharge(a, dq.id, { kind: "detention", description: "Detention at Trinity DC — 2h 30m over 2 h free", qty: 250, unit: "h", rateCents: 7500 });
  });
  await step("lumper approved", async () => {
    const x = delivered[1];
    const c = await B.addCharge(a, x.id, { kind: "lumper", rateCents: 18500, description: "Lumper at Trinity DC (receipt on file)" });
    await B.approveCharge(a, c.id, { by: "Jenna at Northstar", ref: "email 'RE: lumper'" });
  });
  await step("TONU", async () => {
    const o = await order(C.summit, 150000, [stop("pickup", L.dallas, appt(-1, 8)), stop("delivery", L.yard, appt(0, 9))], { refs: { po: po() } });
    await O.markTonu(a, o.order.id, { amountCents: 25000, reason: "Shipper cancelled after the truck arrived" });
  });

  // ---------------- invoices in every state ----------------
  const invs: { id: string; total: number }[] = [];
  const invoice = async (label: string, idx: number, daysAgo: number) =>
    step(label, async () => {
      const x = delivered[idx];
      if (!x) return;
      const inv = await B.createInvoice(a, [x.id], { withoutPending: true });
      const iss = await B.issueInvoice(a, inv.id, { issuedAt: new Date(now - daysAgo * DAY) });
      await B.sendInvoice(a, inv.id).catch(() => null);
      invs.push({ id: iss.id, total: iss.totalCents });
    });
  await invoice("invoice: current", 6, 5);
  await invoice("invoice: 30+", 7, 50);
  await invoice("invoice: factored", 8, 6);
  await invoice("invoice: Canada", 9, 12);
  await invoice("invoice: paid", 10, 20);
  await invoice("invoice: 60+", 11, 70);
  await step("payment: one check for two invoices + on account", async () => {
    const paid = invs[4];
    const cur = invs[0];
    if (!paid || !cur) return;
    await applyPayment(a, { customerId: C.summit, amountCents: paid.total + 100000 + 25000, method: "check", reference: "CHK 88213", receivedAt: new Date(now - 2 * DAY), remittance: "Summit Logistics remittance", applications: [{ invoiceId: paid.id, amountCents: paid.total }, { invoiceId: cur.id, amountCents: 100000 }] });
  });
  await step("dispute", async () => {
    const x = invs[1];
    if (x) await B.disputeInvoice(a, x.id, "Customer says the pallets arrived damaged — claim pending", new Date(now + 10 * DAY));
  });
  await step("factor funding", async () => {
    const x = invs[2];
    if (x) await F.recordFunding(a, [x.id], { reference: "SCH-0412", at: new Date(now - 5 * DAY) });
  });

  // ---------------- carrier bills ----------------
  await step("carrier bills", async () => {
    await B.syncCarrierBills(a);
    const bills = await db.select().from(s.carrierBills).where(eq(s.carrierBills.tenantId, a.tenantId));
    const first = bills.find((b) => b.expectedCents > 40000);
    if (first) await B.receiveCarrierBill(a, first.id, { invoicedCents: first.expectedCents, carrierInvoiceNumber: "TDN-5521" });
  });

  // ---------------- driver pay: last week's statements ----------------
  await step("settlements", async () => {
    const lastSunday = new Date(dayStart - ((new Date(dayStart).getUTCDay() + 7) % 7) * DAY - 7 * DAY);
    await B.addPayItem(a, D.rafael, { kind: "advance", description: "Fuel advance", amountCents: 20000, remainingCents: 40000 });
    await B.addPayItem(a, D.jorge, { kind: "deduction", description: "Occupational accident insurance", amountCents: 4200, recurring: true });
    const run = await settlementRun(a, lastSunday, new Date(lastSunday.getTime() + 7 * DAY));
    const ids = run.map((r) => r.settlementId).filter(Boolean) as string[];
    if (ids.length > 1) {
      await approveSettlements(a, ids.slice(0, Math.ceil(ids.length / 2)));
      await paySettlements(a, ids.slice(0, 1), { method: "ach", reference: "ACH batch 0921" }).catch(() => null);
    }
  });

  // ---------------- safety ----------------
  await step("document type: medical card", () => create(a, "documentType", { name: "Drug & alcohol policy receipt", appliesTo: "driver", tracksExpiry: false, required: false, blocksDispatch: false }));
  for (const [d, n] of [[D.rafael, 9], [D.marisol, 9], [D.jorge, 9], [D.kevin, 7], [D.luz, 9], [D.arturo, 8], [D.hector, 9], [D.priya, 6], [D.tomas, 3], [D.denise, 9]] as const)
    await step("dq file", async () => {
      const items = ["application", "mvr_hire", "road_test", "clearinghouse_full", "prior_employers", "mvr_annual", "annual_review", "clearinghouse_annual"].slice(0, n);
      for (const k of items) await S.recordDq(a, d, k, { completedAt: new Date(now - (k.includes("annual") ? 120 : 380) * DAY), note: k === "annual_review" ? "Reviewed by S. Guerra" : null });
      if (n >= 6) await S.addTest(a, { driverId: d, reason: "pre_employment", substance: "drug", collectedAt: new Date(now - 395 * DAY), result: "negative", specimenId: `CCF-${Math.floor(1000000 + Math.random() * 8999999)}`, collector: "Laredo Occupational Health (demo)" });
    });
  await step("D&A random draw", async () => {
    const q = Math.floor(new Date(now).getUTCMonth() / 3) + 1;
    await S.drawRandom(a, { period: `${new Date(now).getUTCFullYear()}-Q${q}`, drugRate: 50, alcoholRate: 10, drawsPerYear: 4 });
  });
  await step("inspections", async () => {
    await S.saveInspection(a, null, { inspectedAt: new Date(now - 9 * DAY), country: "US", jurisdiction: "TX", level: 2, driverId: D.hector, truckId: T["207"], reportNumber: "TXDEMO0001", location: "Laredo, World Trade Bridge", violations: [{ code: "393.9", description: "Inoperable required lamp", severity: 6, oos: false }] });
    await S.saveInspection(a, null, { inspectedAt: new Date(now - 30 * DAY), country: "US", jurisdiction: "TX", level: 1, driverId: D.jorge, truckId: T["203"], reportNumber: "TXDEMO0002", violations: [] });
    await S.saveInspection(a, null, { inspectedAt: new Date(now - 64 * DAY), country: "US", jurisdiction: "OK", level: 1, driverId: D.rafael, truckId: T["201"], reportNumber: "OKDEMO0003", violations: [{ code: "395.8(e)", description: "False report of driver's record of duty status", severity: 7, oos: true }, { code: "396.3(a)(1)", description: "Brakes out of adjustment", severity: 4, oos: false }] });
    await S.saveInspection(a, null, { inspectedAt: new Date(now - 40 * DAY), country: "CA", jurisdiction: "ON", level: 2, driverId: D.priya, truckId: T["208"], reportNumber: "ONDEMO0004", violations: [] });
    await S.saveInspection(a, null, { inspectedAt: new Date(now - 120 * DAY), country: "US", jurisdiction: "TX", level: 3, driverId: D.arturo, reportNumber: "TXDEMO0005", violations: [{ code: "391.11(b)(2)", description: "Non-English-speaking driver", severity: 4, oos: false, removed: true }] });
  });
  await step("incident", () => saveIncident(a, null, { occurredAt: new Date(now - 6 * DAY), kind: "accident", driverId: D.jorge, truckId: T["203"], location: "Trinity DC yard, Dallas TX", description: "Backing onto door 9, trailer clipped the bumper post. No injuries, minor damage.", status: "under_review", preventable: "preventable" }));
  await step("incident 2", () => saveIncident(a, null, { occurredAt: new Date(now - 21 * DAY), kind: "cargo", driverId: D.marisol, description: "Two pallets shifted in transit, one case crushed. Claim filed by the customer.", claimNumber: "CLM-44120", status: "open" }));

  // ---------------- fuel for IFTA ----------------
  for (const [truckU, j, g, dd] of [["201", "TX", 180, 3], ["201", "OK", 150, 8], ["203", "TX", 160, 5], ["207", "AR", 140, 1], ["207", "TX", 170, 2], ["202", "TX", 120, 6], ["208", "MI", 110, 4]] as const)
    await step("fuel", () => addFuelPurchase(a, { truckId: T[truckU], purchasedAt: new Date(now - dd * DAY).toISOString().slice(0, 10), jurisdiction: j, gallons: g, amountCents: g * 379, vendor: "Demo Travel Center" }));

  // ---------------- drivers talking to dispatch ----------------
  await step("messages", async () => {
    await driverMessage(a.tenantId, D.marisol, null, "Still on the door at Trinity, they say 1 more hour");
    await driverMessage(a.tenantId, D.hector, null, "Detour off I-30, adding ~3 hours. Customer knows?");
    await driverMessage(a.tenantId, D.arturo, null, "En la fila del puente, 40 min aprox.");
  });

  await step("compliance run", () => evaluateAll(a));
  return log;
}
