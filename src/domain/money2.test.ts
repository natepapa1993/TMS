// Features: F-7.28 F-7.29 F-7.35 pay run keeps lines added by hand; percent pay on the leg's share; estimated miles in pay, P&L, reports and the assign margin; report tables tie to the tiles
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { legs as legsT, stops as stopsT, settlements as settlementsT } from "@/db/schema";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, learnStopCoordinates } from "./orders";
import * as B from "./billing";
import * as R from "./reports";
import * as Run from "./settlement-run";
import { legShare, shareLabel, legPayLines, payTypeLines } from "./pay-plans-pure";
import { legMarginPreview } from "./pay-estimate";
import { toHome } from "./fx-rules";
import { updateCompany } from "./company";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; mxCust: string; garza: string; t1: string; t2: string; kevin: string; mateo: string; arturo: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  await create(a, "billingEntity", { legalName: "Frontera Freight LLC", country: "US", invoicePrefix: "FF", nextInvoiceNumber: 2401, isDefault: true, remitTo: { line1: "4100 Mines Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" } });
  const cust = await create(a, "customer", { name: "Summit Logistics", kind: "broker", termsDays: 30, billingEmail: "ap@summit.test", requiredDocs: [] });
  const mxCust = await create(a, "customer", { name: "Sierra Madre", country: "MX", termsDays: 30, billingEmail: "cxp@sierra.test", requiredDocs: [] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  await create(a, "carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test", mcNumber: "123456" });
  const t1 = await create(a, "truck", { unitNumber: "204", usPlate: "TX204", usPlateExpires: future });
  const t2 = await create(a, "truck", { unitNumber: "206", usPlate: "TX206", usPlateExpires: future });
  const kevin = await create(a, "driver", { name: "Kevin Walsh", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "pct", payRateCents: 2800, currentTruckId: t1.id });
  const mateo = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t2.id });
  const arturo = await create(a, "driver", { name: "Arturo Lima", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 60 });
  f = { cust: cust.id, mxCust: mxCust.id, garza: garza.id, t1: t1.id, t2: t2.id, kevin: kevin.id, mateo: mateo.id, arturo: arturo.id };
});

const finish = async (legId: string, by: "driver_app" | "carrier" = "driver_app") => {
  await dispatchLeg(a, legId);
  await acceptLeg(a, legId, by);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, legId, st);
};

/** Monterrey → Nuevo Laredo yard (Garza, pesos) → Laredo yard → San Antonio: nobody types miles, the stops give estimates. */
async function threeLeg(opts: { currency?: string; rateCents?: number; usDriver?: string; usTruck?: string } = {}) {
  const o = await createOrder(a, {
    customerId: opts.currency === "MXN" ? f.mxCust : f.cust,
    rateCents: opts.rateCents ?? 5310000,
    currency: opts.currency ?? "MXN",
    stops: [
      { type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" } },
      { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" } },
      { type: "yard", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } },
      { type: "delivery", name: "San Antonio DC", country: "US", address: { city: "San Antonio", state: "TX" } },
    ],
    template: "mx_crossing_us",
    book: true,
  });
  const [mx, cross, us] = o.legs;
  await planLeg(a, mx.id, { kind: "carrier", carrierId: f.garza, carrierRateCents: 1200000, carrierRateCurrency: "MXN" });
  await planLeg(a, us.id, { kind: "truck", truckId: opts.usTruck ?? f.t1, driverId: opts.usDriver ?? f.kevin });
  return { o, mx, cross, us };
}

describe("a leg's share of the load (pure)", () => {
  const L = (id: string, type: string, planned: number | null, est: number | null = null, state = "completed") => ({ id, type, state, plannedMiles: planned, estMiles: est });
  it("one leg is the whole load; by miles when every leg has them (typed or est.); evenly when one has none; an empty move has none; cancelled legs don't count", () => {
    expect(legShare("a", [L("a", "domestic", 400)])).toMatchObject({ share: 1, basis: "whole" });
    const s = legShare("c", [L("a", "mx", null, 140), L("b", "crossing", 8), L("c", "us", null, 152)]);
    expect(s).toMatchObject({ basis: "miles", legMiles: 152, loadMiles: 300, est: true });
    expect(s.share).toBeCloseTo(152 / 300);
    expect(shareLabel("us", s)).toBe("US leg share 50.7% (152 of 300 mi est.)");
    expect(legShare("c", [L("a", "mx", null), L("b", "crossing", 8), L("c", "us", 152)])).toMatchObject({ share: 1 / 3, basis: "legs" });
    expect(legShare("m", [L("m", "equipment_move", 20), L("c", "us", 152)])).toMatchObject({ share: 0, basis: "none" });
    expect(legShare("c", [L("a", "mx", 140, null, "cancelled"), L("c", "us", 152)])).toMatchObject({ share: 1, basis: "whole" });
  });

  it("a percent (pay type or plan rule) is of the leg's share, labelled; two percent drivers on one load never get more than the percent of the whole", () => {
    const legs = [L("a", "mx", 150), L("b", "us", 150)];
    const lines = [...payTypeLines({ payType: "pct", payRateCents: 2800 }, { id: "a", seq: 1, type: "mx", plannedMiles: 150 }, { orderNumber: "26-1", rateCents: 5310000, currency: "MXN", linehaulUsdCents: 287805, share: legShare("a", legs) }), ...payTypeLines({ payType: "pct", payRateCents: 2800 }, { id: "b", seq: 2, type: "us", plannedMiles: 150 }, { orderNumber: "26-1", rateCents: 5310000, currency: "MXN", linehaulUsdCents: 287805, share: legShare("b", legs) })];
    expect(lines[1].description).toBe("26-1 leg 2 · 28% of $1,439.03 — US leg share 50% (150 of 300 mi) of the load's $2,878.05 (MX$53,100.00)");
    expect(lines.reduce((x, l) => x + l.amountCents, 0)).toBeLessThanOrEqual(Math.round(287805 * 0.28) + 1);
    // one leg: the whole load, as before
    const one = payTypeLines({ payType: "pct", payRateCents: 2800 }, { id: "a", seq: 1, type: "domestic", plannedMiles: 400 }, { orderNumber: "26-2", rateCents: 100000, currency: "USD", linehaulUsdCents: 100000, share: legShare("a", [L("a", "domestic", 400)]) });
    expect(one[0]).toMatchObject({ amountCents: 28000, description: "26-2 leg 1 · 28% of $1,000.00" });
    // a plan's percent rule pays each leg its share
    const input = { legId: "b", orderId: "o", orderNumber: "26-1", seq: 2, type: "us", customerId: null, equipment: "dry_van", loadedMiles: 150, emptyMiles: null, stops: 1, hours: null, linehaulCents: 287805, billedCents: 287805, firstLegOfLoad: false, team: false, loadShare: legShare("b", legs) };
    const plan = legPayLines({ rules: [{ id: "r", kind: "pct_linehaul", amount: 2800 }], teamSplit: "half" }, input);
    expect(plan[0].amountCents).toBe(Math.round((Math.round(287805 / 2) * 2800) / 10000));
    expect(plan[0].description).toMatch(/US leg share 50% \(150 of 300 mi\) of the load's \$2878\.05 line haul/);
  });
});

describe("percent pay and estimated miles on a multi-leg load", () => {
  it("Kevin (28%) on the US leg only is paid 28% of the US leg's share, by estimated miles; the P&L and reports use the estimates too", async () => {
    const { o, us, mx, cross } = await threeLeg({ currency: "MXN" });
    const legRows = await db.select().from(legsT).where(eq(legsT.orderId, o.order.id));
    expect(legRows.every((l) => l.plannedMiles == null && (l.estMiles ?? 0) > 0)).toBe(true); // nobody typed miles
    await finish(us.id);
    await updateCompany(a, { fx: { MXN: "18.45" } }); // not invoiced yet: the company rate converts it
    const week = B.weekOf(new Date());
    const st = await B.buildSettlement(a, f.kevin, week.start, week.end);
    const line = st.lines.find((l) => l.legId === us.id)!;
    const total = legRows.reduce((x, l) => x + l.estMiles!, 0);
    const mine = legRows.find((l) => l.id === us.id)!.estMiles!;
    const rate = 184500;
    const base = Math.round(toHome(5310000, "MXN", rate) * (mine / total));
    expect(line.amountCents).toBe(Math.round((base * 2800) / 10000));
    expect(line.description).toContain(`US leg share`);
    expect(line.description).toContain(`(${mine} of ${total} mi est.)`);
    expect(line.source).toBe("leg share of the order rate");
    // the P&L: the paid leg counts what the statement pays; fuel on the US leg's estimated miles
    const pnl = await B.orderPnl(a, o.order.id);
    expect(pnl.driverPay).toBe(line.amountCents);
    expect(pnl.miles).toBe(mine);
    expect(pnl.fuel).toBeGreaterThan(0);
    void mx;
    void cross;
  });

  it("a per-mile driver on a multi-leg load with no typed miles: statement, P&L, reports and the assign margin all use the estimate", async () => {
    const { o, us } = await threeLeg({ currency: "USD", rateCents: 480000, usDriver: f.mateo, usTruck: f.t2 });
    const mine = (await db.select().from(legsT).where(eq(legsT.id, us.id)))[0].estMiles!;
    expect(mine).toBeGreaterThan(100);
    // before it runs: the assign margin counts this leg's pay and fuel, and the other legs' carrier
    const mp = await legMarginPreview(a, us.id, { driverId: f.mateo });
    expect(mp).toMatchObject({ miles: mine, milesEst: true, driverPayCents: mine * 62, loadUsdCents: 480000 });
    expect(mp.fuelCents).toBeGreaterThan(0);
    expect(mp.otherCarrierCents).toBe(toHome(1200000, "MXN", 180000));
    // a leg on the carrier tab sees our driver's pay and fuel on the US leg as "other legs"
    const mx = await legMarginPreview(a, o.legs[0].id);
    expect(mx.otherDriverPayCents).toBe(mine * 62);
    expect(mx.otherFuelCents).toBe(mp.fuelCents);
    await finish(us.id);
    // the P&L before any statement: estimated pay, not $0
    const pnl = await B.orderPnl(a, o.order.id);
    expect(pnl).toMatchObject({ driverPay: mine * 62, driverPayEstimated: true, miles: mine, milesEst: true });
    // the statement pays the estimate, labelled
    const week = B.weekOf(new Date());
    const st = await B.buildSettlement(a, f.mateo, week.start, week.end);
    expect(st.lines[0]).toMatchObject({ amountCents: mine * 62, source: "estimated miles" });
    expect(st.lines[0].description).toContain(`${mine} mi (est.)`);
  });

  it("a phone fix far from the town a stop names is not learned: the leg keeps its estimate", async () => {
    const { us } = await threeLeg({ currency: "USD", rateCents: 480000 });
    const [before] = await db.select().from(legsT).where(eq(legsT.id, us.id));
    // a GPS stuck in Detroit arriving at the Laredo yard and at San Antonio
    await learnStopCoordinates(db, a, before.fromStopId!, "42.3314", "-83.0458");
    await learnStopCoordinates(db, a, before.toStopId!, "42.3314", "-83.0458");
    const [after] = await db.select().from(legsT).where(eq(legsT.id, us.id));
    expect(after.estMiles).toBe(before.estMiles);
    const [stop] = await db.select().from(stopsT).where(eq(stopsT.id, before.toStopId!));
    expect(stop.lat).toBeNull();
    // a fix in San Antonio is learned
    await learnStopCoordinates(db, a, before.toStopId!, "29.43", "-98.49");
    expect((await db.select().from(stopsT).where(eq(stopsT.id, before.toStopId!)))[0].lat).not.toBeNull();
  });
});

describe("re-running the week keeps what a person added", () => {
  it("a layover line added by hand survives the rerun and the run says so; a hand deduction that no longer fits is cut to what fits; a dispute stays on its line", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas", country: "US" }], template: "domestic", book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t2, driverId: f.mateo }, { plannedMiles: 100 });
    await finish(o.legs[0].id);
    const week = B.weekOf(new Date());
    const run1 = await Run.settlementRun(a, week.start, week.end);
    const id = run1.find((r) => r.driver === "Mateo Ruiz")!.settlementId!;
    await B.addSettlementLine(a, id, { kind: "accessorial", description: "Layover Nuevo Laredo 9/28", amountCents: 7500 });
    await B.addSettlementLine(a, id, { kind: "deduction", description: "Ticket reimbursement to company", amountCents: 10000 });
    // the driver disputes the load line
    const [st0] = await db.select().from(settlementsT).where(eq(settlementsT.id, id));
    await db.update(settlementsT).set({ lines: st0.lines.map((l) => (l.kind === "leg" ? { ...l, disputed: "it was 120 miles" } : l)) }).where(eq(settlementsT.id, id));
    expect(st0.netCents).toBe(6200 + 7500 - 10000);
    const run2 = await Run.settlementRun(a, week.start, week.end);
    const row = run2.find((r) => r.driver === "Mateo Ruiz")!;
    expect(row.keptManual).toBe(2);
    expect(row.note).toContain("kept 2 lines added by hand");
    const [st] = await db.select().from(settlementsT).where(eq(settlementsT.id, id));
    expect(st.lines.find((l) => l.description === "Layover Nuevo Laredo 9/28")).toMatchObject({ amountCents: 7500, source: "manual" });
    expect(st.lines.find((l) => l.kind === "leg")!.disputed).toBe("it was 120 miles");
    expect(st.netCents).toBe(6200 + 7500 - 10000);
    // the load gets shorter miles: the $100 hand deduction no longer fits; it takes what there is
    const { setLegMiles } = await import("./orders");
    await setLegMiles(a, o.legs[0].id, 20);
    await Run.settlementRun(a, week.start, week.end);
    const [st2] = await db.select().from(settlementsT).where(eq(settlementsT.id, id));
    const ded = st2.lines.find((l) => l.source === "manual" && l.kind === "deduction")!;
    expect(ded.amountCents).toBe(-(1240 + 7500));
    expect(ded.description).toMatch(/only \$87\.40 of \$100\.00 fits this week/);
    expect(st2.netCents).toBe(0);
    // miles back: the whole deduction again, the note gone
    await setLegMiles(a, o.legs[0].id, 100);
    await Run.settlementRun(a, week.start, week.end);
    const [st3] = await db.select().from(settlementsT).where(eq(settlementsT.id, id));
    expect(st3.lines.find((l) => l.source === "manual" && l.kind === "deduction")).toMatchObject({ amountCents: -10000, description: "Ticket reimbursement to company" });
  });
});

describe("report tables add up to the tiles", () => {
  it("split cents to the cent; a load run by two trucks splits by leg miles; a carrier-only load is its own row", async () => {
    expect(R.splitCents(1001, [1, 1])).toEqual([501, 500]);
    expect(R.splitCents(287805, [140, 8, 152]).reduce((x, y) => x + y, 0)).toBe(287805);
    expect(R.splitCents(-100, [1, 2])).toEqual([-33, -67]);
    expect(R.splitCents(500, [0, 0])).toEqual([250, 250]);
    // two trucks on one load (Laredo → San Antonio yard on 204, typed 150 mi; San Antonio → Dallas on 206, est.), and a load a carrier ran alone
    const o = await createOrder(a, { customerId: f.cust, rateCents: 300000, stops: [{ type: "pickup", name: "Laredo DC", country: "US", address: { city: "Laredo", state: "TX" } }, { type: "yard", name: "SA Yard", country: "US", address: { city: "San Antonio", state: "TX" } }, { type: "delivery", name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" } }], book: true });
    expect(o.legs).toHaveLength(2);
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.arturo }, { plannedMiles: 150 });
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: f.t2, driverId: f.mateo });
    for (const l of o.legs) await finish(l.id);
    const est = (await db.select().from(legsT).where(eq(legsT.id, o.legs[1].id)))[0].estMiles!;
    const solo = await createOrder(a, { customerId: f.cust, rateCents: 90000, stops: [{ type: "pickup", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas", country: "US" }], template: "domestic", book: true });
    const lone = (await db.select().from((await import("@/db/schema")).carriers)).find((c) => c.name === "Lone Star Freight")!;
    await planLeg(a, solo.legs[0].id, { kind: "carrier", carrierId: lone.id, carrierRateCents: 50000, carrierRateCurrency: "USD" });
    await finish(solo.legs[0].id, "carrier");
    const period = R.defaultPeriod(new Date(), "America/Chicago");
    const dash = await R.dashboard(a, period);
    for (const by of ["truck", "driver", "carrier", "customer", "lane", "week"] as const) {
      const rows = await R.breakdown(a, by, period);
      expect(rows.reduce((x, r) => x + r.revenueCents, 0)).toBe(dash.revenueCents);
      expect(rows.reduce((x, r) => x + r.marginCents, 0)).toBe(dash.marginCents);
      expect(new Set(rows.flatMap((r) => r.orderIds)).size).toBe(dash.loads);
    }
    const trucks = await R.breakdown(a, "truck", period);
    expect(trucks.map((r) => r.label)).toContain("No truck of ours (carriers ran it)");
    expect(trucks[trucks.length - 1].key).toBe("~none");
    // split by the legs' miles: 150 typed on 204, the estimate on 206
    const t204 = trucks.find((r) => r.label === "Unit 204")!;
    expect(t204.revenueCents).toBe(R.splitCents(300000, [150, est])[0]);
    expect(t204.miles).toBe(150);
    // no statement yet: the reports estimate driver pay from each driver's rule on the miles (est. too)
    const [detail] = await R.orderDetail(a, period, null, [o.order.id]);
    expect(detail.driverPay).toBe(150 * 60 + est * 62);
    expect(detail.fuel).toBeGreaterThan(0);
  });
});
