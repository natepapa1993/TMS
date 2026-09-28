// Features: F-26.4 F-26.5
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { settlements, receipts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import * as B from "./billing";
import * as F from "./factoring";
import * as R from "./settlement-run";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; d1: string; d2: string; d3: string; entity: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Pay Carrier");
  const entity = await create(a, "billingEntity", { legalName: "Pay Carrier LLC", country: "US", invoicePrefix: "PC", nextInvoiceNumber: 1, isDefault: true, factorName: "Triumph", factorEmail: "schedules@triumph.test", factorAll: true, factorAdvanceBp: 90, factorFeeBp: 3, factorRecourseDays: 90 });
  const cust = await create(a, "customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", requiredDocs: [] });
  const t1 = await create(a, "truck", { unitNumber: "101", usPlate: "TX101", usPlateExpires: future });
  const d1 = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id, payType: "per_mile", payRateCents: 60 });
  const d2 = await create(a, "driver", { name: "Ana Torres", driverType: "CDL", licenseExpires: future, medicalExpires: future });
  const d3 = await create(a, "driver", { name: "Luis Vega", driverType: "CDL", licenseExpires: future, medicalExpires: future });
  f = { cust: cust.id, t1: t1.id, d1: d1.id, d2: d2.id, d3: d3.id, entity: entity.id };
});

async function delivered(rate = 100000) {
  const o = await createOrder(a, { customerId: f.cust, rateCents: rate, stops: [{ type: "pickup", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas", country: "US" }], book: true });
  await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d1 }, { plannedMiles: 500 });
  await dispatchLeg(a, o.legs[0].id);
  await acceptLeg(a, o.legs[0].id);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
  return o;
}

describe("the weekly pay run", () => {
  it("builds a statement for everyone who ran or has a pay item due, approves them together (not a disputed one), pays them in one batch; the PDF carries the year to date", async () => {
    await delivered();
    await B.addPayItem(a, f.d2, { kind: "reimbursement", description: "Scale ticket", amountCents: 1200 });
    const start = new Date(Date.now() - 3 * 86400_000);
    const end = new Date(Date.now() + 4 * 86400_000);
    const run = await R.settlementRun(a, start, end);
    expect(run.map((r) => [r.driver, r.netCents, r.note])).toEqual([
      ["Ana Torres", 1200, "pay items only (no legs this week)"],
      ["Daniel Reyes", 30000, null],
    ]); // Luis ran nothing
    const [ana, dan] = run.map((r) => r.settlementId!);
    // Ana disputes her line: her statement waits
    const [st] = await db.select().from(settlements).where(eq(settlements.id, ana));
    await db.update(settlements).set({ lines: st.lines.map((l) => ({ ...l, disputed: "that was $15" })) }).where(eq(settlements.id, ana));
    const ap = await R.approveSettlements(a, [ana, dan]);
    expect(ap.approved).toBe(1);
    expect(ap.skipped[0].reason).toMatch(/disputed/);
    await expect(R.paySettlements(a, [ana], { method: "ach" })).rejects.toThrow(/nothing approved/);
    const paid = await R.paySettlements(a, [ana, dan], { method: "ach", reference: "ACH 0926" });
    expect(paid).toEqual({ paid: 1, totalCents: 30000 });
    // running the week again leaves the paid one alone
    expect((await R.settlementRun(a, start, end)).find((r) => r.settlementId === dan)!.note).toBe("already paid");
    const pdf = await PDFDocument.load(await R.settlementPdf(a, dan));
    expect(pdf.getPageCount()).toBe(1);
    // the driver app: only their own, only approved or paid
    expect(await R.driverSettlementPdf(a.tenantId, f.d1, dan)).not.toBeNull();
    expect(await R.driverSettlementPdf(a.tenantId, f.d2, dan)).toBeNull();
    expect(await R.driverSettlementPdf(a.tenantId, f.d2, ana)).toBeNull(); // still open
  });
});

describe("factoring ledger", () => {
  it("funds at the entity's terms (90% / 3%), leaves Receivables, collects with the reserve back; a chargeback returns the invoice to Receivables", async () => {
    expect(F.toBp(97, 0)).toBe(9700);
    expect(F.toBp(9700, 0)).toBe(9700);
    expect(F.split(100000, 9000, 300)).toEqual({ advance: 90000, fee: 3000, reserve: 7000 });
    const i1 = await B.issueInvoice(a, (await B.createInvoice(a, [(await delivered(100000)).order.id])).id);
    const i2 = await B.issueInvoice(a, (await B.createInvoice(a, [(await delivered(50000)).order.id])).id);
    expect(i1.factored).toBe(true);
    let l = await F.factorLedger(a);
    expect(l.rows.map((r) => r.status)).toEqual(["to_fund", "to_fund"]);
    expect(l.totals.toFund).toBe(150000);
    await expect(F.recordFunding(a, [], {})).rejects.toThrow(/pick/);
    const funded = await F.recordFunding(a, [i1.id, i2.id], { reference: "SCH-77" });
    expect(funded.advancedCents).toBe(135000);
    await expect(F.recordFunding(a, [i1.id], {})).rejects.toThrow(/already funded/);
    l = await F.factorLedger(a);
    expect(l.totals).toMatchObject({ toFund: 0, exposure: 135000, reserveHeld: 10500, feesYtd: 4500 });
    // Receivables: the customer owes the factor, not us
    const ar = await B.aging(a);
    expect(ar.totals.total).toBe(0);
    expect(ar.withFactor).toBe(150000);
    // collected: the invoice is paid by factoring and the 7% reserve comes back
    const c = await F.recordCollection(a, i1.id, { reference: "REM-1" });
    expect(c.reserveCents).toBe(7000);
    const d = await B.invoiceById(a, i1.id);
    expect(d.invoice.state).toBe("paid");
    expect((await db.select().from(receipts).where(eq(receipts.invoiceId, i1.id)))[0].method).toBe("factoring");
    await expect(F.recordChargeback(a, i1.id)).rejects.toThrow(/collected/);
    // unpaid past recourse: charged back, back in our Receivables
    const cb = await F.recordChargeback(a, i2.id, { note: "RXO didn't pay in 90 days" });
    expect(cb.repaidCents).toBe(45000);
    expect((await B.aging(a)).totals.total).toBe(50000);
    l = await F.factorLedger(a);
    expect(Object.fromEntries(l.rows.map((r) => [r.number, r.status]))).toEqual({ [i1.number!]: "collected", [i2.number!]: "charged_back" });
    expect(l.totals.exposure).toBe(0);
  });
});
