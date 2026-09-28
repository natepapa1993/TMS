// Features: F-7.2 QuickBooks export — IIF and QBO CSV from the ledger, runs that stamp what went out, reopen
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, ValidationError } from "./orders";
import * as B from "./billing";
import * as A from "./accounting";
import { updateCompany } from "./company";
import { zonedDate } from "@/lib/time";

/** statements for this week can only be approved once it has ended */
const afterWeek = new Date(Date.now() + 8 * 86400_000);

const future = new Date(Date.now() + 365 * 86400_000);
const pdf = Buffer.from("%PDF-1.4 fixture");
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; garza: string; t2104: string; reyes: string };
const today = () => zonedDate(new Date(), "America/Detroit");
const period = () => ({ from: zonedDate(new Date(Date.now() - 40 * 86400_000), "America/Detroit"), to: today() });

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", nextInvoiceNumber: 1, isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, billingEmail: "ap@rxo.test", requiredDocs: [], qbName: "RXO Logistics LLC" });
  const garza = await create(a, "carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test", mcNumber: "123456" });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t2104.id, qbName: "Reyes, Daniel" });
  f = { rxo: rxo.id, garza: garza.id, t2104: t2104.id, reyes: reyes.id };
});

async function delivered(rate: number, who: "truck" | "carrier") {
  const o = await createOrder(a, { customerId: f.rxo, rateCents: rate, refs: { rate_con: "RC-1" }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }], template: "domestic", book: true });
  const leg = o.legs[0].id;
  if (who === "truck") await planLeg(a, leg, { kind: "truck", truckId: f.t2104, driverId: f.reyes }, { plannedMiles: 420 });
  else await planLeg(a, leg, { kind: "carrier", carrierId: f.garza, carrierRateCents: 45000 });
  await dispatchLeg(a, leg);
  await acceptLeg(a, leg, who === "truck" ? "driver_app" : "carrier");
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
  await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
  return o;
}

describe("QuickBooks export", () => {
  it("IIF carries invoices (income by charge kind), receipts, carrier bills with payment, driver settlements with deductions; names come from the QuickBooks fields", async () => {
    await updateCompany(a, { qb: { bankAccount: "Chase Operating" } });
    const o1 = await delivered(180000, "truck");
    await B.addCharge(a, o1.order.id, { kind: "fuel", description: "Fuel surcharge 20%", qty: 2000, unit: "pct", rateCents: 180000 });
    await B.acceptRateConMismatch(a, o1.order.id, "fuel per tariff");
    const inv = await B.issueInvoice(a, (await B.createInvoice(a, [o1.order.id])).id);
    await B.recordReceipt(a, inv.id, { amountCents: 100000, method: "ach", reference: "ACH-1", receivedAt: new Date() });
    const o2 = await delivered(90000, "carrier");
    await B.syncCarrierBills(a);
    const [bill] = await B.carrierBillsList(a);
    await B.receiveCarrierBill(a, bill.bill.id, { invoicedCents: 45000, carrierInvoiceNumber: "LS-1001" });
    await B.approveCarrierBill(a, bill.bill.id, { approvedCents: 45000 });
    await B.payCarrierBill(a, bill.bill.id, { method: "ach", reference: "ACH-9" });
    const { start, end } = B.weekOf(new Date());
    await B.addPayItem(a, f.reyes, { kind: "deduction", description: "Occupational insurance", amountCents: 4500, recurring: true });
    let st = await B.buildSettlement(a, f.reyes, start, end);
    st = await B.settlementTransition(a, st.id, "reviewed");
    await B.settlementTransition(a, st.id, "approved", { now: afterWeek });
    void o2;

    const preview = await A.previewExport(a, { ...period(), onlyNew: true });
    expect(preview).toMatchObject({ invoices: 1, receipts: 1, carrierBills: 1, settlements: 1, invoicedCents: 216000, receivedCents: 100000 });
    const run = await A.createExport(a, { format: "iif", ...period(), onlyNew: true });
    expect(run.counts).toEqual({ invoices: 1, receipts: 1, carrierBills: 1, settlements: 1 });
    const { files } = await A.exportFiles(a, run.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/\.iif$/);
    const iif = files[0].body;
    const lines = iif.split("\r\n");
    expect(lines[0]).toBe("!ACCNT\tNAME\tACCNTTYPE"); // the accounts it posts to come first, so a fresh company file takes it
    expect(lines).toContain("ACCNT\tAccounts Receivable\tAR");
    expect(lines).toContain("ACCNT\tUndeposited Funds\tOCASSET");
    expect(lines).toContain("!CUST\tNAME");
    expect(lines).toContain("CUST\tRXO Logistics LLC");
    expect(lines).toContain("VEND\tLone Star Freight");
    expect(lines).toContain("VEND\tReyes, Daniel");
    const d = lines.find((l) => l.startsWith("TRNS\t\tINVOICE"))!;
    expect(d).toMatch(/^TRNS\t\tINVOICE\t\d{2}\/\d{2}\/\d{4}\tAccounts Receivable\tRXO Logistics LLC\t\t2160\.00\t247-000001\t26-00001\tN\tNet 30\t\d{2}\/\d{2}\/\d{4}$/);
    expect(lines.some((l) => /^SPL\t\tINVOICE\t.*\tFreight Income\tRXO Logistics LLC\t\t-1800\.00\t247-000001\tLine haul\t-1\t1800\.00\tLine haul$/.test(l))).toBe(true);
    expect(lines.some((l) => /^SPL\t\tINVOICE\t.*\tFuel Surcharge Income\t.*\t-360\.00\t247-000001\tFuel surcharge 20%\t-1\t360\.00\tFuel surcharge$/.test(l))).toBe(true);
    expect(lines.some((l) => /^TRNS\t\tPAYMENT\t.*\tUndeposited Funds\tRXO Logistics LLC\t\t1000\.00\tACH-1\tach for 247-000001/.test(l))).toBe(true);
    expect(lines.some((l) => /^SPL\t\tPAYMENT\t.*\tAccounts Receivable\t.*\t-1000\.00\t247-000001/.test(l))).toBe(true);
    expect(lines.some((l) => /^TRNS\t\tBILL\t.*\tAccounts Payable\tLone Star Freight\t\t-450\.00\tLS-1001\t26-00002/.test(l))).toBe(true);
    expect(lines.some((l) => /^SPL\t\tBILL\t.*\tPurchased Transportation\tLone Star Freight\t\t450\.00\tLS-1001/.test(l))).toBe(true);
    expect(lines.some((l) => /^TRNS\t\tBILLPMT\t.*\tChase Operating\tLone Star Freight\t\t-450\.00\tACH-9\tpays LS-1001/.test(l))).toBe(true);
    expect(lines.some((l) => /^TRNS\t\tBILL\t.*\tAccounts Payable\tReyes, Daniel\t\t-215\.40\tPAY-\d{4}-\d{2}-\d{2}\tweek of/.test(l))).toBe(true);
    expect(lines.some((l) => /^SPL\t\tBILL\t.*\tDriver Pay\tReyes, Daniel\t\t260\.40\t/.test(l))).toBe(true);
    expect(lines.some((l) => /^SPL\t\tBILL\t.*\tDriver Deductions\tReyes, Daniel\t\t-45\.00\t.*Occupational insurance/.test(l))).toBe(true);
    // every TRNS balances against its SPLs
    let bal = 0;
    for (const l of lines) {
      const c = l.split("\t");
      if (c[0] === "TRNS" || c[0] === "SPL") bal += Math.round(Number(c[7]) * 100);
      if (c[0] === "ENDTRNS") {
        expect(bal).toBe(0);
        bal = 0;
      }
    }
    // the run stamped everything: only-new finds nothing, everything finds them again
    await expect(A.createExport(a, { format: "iif", ...period(), onlyNew: true })).rejects.toThrow(/nothing new/);
    expect((await A.previewExport(a, { ...period(), onlyNew: false })).invoices).toBe(1);
    // reopen → new again, once
    await A.reopenExport(a, run.id);
    expect((await A.previewExport(a, { ...period(), onlyNew: true })).invoices).toBe(1);
    await expect(A.reopenExport(a, run.id)).rejects.toThrow(/already/);
    expect((await A.listExports(a))[0].reopenedAt).toBeTruthy();
  });

  it("QBO gives one CSV per list with the import columns; blank QuickBooks names fall back to the record name; bad periods refused", async () => {
    await update(a, "customer", f.rxo, { qbName: "" });
    const o = await delivered(100000, "truck");
    const inv = await B.issueInvoice(a, (await B.createInvoice(a, [o.order.id])).id);
    await B.recordReceipt(a, inv.id, { amountCents: 100000, method: "check", reference: "1234", receivedAt: new Date() });
    const run = await A.createExport(a, { format: "qbo", ...period(), onlyNew: true });
    const { files } = await A.exportFiles(a, run.id);
    expect(files.map((x) => x.name.replace(/^.*-/, ""))).toEqual(["invoices.csv", "bills.csv", "payments.csv", "credits.csv", "journal.csv"]);
    const invCsv = files[0].body.split("\r\n");
    expect(invCsv[0]).toBe("InvoiceNo,Customer,InvoiceDate,DueDate,Terms,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,Currency");
    expect(invCsv[1]).toMatch(/^247-000001,RXO,\d{2}\/\d{2}\/\d{4},\d{2}\/\d{2}\/\d{4},Net 30,26-00001,Line haul,Line haul,1,1000\.00,1000\.00,USD$/);
    const pay = files[2].body.split("\r\n");
    expect(pay[1]).toMatch(/^\d{2}\/\d{2}\/\d{4},RXO,247-000001,1000\.00,check,1234,Undeposited Funds,1000\.00$/);
    expect(files[1].body.split("\r\n").filter(Boolean)).toHaveLength(1); // header only: no bills
    await expect(A.createExport(a, { format: "qbo", from: "2026-13-01", to: today(), onlyNew: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(A.createExport(a, { format: "qbo", from: today(), to: "2020-01-01", onlyNew: true })).rejects.toThrow(/after/);
  });

  it("credit memos go out as credit memos (IIF and CSV), once; a credit can't exceed what's still open; a receipt keeps its calendar day", async () => {
    const o = await delivered(175000, "truck");
    const inv = await B.issueInvoice(a, (await B.createInvoice(a, [o.order.id])).id);
    await B.recordReceipt(a, inv.id, { amountCents: 170000, method: "ach", reference: "ACH-1", receivedAt: new Date("2026-09-27T12:00:00Z") });
    await expect(B.creditMemo(a, inv.id, { amountCents: 170000, reason: "wrong" })).rejects.toThrow(/can't be more than the \$50\.00 still open/);
    const cm = await B.creditMemo(a, inv.id, { amountCents: 5000, reason: "late delivery discount" });
    const run = await A.createExport(a, { format: "iif", ...period(), onlyNew: true });
    const { files } = await A.exportFiles(a, run.id);
    const iif = files[0].body;
    expect(iif).toContain(`CREDIT MEMO`);
    const cmLine = iif.split("\r\n").find((l) => l.startsWith("TRNS\t\tCREDIT MEMO"))!;
    expect(cmLine.split("\t").slice(7, 9)).toEqual(["-50.00", cm.number]);
    expect(iif).toMatch(/TRNS\t\tPAYMENT\t09\/27\/2026/);
    expect((await A.previewExport(a, { ...period(), onlyNew: true })).credits).toBe(0);
    const q = await A.createExport(a, { format: "qbo", ...period(), onlyNew: false });
    const credits = (await A.exportFiles(a, q.id)).files.find((x) => x.name.endsWith("credits.csv"))!;
    expect(credits.body).toContain(`${cm.number},`);
    expect(credits.body).toContain(",late delivery discount,50.00,USD");
  });
});
