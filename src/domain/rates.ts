import { and, eq, isNull, lte, desc, asc, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { FuelBand } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { zonedDate } from "@/lib/time";
import { coords, roadMiles } from "@/lib/geo";
import { NotFoundError, ValidationError, zoneMatches } from "./orders";

/**
 * Customer lane rates and fuel surcharge tables: a load built for a customer on a lane they have a
 * contract for is priced from it — flat or per mile with its minimum — and its fuel surcharge comes from
 * the rate (a percent or cents per mile) or from the fuel table at the week's diesel price.
 */

// ---------- fuel tables ----------

/** Pure: the surcharge a table gives at a diesel price (cents per gallon); null when no band covers it. */
export function fscValue(bands: FuelBand[], priceCents: number): number | null {
  const b = [...bands].sort((p, q) => p.from - q.from).find((x) => priceCents >= x.from && (x.to == null || priceCents < x.to));
  return b ? b.value : null;
}

/** Monday of the week a date falls in, as YYYY-MM-DD. */
export function mondayOf(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400_000).toISOString().slice(0, 10);
}

function cleanBands(bands: FuelBand[]) {
  if (!Array.isArray(bands) || !bands.length) throw new ValidationError("a table needs at least one price band", "bands");
  const out = bands.map((b, i) => {
    const from = Math.round(Number(b.from));
    const to = b.to == null || (b.to as unknown) === "" ? null : Math.round(Number(b.to));
    const value = Math.round(Number(b.value));
    if (!Number.isFinite(from) || from < 0) throw new ValidationError(`band ${i + 1}: price from`, "bands");
    if (to != null && (!Number.isFinite(to) || to <= from)) throw new ValidationError(`band ${i + 1}: "to" must be above "from"`, "bands");
    if (!Number.isFinite(value) || value < 0) throw new ValidationError(`band ${i + 1}: surcharge`, "bands");
    return { from, to, value };
  });
  out.sort((p, q) => p.from - q.from);
  for (let i = 1; i < out.length; i++) if (out[i - 1].to == null || out[i - 1].to! > out[i].from) throw new ValidationError(`bands ${i} and ${i + 1} overlap`, "bands");
  return out;
}

export async function listFuel(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [tables, prices] = await Promise.all([
    db.select().from(s.fuelTables).where(and(eq(s.fuelTables.tenantId, ctx.tenantId), isNull(s.fuelTables.archivedAt))).orderBy(asc(s.fuelTables.name)),
    db.select().from(s.fuelPrices).where(eq(s.fuelPrices.tenantId, ctx.tenantId)).orderBy(desc(s.fuelPrices.weekOf)).limit(26),
  ]);
  return { tables, prices };
}

export async function saveFuelTable(ctx: Ctx, input: { id?: string | null; name: string; method: string; bands: FuelBand[]; isDefault?: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const name = input.name?.trim();
  if (!name) throw new ValidationError("name the table", "name");
  const bands = cleanBands(input.bands);
  const method = input.method === "per_mile" ? "per_mile" : "pct";
  const id = input.id ?? newId();
  await db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(s.fuelTables).set({ isDefault: false }).where(eq(s.fuelTables.tenantId, ctx.tenantId));
    if (input.id) {
      const [cur] = await tx.select().from(s.fuelTables).where(and(eq(s.fuelTables.tenantId, ctx.tenantId), eq(s.fuelTables.id, input.id))).limit(1);
      if (!cur || cur.archivedAt) throw new NotFoundError("fuel table", input.id);
      await tx.update(s.fuelTables).set({ name, method, bands, isDefault: !!input.isDefault, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.fuelTables.id, cur.id));
    } else await tx.insert(s.fuelTables).values({ id, tenantId: ctx.tenantId, name, method, bands, isDefault: !!input.isDefault, createdBy: ctx.userId, updatedBy: ctx.userId });
    await writeAudit(tx, ctx, "fuel_table", id, input.id ? "update" : "create", undefined, name);
  });
  return { id };
}

export async function deleteFuelTable(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  await db.update(s.fuelTables).set({ archivedAt: new Date(), isDefault: false, updatedBy: ctx.userId }).where(and(eq(s.fuelTables.tenantId, ctx.tenantId), eq(s.fuelTables.id, id)));
  await writeAudit(db, ctx, "fuel_table", id, "archive");
}

/** The week's diesel price (cents per gallon); a second entry for the same week replaces it. */
export async function setFuelPrice(ctx: Ctx, date: string, priceCents: number, source = "manual") {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("the week as YYYY-MM-DD", "weekOf");
  if (!Number.isFinite(priceCents) || priceCents < 100 || priceCents > 2000) throw new ValidationError("a diesel price per gallon between $1 and $20", "price");
  const weekOf = mondayOf(date);
  await db
    .insert(s.fuelPrices)
    .values({ id: newId(), tenantId: ctx.tenantId, weekOf, priceCents: Math.round(priceCents), source, createdBy: ctx.userId, updatedBy: ctx.userId })
    .onConflictDoUpdate({ target: [s.fuelPrices.tenantId, s.fuelPrices.weekOf], set: { priceCents: Math.round(priceCents), source, updatedAt: new Date(), updatedBy: ctx.userId } });
  await writeAudit(db, ctx, "fuel_price", weekOf, "update", undefined, `$${(priceCents / 100).toFixed(2)}/gal week of ${weekOf}`);
  return { weekOf };
}

/** The price in force for a date: that week's, or the latest before it. */
export async function fuelPriceFor(tenantId: string, date: string) {
  const [p] = await db.select().from(s.fuelPrices).where(and(eq(s.fuelPrices.tenantId, tenantId), lte(s.fuelPrices.weekOf, mondayOf(date)))).orderBy(desc(s.fuelPrices.weekOf)).limit(1);
  return p ?? null;
}

// ---------- customer lane rates ----------

export type RateSuggestion = {
  rateId: string;
  lane: string;
  rateType: "flat" | "per_mile";
  unitCents: number;
  miles: number | null;
  rateCents: number | null; // the line haul, when it can be figured
  minimumApplied: boolean;
  currency: string;
  fuel: { rule: "included" | "pct" | "per_mile"; pct: number | null; centsPerMile: number | null; note: string | null };
  notes: string | null;
};

/**
 * The contract rate for a customer on a lane (first pickup → last delivery), valid on the pickup date,
 * equipment matching or unspecified; the newest wins. Per-mile lanes use the miles given and the minimum.
 */
export async function suggestCustomerRate(ctx: Ctx, input: { customerId: string; equipment?: string | null; from: { name: string; address?: { city?: string | null; state?: string | null } | null }; to: { name: string; address?: { city?: string | null; state?: string | null } | null }; miles?: number | null; date?: string | null }): Promise<RateSuggestion | null> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const [tenant] = await db.select({ zone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const date = input.date && /^\d{4}-\d{2}-\d{2}/.test(input.date) ? input.date.slice(0, 10) : zonedDate(new Date(), tenant?.zone ?? "America/Detroit");
  const at = new Date(`${date}T12:00:00Z`);
  const rates = await db.select().from(s.customerRates).where(and(eq(s.customerRates.tenantId, ctx.tenantId), eq(s.customerRates.customerId, input.customerId), isNull(s.customerRates.archivedAt)));
  const hits = rates.filter((r) => r.validFrom.getTime() <= at.getTime() + 86400_000 && (!r.validTo || r.validTo.getTime() >= at.getTime() - 86400_000) && zoneMatches(r.originZone, input.from) && zoneMatches(r.destinationZone, input.to) && (!r.equipment || !input.equipment || r.equipment === input.equipment));
  if (!hits.length) return null;
  const best = hits.sort((p, q) => (q.equipment ? 1 : 0) - (p.equipment ? 1 : 0) || q.updatedAt.getTime() - p.updatedAt.getTime())[0];
  const perMile = best.rateType === "per_mile";
  let rateCents: number | null = perMile ? (input.miles ? Math.round(best.rateCents * input.miles) : null) : best.rateCents;
  let minimumApplied = false;
  if (perMile && rateCents != null && best.minimumCents && rateCents < best.minimumCents) {
    rateCents = best.minimumCents;
    minimumApplied = true;
  }
  const fuel: RateSuggestion["fuel"] = { rule: "included", pct: null, centsPerMile: null, note: null };
  if (best.fuelRule === "pct" && best.fuelValue != null) Object.assign(fuel, { rule: "pct", pct: best.fuelValue, note: `${best.fuelValue}% on the rate` });
  else if (best.fuelRule === "per_mile" && best.fuelValue != null) Object.assign(fuel, { rule: "per_mile", centsPerMile: best.fuelValue, note: `${best.fuelValue}¢/mi on the rate` });
  else if (best.fuelRule === "table") {
    const [table] = await db.select().from(s.fuelTables).where(and(eq(s.fuelTables.tenantId, ctx.tenantId), eq(s.fuelTables.isDefault, true), isNull(s.fuelTables.archivedAt))).limit(1);
    const price = await fuelPriceFor(ctx.tenantId, date);
    if (!table) fuel.note = "no default fuel table — set one under Billing → Fuel";
    else if (!price) fuel.note = `no diesel price entered for the week of ${mondayOf(date)}`;
    else {
      const v = fscValue(table.bands, price.priceCents);
      if (v == null) fuel.note = `${table.name} has no band for $${(price.priceCents / 100).toFixed(2)}/gal`;
      else if (table.method === "pct") Object.assign(fuel, { rule: "pct", pct: Math.round(v / 100), note: `${table.name}: ${(v / 100).toFixed(2)}% at $${(price.priceCents / 100).toFixed(2)}/gal (week of ${price.weekOf})` });
      else Object.assign(fuel, { rule: "per_mile", centsPerMile: v, note: `${table.name}: ${v}¢/mi at $${(price.priceCents / 100).toFixed(2)}/gal (week of ${price.weekOf})` });
    }
  }
  return { rateId: best.id, lane: `${best.originZone} → ${best.destinationZone}`, rateType: perMile ? "per_mile" : "flat", unitCents: best.rateCents, miles: input.miles ?? null, rateCents, minimumApplied, currency: best.currency, fuel, notes: best.notes ?? null };
}

/** Estimated road miles along the stops, from the saved locations' coordinates; null when any stop has none. */
export async function routeMiles(ctx: Ctx, locationIds: (string | null)[]) {
  assertCtx(ctx);
  if (locationIds.length < 2 || locationIds.some((x) => !x)) return null;
  const rows = await db.select({ id: s.locations.id, lat: s.locations.lat, lng: s.locations.lng }).from(s.locations).where(and(eq(s.locations.tenantId, ctx.tenantId), inArray(s.locations.id, locationIds as string[])));
  const pts = locationIds.map((id) => {
    const r = rows.find((x) => x.id === id);
    return r ? coords(r.lat, r.lng) : null;
  });
  if (pts.some((p) => !p)) return null;
  let mi = 0;
  for (let i = 1; i < pts.length; i++) mi += roadMiles(pts[i - 1]!, pts[i]!);
  return Math.round(mi);
}
