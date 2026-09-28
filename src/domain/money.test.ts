// Features: F-7.20 F-7.21 F-7.22 F-7.23 F-7.24 F-7.25 F-7.26 F-7.27 money in three currencies — rates, payments, receivables, reports, carrier rates, rate-con charges, driver pay safety, QuickBooks, factoring, closed period, credit memos
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { outbox, payItems, settlements as settlementsT } from "@/db/schema";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, updateOrder, ValidationError } from "./orders";
import { getCompany, updateCompany } from "./company";
import * as B from "./billing";
import * as C from "./cash";
import * as F from "./factoring";
import * as A from "./accounting";
import * as R from "./reports";
import * as Run from "./settlement-run";
import { sendTender } from "./tenders";
import { suggest } from "./cash-rules";
import { applyDeductions, legPayLines } from "./pay-plans-pure";
import { payInputs } from "./pay-inputs";
import { money, parseRate, toHome, pickRate, sumByCurrency, formatTotals, fxNote } from "./fx-rules";
import { zonedDate } from "@/lib/time";

const future = new Date(Date.now() + 365 * 86400_000);
const afterWeek = new Date(Date.now() + 8 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { entity: string; usCust: string; mxCust: string; caCust: string; garza: string; lone: string; t1: string; reyes: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  const entity = await create(a, "billingEntity", { legalName: "Frontera Freight LLC", country: "US", invoicePrefix: "FF", nextInvoiceNumber: 2401, isDefault: true, remitTo: { line1: "4100 Mines Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" } });
  const usCust = await create(a, "customer", { name: "Summit Logistics", kind: "broker", termsDays: 30, billingEmail: "ap@summit.test", requiredDocs: [], accessorialApproval: false });
  const mxCust = await create(a, "customer", { name: "Sierra Madre", country: "MX", termsDays: 30, billingEmail: "cxp@sierra.test", requiredDocs: [] });
  const caCust = await create(a, "customer", { name: "Maple Leaf", country: "CA", termsDays: 30, billingEmail: "ap@maple.test", requiredDocs: [] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  const lone = await create(a, "carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test", mcNumber: "123456" });
  const t1 = await create(a, "truck", { unitNumber: "204", usPlate: "TX204", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t1.id });
  f = { entity: entity.id, usCust: usCust.id, mxCust: mxCust.id, caCust: caCust.id, garza: garza.id, lone: lone.id, t1: t1.id, reyes: reyes.id };
});

/** A delivered one-leg load on our truck (or a partner carrier), completed at `at` (default now). */
async function delivered(o: { customerId: string; rateCents: number; currency?: string; miles?: number | null; carrier?: { id: string; cents: number; currency?: string }; at?: Date }) {
  const ord = await createOrder(a, { customerId: o.customerId, rateCents: o.rateCents, currency: o.currency ?? "USD", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }], template: "domestic", book: true });
  const leg = ord.legs[0].id;
  if (o.carrier) await planLeg(a, leg, { kind: "carrier", carrierId: o.carrier.id, carrierRateCents: o.carrier.cents, carrierRateCurrency: o.carrier.currency ?? "USD" });
  else await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.reyes }, { plannedMiles: o.miles === undefined ? 400 : o.miles });
  await dispatchLeg(a, leg);
  await acceptLeg(a, leg, o.carrier ? "carrier" : "driver_app");
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st, o.at ? { at: o.at } : {});
  return ord;
}
const invoice = async (orderId: string, rate?: string | number) => B.issueInvoice(a, (await B.createInvoice(a, [orderId])).id, rate != null ? { exchangeRate: rate } : {});

describe("currency rules (pure)", () => {
  it("symbols, ISO codes on documents, typed rates checked, conversion, per-currency totals", () => {
    expect(money(259000, "CAD")).toBe("CA$2,590.00");
    expect(money(5310000, "MXN", { code: true })).toBe("MX$53,100.00 MXN");
    expect(money(-4500, "USD", { code: true })).toBe("-$45.00");
    expect(parseRate("18.45", "MXN")).toBe(184500);
    expect(parseRate("1.37", "CAD")).toBe(13700);
    expect(() => parseRate("0.054", "MXN")).toThrow(/doesn't look right/);
    expect(() => parseRate("", "CAD")).toThrow(/CAD per 1 USD/);
    expect(toHome(5310000, "MXN", 184500)).toBe(287805); // MX$53,100 at 18.45 = $2,878.05
    expect(toHome(100, "USD", null)).toBe(100);
    expect(pickRate("MXN", 184500, { MXN: { rateE4: 190000, at: "" } })).toEqual({ rateE4: 184500, source: "invoice" });
    expect(pickRate("MXN", null, { MXN: { rateE4: 190000, at: "" } })).toEqual({ rateE4: 190000, source: "company" });
    expect(pickRate("CAD", null, {})).toEqual({ rateE4: 13700, source: "default" });
    const t = sumByCurrency([{ c: "USD", v: 245000 }, { c: "MXN", v: 5310000 }, { c: "USD", v: 100 }], (x) => x.c, (x) => x.v);
    expect(t).toEqual({ USD: 245100, MXN: 5310000 });
    expect(formatTotals(t)).toBe("$2,451.00 · MX$53,100.00");
    expect(fxNote([{ currency: "MXN", rateE4: 184500, source: "invoice" }, { currency: "MXN", rateE4: 184500, source: "invoice" }])).toBe("MXN at 18.4500 (rate on the invoice)");
  });

  it("net pay never below $0: deductions are taken in order, the rest is short", () => {
    expect(applyDeductions(5000, [{ key: "a", wantCents: 3000 }, { key: "b", wantCents: 4000 }, { key: "c", wantCents: 100 }])).toEqual([
      { key: "a", takenCents: 3000, shortCents: 0 },
      { key: "b", takenCents: 2000, shortCents: 2000 },
      { key: "c", takenCents: 0, shortCents: 100 },
    ]);
    expect(applyDeductions(0, [{ key: "x", wantCents: 30000 }])).toEqual([{ key: "x", takenCents: 0, shortCents: 30000 }]);
  });
});

describe("invoices, payments and receivables per currency", () => {
  it("CAD needs a rate too; the rate becomes the company's; receivables and invoice totals stay per currency; statements subtotal per currency", async () => {
    const us = await delivered({ customerId: f.mxCust, rateCents: 245000 });
    const mx = await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN" });
    const ca = await delivered({ customerId: f.caCust, rateCents: 259000, currency: "CAD" });
    await invoice(us.order.id);
    const caDraft = await B.createInvoice(a, [ca.order.id]);
    await expect(B.issueInvoice(a, caDraft.id)).rejects.toThrow(/exchange rate is required for a CAD invoice/);
    await expect(B.issueInvoice(a, caDraft.id, { exchangeRate: "0.73" })).rejects.toThrow(/doesn't look right/);
    const caInv = await B.issueInvoice(a, caDraft.id, { exchangeRate: "1.3650" });
    expect(caInv.exchangeRate).toBe(13650);
    expect(caInv.snapshot!.exchangeRate).toBe(1.365);
    const mxInv = await invoice(mx.order.id, 18.45);
    expect((await getCompany(a)).settings.fx).toMatchObject({ MXN: { rateE4: 184500 }, CAD: { rateE4: 13650 } });
    const ag = await B.aging(a);
    expect(ag.rows.map((r) => [r.name, r.currency, r.total])).toEqual([
      ["Sierra Madre", "USD", 245000],
      ["Sierra Madre", "MXN", 5310000],
      ["Maple Leaf", "CAD", 259000],
    ]);
    expect(Object.fromEntries(Object.entries(ag.totals).map(([k, v]) => [k, v.total]))).toEqual({ USD: 245000, MXN: 5310000, CAD: 259000 });
    // one USD figure, each invoice at its own rate: 2,450 + 53,100 / 18.45 + 2,590 / 1.365
    expect(ag.home.openCents).toBe(245000 + toHome(5310000, "MXN", 184500) + toHome(259000, "CAD", 13650));
    const st = await B.statementPdf(a, f.mxCust);
    expect(st.fileName).toMatch(/^Statement Sierra Madre \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(st.pdf.length).toBeGreaterThan(500);
    const list = await B.listInvoices(a, { view: "open" });
    expect(sumByCurrency(list, (i) => i.currency, (i) => i.totalCents)).toEqual({ USD: 245000, MXN: 5310000, CAD: 259000 });
    void mxInv;
  });

  it("a payment has a currency: pesos never pay a dollar invoice, matching oldest first stays in the currency; payments in a closed period are refused", async () => {
    const us = await invoice((await delivered({ customerId: f.mxCust, rateCents: 245000 })).order.id);
    const mx = await invoice((await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN" })).order.id, "18.45");
    const { invoices } = await C.openItems(a, f.mxCust);
    // no remittance, "match oldest first": the USD invoice is older, but a MXN payment only goes to MXN invoices
    const plan = suggest(invoices, 5310000, "", "MXN");
    expect(plan.map((p) => [p.number, p.applyCents])).toEqual([[mx.number, 5310000]]);
    await expect(C.applyPayment(a, { customerId: f.mxCust, amountCents: 5310000, currency: "MXN", applications: [{ invoiceId: us.id, amountCents: 245000 }] })).rejects.toThrow(/is a USD invoice and this payment is in MXN/);
    const r = await C.applyPayment(a, { customerId: f.mxCust, amountCents: 5310000, currency: "MXN", method: "wire", reference: "SPEI 7731", applications: [{ invoiceId: mx.id, amountCents: 5310000 }] });
    expect(r.onAccountCents).toBe(0);
    expect((await B.invoiceById(a, mx.id)).invoice.state).toBe("paid");
    expect((await B.invoiceById(a, us.id)).invoice.state).toBe("issued");
    // month-end close: nothing dated in the closed period
    await B.closePeriod(a, new Date(Date.now() - 86400_000));
    await expect(C.applyPayment(a, { customerId: f.mxCust, amountCents: 1000, currency: "USD", receivedAt: new Date(Date.now() - 2 * 86400_000), applications: [{ invoiceId: us.id, amountCents: 1000 }] })).rejects.toThrow(/books are closed/);
    await expect(B.recordReceipt(a, us.id, { amountCents: 1000, receivedAt: new Date(Date.now() - 3 * 86400_000) })).rejects.toThrow(/books are closed/);
    await B.recordReceipt(a, us.id, { amountCents: 1000 });
  });
});

describe("reports in USD", () => {
  it("revenue converts at the invoice's rate (the company rate until invoiced), is net of credit memos, and receivables match the Receivables screen", async () => {
    await updateCompany(a, { fx: { CAD: "1.40" } });
    const us = await delivered({ customerId: f.usCust, rateCents: 200000 });
    const mx = await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN", carrier: { id: f.lone, cents: 950000, currency: "MXN" } });
    const ca = await delivered({ customerId: f.caCust, rateCents: 280000, currency: "CAD" });
    const usInv = await invoice(us.order.id);
    await invoice(mx.order.id, "18.45");
    await B.creditMemo(a, usInv.id, { amountCents: 17000, reason: "short pay settled" });
    const period = { from: zonedDate(new Date(Date.now() - 2 * 86400_000), "America/Detroit"), to: zonedDate(new Date(Date.now() + 86400_000), "America/Detroit") };
    const d = await R.dashboard(a, period);
    const mxUsd = toHome(5310000, "MXN", 184500);
    const caUsd = toHome(280000, "CAD", 14000); // not invoiced yet: the company rate
    expect(d.revenueCents).toBe(200000 - 17000 + mxUsd + caUsd);
    expect(d.creditedCents).toBe(17000);
    expect(d.fxNote).toContain("MXN at 18.4500 (rate on the invoice)");
    expect(d.fxNote).toContain("CAD at 1.4000 (company rate");
    // receivables: the same definition as the Receivables screen, in USD
    expect(d.arOpenCents).toBe((await B.aging(a)).home.openCents);
    // the carrier was paid MX$9,500: its cost is converted too, never subtracted as dollars
    const pnl = await B.orderPnl(a, mx.order.id);
    expect(pnl.currency).toBe("USD");
    expect(pnl.revenue).toBe(mxUsd);
    expect(pnl.carrierCost).toBe(toHome(950000, "MXN", 184500));
    expect(pnl.marginPct).toBeGreaterThan(80);
    const byCustomer = await R.breakdown(a, "customer", period);
    expect(byCustomer.find((r) => r.label === "Sierra Madre")!.revenueCents).toBe(mxUsd);
    void ca;
  });
});

describe("carrier rates carry their own currency", () => {
  it("tendering in Canadian dollars keeps CAD on the leg and the tender; a currency we don't use is refused", async () => {
    const o = await createOrder(a, { customerId: f.usCust, rateCents: 480000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }], template: "domestic", book: true });
    await sendTender(a, o.legs[0].id, { carrierId: f.lone, rateCents: 95000, currency: "CAD", channel: "manual" });
    const { legs, tenders } = await import("@/db/schema");
    const [leg] = await db.select().from(legs).where(eq(legs.id, o.legs[0].id));
    expect([leg.carrierRateCents, leg.carrierRateCurrency]).toEqual([95000, "CAD"]);
    const [tender] = await db.select().from(tenders).where(eq(tenders.legId, leg.id));
    expect(tender.currency).toBe("CAD");
    await expect(planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: f.lone, carrierRateCents: 100, carrierRateCurrency: "EUR" })).rejects.toThrow(/USD, MXN or CAD/);
  });

  it("a carrier bill from a peso leg is in pesos", async () => {
    await delivered({ customerId: f.usCust, rateCents: 150000, carrier: { id: f.lone, cents: 950000, currency: "MXN" } });
    await B.syncCarrierBills(a);
    const [b] = await B.carrierBillsList(a);
    expect([b.bill.expectedCents, b.bill.currency]).toEqual([950000, "MXN"]);
  });
});

describe("rate-con charges follow the rate", () => {
  it("saving the rate or currency rebuilds line haul and fuel in the load's currency; reset replaces a typed line haul; accepting a currency mismatch is refused", async () => {
    const o = await delivered({ customerId: f.caCust, rateCents: 190000 });
    let cs = await B.ensureCharges(a, o.order.id);
    expect(cs.map((c) => [c.kind, c.amountCents, c.currency])).toEqual([["linehaul", 190000, "USD"]]);
    await updateOrder(a, o.order.id, { rateCents: 259000, currency: "CAD", fuelRule: "pct", fuelPct: 10 });
    cs = await B.chargesFor(a, o.order.id);
    expect(cs.map((c) => [c.kind, c.amountCents, c.currency, c.source]).sort()).toEqual([["fuel", 25900, "CAD", "rate_con"], ["linehaul", 259000, "CAD", "rate_con"]]);
    let q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q.mismatch).toBe(false);
    // a typed line haul (someone's own number) and an extra left in USD
    await B.addCharge(a, o.order.id, { kind: "linehaul", description: "Line haul (typed)", rateCents: 100000 });
    await B.addCharge(a, o.order.id, { kind: "lumper", rateCents: 18500, currency: "USD", approvalState: "none" });
    q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q.mismatchReason).toMatch(/1 charge is in USD but the load is in CAD/);
    expect(q.bigDifference).toBe(true);
    await expect(B.acceptRateConMismatch(a, o.order.id, "customer approved")).rejects.toThrow(/in USD but the load is in CAD/);
    await B.resetChargesToRateCon(a, o.order.id);
    const lumper = (await B.chargesFor(a, o.order.id)).find((c) => c.kind === "lumper")!;
    await B.removeCharge(a, lumper.id);
    cs = await B.chargesFor(a, o.order.id);
    expect(cs.map((c) => [c.kind, c.amountCents, c.source]).sort()).toEqual([["fuel", 25900, "rate_con"], ["linehaul", 259000, "rate_con"]]);
    // invoiced: the rate-con charges no longer move (a change is a credit or a supplemental)
    await invoice(o.order.id, "1.37");
    expect(await B.syncRateConCharges(a, o.order.id)).toMatchObject({ changed: false });
  });

  it("a draft invoice follows the rate-con charges when the rate changes before it is issued", async () => {
    const o = await delivered({ customerId: f.usCust, rateCents: 190000 });
    const draft = await B.createInvoice(a, [o.order.id]);
    expect(draft.totalCents).toBe(190000);
    await updateOrder(a, o.order.id, { rateCents: 205000 });
    const d = await B.invoiceById(a, draft.id);
    expect([d.invoice.totalCents, d.lines.map((l) => l.amountCents)]).toEqual([205000, [205000]]);
    const issued = await B.issueInvoice(a, draft.id);
    expect(issued.totalCents).toBe(205000);
  });

  it("detention is billed by the minute: 2 h 28 min over at $75/h is $185.00", async () => {
    const o = await delivered({ customerId: f.usCust, rateCents: 100000 });
    const { stops } = await import("@/db/schema");
    const t0 = new Date(Date.now() - 10 * 3600_000);
    const [pu] = await db.select().from(stops).where(eq(stops.orderId, o.order.id)).orderBy(stops.seq).limit(1);
    await db.update(stops).set({ arrivedAt: t0, departedAt: new Date(t0.getTime() + (120 + 148) * 60_000) }).where(eq(stops.id, pu.id));
    const [det] = await B.computeDetention(a, o.order.id, { freeMinutes: 120, rateCentsPerHour: 7500 });
    expect(det.amountCents).toBe(18500);
  });
});

describe("driver pay is safe to approve", () => {
  it("an advance bigger than the week's pay takes only what there is, net $0, the rest stays owed; a deduction short carries to next week; a week with no pay makes no statement", async () => {
    const { start, end } = B.weekOf(new Date(Date.now() - 7 * 86400_000));
    const mid = new Date(start.getTime() + 3 * 86400_000);
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 200, at: mid }); // 200 × 0.62 = $124
    await B.addPayItem(a, f.reyes, { kind: "deduction", description: "Occupational insurance", amountCents: 10000 }); // one-off $100
    await B.addPayItem(a, f.reyes, { kind: "advance", description: "Cash advance", amountCents: 30000 }); // $300, all at once
    let st = await B.buildSettlement(a, f.reyes, start, end);
    expect(st.grossCents).toBe(12400);
    expect(st.netCents).toBe(0);
    const ded = st.lines.filter((l) => l.kind === "deduction").map((l) => [l.source, -l.amountCents, l.shortCents ?? 0]);
    expect(ded).toEqual([["one-off", 10000, 0], ["advance", 2400, 27600]]);
    st = await B.settlementTransition(a, st.id, "reviewed");
    await B.settlementTransition(a, st.id, "approved");
    await B.settlementTransition(a, st.id, "paid", { method: "ach" });
    const adv = (await db.select().from(payItems).where(eq(payItems.description, "Cash advance")))[0];
    expect([adv.remainingCents, adv.active]).toEqual([27600, true]);
    const ledger = await B.payItemLedger(a, { driverId: f.reyes, includeDone: true });
    expect(ledger.find((x) => x.description === "Cash advance")).toMatchObject({ originalCents: 30000, recoveredCents: 2400, remainingCents: 27600 });
    // this week: no legs, only the advance → no statement at all
    const now = B.weekOf(new Date());
    await expect(B.buildSettlement(a, f.reyes, now.start, now.end)).rejects.toThrow(/no pay for the week/);
    const run = await Run.settlementRun(a, now.start, now.end);
    expect(run.map((r) => [r.driver, r.state])).toEqual([["Mateo Ruiz", "skipped"]]);
    expect(await db.select().from(settlementsT).where(eq(settlementsT.periodStart, now.start))).toHaveLength(0);
  });

  it("a recurring deduction that doesn't fit carries to next week as its own line", async () => {
    const lastWeek = B.weekOf(new Date(Date.now() - 7 * 86400_000));
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 50, at: new Date(lastWeek.start.getTime() + 2 * 86400_000) }); // $31
    await B.addPayItem(a, f.reyes, { kind: "deduction", description: "Trailer rent", amountCents: 5000, recurring: true });
    let st = await B.buildSettlement(a, f.reyes, lastWeek.start, lastWeek.end);
    expect(st.netCents).toBe(0);
    expect(st.lines.find((l) => l.kind === "deduction")).toMatchObject({ amountCents: -3100, shortCents: 1900 });
    for (const to of ["reviewed", "approved"] as const) st = await B.settlementTransition(a, st.id, to);
    await B.settlementTransition(a, st.id, "paid", { method: "ach" });
    const carried = (await db.select().from(payItems)).find((i) => i.carriedFrom === st.id)!;
    expect(carried).toMatchObject({ kind: "deduction", amountCents: 1900, recurring: false });
    expect(carried.description).toMatch(/^Carried from week of \d{4}-\d{2}-\d{2}: Trailer rent$/);
    // next week, with pay: the carried $19 first, then this week's rent
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 400 });
    const now = B.weekOf(new Date());
    const next = await B.buildSettlement(a, f.reyes, now.start, now.end);
    expect(next.lines.filter((l) => l.kind === "deduction").map((l) => [l.source, l.amountCents])).toEqual([["carried from last week", -1900], ["recurring", -5000]]);
  });

  it("approval waits for a load with no miles and for the week to end (the owner may approve early with a reason); a leg finished after its week was paid lands on the next statement", async () => {
    const lastWeek = B.weekOf(new Date(Date.now() - 7 * 86400_000));
    const mid = new Date(lastWeek.start.getTime() + 3 * 86400_000);
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 300, at: mid });
    let st = await B.buildSettlement(a, f.reyes, lastWeek.start, lastWeek.end);
    for (const to of ["reviewed", "approved"] as const) st = await B.settlementTransition(a, st.id, to);
    await B.settlementTransition(a, st.id, "paid", { method: "ach" });
    // a leg from last week recorded after last week was paid, with no miles
    const late = await delivered({ customerId: f.usCust, rateCents: 90000, miles: null, at: mid });
    // stops the city list doesn't know: no estimate either, so the line really has no miles
    const S = await import("@/db/schema");
    await db.update(S.legs).set({ estMiles: null }).where(eq(S.legs.id, late.legs[0].id));
    const now = B.weekOf(new Date());
    let cur = await B.buildSettlement(a, f.reyes, now.start, now.end);
    const line = cur.lines.find((l) => l.legId === late.legs[0].id)!;
    expect(line.description).toMatch(/\(late: completed \d{4}-\d{2}-\d{2}, after that week's statement\)/);
    expect(line.blocker).toMatch(/no miles/);
    cur = await B.settlementTransition(a, cur.id, "reviewed");
    await expect(B.settlementTransition(a, cur.id, "approved", { now: afterWeek })).rejects.toThrow(/has no miles/);
    // miles entered, rebuilt
    await (await import("./orders")).setLegMiles(a, late.legs[0].id, 250);
    await B.settlementTransition(a, cur.id, "open");
    cur = await B.buildSettlement(a, f.reyes, now.start, now.end);
    expect(cur.grossCents).toBe(250 * 62);
    cur = await B.settlementTransition(a, cur.id, "reviewed");
    await expect(B.settlementTransition(a, cur.id, "approved")).rejects.toThrow(/week isn't over/);
    const billing = { ...a, role: "billing" as const };
    await expect(B.settlementTransition(billing, cur.id, "approved", { earlyReason: "final check" })).rejects.toThrow(/only the owner/);
    await B.settlementTransition(a, cur.id, "approved", { earlyReason: "final check before he goes home" });
    // the run skips it (already approved) and shows nothing lost
    expect((await Run.approveSettlements(a, [cur.id])).skipped[0].reason).toMatch(/already approved/);
  });

  it("a % of line haul on a peso load is a % of its dollar value; % of everything billed leaves out pending, rejected and pass-through charges", async () => {
    await update(a, "customer", f.mxCust, { accessorialApproval: true });
    const o = await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN" });
    await B.ensureCharges(a, o.order.id);
    await B.addCharge(a, o.order.id, { kind: "lumper", rateCents: 300000, approvalState: "approved" }); // pass-through
    await B.addCharge(a, o.order.id, { kind: "detention", rateCents: 150000 }); // waits for approval
    await updateCompany(a, { fx: { MXN: "18.45" } }); // not invoiced yet: the company rate converts it
    const leg = (await db.select().from((await import("@/db/schema")).legs).where(eq((await import("@/db/schema")).legs.id, o.legs[0].id)))[0];
    const [inp] = await payInputs(a, f.reyes, [leg]);
    expect(inp.linehaulCents).toBe(toHome(5310000, "MXN", 184500));
    expect(inp.billedCents).toBe(toHome(5310000, "MXN", 184500)); // no lumper, no pending detention
    const lines = legPayLines({ rules: [{ id: "r", kind: "pct_linehaul", amount: 2800 }], teamSplit: "half" }, inp);
    expect(lines[0].amountCents).toBe(Math.round((toHome(5310000, "MXN", 184500) * 2800) / 10000));
  });
});

describe("QuickBooks export", () => {
  it("one deposit per payment with a line per invoice; factoring as balanced journals; no negative bill; escrow and advances to their own accounts; the IIF lists its accounts", async () => {
    await update(a, "billingEntity", f.entity, { factorName: "Summit Capital", factorEmail: "f@summit.test", factorRemitTo: { line1: "PO Box 1", city: "Dallas", state: "TX" } });
    const i1 = await invoice((await delivered({ customerId: f.usCust, rateCents: 74000 })).order.id);
    const i2 = await invoice((await delivered({ customerId: f.usCust, rateCents: 182000 })).order.id);
    await C.applyPayment(a, { customerId: f.usCust, amountCents: 300000, currency: "USD", method: "check", reference: "90417", applications: [{ invoiceId: i1.id, amountCents: 74000 }, { invoiceId: i2.id, amountCents: 182000 }] });
    // a factored customer: funded, then collected
    await update(a, "customer", f.caCust, { invoiceDelivery: "factor" });
    const fi = await invoice((await delivered({ customerId: f.caCust, rateCents: 230000 })).order.id);
    expect(fi.factored).toBe(true);
    await F.recordFunding(a, [fi.id], { advanceBp: 95, feeBp: 2.5 });
    await F.recordCollection(a, fi.id, { reference: "REM-1" });
    // a driver whose deductions ate the whole week: a $0 bill with pay and an advance, never negative
    const lastWeek = B.weekOf(new Date(Date.now() - 7 * 86400_000));
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 100, at: new Date(lastWeek.start.getTime() + 86400_000) });
    await B.addPayItem(a, f.reyes, { kind: "advance", description: "Cash advance", amountCents: 30000 });
    await B.addPayItem(a, f.reyes, { kind: "escrow", description: "Escrow", amountCents: 5000, targetCents: 100000 });
    let st = await B.buildSettlement(a, f.reyes, lastWeek.start, lastWeek.end);
    for (const to of ["reviewed", "approved"] as const) st = await B.settlementTransition(a, st.id, to);
    await B.settlementTransition(a, st.id, "paid", { method: "ach" });
    const period = { from: zonedDate(new Date(Date.now() - 20 * 86400_000), "America/Detroit"), to: zonedDate(new Date(), "America/Detroit") };
    const run = await A.createExport(a, { format: "iif", ...period, onlyNew: true });
    const iif = (await A.exportFiles(a, run.id)).files[0].body;
    const lines = iif.split("\r\n");
    for (const acct of ["ACCNT\tUndeposited Funds\tOCASSET", "ACCNT\tFactor Reserve\tOCASSET", "ACCNT\tFactoring Fees\tEXP", "ACCNT\tDriver Advances\tOCASSET"]) expect(lines).toContain(acct);
    expect(lines).toContain("!INVITEM\tNAME\tINVITEMTYPE\tACCNT");
    // the check: one deposit of $3,000 — two invoices and $440 on account
    const pay = lines.filter((l) => l.startsWith("TRNS\t\tPAYMENT"));
    expect(pay.filter((l) => l.includes("\t90417\t"))).toHaveLength(1);
    expect(pay.find((l) => l.includes("\t90417\t"))!.split("\t")[7]).toBe("3000.00");
    expect(lines.filter((l) => l.startsWith("SPL\t\tPAYMENT") && /\t-(740|1820|440)\.00\t/.test(l))).toHaveLength(3);
    // the factor's collection is not a customer payment: the funding journal took the invoice off Receivables
    expect(pay.some((l) => l.includes("factoring"))).toBe(false);
    const gj = lines.filter((l) => /^(TRNS|SPL)\t\tGENERAL JOURNAL/.test(l));
    expect(gj.some((l) => l.includes("\tFactoring Fees\t") && l.includes("\t57.50\t"))).toBe(true);
    expect(gj.some((l) => l.includes("\tFactor Reserve\t") && l.includes("\t-57.50\t"))).toBe(true); // released on collection
    // the driver bill: $62 pay, -$62 advance, total $0; nothing to escrow; never a negative bill
    const bill = lines.find((l) => l.startsWith("TRNS\t\tBILL") && l.includes("PAY-"))!;
    expect(Number(bill.split("\t")[7])).toBeGreaterThanOrEqual(0);
    expect(lines.some((l) => l.startsWith("SPL\t\tBILL") && l.includes("\tDriver Advances\t") && l.includes("\t-62.00\t"))).toBe(true);
    expect(lines.some((l) => l.includes("BILLPMT") && l.includes("Mateo"))).toBe(false); // $0 paid: no bill payment
    // every transaction balances
    let bal = 0;
    for (const l of lines) {
      const c = l.split("\t");
      if (c[0] === "TRNS" || c[0] === "SPL") bal += Math.round(Number(c[7]) * 100);
      if (c[0] === "ENDTRNS") {
        expect(bal).toBe(0);
        bal = 0;
      }
    }
    // QBO: the journal file and the credit memos file exist
    const q = await A.createExport(a, { format: "qbo", ...period, onlyNew: false });
    const files = (await A.exportFiles(a, q.id)).files;
    expect(files.find((x) => x.name.endsWith("journal.csv"))!.body).toContain("Factor Reserve");
    expect(files.find((x) => x.name.endsWith("payments.csv"))!.body.split("\r\n").filter((l) => l.includes(",90417,"))).toHaveLength(3);
  });

  it("a payment an older export already sent receipt by receipt is not sent again as a deposit", async () => {
    const i1 = await invoice((await delivered({ customerId: f.usCust, rateCents: 74000 })).order.id);
    await C.applyPayment(a, { customerId: f.usCust, amountCents: 74000, currency: "USD", method: "check", reference: "88", applications: [{ invoiceId: i1.id, amountCents: 74000 }] });
    const { receipts } = await import("@/db/schema");
    await db.update(receipts).set({ exportedAt: new Date() }).where(eq(receipts.invoiceId, i1.id)); // what an older run stamped
    const period = { from: zonedDate(new Date(Date.now() - 5 * 86400_000), "America/Detroit"), to: zonedDate(new Date(), "America/Detroit") };
    expect((await A.previewExport(a, { ...period, onlyNew: true })).receipts).toBe(0);
    expect((await A.previewExport(a, { ...period, onlyNew: false })).receipts).toBe(1);
  });

  it("a peso invoice goes out in dollars at its own rate, with the original in the memo", async () => {
    await invoice((await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN" })).order.id, "18.45");
    const period = { from: zonedDate(new Date(Date.now() - 5 * 86400_000), "America/Detroit"), to: zonedDate(new Date(), "America/Detroit") };
    const run = await A.createExport(a, { format: "qbo", ...period, onlyNew: true });
    const inv = (await A.exportFiles(a, run.id)).files[0].body;
    expect(inv).toContain(",2878.05,USD");
    expect(inv).toContain("MX$53,100.00 MXN at 18.4500");
  });
});

describe("factoring: remit-to required, chargeback, corrected invoice", () => {
  it("a factor needs its remit-to address; issuing a factored invoice without it is refused; a chargeback repays advance + fee and puts the reserve back on Receivables; the corrected invoice drops the notice", async () => {
    await expect(update(a, "billingEntity", f.entity, { factorName: "Summit Capital" })).rejects.toThrow(/needs a remit-to address/);
    await update(a, "billingEntity", f.entity, { factorName: "Summit Capital", factorEmail: "f@summit.test", factorRemitTo: { line1: "PO Box 1", city: "Dallas", state: "TX" }, factorAll: true });
    const { billingEntities } = await import("@/db/schema");
    // someone cleared it directly in the database: issuing still refuses
    await db.update(billingEntities).set({ factorRemitTo: null }).where(eq(billingEntities.id, f.entity));
    const o = await delivered({ customerId: f.usCust, rateCents: 263750 });
    const draft = await B.createInvoice(a, [o.order.id]);
    await expect(B.issueInvoice(a, draft.id)).rejects.toThrow(/no remit-to address for the factor/);
    await db.update(billingEntities).set({ factorRemitTo: { line1: "PO Box 1", city: "Dallas", state: "TX" } }).where(eq(billingEntities.id, f.entity));
    const inv = await B.issueInvoice(a, draft.id);
    expect(inv.snapshot!.factor!.remitTo).toMatchObject({ line1: "PO Box 1" });
    await F.recordFunding(a, [inv.id], { advanceBp: 95, feeBp: 2.5 });
    const cb = await F.recordChargeback(a, inv.id, { note: "90 days unpaid" });
    expect(cb).toMatchObject({ advanceCents: 250563, feeCents: 6594, repaidCents: 257157, reserveBackToArCents: 6593 });
    const l = await F.factorLedger(a);
    expect(l.rows[0]).toMatchObject({ status: "charged_back", reserveBackToArCents: 6593, needsCorrectedInvoice: true });
    expect(l.totals.reserveBackToAr).toBe(6593);
    expect((await B.aging(a)).totals.USD.total).toBe(263750);
    const sent = await B.sendCorrectedInvoice(a, inv.id);
    expect(sent.state).toBe("sent");
    const after = (await B.invoiceById(a, inv.id)).invoice;
    expect(after.snapshot!.factor).toBeNull();
    expect(after.snapshot!.correctedFromFactor).toBe("Summit Capital");
    expect(after.pdfStorageKey).not.toBe(inv.pdfStorageKey);
    expect((await F.factorLedger(a)).rows[0].needsCorrectedInvoice).toBe(false);
  });

  it("factor funding, collection, chargeback and carrier bill payments dated in a closed period are refused", async () => {
    await update(a, "billingEntity", f.entity, { factorName: "Summit Capital", factorEmail: "f@summit.test", factorRemitTo: { line1: "PO Box 1", city: "Dallas" }, factorAll: true });
    const inv = await invoice((await delivered({ customerId: f.usCust, rateCents: 100000 })).order.id);
    await B.closePeriod(a, new Date(Date.now() - 86400_000));
    const old = new Date(Date.now() - 5 * 86400_000);
    await expect(F.recordFunding(a, [inv.id], { at: old })).rejects.toThrow(/books are closed/);
    await F.recordFunding(a, [inv.id], {});
    await expect(F.recordChargeback(a, inv.id, { at: old })).rejects.toThrow(/books are closed/);
    await expect(F.recordCollection(a, inv.id, { at: old })).rejects.toThrow(/books are closed/);
    await delivered({ customerId: f.usCust, rateCents: 90000, carrier: { id: f.lone, cents: 45000 } });
    await B.syncCarrierBills(a);
    const [bill] = await B.carrierBillsList(a);
    await B.receiveCarrierBill(a, bill.bill.id, { invoicedCents: 45000 });
    await B.approveCarrierBill(a, bill.bill.id, { allowNoPod: true });
    await expect(B.payCarrierBill(a, bill.bill.id, { method: "ach", paidAt: old })).rejects.toThrow(/books are closed/);
  });
});

describe("credit memos and disputes", () => {
  it("a credit memo has its own number sequence and PDF, is sent like an invoice, re-draws the invoice; a dispute is resolved with an outcome and a note", async () => {
    const o1 = await delivered({ customerId: f.usCust, rateCents: 285000 });
    const i1 = await invoice(o1.order.id);
    await B.sendInvoice(a, i1.id);
    await B.disputeInvoice(a, i1.id, "lumper not approved");
    await expect(B.resolveDispute(a, i1.id, { outcome: "credited", note: "agreed" })).rejects.toThrow(/issue the credit memo first/);
    const cm = await B.creditMemo(a, i1.id, { amountCents: 40000, reason: "lumper not approved" });
    expect(cm.number).toBe("FF-CM-000001");
    expect(cm.pdfStorageKey).toBeTruthy();
    const i2 = await invoice((await delivered({ customerId: f.usCust, rateCents: 100000 })).order.id);
    expect(i2.number).toBe("FF-002402"); // the credit took no invoice number
    const { bytes } = await B.creditMemoPdf(a, cm.id);
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("%PDF");
    const sent = await B.sendCreditMemo(a, cm.id);
    expect(sent.sentTo).toBe("ap@summit.test");
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectKind, "credit_memo"));
    expect(mail.subject).toContain("Credit memo FF-CM-000001");
    expect(mail.body).toContain("$2,450.00");
    expect((await B.listCreditMemos(a)).map((m) => m.memo.number)).toEqual(["FF-CM-000001"]);
    const inv = (await B.invoiceById(a, i1.id)).invoice;
    expect(inv.pdfStorageKey).not.toBe(i1.pdfStorageKey); // re-drawn with the credit
    const r = await B.resolveDispute(a, i1.id, { outcome: "credited", note: "credit FF-CM-000001 agreed with Sam at Summit" });
    expect(r.state).toBe("sent");
    expect(r.disputeResolution).toMatch(/^Resolved with a credit memo: credit FF-CM-000001/);
    await expect(B.resolveDispute(a, i1.id, { outcome: "other", note: "x" })).rejects.toThrow(/only a disputed invoice/);
  });

  it("a supplemental invoice names the invoice it adds to; the invoice snapshot prints dates on the stop's own day", async () => {
    const o = await delivered({ customerId: f.usCust, rateCents: 150000 });
    const first = await invoice(o.order.id);
    await B.addCharge(a, o.order.id, { kind: "detention", rateCents: 18500 });
    const sup = await B.createInvoice(a, [o.order.id]);
    expect(sup).toMatchObject({ kind: "supplemental", supplementOf: first.id });
    const issued = await B.issueInvoice(a, sup.id);
    expect(issued.snapshot!.supplementOf).toBe(first.number);
    expect(issued.snapshot!.stops[0].departedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(issued.snapshot!.timeZone).toBe("America/Detroit");
  });
});

describe("records", () => {
  it("rejects a currency we don't use on a load", async () => {
    const o = await delivered({ customerId: f.usCust, rateCents: 100000 });
    await expect(updateOrder(a, o.order.id, { currency: "EUR" })).rejects.toBeInstanceOf(ValidationError);
  });
});
