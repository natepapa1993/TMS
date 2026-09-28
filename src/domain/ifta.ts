import { and, eq, gte, lt, inArray, isNotNull, asc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { zonedDate, zonedMidnight } from "@/lib/time";
import { coords, haversineMiles, roadMiles } from "@/lib/geo";
import { ValidationError, NotFoundError } from "./orders";
import { splitSegment, jurisdictionCode, IFTA_MEMBERS, JURISDICTION_COUNTRY } from "./ifta-geo";
import { readTable } from "./load-import";

/**
 * IFTA: the quarterly fuel-tax return. Miles by jurisdiction come from the trucks' GPS positions (ELD or
 * the driver app) where there are any, else from each completed leg's route between its stops, plus
 * trip-sheet entries; fuel comes from purchases entered or imported from the fuel card. The return:
 * fleet MPG = all miles ÷ all gallons; in each member jurisdiction taxable gallons = its miles ÷ MPG,
 * net = taxable − tax-paid gallons bought there, tax = net × the quarter's rate (a credit when negative).
 */

// ---------- quarters ----------

export function quarterOf(date: string) {
  const [y, m] = date.split("-").map(Number);
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}
export function quarterDates(q: string) {
  const m = /^(\d{4})Q([1-4])$/.exec(q);
  if (!m) throw new ValidationError("quarter as 2026Q3", "quarter");
  const y = Number(m[1]);
  const n = Number(m[2]);
  const start = `${y}-${String((n - 1) * 3 + 1).padStart(2, "0")}-01`;
  const end = n === 4 ? `${y + 1}-01-01` : `${y}-${String(n * 3 + 1).padStart(2, "0")}-01`;
  return { start, end };
}
async function zoneOf(tenantId: string) {
  const [t] = await db.select({ zone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  return t?.zone ?? "America/Detroit";
}
async function quarterRange(tenantId: string, q: string) {
  const zone = await zoneOf(tenantId);
  const { start, end } = quarterDates(q);
  return { zone, from: zonedMidnight(start, zone), to: zonedMidnight(end, zone), start, end };
}

// ---------- miles ----------

type Acc = Map<string, { truckId: string; date: string; jurisdiction: string; miles: number; source: string; legId: string | null; note: string | null }>;
function add(acc: Acc, r: { truckId: string; date: string; jurisdiction: string; miles: number; source: string; legId?: string | null; note?: string | null }) {
  const key = [r.truckId, r.date, r.jurisdiction, r.source, r.legId ?? ""].join("|");
  const cur = acc.get(key);
  if (cur) cur.miles += r.miles;
  else acc.set(key, { ...r, legId: r.legId ?? null, note: r.note ?? null });
}

const GPS_MAX_GAP_MS = 3 * 3600_000;
const GPS_MAX_JUMP_MI = 250;

/**
 * Recompute the quarter's miles: GPS first (consecutive positions of a truck, straight line between
 * them, split where the line crosses a border), then every completed leg of our trucks that has no GPS
 * of its own, along the line between its stops scaled to its planned (or estimated road) miles.
 * Trip-sheet entries are kept.
 */
export async function computeMiles(ctx: Ctx, quarter: string) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const { zone, from, to } = await quarterRange(ctx.tenantId, quarter);
  const acc: Acc = new Map();
  const warnings: string[] = [];

  // GPS
  const pos = await db
    .select({ truckId: s.positions.truckId, legId: s.positions.legId, at: s.positions.at, lat: s.positions.lat, lng: s.positions.lng })
    .from(s.positions)
    .where(and(eq(s.positions.tenantId, ctx.tenantId), isNotNull(s.positions.truckId), gte(s.positions.at, from), lt(s.positions.at, to)))
    .orderBy(asc(s.positions.truckId), asc(s.positions.at));
  const gpsLegs = new Set<string>();
  let gpsMiles = 0;
  for (let i = 1; i < pos.length; i++) {
    const p = pos[i - 1];
    const q = pos[i];
    if (p.truckId !== q.truckId) continue;
    if (q.legId) gpsLegs.add(q.legId);
    if (q.at.getTime() - p.at.getTime() > GPS_MAX_GAP_MS) continue;
    const a = coords(p.lat, p.lng);
    const b = coords(q.lat, q.lng);
    if (!a || !b) continue;
    const d = haversineMiles(a, b);
    if (d < 0.05 || d > GPS_MAX_JUMP_MI) continue;
    gpsMiles += d;
    for (const [j, m] of Object.entries(splitSegment(a, b, d))) add(acc, { truckId: q.truckId!, date: zonedDate(q.at, zone), jurisdiction: j, miles: m, source: "gps" });
  }
  if (pos[0]?.legId) gpsLegs.add(pos[0].legId);

  // completed legs without GPS
  const legs = await db
    .select({ id: s.legs.id, orderId: s.legs.orderId, truckId: s.legs.truckId, fromStopId: s.legs.fromStopId, toStopId: s.legs.toStopId, plannedMiles: s.legs.plannedMiles, completedAt: s.legs.completedAt })
    .from(s.legs)
    .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.state, "completed"), isNotNull(s.legs.truckId), gte(s.legs.completedAt, from), lt(s.legs.completedAt, to)));
  const todo = legs.filter((l) => !gpsLegs.has(l.id));
  const stopIds = todo.flatMap((l) => [l.fromStopId, l.toStopId]).filter((x): x is string => !!x);
  const stops = stopIds.length ? await db.select().from(s.stops).where(inArray(s.stops.id, stopIds)) : [];
  const locIds = stops.map((x) => x.locationId).filter((x): x is string => !!x);
  const locs = locIds.length ? await db.select({ id: s.locations.id, lat: s.locations.lat, lng: s.locations.lng }).from(s.locations).where(inArray(s.locations.id, locIds)) : [];
  const orderIds = [...new Set(todo.map((l) => l.orderId))];
  const orders = orderIds.length ? await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(inArray(s.orders.id, orderIds)) : [];
  let legMiles = 0;
  for (const l of todo) {
    const f = stops.find((x) => x.id === l.fromStopId);
    const t = stops.find((x) => x.id === l.toStopId);
    const num = orders.find((o) => o.id === l.orderId)?.orderNumber ?? "a load";
    const pt = (st?: (typeof stops)[number]) => {
      if (!st) return null;
      const c = coords(st.lat, st.lng);
      if (c) return c;
      const loc = locs.find((x) => x.id === st.locationId);
      return loc ? coords(loc.lat, loc.lng) : null;
    };
    const a = pt(f);
    const b = pt(t);
    const miles = l.plannedMiles ?? (a && b ? Math.round(roadMiles(a, b)) : null);
    if (!miles) {
      warnings.push(`${num}: no miles on the leg and no coordinates to estimate them`);
      continue;
    }
    legMiles += miles;
    const date = zonedDate(l.completedAt!, zone);
    if (a && b) {
      for (const [j, m] of Object.entries(splitSegment(a, b, miles))) add(acc, { truckId: l.truckId!, date, jurisdiction: j, miles: m, source: "leg_estimate", legId: l.id });
      continue;
    }
    const ja = jurisdictionCode(f?.address?.state, f?.country);
    const jb = jurisdictionCode(t?.address?.state, t?.country);
    if (ja && jb && ja === jb) add(acc, { truckId: l.truckId!, date, jurisdiction: ja, miles, source: "leg_estimate", legId: l.id });
    else if (ja && jb) {
      add(acc, { truckId: l.truckId!, date, jurisdiction: ja, miles: miles / 2, source: "leg_estimate", legId: l.id, note: "split evenly: stops without coordinates" });
      add(acc, { truckId: l.truckId!, date, jurisdiction: jb, miles: miles / 2, source: "leg_estimate", legId: l.id, note: "split evenly: stops without coordinates" });
      warnings.push(`${num}: ${ja} → ${jb} split evenly (save the stops as locations with coordinates for an exact split)`);
    } else {
      add(acc, { truckId: l.truckId!, date, jurisdiction: ja ?? jb ?? "??", miles, source: "leg_estimate", legId: l.id, note: "jurisdiction unknown" });
      warnings.push(`${num}: the stops have no state — ${miles} mi unassigned`);
    }
  }

  const rows = [...acc.values()].filter((r) => r.miles >= 0.05);
  await db.transaction(async (tx) => {
    await tx.delete(s.iftaMiles).where(and(eq(s.iftaMiles.tenantId, ctx.tenantId), eq(s.iftaMiles.quarter, quarter), inArray(s.iftaMiles.source, ["gps", "leg_estimate"])));
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(s.iftaMiles).values(rows.slice(i, i + 500).map((r) => ({ id: newId(), tenantId: ctx.tenantId, quarter, truckId: r.truckId, date: r.date, jurisdiction: r.jurisdiction, milesTenths: Math.round(r.miles * 10), source: r.source, legId: r.legId, note: r.note, createdBy: ctx.userId, updatedBy: ctx.userId })));
  });
  await writeAudit(db, ctx, "ifta", quarter, "update", undefined, `miles recomputed: ${Math.round(gpsMiles)} GPS, ${legMiles} from legs`);
  return { gpsMiles: Math.round(gpsMiles), legMiles, legsFromGps: gpsLegs.size, legsEstimated: todo.length, warnings };
}

/** A trip-sheet entry: miles a truck ran in a jurisdiction on a day (what GPS and the legs cannot see: a repair run, a deadhead with no app). */
export async function addTripMiles(ctx: Ctx, input: { truckId: string; date: string; jurisdiction: string; miles: number; note?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const j = jurisdictionCode(input.jurisdiction);
  if (!j) throw new ValidationError("a state or province code (TX, ON…) or MX", "jurisdiction");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ValidationError("the date", "date");
  if (!Number.isFinite(input.miles) || input.miles <= 0 || input.miles > 5000) throw new ValidationError("miles between 0 and 5,000", "miles");
  const [truck] = await db.select({ id: s.trucks.id }).from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, input.truckId))).limit(1);
  if (!truck) throw new NotFoundError("truck", input.truckId);
  const id = newId();
  await db.insert(s.iftaMiles).values({ id, tenantId: ctx.tenantId, quarter: quarterOf(input.date), truckId: truck.id, date: input.date, jurisdiction: j, milesTenths: Math.round(input.miles * 10), source: "trip_sheet", note: input.note?.trim() || null, createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, "ifta", id, "create", undefined, `trip sheet ${input.miles} mi ${j} on ${input.date}`);
  return { id };
}

export async function deleteTripMiles(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const [r] = await db.select().from(s.iftaMiles).where(and(eq(s.iftaMiles.tenantId, ctx.tenantId), eq(s.iftaMiles.id, id))).limit(1);
  if (!r) throw new NotFoundError("miles entry", id);
  if (r.source !== "trip_sheet") throw new ValidationError("computed miles are replaced by recomputing; add a trip-sheet entry to correct them");
  await db.delete(s.iftaMiles).where(eq(s.iftaMiles.id, id));
  await writeAudit(db, ctx, "ifta", id, "archive");
}

// ---------- fuel ----------

export type FuelInput = { truckId?: string | null; driverId?: string | null; purchasedAt: string; jurisdiction: string; country?: string | null; gallons?: number | null; liters?: number | null; fuelType?: string; amountCents?: number | null; currency?: string; vendor?: string | null; city?: string | null; receiptNumber?: string | null; taxPaid?: boolean; source?: string };
const LITER = 0.264172;

function cleanFuel(input: FuelInput) {
  const j = jurisdictionCode(input.jurisdiction, input.country);
  if (!j) throw new ValidationError(`"${input.jurisdiction ?? ""}" is not a state, province or MX`, "jurisdiction");
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.purchasedAt) ? `${input.purchasedAt}T12:00:00Z` : input.purchasedAt);
  if (Number.isNaN(at.getTime())) throw new ValidationError("the purchase date", "purchasedAt");
  const gal = input.gallons != null ? input.gallons : input.liters != null ? input.liters * LITER : NaN;
  if (!Number.isFinite(gal) || gal <= 0 || gal > 2000) throw new ValidationError("gallons (or liters) bought", "gallons");
  const fuelType = ["diesel", "gasoline", "def"].includes(input.fuelType ?? "") ? input.fuelType! : "diesel";
  return { j, at, gallonsMilli: Math.round(gal * 1000), fuelType };
}

export async function addFuelPurchase(ctx: Ctx, input: FuelInput) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const c = cleanFuel(input);
  if (input.truckId) {
    const [t] = await db.select({ id: s.trucks.id }).from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), eq(s.trucks.id, input.truckId))).limit(1);
    if (!t) throw new NotFoundError("truck", input.truckId);
  }
  const id = newId();
  await db.insert(s.fuelPurchases).values({ id, tenantId: ctx.tenantId, truckId: input.truckId || null, driverId: input.driverId || null, purchasedAt: c.at, jurisdiction: c.j, gallonsMilli: c.gallonsMilli, fuelType: c.fuelType, amountCents: input.amountCents ?? null, currency: input.currency ?? (c.j === "MX" ? "MXN" : JURISDICTION_COUNTRY[c.j] === "CA" ? "CAD" : "USD"), vendor: input.vendor?.trim() || null, city: input.city?.trim() || null, receiptNumber: input.receiptNumber?.trim() || null, taxPaid: input.taxPaid ?? true, source: input.source ?? "manual", createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, "fuel_purchase", id, "create", undefined, `${(c.gallonsMilli / 1000).toFixed(1)} gal ${c.j}`);
  return { id };
}

export async function deleteFuelPurchase(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const r = await db.delete(s.fuelPurchases).where(and(eq(s.fuelPurchases.tenantId, ctx.tenantId), eq(s.fuelPurchases.id, id))).returning({ id: s.fuelPurchases.id });
  if (!r.length) throw new NotFoundError("fuel purchase", id);
  await writeAudit(db, ctx, "fuel_purchase", id, "archive");
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const FUEL_ALIAS: Record<string, string[]> = {
  date: ["date", "transactiondate", "trandate", "purchasedate", "fecha", "posteddate"],
  time: ["time", "transactiontime", "hora"],
  unit: ["unit", "unitnumber", "truck", "trucknumber", "vehicle", "vehicleid", "tractor", "unidad"],
  jurisdiction: ["state", "st", "jurisdiction", "province", "stateprov", "stateprovince", "locationstate", "estado"],
  country: ["country", "pais"],
  gallons: ["gallons", "gal", "qty", "quantity", "fuelgallons", "dieselgallons", "units", "volume"],
  liters: ["liters", "litres", "litros"],
  amount: ["amount", "total", "totalamount", "netamount", "cost", "fuelamount", "importe"],
  vendor: ["vendor", "merchant", "truckstop", "location", "locationname", "site", "station", "chain"],
  city: ["city", "locationcity", "ciudad"],
  receipt: ["receipt", "receiptnumber", "invoice", "invoicenumber", "transaction", "transactionid", "trannumber", "ticket"],
  product: ["product", "fueltype", "item", "productcode", "producto"],
};
function col(headers: string[], field: string) {
  const want = FUEL_ALIAS[field];
  return headers.find((h) => want.includes(norm(h))) ?? null;
}

/**
 * Import a fuel-card or fuel-receipt sheet (.xlsx or .csv, any card's export: headers matched by name).
 * Trucks matched by unit number; DEF lines kept as DEF (not taxable fuel); a purchase already on file
 * (same truck, time, gallons and receipt) is skipped.
 */
export async function importFuelPurchases(ctx: Ctx, file: { fileName: string; bytes: Buffer }) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const table = await readTable(file);
  const h = Object.fromEntries(Object.keys(FUEL_ALIAS).map((k) => [k, col(table.headers, k)])) as Record<string, string | null>;
  const missing = ["date", "jurisdiction"].filter((k) => !h[k]);
  if (!h.gallons && !h.liters) missing.push("gallons");
  if (missing.length) throw new ValidationError(`the sheet needs columns for ${missing.join(", ")} (found: ${table.headers.join(", ")})`, "file");
  const trucks = await db.select({ id: s.trucks.id, unit: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId));
  const existing = await db.select({ truckId: s.fuelPurchases.truckId, at: s.fuelPurchases.purchasedAt, g: s.fuelPurchases.gallonsMilli, r: s.fuelPurchases.receiptNumber }).from(s.fuelPurchases).where(eq(s.fuelPurchases.tenantId, ctx.tenantId));
  const seen = new Set(existing.map((e) => `${e.truckId}|${e.at.getTime()}|${e.g}|${e.r ?? ""}`));
  const num = (v?: string) => (v ? Number(v.replace(/[$,\s]/g, "")) : NaN);
  let added = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of table.rows.entries()) {
    const rowNo = i + 2;
    try {
      const unit = h.unit ? r[h.unit]?.trim() : "";
      const truck = unit ? trucks.find((t) => t.unit.toLowerCase() === unit.toLowerCase() || t.unit.replace(/^0+/, "") === unit.replace(/^0+/, "")) : null;
      if (unit && !truck) {
        skipped.push({ row: rowNo, reason: `unit ${unit} is not one of your trucks` });
        continue;
      }
      const product = (h.product ? r[h.product] : "")?.toLowerCase() ?? "";
      const fuelType = /def|exhaust|urea/.test(product) ? "def" : /gas|unl|regular/.test(product) && !/diesel/.test(product) ? "gasoline" : "diesel";
      if (product && /reefer|oil|cash|scale|wash|toll|fee|misc/.test(product) && !/diesel|fuel/.test(product)) {
        skipped.push({ row: rowNo, reason: `not fuel (${r[h.product!]})` });
        continue;
      }
      const date = r[h.date!]?.trim() ?? "";
      const iso = /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : (() => {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(date);
        return m ? `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : date;
      })();
      const time = h.time ? r[h.time]?.trim() : "";
      const purchasedAt = time && /^\d{1,2}:\d{2}/.test(time) ? `${iso}T${time.padStart(5, "0").slice(0, 5)}:00Z` : iso;
      const c = cleanFuel({ purchasedAt, jurisdiction: r[h.jurisdiction!] ?? "", country: h.country ? r[h.country] : null, gallons: h.gallons ? num(r[h.gallons]) : null, liters: !h.gallons && h.liters ? num(r[h.liters]) : null, fuelType });
      const receipt = h.receipt ? r[h.receipt]?.trim() || null : null;
      const key = `${truck?.id ?? null}|${c.at.getTime()}|${c.gallonsMilli}|${receipt ?? ""}`;
      if (seen.has(key)) {
        skipped.push({ row: rowNo, reason: "already on file" });
        continue;
      }
      seen.add(key);
      const amt = h.amount ? num(r[h.amount]) : NaN;
      await db.insert(s.fuelPurchases).values({ id: newId(), tenantId: ctx.tenantId, truckId: truck?.id ?? null, purchasedAt: c.at, jurisdiction: c.j, gallonsMilli: c.gallonsMilli, fuelType: c.fuelType, amountCents: Number.isFinite(amt) ? Math.round(amt * 100) : null, currency: c.j === "MX" ? "MXN" : JURISDICTION_COUNTRY[c.j] === "CA" ? "CAD" : "USD", vendor: h.vendor ? r[h.vendor]?.trim() || null : null, city: h.city ? r[h.city]?.trim() || null : null, receiptNumber: receipt, source: "import", createdBy: ctx.userId, updatedBy: ctx.userId });
      added++;
    } catch (e) {
      skipped.push({ row: rowNo, reason: (e as Error).message });
    }
  }
  await writeAudit(db, ctx, "fuel_purchase", "import", "import", undefined, `${file.fileName}: ${added} added, ${skipped.length} skipped`);
  return { added, skipped };
}

// ---------- rates ----------

/** The quarter's rates; each row replaces the jurisdiction's rate (a blank rate removes it). */
export async function setRates(ctx: Ctx, quarter: string, rows: { jurisdiction: string; rate: number | null; surcharge?: number | null }[]) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  quarterDates(quarter);
  let saved = 0;
  for (const r of rows) {
    const j = jurisdictionCode(r.jurisdiction);
    if (!j || !IFTA_MEMBERS.has(j)) throw new ValidationError(`${r.jurisdiction}: not an IFTA jurisdiction`, "rates");
    if (r.rate == null) {
      await db.delete(s.iftaRates).where(and(eq(s.iftaRates.tenantId, ctx.tenantId), eq(s.iftaRates.quarter, quarter), eq(s.iftaRates.jurisdiction, j)));
      continue;
    }
    if (!Number.isFinite(r.rate) || r.rate < 0 || r.rate > 3) throw new ValidationError(`${j}: rate in $ per gallon (0–3)`, "rates");
    if (r.surcharge != null && (!Number.isFinite(r.surcharge) || r.surcharge < 0 || r.surcharge > 3)) throw new ValidationError(`${j}: surcharge in $ per gallon`, "rates");
    const rateE4 = Math.round(r.rate * 10000);
    const surchargeE4 = r.surcharge != null ? Math.round(r.surcharge * 10000) : null;
    await db
      .insert(s.iftaRates)
      .values({ id: newId(), tenantId: ctx.tenantId, quarter, jurisdiction: j, rateE4, surchargeE4, createdBy: ctx.userId, updatedBy: ctx.userId })
      .onConflictDoUpdate({ target: [s.iftaRates.tenantId, s.iftaRates.quarter, s.iftaRates.jurisdiction], set: { rateE4, surchargeE4, updatedAt: new Date(), updatedBy: ctx.userId } });
    saved++;
  }
  await writeAudit(db, ctx, "ifta", quarter, "update", undefined, `${saved} rate(s) set`);
  return { saved };
}

/** Copy the last quarter's rates that are not yet set for this one (rates change often: check them). */
export async function copyRatesFrom(ctx: Ctx, quarter: string, fromQuarter: string) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.edit");
  const prev = await db.select().from(s.iftaRates).where(and(eq(s.iftaRates.tenantId, ctx.tenantId), eq(s.iftaRates.quarter, fromQuarter)));
  const cur = await db.select({ j: s.iftaRates.jurisdiction }).from(s.iftaRates).where(and(eq(s.iftaRates.tenantId, ctx.tenantId), eq(s.iftaRates.quarter, quarter)));
  const have = new Set(cur.map((c) => c.j));
  const rows = prev.filter((p) => !have.has(p.jurisdiction));
  if (rows.length) await db.insert(s.iftaRates).values(rows.map((p) => ({ id: newId(), tenantId: ctx.tenantId, quarter, jurisdiction: p.jurisdiction, rateE4: p.rateE4, surchargeE4: p.surchargeE4, createdBy: ctx.userId, updatedBy: ctx.userId })));
  return { copied: rows.length };
}

export function previousQuarter(q: string) {
  const [y, n] = q.split("Q").map(Number);
  return n === 1 ? `${y - 1}Q4` : `${y}Q${n - 1}`;
}

// ---------- the return ----------

export type IftaRow = { jurisdiction: string; member: boolean; miles: number; taxableGallons: number; paidGallons: number; netGallons: number; rate: number | null; surcharge: number | null; taxCents: number | null };

/** Pure: the return from miles and gallons by jurisdiction and the quarter's rates. MPG uses every gallon; the credit only tax-paid ones. */
export function iftaReturn(miles: Record<string, number>, gallons: Record<string, number>, rates: Record<string, { rateE4: number; surchargeE4: number | null }>, paidGallons: Record<string, number> = gallons) {
  const totalMiles = Object.values(miles).reduce((a, b) => a + b, 0);
  const totalGallons = Object.values(gallons).reduce((a, b) => a + b, 0);
  const mpg = totalGallons > 0 ? Math.round((totalMiles / totalGallons) * 100) / 100 : null;
  const codes = [...new Set([...Object.keys(miles), ...Object.keys(gallons)])].sort((a, b) => Number(IFTA_MEMBERS.has(b)) - Number(IFTA_MEMBERS.has(a)) || a.localeCompare(b));
  const rows: IftaRow[] = codes.map((j) => {
    const m = miles[j] ?? 0;
    const paid = paidGallons[j] ?? 0;
    const taxable = mpg ? m / mpg : 0;
    const net = taxable - paid;
    const member = IFTA_MEMBERS.has(j);
    const r = rates[j];
    const taxCents = member && r && mpg ? Math.round((net * r.rateE4) / 100 + (taxable * (r.surchargeE4 ?? 0)) / 100) : null;
    return { jurisdiction: j, member, miles: Math.round(m), taxableGallons: Math.round(taxable * 10) / 10, paidGallons: Math.round(paid * 10) / 10, netGallons: Math.round(net * 10) / 10, rate: r ? r.rateE4 / 10000 : null, surcharge: r?.surchargeE4 != null ? r.surchargeE4 / 10000 : null, taxCents };
  });
  const members = rows.filter((r) => r.member);
  return {
    totalMiles: Math.round(totalMiles),
    iftaMiles: Math.round(members.reduce((a, r) => a + (miles[r.jurisdiction] ?? 0), 0)),
    totalGallons: Math.round(totalGallons * 10) / 10,
    mpg,
    rows,
    taxDueCents: members.reduce((a, r) => a + (r.taxCents ?? 0), 0),
    missingRates: members.filter((r) => r.rate == null && (r.miles > 0 || r.paidGallons > 0)).map((r) => r.jurisdiction),
  };
}

/** The quarter's return for the fleet (or one truck), with the per-truck MPG and what to check. */
export async function iftaReport(ctx: Ctx, quarter: string, truckId?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.view");
  const { from, to } = await quarterRange(ctx.tenantId, quarter);
  const [milesRows, fuelRows, rateRows, trucks] = await Promise.all([
    db.select().from(s.iftaMiles).where(and(eq(s.iftaMiles.tenantId, ctx.tenantId), eq(s.iftaMiles.quarter, quarter), truckId ? eq(s.iftaMiles.truckId, truckId) : sql`true`)),
    db.select().from(s.fuelPurchases).where(and(eq(s.fuelPurchases.tenantId, ctx.tenantId), gte(s.fuelPurchases.purchasedAt, from), lt(s.fuelPurchases.purchasedAt, to), truckId ? eq(s.fuelPurchases.truckId, truckId) : sql`true`)),
    db.select().from(s.iftaRates).where(and(eq(s.iftaRates.tenantId, ctx.tenantId), eq(s.iftaRates.quarter, quarter))),
    db.select({ id: s.trucks.id, unit: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, ctx.tenantId)),
  ]);
  const miles: Record<string, number> = {};
  for (const r of milesRows) miles[r.jurisdiction] = (miles[r.jurisdiction] ?? 0) + r.milesTenths / 10;
  const taxable = fuelRows.filter((f) => f.fuelType !== "def");
  const gallonsAll: Record<string, number> = {};
  const gallonsPaid: Record<string, number> = {};
  for (const f of taxable) {
    gallonsAll[f.jurisdiction] = (gallonsAll[f.jurisdiction] ?? 0) + f.gallonsMilli / 1000;
    if (f.taxPaid) gallonsPaid[f.jurisdiction] = (gallonsPaid[f.jurisdiction] ?? 0) + f.gallonsMilli / 1000;
  }
  const rates = Object.fromEntries(rateRows.map((r) => [r.jurisdiction, { rateE4: r.rateE4, surchargeE4: r.surchargeE4 }]));
  const ret = iftaReturn(miles, gallonsAll, rates, gallonsPaid);
  const taxDueCents = ret.taxDueCents;
  const perTruck = trucks
    .map((t) => {
      const m = milesRows.filter((r) => r.truckId === t.id).reduce((a, r) => a + r.milesTenths / 10, 0);
      const g = taxable.filter((f) => f.truckId === t.id).reduce((a, f) => a + f.gallonsMilli / 1000, 0);
      return { truckId: t.id, unit: t.unit, miles: Math.round(m), gallons: Math.round(g * 10) / 10, mpg: g > 0 ? Math.round((m / g) * 100) / 100 : null };
    })
    .filter((t) => t.miles || t.gallons);
  const warnings: string[] = [];
  if (!fuelRows.length) warnings.push("No fuel purchases this quarter: import the fuel card or enter the receipts.");
  if (!milesRows.length) warnings.push("No miles yet: recalculate from GPS and the loads, or add trip-sheet miles.");
  for (const t of perTruck) {
    if (t.miles && !t.gallons) warnings.push(`Truck ${t.unit}: ${t.miles.toLocaleString()} mi but no fuel.`);
    else if (t.gallons && !t.miles) warnings.push(`Truck ${t.unit}: fuel but no miles.`);
    else if (t.mpg != null && (t.mpg < 3 || t.mpg > 12)) warnings.push(`Truck ${t.unit}: ${t.mpg} MPG looks wrong — missing miles or fuel?`);
  }
  if (miles["??"]) warnings.push(`${Math.round(miles["??"])} mi have no jurisdiction (stops without a state).`);
  if (ret.missingRates.length) warnings.push(`No tax rate entered for ${ret.missingRates.join(", ")} — copy them from the IFTA rate matrix for ${quarter}.`);
  const sources: Record<string, number> = {};
  for (const r of milesRows) sources[r.source] = (sources[r.source] ?? 0) + r.milesTenths / 10;
  return { quarter, ...ret, taxDueCents, perTruck, warnings, sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, Math.round(v)])), fuelCount: fuelRows.length, defGallons: Math.round(fuelRows.filter((f) => f.fuelType === "def").reduce((a, f) => a + f.gallonsMilli / 1000, 0) * 10) / 10 };
}

/** The purchases and trip-sheet entries of a quarter, for the page. */
export async function iftaDetail(ctx: Ctx, quarter: string) {
  assertCtx(ctx);
  requirePermission(ctx, "ifta.view");
  const { from, to } = await quarterRange(ctx.tenantId, quarter);
  const [fuel, trips, rates] = await Promise.all([
    db.select().from(s.fuelPurchases).where(and(eq(s.fuelPurchases.tenantId, ctx.tenantId), gte(s.fuelPurchases.purchasedAt, from), lt(s.fuelPurchases.purchasedAt, to))).orderBy(asc(s.fuelPurchases.purchasedAt)),
    db.select().from(s.iftaMiles).where(and(eq(s.iftaMiles.tenantId, ctx.tenantId), eq(s.iftaMiles.quarter, quarter), eq(s.iftaMiles.source, "trip_sheet"))).orderBy(asc(s.iftaMiles.date)),
    db.select().from(s.iftaRates).where(and(eq(s.iftaRates.tenantId, ctx.tenantId), eq(s.iftaRates.quarter, quarter))),
  ]);
  return { fuel, trips, rates };
}

/** The return as CSV, one row per jurisdiction. */
export function iftaCsv(r: Awaited<ReturnType<typeof iftaReport>>) {
  const lines = [["Jurisdiction", "IFTA member", "Miles", "Taxable gallons", "Tax-paid gallons", "Net taxable gallons", "Rate $/gal", "Surcharge $/gal", "Tax (credit) $"].join(",")];
  for (const x of r.rows) lines.push([x.jurisdiction, x.member ? "yes" : "no", x.miles, x.taxableGallons, x.paidGallons, x.netGallons, x.rate ?? "", x.surcharge ?? "", x.taxCents != null ? (x.taxCents / 100).toFixed(2) : ""].join(","));
  lines.push(["Total", "", r.totalMiles, "", r.totalGallons, "", "", "", (r.taxDueCents / 100).toFixed(2)].join(","));
  lines.push(`Fleet MPG,${r.mpg ?? ""}`);
  return lines.join("\n") + "\n";
}
