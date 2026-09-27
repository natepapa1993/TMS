// Features: F-1.1 the product starts empty — the old demo seed is cleared once, never over anything a person entered
import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { truncateAll } from "@/test/helpers";
import { db } from "./client";
import { customers, orders, users, tenants, integrations } from "./schema";
import { createTenantWithOwner } from "@/lib/auth";
import { create } from "@/data/records";

/** What the old startup seed left behind: a company, its owner, and invented master data and loads. */
async function seedDemo() {
  const { tenantId, userId } = await createTenantWithOwner({ tenantName: "Demo Carrier", slug: "demo", ownerName: "Demo Owner", email: "demo@crossline.local", password: "crossline-demo-2026" });
  const ctx = { tenantId, userId, role: "owner" as const };
  const rxo = await create(ctx, "customer", { name: "RXO", kind: "broker" });
  await create(ctx, "customer", { name: "Magna", kind: "customer" });
  await create(ctx, "truck", { unitNumber: "2117", usPlate: "RC59022" });
  const { createOrder } = await import("@/domain/orders");
  await createOrder(ctx, { customerId: rxo.id, rateCents: 180000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
}
import { clearSeededDemo } from "./clear-seed";
import { newId } from "@/lib/ids";

beforeEach(async () => {
  await truncateAll();
});

describe("clearing the old demo seed", () => {
  it("removes every seeded record, keeps the login, the company and integration keys, and runs once", async () => {
    expect(await clearSeededDemo()).toMatch(/no seeded account/);
    await seedDemo();
    const [u] = await db.select().from(users).where(eq(users.email, "demo@crossline.local"));
    await db.insert(integrations).values({ id: newId(), tenantId: u.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk" } });
    expect((await db.select().from(customers)).length).toBeGreaterThan(0);
    const r = await clearSeededDemo();
    expect(r).toMatch(/^cleared the seeded data/);
    expect(await db.select().from(customers)).toHaveLength(0);
    expect(await db.select().from(orders)).toHaveLength(0);
    const left = (await db.execute(sql`select count(*)::int as n from trucks`)) as unknown as { n: number }[];
    expect(left[0].n).toBe(0);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await db.select().from(integrations)).toHaveLength(1);
    expect(await clearSeededDemo()).toBe("already cleared");
  });

  it("refuses when someone entered anything after the seed, and says what", async () => {
    await seedDemo();
    const [c] = await db.select().from(customers).limit(1);
    await db.update(customers).set({ createdAt: new Date(Date.now() + 3600_000) }).where(eq(customers.id, c.id)); // a customer added later
    const r = await clearSeededDemo();
    expect(r).toMatch(/^NOT cleared — records created after the seed in Demo Carrier: customers: 1/);
    expect((await db.select().from(customers)).length).toBeGreaterThan(1);
  });
});
