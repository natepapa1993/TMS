// Features: F-21.1 F-21.2
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { stops as stopsT, payItems } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import * as B from "./billing";
import { legPayLines, statementExtras, savePlan, assignPlan, deletePlan, listPlans, type LegPayInput } from "./pay-plans";

/** statements for this week can only be approved once it has ended */
const afterWeek = new Date(Date.now() + 8 * 86400_000);

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; dan: string; ana: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Pay Carrier");
  const cust = await create(a, "customer", { name: "Acme", kind: "broker" });
  const t1 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX", usPlateExpires: future });
  const dan = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
  const ana = await create(a, "driver", { name: "Ana Cruz", driverType: "CDL", licenseExpires: future, medicalExpires: future });
  f = { cust: cust.id, t1: t1.id, dan: dan.id, ana: ana.id };
});

const leg = (p: Partial<LegPayInput> = {}): LegPayInput => ({ legId: "l1", orderId: "o1", orderNumber: "26-00001", seq: 1, type: "domestic", customerId: "c1", equipment: "53_dry", loadedMiles: 500, emptyMiles: 40, stops: 3, hours: 10, linehaulCents: 200000, billedCents: 215000, firstLegOfLoad: true, team: false, ...p });

describe("pay rules, pure", () => {
  it("each kind of rule, with conditions and the team split", () => {
    const plan = {
      teamSplit: "half",
      rules: [
        { id: "1", kind: "per_loaded_mile" as const, amount: 60 },
        { id: "2", kind: "per_empty_mile" as const, amount: 30 },
        { id: "3", kind: "per_extra_stop" as const, amount: 2500 },
        { id: "4", kind: "crossing" as const, amount: 7500 },
        { id: "5", kind: "flat_per_load" as const, amount: 5000, when: { customerIds: ["c9"] } }, // not this customer
        { id: "6", kind: "pct_total" as const, amount: 500, when: { legTypes: ["crossing"] } },
      ],
    };
    const lines = legPayLines(plan, leg());
    expect(lines.map((l) => [l.description.split(" · ")[1], l.amountCents])).toEqual([
      ["500 loaded mi × $0.60", 30000],
      ["40 empty mi × $0.30", 1200],
      ["1 extra stop × $25.00", 2500],
    ]);
    const x = legPayLines(plan, leg({ type: "crossing", team: true }));
    expect(x.map((l) => l.amountCents)).toEqual([15000, 600, 1250, 3750, 5375]); // half each; 5% of 2,150 billed ÷ 2
    expect(x[0].description).toContain("(team ½)");
    expect(legPayLines({ ...plan, teamSplit: "full" }, leg({ type: "crossing", team: true }))[0].amountCents).toBe(30000);
  });
  it("a percent is paid once per load; a leg without miles says so", () => {
    const plan = { teamSplit: "half", rules: [{ id: "1", kind: "pct_linehaul" as const, amount: 2800 }, { id: "2", kind: "per_loaded_mile" as const, amount: 60 }] };
    expect(legPayLines(plan, leg({ firstLegOfLoad: false })).map((l) => l.amountCents)).toEqual([30000]);
    const noMiles = legPayLines(plan, leg({ loadedMiles: null }));
    expect(noMiles.map((l) => [l.amountCents, l.source])).toEqual([
      [56000, "line haul"],
      [0, "missing miles"],
    ]);
  });
  it("per diem for days worked, then a top-up to the minimum", () => {
    expect(statementExtras({ perDiemCents: 1500, minimumCents: 100000 }, 4, 80000).map((l) => [l.kind, l.amountCents])).toEqual([
      ["reimbursement", 6000],
      ["adjustment", 20000],
    ]);
    expect(statementExtras({ perDiemCents: null, minimumCents: 100000 }, 4, 120000)).toEqual([]);
  });
});

async function runLoad(driverId: string, miles: number, stopsList: { type: "pickup" | "delivery"; name: string; country: string }[], coDriverId?: string) {
  const o = await createOrder(a, { customerId: f.cust, rateCents: 200000, stops: stopsList, book: true });
  await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId, coDriverId }, { plannedMiles: miles, override: true, reason: "test" });
  await dispatchLeg(a, o.legs[0].id);
  await acceptLeg(a, o.legs[0].id);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
  return o;
}

describe("statements on a pay plan", () => {
  it("rules, empty miles from the last delivery, extra stops, per diem, minimum; escrow held until its target; advance taken back", async () => {
    const { id } = await savePlan(a, { name: "OTR solo", rules: [{ id: "", kind: "per_loaded_mile", amount: 60 }, { id: "", kind: "per_empty_mile", amount: 30 }, { id: "", kind: "per_extra_stop", amount: 2500 }], perDiemCents: 1500, minimumCents: 150000 });
    await assignPlan(a, [f.dan], id);
    const first = await runLoad(f.dan, 300, [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }]);
    const second = await runLoad(f.dan, 500, [{ type: "pickup", name: "C", country: "US" }, { type: "pickup", name: "C2", country: "US" }, { type: "delivery", name: "D", country: "US" }]);
    // coordinates: B (first delivery) and C (second pickup) about 40 road miles apart
    await db.update(stopsT).set({ lat: "42.30", lng: "-83.48" }).where(and(eq(stopsT.orderId, first.order.id), eq(stopsT.name, "B")));
    await db.update(stopsT).set({ lat: "42.66", lng: "-83.40" }).where(and(eq(stopsT.orderId, second.order.id), eq(stopsT.name, "C")));
    await B.addPayItem(a, f.dan, { kind: "escrow", description: "Escrow", amountCents: 10000, targetCents: 15000 });
    await B.addPayItem(a, f.dan, { kind: "advance", description: "Cash advance", amountCents: 20000 });
    const { start, end } = B.weekOf(new Date());
    const st = await B.buildSettlement(a, f.dan, start, end);
    const d = st.lines.map((l) => [l.source, l.amountCents]);
    expect(d).toContainEqual(["planned miles", 18000]); // 300 × 0.60
    expect(d).toContainEqual(["planned miles", 30000]); // 500 × 0.60
    const empty = st.lines.find((l) => l.source === "empty miles from the last delivery")!;
    expect(empty.qty).toBeGreaterThan(20);
    expect(empty.qty).toBeLessThan(40);
    expect(d).toContainEqual(["stops beyond pickup and delivery", 2500]);
    expect(d).toContainEqual(["plan", 1500]); // per diem, 1 day
    const topUp = st.lines.find((l) => l.source === "plan minimum")!;
    // the minimum is on earnings; per diem is a reimbursement on top
    const earned = st.lines.filter((l) => l.kind === "leg" || l.kind === "accessorial").reduce((s2, l) => s2 + l.amountCents, 0);
    expect(earned + topUp.amountCents).toBe(150000);
    expect(d).toContainEqual(["escrow", -10000]);
    expect(d).toContainEqual(["advance", -20000]);
    // paid: the escrow holds 100; the next statement only collects 50 more; the advance is gone
    for (const to of ["reviewed", "approved", "paid"] as const) await B.settlementTransition(a, st.id, to, { method: "ach", now: afterWeek });
    const [esc] = await db.select().from(payItems).where(and(eq(payItems.driverId, f.dan), eq(payItems.kind, "escrow")));
    expect(esc.balanceCents).toBe(10000);
    const next = B.weekOf(new Date(Date.now() + 7 * 86400_000));
    const st2 = await B.buildSettlement(a, f.dan, next.start, next.end);
    expect(st2.lines.map((l) => [l.source, l.amountCents])).toEqual(expect.arrayContaining([["escrow", -5000]]));
    expect(st2.lines.some((l) => l.source === "advance")).toBe(false);
    // release some escrow back
    await B.releaseEscrow(a, esc.id, 4000, "left the company");
    await expect(B.releaseEscrow(a, esc.id, 99999)).rejects.toThrow(/held/);
  });

  it("plans: need a rule, can't delete with drivers on them; drivers off a plan go back to their own pay", async () => {
    await expect(savePlan(a, { name: "Empty", rules: [] })).rejects.toThrow(/at least one rule/);
    await expect(savePlan(a, { name: "Bad", rules: [{ id: "", kind: "pct_linehaul", amount: 12000 }] })).rejects.toThrow(/at most 100/);
    const { id } = await savePlan(a, { name: "Team", rules: [{ id: "", kind: "per_loaded_mile", amount: 70 }], teamSplit: "full" });
    await assignPlan(a, [f.dan, f.ana], id);
    await expect(deletePlan(a, id)).rejects.toThrow(/still on this plan/);
    const { drivers } = await listPlans(a);
    expect(drivers.filter((x) => x.payPlanId === id).length).toBe(2);
    await runLoad(f.dan, 400, [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], f.ana);
    const { start, end } = B.weekOf(new Date());
    const st = await B.buildSettlement(a, f.ana, start, end);
    expect(st.lines.find((l) => l.kind === "leg")!.amountCents).toBe(28000); // full share for the co-driver
    await assignPlan(a, [f.dan, f.ana], null);
    await deletePlan(a, id);
  });
});
