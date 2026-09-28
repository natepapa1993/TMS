// Features: F-9 reporting — owner dashboard numbers and breakdowns computed from the same orders, charges, bills and settlements F-7.6
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { flags, orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import * as B from "./billing";
import * as R from "./reports";
import { zonedDate } from "@/lib/time";
import { updateCompany } from "./company";

/** statements for this week can only be approved once it has ended */
const afterWeek = new Date(Date.now() + 8 * 86400_000);

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; magna: string; garza: string; t2104: string; t2117: string; reyes: string; cruz: string; entity: string };
const period = () => ({ from: zonedDate(new Date(Date.now() - 30 * 86400_000), "America/Detroit"), to: zonedDate(new Date(Date.now() + 86400_000), "America/Detroit") });

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  const entity = await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: [] });
  const magna = await create(a, "customer", { name: "Magna", kind: "customer", termsDays: 45, requiredDocs: [] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const t2117 = await create(a, "truck", { unitNumber: "2117", usPlate: "RC59022", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t2104.id });
  const cruz = await create(a, "driver", { name: "Alejandro Cruz", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 60, currentTruckId: t2117.id });
  f = { rxo: rxo.id, magna: magna.id, garza: garza.id, t2104: t2104.id, t2117: t2117.id, reyes: reyes.id, cruz: cruz.id, entity: entity.id };
});

async function domestic(customerId: string, rate: number, truck: string, driver: string, miles: number, from = "Laredo", to = "San Antonio") {
  const o = await createOrder(a, { customerId, rateCents: rate, stops: [{ type: "pickup", name: `${from} Yard`, country: "US", address: { city: from, state: "TX" } }, { type: "delivery", name: `${to} plant`, country: "US", address: { city: to, state: "TX" } }], template: "domestic", book: true });
  await planLeg(a, o.legs[0].id, { kind: "truck", truckId: truck, driverId: driver }, { plannedMiles: miles });
  await dispatchLeg(a, o.legs[0].id);
  await acceptLeg(a, o.legs[0].id);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
  return o;
}

describe("reports", () => {
  it("dashboard: revenue, loads, revenue per truck, margin from charges − (carrier + driver pay + fuel + tolls), empty %, at-risk, crossings pending, expiring docs, AR", async () => {
    await updateCompany(a, { fuelCostCentsPerMile: 50 });
    const o1 = await domestic(f.rxo, 180000, f.t2104, f.reyes, 400); // 2104 Reyes
    const o2 = await domestic(f.magna, 120000, f.t2117, f.cruz, 300, "Laredo", "Dallas"); // 2117 Cruz
    await domestic(f.rxo, 90000, f.t2104, f.reyes, 200); // 2104 again
    // an equipment move on 2117 (empty miles)
    const em = await createOrder(a, { customerId: f.magna, rateCents: 0, stops: [{ type: "yard", name: "Dallas yard", country: "US", address: { city: "Dallas", state: "TX" } }, { type: "yard", name: "Laredo yard", country: "US", address: { city: "Laredo", state: "TX" } }], template: "equipment_move", book: true });
    await planLeg(a, em.legs[0].id, { kind: "truck", truckId: f.t2117, driverId: f.cruz }, { plannedMiles: 100 });
    await dispatchLeg(a, em.legs[0].id);
    await acceptLeg(a, em.legs[0].id);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, em.legs[0].id, st);
    // one carrier order with an approved bill
    const oc = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops: [{ type: "pickup", name: "MTY", country: "MX", address: { city: "Monterrey", state: "NL" } }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US", address: { city: "Laredo", state: "TX" } }], template: "mx_crossing", book: true });
    for (const leg of oc.legs) {
      await planLeg(a, leg.id, { kind: "carrier", carrierId: f.garza, carrierRateCents: leg.type === "mx" ? 45000 : 15000 });
      await dispatchLeg(a, leg.id);
      await acceptLeg(a, leg.id, "carrier");
      for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg.id, st, { source: "carrier" });
    }
    await B.syncCarrierBills(a);
    // driver pay: Reyes' statement approved (o1 + o3 = 600 mi × .62 = 372.00)
    const { start, end } = B.weekOf(new Date());
    let st = await B.buildSettlement(a, f.reyes, start, end);
    st = await B.settlementTransition(a, st.id, "reviewed");
    await B.settlementTransition(a, st.id, "approved", { now: afterWeek });
    // an issued, overdue invoice and a red flag
    const inv = await B.issueInvoice(a, (await B.createInvoice(a, [o1.order.id])).id, { issuedAt: new Date(Date.now() - 45 * 86400_000) });
    await B.recordReceipt(a, inv.id, { amountCents: 50000, method: "ach", receivedAt: new Date() });
    await db.insert(flags).values({ id: newId(), tenantId: a.tenantId, orderId: o2.order.id, code: "no_position", level: "red", title: "No position for 2 h" });
    await db.update(orders).set({ state: "in_transit" }).where(eq(orders.id, o2.order.id)); // pretend it is still rolling for the at-risk count

    const dash = await R.dashboard(a, period());
    // o2 was pushed back to in_transit above, so delivered revenue = o1 + o3 + em (0) + oc
    expect(dash.loads).toBe(4);
    expect(dash.revenueCents).toBe(180000 + 90000 + 0 + 285000);
    expect(dash.activeTrucks).toBe(2); // 2104 on o1/o3, 2117 on the equipment move
    expect(dash.revenuePerTruckCents).toBe(Math.round(555000 / 2));
    // margin: revenue 555000 − carrier 60000 − driver pay 37200 (statement) − Cruz's 100 mi × .60 on the equipment
    // move (no statement yet: estimated from his rule) − fuel (400+200+100) × 50 = 35000 − tolls 0
    expect(dash.marginCents).toBe(555000 - 60000 - 37200 - 6000 - 35000);
    expect(dash.marginPct).toBe(Math.round(((555000 - 138200) / 555000) * 1000) / 10);
    expect(dash.emptyPct).toBe(Math.round((100 / 700) * 1000) / 10);
    expect(dash.atRisk.count).toBe(1);
    expect(dash.atRisk.orders[0].orderNumber).toBe(o2.order.orderNumber);
    expect(dash.crossingsPending.count).toBe(0); // oc is delivered (cleared)
    expect(dash.expiringDocs.count).toBeGreaterThanOrEqual(0);
    expect(dash.arOpenCents).toBe(130000);
    expect(dash.arOverdueCents).toBe(130000);
  });

  it("breakdowns: by truck (split evenly across units), customer, lane, carrier, week; CSV; entity filter", async () => {
    await updateCompany(a, { fuelCostCentsPerMile: 50 });
    await domestic(f.rxo, 180000, f.t2104, f.reyes, 400);
    await domestic(f.magna, 120000, f.t2117, f.cruz, 300, "Laredo", "Dallas");
    await domestic(f.rxo, 90000, f.t2104, f.reyes, 200);
    const byTruck = await R.breakdown(a, "truck", period());
    expect(byTruck.map((r) => [r.label, r.loads, r.revenueCents, r.miles])).toEqual([
      ["Unit 2104", 2, 270000, 600],
      ["Unit 2117", 1, 120000, 300],
    ]);
    // no statement yet: driver pay is estimated from Reyes' rule (600 mi × .62), plus fuel
    expect(byTruck[0].costCents).toBe(600 * 50 + 600 * 62);
    expect(byTruck[0].marginPct).toBe(Math.round(((270000 - 67200) / 270000) * 1000) / 10);
    const byCustomer = await R.breakdown(a, "customer", period());
    expect(byCustomer.map((r) => [r.label, r.loads])).toEqual([
      ["RXO", 2],
      ["Magna", 1],
    ]);
    const byLane = await R.breakdown(a, "lane", period());
    expect(byLane.map((r) => r.label)).toEqual(["Laredo, TX → San Antonio, TX", "Laredo, TX → Dallas, TX"]);
    // every load is on our trucks: one row saying so, so the table still adds up to the tiles
    expect((await R.breakdown(a, "carrier", period())).map((r) => [r.label, r.loads])).toEqual([["Our own trucks (no carrier)", 3]]);
    const byWeek = await R.breakdown(a, "week", period());
    expect(byWeek).toHaveLength(1);
    expect(byWeek[0].loads).toBe(3);
    const csv = R.breakdownCsv("truck", byTruck);
    expect(csv.split("\n")[0]).toBe("truck,loads,revenue,cost,margin,margin_pct,miles");
    expect(csv.split("\n")[1]).toBe("Unit 2104,2,2700.00,672.00,2028.00,75.1,600");
    // entity filter: nothing is on the entity → empty; after tagging one order → just it
    expect(await R.breakdown(a, "truck", period(), f.entity)).toEqual([]);
    await db.update(orders).set({ billingEntityId: f.entity }).where(eq(orders.orderNumber, "26-00002"));
    expect((await R.breakdown(a, "truck", period(), f.entity)).map((r) => r.label)).toEqual(["Unit 2117"]);
    const detail = await R.orderDetail(a, period(), null, byTruck[0].orderIds);
    expect(detail.map((x) => x.orderNumber).sort()).toEqual(["26-00001", "26-00003"]);
    expect(detail[0].fuel).toBe(detail[0].miles * 50);
  });

  it("periods: default is month-to-date and week is Sunday–Saturday, in the company zone", () => {
    expect(R.defaultPeriod(new Date("2026-09-27T03:00:00Z"), "America/Detroit")).toEqual({ from: "2026-09-01", to: "2026-09-26" });
    expect(R.weekPeriod(new Date("2026-09-27T03:00:00Z"), "America/Detroit")).toEqual({ from: "2026-09-20", to: "2026-09-26" });
    expect(R.weekPeriod(new Date("2026-09-27T03:00:00Z"), "UTC")).toEqual({ from: "2026-09-27", to: "2026-10-03" });
  });
});

describe("the owner's Monday email", () => {
  it("goes out once, on a Monday after 7 in the company zone, with last week's numbers; nothing without a sender", async () => {
    const { integrations, outbox, tenants } = await import("@/db/schema");
    // a load delivered last week (Wednesday), in the company zone
    const o = await domestic(f.rxo, 180000, f.t2104, f.reyes, 420);
    await db.update(orders).set({ deliveredAt: new Date("2026-09-23T15:00:00Z") }).where(eq(orders.id, o.order.id));
    const monday = new Date("2026-09-28T12:30:00Z"); // 8:30 AM Detroit
    // Sunday: nothing; Monday too early: nothing
    expect(await R.sendOwnerWeekly(new Date("2026-09-27T14:00:00Z"))).toMatchObject({ sent: 0 });
    expect(await R.sendOwnerWeekly(new Date("2026-09-28T09:30:00Z"))).toMatchObject({ sent: 0 }); // 5:30 AM Detroit
    // no sender: marked as done for the week, nothing queued
    expect(await R.sendOwnerWeekly(monday)).toMatchObject({ sent: 0 });
    expect(await db.select().from(outbox)).toHaveLength(0);
    await db.update(tenants).set({ settings: {} }).where(eq(tenants.id, a.tenantId));
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "resend", enabled: true, config: { apiKey: "re_test", from: "Reports <r@example.com>" } });
    expect(await R.sendOwnerWeekly(monday)).toMatchObject({ sent: 1 });
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectKind, "owner_weekly"));
    expect(mail.to).toBe(a.email);
    expect(mail.subject).toBe("Last week: $1,800.00 on 1 load, 100% margin".replace("100% margin", `${(await R.dashboard(a, { from: "2026-09-20", to: "2026-09-26" })).marginPct}% margin`));
    expect(mail.body).toContain("week of 2026-09-20 to 2026-09-26");
    expect(mail.body).toContain("RXO: $1,800.00 on 1 load");
    expect(mail.body).toContain("Unit 2104");
    expect(mail.body).toContain("/reports?range=custom&from=2026-09-20&to=2026-09-26");
    // the same Monday again: once
    expect(await R.sendOwnerWeekly(new Date("2026-09-28T16:00:00Z"))).toMatchObject({ sent: 0 });
  });
});
