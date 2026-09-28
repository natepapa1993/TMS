// Features: F-20.1
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { legs as legsT, orders as ordersT } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder } from "./orders";
import { loadGrid, listViews, saveView, deleteView } from "./load-grid";

let a: Awaited<ReturnType<typeof makeTenant>>;
let cust: string;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Grid Carrier");
  cust = (await create(a, "customer", { name: "Acme Logistics", kind: "broker" })).id;
});

describe("load board rows", () => {
  it("flattens lane, dates, legs, money and miles into one row", async () => {
    const pickupAt = new Date("2026-10-02T13:00:00Z");
    const o = await createOrder(a, {
      customerId: cust,
      rateCents: 300000,
      refs: { po: "PO-1", reference: "L-9" },
      stops: [
        { type: "pickup", name: "Shipper Canton", country: "US", address: { city: "Canton", state: "MI" }, windowStart: pickupAt },
        { type: "yard", name: "Detroit yard", country: "US" },
        { type: "delivery", name: "Consignee Toronto", country: "CA", address: { city: "Toronto", state: "ON" } },
      ],
      book: true,
    });
    await db.update(legsT).set({ plannedMiles: 250, carrierRateCents: 50000 }).where(eq(legsT.id, o.legs[0].id));
    await db.update(legsT).set({ plannedMiles: 250 }).where(eq(legsT.id, o.legs[1].id));
    const [r] = await loadGrid(a);
    expect(r.orderNumber).toBe(o.order.orderNumber);
    expect(r.customer).toBe("Acme Logistics");
    expect([r.pickupCity, r.pickupState, r.pickupAt]).toEqual(["Canton", "MI", pickupAt.toISOString()]);
    expect([r.deliveryCity, r.deliveryCountry]).toEqual(["Toronto", "CA"]);
    expect(r.legs).toBe("US → Crossing");
    expect(r.stops).toBe(3);
    expect(r.crossBorder).toBe(true);
    expect(r.uncoveredLegs).toBe(2);
    expect(r.miles).toBe(500);
    expect(r.carrierCostCents).toBe(50000);
    expect(r.marginCents).toBeNull(); // legs not covered yet: cost unknown
    await db.update(legsT).set({ state: "planned", assigneeKind: "carrier" }).where(eq(legsT.orderId, o.order.id));
    expect((await loadGrid(a))[0].marginCents).toBe(250000);
    expect(r.rpmCents).toBe(600);
    expect([r.po, r.reference]).toEqual(["PO-1", "L-9"]);
    expect(r.crossing).toBe("New");
  });

  it("keeps open loads of any age; closed ones only inside the window", async () => {
    const old = await createOrder(a, { customerId: cust, rateCents: 1, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    const oldClosed = await createOrder(a, { customerId: cust, rateCents: 1, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] });
    const longAgo = new Date(Date.now() - 400 * 86400_000);
    await db.update(ordersT).set({ createdAt: longAgo }).where(eq(ordersT.id, old.order.id));
    await db.update(ordersT).set({ createdAt: longAgo, state: "cancelled" }).where(eq(ordersT.id, oldClosed.order.id));
    const in60 = (await loadGrid(a, { days: 60 })).map((r) => r.id);
    expect(in60).toContain(old.order.id);
    expect(in60).not.toContain(oldClosed.order.id);
    expect((await loadGrid(a, { days: 0 })).map((r) => r.id)).toContain(oldClosed.order.id);
  });

  it("never shows another company's loads", async () => {
    const b = await makeTenant("Other");
    await createOrder(a, { customerId: cust, rateCents: 1, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] });
    expect(await loadGrid(b)).toEqual([]);
  });
});

describe("saved views", () => {
  it("personal by default, shared when asked; only the owner changes them", async () => {
    const other = { ...a, userId: (await makeTenant()).userId, role: "dispatcher" as const };
    await db.execute(`update users set tenant_id = '${a.tenantId}' where id = '${other.userId}'`);
    const { id } = await saveView(a, "loads", { name: "My open", config: { quick: "open", hidden: ["po"] } });
    expect((await listViews(a, "loads")).map((v) => v.name)).toEqual(["My open"]);
    expect(await listViews(other, "loads")).toEqual([]);
    await saveView(a, "loads", { id, name: "My open", shared: true, config: { quick: "open" } });
    const seen = await listViews(other, "loads");
    expect(seen.map((v) => [v.name, v.shared, v.mine])).toEqual([["My open", true, false]]);
    await expect(saveView(other, "loads", { id, name: "hijack", config: {} })).rejects.toThrow(/owner/);
    await expect(deleteView(other, id)).rejects.toThrow(/owner/);
    await deleteView(a, id);
    expect(await listViews(a, "loads")).toEqual([]);
  });
  it("needs a name", async () => {
    await expect(saveView(a, "loads", { name: "  ", config: {} })).rejects.toThrow(/name/);
  });
});
