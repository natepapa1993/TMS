import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations, trucks } from "@/db/schema";
import { systemCtx } from "@/lib/context";
import { recordPosition } from "@/domain/tracking";

/**
 * Motive (KeepTruckin) ELD: vehicle locations → positions (spec §5.1).
 * Per-tenant API key lives in the integrations table (Settings → Integrations), never in code.
 * Docs: GET https://api.gomotive.com/v1/vehicle_locations  (X-Api-Key)
 */

export type MotiveVehicleLocation = {
  vehicle: { id: number; number?: string | null; current_location?: { lat: number; lon: number; located_at: string; speed?: number | null; bearing?: number | null; description?: string | null } | null };
};

/** Pure: turn Motive's payload into position inputs keyed by ELD vehicle id / unit number. */
export function parseVehicleLocations(payload: { vehicles?: MotiveVehicleLocation[] } | MotiveVehicleLocation[]) {
  const list = Array.isArray(payload) ? payload : (payload.vehicles ?? []);
  const out: { eldVehicleId: string; unitNumber: string | null; at: Date; lat: number; lng: number; speedMph: number | null; heading: number | null; place: string | null; externalId: string }[] = [];
  for (const v of list) {
    const loc = v.vehicle?.current_location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") continue;
    const at = new Date(loc.located_at);
    if (Number.isNaN(at.getTime())) continue;
    out.push({
      eldVehicleId: String(v.vehicle.id),
      unitNumber: v.vehicle.number ?? null,
      at,
      lat: loc.lat,
      lng: loc.lon,
      speedMph: loc.speed != null ? Math.round(loc.speed) : null,
      heading: loc.bearing != null ? Math.round(loc.bearing) : null,
      place: loc.description ?? null,
      externalId: `motive:${v.vehicle.id}:${at.toISOString()}`,
    });
  }
  return out;
}

export async function fetchVehicleLocations(apiKey: string, fetchImpl: typeof fetch = fetch) {
  const all: MotiveVehicleLocation[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.gomotive.com/v1/vehicle_locations?per_page=100&page_no=${page}`, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
    if (!res.ok) throw new Error(`motive ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { vehicles?: MotiveVehicleLocation[]; pagination?: { total?: number; per_page?: number; page_no?: number } };
    all.push(...(json.vehicles ?? []));
    const total = json.pagination?.total ?? 0;
    if (!json.vehicles?.length || all.length >= total) break;
  }
  return all;
}

/** One tenant: pull, match to trucks by eldVehicleId (then unit number), record. */
export async function pollMotive(tenantId: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
  const ctx = systemCtx(tenantId);
  const raw = await fetchVehicleLocations(apiKey, fetchImpl);
  const parsed = parseVehicleLocations(raw);
  const fleet = await db.select({ id: trucks.id, unitNumber: trucks.unitNumber, eldVehicleId: trucks.eldVehicleId }).from(trucks).where(eq(trucks.tenantId, tenantId));
  let recorded = 0;
  let unmatched = 0;
  let duplicates = 0;
  for (const p of parsed) {
    const truck = fleet.find((t) => t.eldVehicleId && t.eldVehicleId === p.eldVehicleId) ?? fleet.find((t) => p.unitNumber && t.unitNumber.toLowerCase() === p.unitNumber.toLowerCase());
    if (!truck) {
      unmatched++;
      continue;
    }
    const r = await recordPosition(ctx, { source: "eld", truckId: truck.id, at: p.at, lat: p.lat, lng: p.lng, speedMph: p.speedMph, heading: p.heading, place: p.place, externalId: p.externalId });
    if (r.duplicate) duplicates++;
    else recorded++;
  }
  return { vehicles: parsed.length, recorded, duplicates, unmatched };
}

/** Job: every tenant with Motive enabled. Errors are stored on the integration row, not thrown. */
export async function pollMotiveAll(now = new Date(), fetchImpl: typeof fetch = fetch) {
  const rows = await db.select().from(integrations).where(and(eq(integrations.provider, "motive"), eq(integrations.enabled, true)));
  let polled = 0;
  for (const row of rows) {
    const key = row.config.apiKey;
    if (!key) continue;
    try {
      const r = await pollMotive(row.tenantId, key, fetchImpl);
      await db.update(integrations).set({ lastRunAt: now, lastError: null, lastResult: JSON.stringify(r) }).where(eq(integrations.id, row.id));
      polled++;
    } catch (e) {
      await db.update(integrations).set({ lastRunAt: now, lastError: String((e as Error).message).slice(0, 500) }).where(eq(integrations.id, row.id));
    }
  }
  return { polled };
}
