// Features: F-5 tracking — Motive ELD poll
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { integrations, positions } from "@/db/schema";
import { newId } from "@/lib/ids";
import { parseVehicleLocations, pollMotive, pollMotiveAll } from "./motive";
import { eq } from "drizzle-orm";

const fixture = {
  vehicles: [
    { vehicle: { id: 101, number: "2117", current_location: { lat: 27.5064, lon: -99.5075, located_at: "2026-09-26T20:00:00Z", speed: 61.2, bearing: 350, description: "I-35 N, Laredo, TX" } } },
    { vehicle: { id: 102, number: "2104", current_location: { lat: 32.7357, lon: -97.1081, located_at: "2026-09-26T20:01:00Z", speed: 0, bearing: null, description: "Arlington, TX" } } },
    { vehicle: { id: 103, number: "9999", current_location: null } },
    { vehicle: { id: 104, number: "8888", current_location: { lat: 30, lon: -98, located_at: "not a date" } } },
  ],
  pagination: { total: 4, per_page: 100, page_no: 1 },
};

const fakeFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
});

describe("Motive ELD", () => {
  it("parses vehicle locations and skips vehicles without a usable fix", () => {
    const p = parseVehicleLocations(fixture);
    expect(p.length).toBe(2);
    expect(p[0]).toMatchObject({ eldVehicleId: "101", unitNumber: "2117", lat: 27.5064, lng: -99.5075, speedMph: 61, heading: 350, place: "I-35 N, Laredo, TX" });
    expect(p[0].externalId).toBe("motive:101:2026-09-26T20:00:00.000Z");
  });

  it("matches trucks by ELD vehicle id first, then by unit number; ignores the rest; de-dups on re-poll", async () => {
    const t2117 = await create(a, "truck", { unitNumber: "2117", eldProvider: "Motive", eldVehicleId: "101" });
    await create(a, "truck", { unitNumber: "2104" }); // matched by number
    const r1 = await pollMotive(a.tenantId, "k", fakeFetch(fixture));
    expect(r1).toEqual({ vehicles: 2, recorded: 2, duplicates: 0, unmatched: 0 });
    const r2 = await pollMotive(a.tenantId, "k", fakeFetch(fixture));
    expect(r2.duplicates).toBe(2);
    const pos = await db.select().from(positions).where(eq(positions.truckId, t2117.id));
    expect(pos.length).toBe(1);
    expect(pos[0].source).toBe("eld");
    expect(pos[0].place).toBe("I-35 N, Laredo, TX");
  });

  it("pollMotiveAll only runs enabled tenants and records errors on the integration row", async () => {
    await create(a, "truck", { unitNumber: "2117", eldVehicleId: "101" });
    const b = await makeTenant("B");
    await db.insert(integrations).values([
      { id: newId(), tenantId: a.tenantId, provider: "motive", enabled: true, config: { apiKey: "good" } },
      { id: newId(), tenantId: b.tenantId, provider: "motive", enabled: false, config: { apiKey: "off" } },
    ]);
    const r = await pollMotiveAll(new Date(), fakeFetch(fixture));
    expect(r.polled).toBe(1);
    const [row] = await db.select().from(integrations).where(eq(integrations.tenantId, a.tenantId));
    expect(row.lastError).toBeNull();
    expect(row.lastResult).toContain('"recorded":1');
    const bad = await pollMotiveAll(new Date(), fakeFetch({ error: "unauthorized" }, 401));
    expect(bad.polled).toBe(0);
    const [row2] = await db.select().from(integrations).where(eq(integrations.tenantId, a.tenantId));
    expect(row2.lastError).toMatch(/401/);
  });
});
