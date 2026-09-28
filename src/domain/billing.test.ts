// Features: F-7 billing — charges, queue with docs + rate-con hard stop, invoice lifecycle with locked snapshot and entity numbering, receipts, void/credit/dispute, AR aging + reminders, carrier bills 3-way + short-pay + pay-when-paid + 1099, driver settlements + deductions + disputes, P&L, month-end close F-4.9 F-26.2
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { outbox, billingEntities } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder, updateOrder, setLegMiles, ValidationError, cancelOrder } from "./orders";
import { updateCompany } from "./company";
import { sendTender, respondToTender } from "./tenders";
import * as B from "./billing";
import { TransitionError } from "./states";

const future = new Date(Date.now() + 365 * 86400_000);
const pdf = Buffer.from("%PDF-1.4 fixture");
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { entity: string; rxo: string; garza: string; t2104: string; reyes: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  const entity = await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", dba: "24/7 Expedite", country: "US", invoicePrefix: "247", nextInvoiceNumber: 1001, isDefault: true, taxId: "12-3456789", remitTo: { line1: "1 Main St", city: "Canton", state: "MI", postalCode: "48187", country: "US" } });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, billingEmail: "ap@rxo.test", requiredDocs: ["POD", "RATE_CON"] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t2104.id });
  f = { entity: entity.id, rxo: rxo.id, garza: garza.id, t2104: t2104.id, reyes: reyes.id };
});

/** A delivered domestic order on our truck with planned miles. */
async function delivered(rate = 180000, miles = 420) {
  const o = await createOrder(a, { customerId: f.rxo, rateCents: rate, refs: { rate_con: "RC-1" }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }], template: "domestic", book: true });
  await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t2104, driverId: f.reyes }, { plannedMiles: miles });
  await dispatchLeg(a, o.legs[0].id);
  await acceptLeg(a, o.legs[0].id);
  const t0 = new Date(Date.now() - 6 * 3600_000);
  const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
  await advanceLeg(a, o.legs[0].id, "en_route_to_pickup", { at: at(0) });
  await advanceLeg(a, o.legs[0].id, "at_pickup", { at: at(1) });
  await advanceLeg(a, o.legs[0].id, "loaded", { at: at(4.5) }); // 3.5 h at pickup → 1.5 h detention over 2 h free
  await advanceLeg(a, o.legs[0].id, "en_route", { at: at(4.5) });
  await advanceLeg(a, o.legs[0].id, "at_delivery", { at: at(5) });
  await advanceLeg(a, o.legs[0].id, "completed", { at: at(5.5) });
  return o;
}

describe("charges & queue (7.2, 7.3)", () => {
  it("line haul comes from the rate con; detention is computed from the stop clocks with the customer's free time", async () => {
    const o = await delivered();
    const cs = await B.ensureCharges(a, o.order.id);
    expect(cs.map((c) => `${c.kind}:${c.amountCents}`)).toEqual(["linehaul:180000"]);
    const det = await B.computeDetention(a, o.order.id, { freeMinutes: 120, rateCentsPerHour: 7500 });
    expect(det.length).toBe(1);
    expect(det[0].qty).toBe(150); // 1.50 h
    expect(det[0].amountCents).toBe(11250);
    expect(det[0].data?.stopId).toBeTruthy();
    expect((await B.computeDetention(a, o.order.id)).length).toBe(0); // idempotent
    const q = await B.billingQueue(a);
    expect(q[0].chargesCents).toBe(180000); // detention waits for the customer's OK
    expect(q[0].pending).toMatchObject({ count: 1, cents: 11250 });
    expect(q[0].mismatch).toBe(false); // an extra isn't a rate-con difference: it's an approval
    expect(q[0].docsComplete).toBe(false);
    expect(q[0].requiredDocs.map((d) => `${d.code}:${d.present}`)).toEqual(["POD:false", "RATE_CON:false"]);
  });

  it("no invoice without the required docs; no invoice while charges differ from the rate con unless accepted with a note", async () => {
    const o = await delivered();
    await B.computeDetention(a, o.order.id);
    await expect(B.createInvoice(a, [o.order.id])).rejects.toThrow(/missing POD, RATE_CON/);
    await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc.pdf", mimeType: "application/pdf", bytes: pdf });
    await expect(B.createInvoice(a, [o.order.id])).rejects.toThrow(/waiting for the customer's approval \(Detention/);
    await expect(B.acceptRateConMismatch(a, o.order.id, "")).rejects.toBeInstanceOf(ValidationError);
    await B.acceptRateConMismatch(a, o.order.id, "detention approved by RXO email 9/26");
    // the customer also requires their PO and ASN on the order before it invoices (spec §7.2 "every customer-required reference")
    await update(a, "customer", f.rxo, { requiredRefs: ["PO", "ASN"] });
    let q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q.requiredRefs).toEqual([{ key: "po", present: false }, { key: "asn", present: false }]);
    expect(q.docsComplete).toBe(false);
    await expect(B.createInvoice(a, [o.order.id])).rejects.toThrow(/missing PO reference, ASN reference/);
    await updateOrder(a, o.order.id, { refs: { ...o.order.refs, po: "5700489439", asn: "6933176" } });
    q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q.requiredRefs.every((r) => r.present)).toBe(true);
    const inv = await B.createInvoice(a, [o.order.id]);
    expect(inv.state).toBe("draft");
    expect(inv.subtotalCents).toBe(191250);
    expect((await getOrder(a, o.order.id)).order.state).toBe("ready_to_bill");
    await expect(B.createInvoice(a, [o.order.id])).rejects.toThrow(/already on an invoice|not ready|already has a draft/);
  });
});

async function readyInvoice(rate = 180000) {
  const o = await delivered(rate);
  await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
  await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc.pdf", mimeType: "application/pdf", bytes: pdf });
  const inv = await B.createInvoice(a, [o.order.id]);
  return { o, inv };
}

describe("invoice lifecycle (7.1, 7.4)", () => {
  it("issue: entity-prefixed number, locked snapshot, PDF; order → invoiced; send; receipts partial then full → paid; over-payment refused", async () => {
    const { o, inv } = await readyInvoice();
    const issued = await B.issueInvoice(a, inv.id);
    expect(issued.number).toBe("247-001001");
    expect(issued.state).toBe("issued");
    expect(issued.dueAt!.getTime() - issued.issuedAt!.getTime()).toBe(30 * 86400_000);
    expect(issued.snapshot!.lines[0].description).toBe("Line haul");
    expect(issued.snapshot!.entity.legalName).toBe("24/7 Expedite LLC");
    expect(issued.snapshot!.billTo.name).toBe("RXO");
    expect(issued.snapshot!.stops.map((x) => x.name)).toEqual(["Laredo Yard", "Toyota San Antonio"]);
    expect((await getOrder(a, o.order.id)).order.state).toBe("invoiced");
    const [ent] = await db.select().from(billingEntities).where(eq(billingEntities.id, f.entity));
    expect(ent.nextInvoiceNumber).toBe(1002);
    // the PDF is real and built from the snapshot
    const pub = await B.invoiceByToken(issued.token!);
    const doc = await PDFDocument.load(pub!.blob.bytes);
    expect(doc.getPageCount()).toBe(1);
    // renaming the customer later does not change the issued invoice
    await update(a, "customer", f.rxo, { name: "RXO Logistics" });
    expect((await B.invoiceById(a, inv.id)).invoice.snapshot!.billTo.name).toBe("RXO");
    // the invoice's charges are locked; a late one waits for approval, then goes on a supplemental invoice
    const late = await B.addCharge(a, o.order.id, { kind: "lumper", rateCents: 5000 });
    expect(late.approvalState).toBe("pending");
    expect((await B.billingQueue(a)).find((q) => q.order.id === o.order.id)).toMatchObject({ supplemental: true, chargesCents: 0, pending: { count: 1 } });
    await expect(B.removeCharge(a, (await B.chargesFor(a, o.order.id)).find((c) => c.kind === "linehaul")!.id)).rejects.toThrow(/on an invoice/);
    await B.removeCharge(a, late.id);

    const sent = await B.sendInvoice(a, inv.id);
    expect(sent.state).toBe("sent");
    expect(sent.sentTo).toBe("ap@rxo.test");
    const mail = await db.select().from(outbox).where(eq(outbox.subjectId, inv.id));
    expect(mail[0].body).toContain("247-001001");
    expect(mail[0].body).toContain(`/i/${issued.token}`);

    await expect(B.recordReceipt(a, inv.id, { amountCents: 200000 })).rejects.toThrow(/over-payment/);
    let r = await B.recordReceipt(a, inv.id, { amountCents: 100000, method: "ach", reference: "ACH-1" });
    expect(r.state).toBe("partially_paid");
    r = await B.recordReceipt(a, inv.id, { amountCents: 80000, method: "check", reference: "1234" });
    expect(r.state).toBe("paid");
    expect((await getOrder(a, o.order.id)).order.state).toBe("paid");
    await expect(B.recordReceipt(a, inv.id, { amountCents: 1 })).rejects.toBeInstanceOf(TransitionError);
  });

  it("void only without receipts; a voided number is never reused; credit memo has its own number; dispute", async () => {
    const { o, inv } = await readyInvoice();
    await B.issueInvoice(a, inv.id);
    await expect(B.voidInvoice(a, inv.id, "")).rejects.toBeInstanceOf(ValidationError);
    const v = await B.voidInvoice(a, inv.id, "wrong entity");
    expect(v.state).toBe("void");
    expect(v.number).toBe("247-001001");
    expect((await getOrder(a, o.order.id)).order.state).toBe("ready_to_bill");
    const inv2 = await B.createInvoice(a, [o.order.id]);
    const issued2 = await B.issueInvoice(a, inv2.id);
    expect(issued2.number).toBe("247-001002");
    await B.recordReceipt(a, inv2.id, { amountCents: 50000 });
    await expect(B.voidInvoice(a, inv2.id, "x")).rejects.toThrow(/credit memo/);
    await expect(B.creditMemo(a, inv2.id, { amountCents: 500000, reason: "too much" })).rejects.toBeInstanceOf(ValidationError);
    const memo = await B.creditMemo(a, inv2.id, { amountCents: 30000, reason: "detention waived" });
    expect(memo.number).toBe("247-CM-000001"); // its own sequence: invoice numbers keep no gaps
    let cur = (await B.invoiceById(a, inv2.id)).invoice;
    expect(cur.creditedCents).toBe(30000);
    expect(cur.state).toBe("partially_paid");
    await B.recordReceipt(a, inv2.id, { amountCents: 100000 });
    cur = (await B.invoiceById(a, inv2.id)).invoice;
    expect(cur.state).toBe("paid");
    // an order on an issued invoice cannot be cancelled
    await expect(cancelOrder(a, o.order.id, "x")).rejects.toBeInstanceOf(TransitionError);
    // dispute
    const { inv: inv3 } = await readyInvoice();
    await B.issueInvoice(a, inv3.id);
    await B.sendInvoice(a, inv3.id);
    const d = await B.disputeInvoice(a, inv3.id, "customer says lumper not approved", new Date(Date.now() + 5 * 86400_000));
    expect(d.state).toBe("disputed");
    await B.recordReceipt(a, inv3.id, { amountCents: 180000 });
    expect((await B.invoiceById(a, inv3.id)).invoice.state).toBe("paid");
  });

  it("month-end close blocks issuing, voiding and crediting in the closed period", async () => {
    const { inv } = await readyInvoice();
    await B.closePeriod(a, new Date(Date.now() + 5000));
    await expect(B.issueInvoice(a, inv.id)).rejects.toThrow(/closed/);
    const issued = await B.issueInvoice(a, inv.id, { issuedAt: new Date(Date.now() + 60_000) });
    expect(issued.state).toBe("issued");
    await expect(B.closePeriod(a, new Date(Date.now() - 86400_000))).rejects.toThrow(/re-opened/);
  });

  it("consolidated invoice for one customer, refused across customers; MXN needs an exchange rate", async () => {
    const o1 = await delivered(100000);
    const o2 = await delivered(150000);
    for (const o of [o1, o2]) {
      await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
      await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc.pdf", mimeType: "application/pdf", bytes: pdf });
    }
    const inv = await B.createInvoice(a, [o1.order.id, o2.order.id]);
    expect(inv.subtotalCents).toBe(250000);
    const issued = await B.issueInvoice(a, inv.id);
    expect(issued.snapshot!.lines.length).toBe(2);
    const magna = await create(a, "customer", { name: "Magna", kind: "customer", requiredDocs: [] });
    const o3 = await createOrder(a, { customerId: magna.id, rateCents: 1000, currency: "MXN", stops: [{ type: "pickup", name: "A", country: "MX" }, { type: "border_yard", name: "B", country: "MX" }, { type: "yard", name: "C", country: "US" }], template: "mx_crossing", book: true });
    await planLeg(a, o3.legs[1].id, { kind: "carrier", carrierId: f.garza, carrierRateCents: 500 });
    await dispatchLeg(a, o3.legs[1].id);
    await acceptLeg(a, o3.legs[1].id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o3.legs[1].id, st, { source: "carrier" });
    await planLeg(a, o3.legs[0].id, { kind: "carrier", carrierId: f.garza, carrierRateCents: 500 });
    await dispatchLeg(a, o3.legs[0].id);
    await acceptLeg(a, o3.legs[0].id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o3.legs[0].id, st, { source: "carrier" });
    await expect(B.createInvoice(a, [o3.order.id, o1.order.id])).rejects.toThrow(/one customer|already/);
    const inv3 = await B.createInvoice(a, [o3.order.id]);
    await expect(B.issueInvoice(a, inv3.id)).rejects.toThrow(/exchange rate/);
    const issued3 = await B.issueInvoice(a, inv3.id, { exchangeRate: 18.4321 });
    expect(issued3.exchangeRate).toBe(184321);
  });
});

describe("AR (7.5)", () => {
  it("customer and order master data drive the numbers: free time, detention rate, fuel %, reminder opt-out, tolls in the P&L", async () => {
    await update(a, "customer", f.rxo, { detentionFreeMinutes: 60, detentionRateCents: 5000, reminderDays: [] });
    const o = await delivered();
    await updateOrder(a, o.order.id, { fuelRule: "pct", fuelPct: 20, tollsFeesCents: 3200 });
    const cs = await B.ensureCharges(a, o.order.id);
    expect(cs.map((c) => `${c.kind}:${c.amountCents}`).sort()).toEqual(["fuel:36000", "linehaul:180000"]);
    const det = await B.computeDetention(a, o.order.id);
    expect(det[0].qty).toBe(250); // 3.5 h at the dock − 1 h free
    expect(det[0].amountCents).toBe(12500);
    await updateCompany(a, { fuelCostCentsPerMile: 80 });
    await setLegMiles(a, o.legs[0].id, 500);
    const pnl = await B.orderPnl(a, o.order.id);
    expect(pnl.extra).toBe(3200);
    expect(pnl.fuel).toBe(500 * 80);
    await expect(updateCompany(a, { timeZone: "Mars/Olympus" })).rejects.toBeInstanceOf(ValidationError);
    // opted out: no reminders however late
    await update(a, "customer", f.rxo, { requiredDocs: [] });
    await B.acceptRateConMismatch(a, o.order.id, "fuel and detention per the customer's tariff");
    const inv = await B.createInvoice(a, [o.order.id]);
    expect(inv.subtotalCents).toBe(180000 + 36000 + 12500);
    await B.issueInvoice(a, inv.id, { issuedAt: new Date(Date.now() - 60 * 86400_000) });
    await B.sendInvoice(a, inv.id);
    expect((await B.sendReminders(new Date())).sent).toBe(0);
  });

  it("aging buckets by customer, statement PDF, reminders once per step", async () => {
    const { inv } = await readyInvoice(100000);
    await B.issueInvoice(a, inv.id, { issuedAt: new Date(Date.now() - 45 * 86400_000) });
    await B.sendInvoice(a, inv.id);
    const { inv: inv2 } = await readyInvoice(50000);
    await B.issueInvoice(a, inv2.id);
    const ag = await B.aging(a);
    expect(ag.rows.length).toBe(1);
    expect(ag.rows[0].buckets["1_30"]).toBe(100000); // 15 days past due
    expect(ag.rows[0].buckets.current).toBe(50000);
    expect(ag.totals.USD.total).toBe(150000);
    const st = await PDFDocument.load((await B.statementPdf(a, f.rxo)).pdf);
    expect(st.getPageCount()).toBe(1);
    expect((await B.sendReminders(new Date())).sent).toBe(1); // +10 step (15 days late)
    expect((await B.sendReminders(new Date())).sent).toBe(0);
    const mails = await db.select().from(outbox).where(eq(outbox.subjectKind, "invoice_reminder"));
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toMatch(/15 days past due/);
    expect((await B.sendReminders(new Date(Date.now() + 6 * 86400_000))).sent).toBe(1); // +20 step
  });
});

describe("carrier bills (7.6)", () => {
  async function carrierLeg() {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops: [{ type: "pickup", name: "MTY", country: "MX" }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }], template: "mx_crossing", book: true });
    const t = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000 });
    await respondToTender(t.tender.token, { accept: true, name: "Luis", driverName: "Pedro" });
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st, { source: "carrier" });
    // the same carrier also runs the crossing (by phone, no tender) so the order delivers
    await planLeg(a, o.legs[1].id, { kind: "carrier", carrierId: f.garza, carrierRateCents: 15000 });
    await dispatchLeg(a, o.legs[1].id);
    await acceptLeg(a, o.legs[1].id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[1].id, st, { source: "carrier" });
    return o;
  }

  it("expected at the tender rate → received → three-way → approve / short-pay → pay with quick-pay; pay-when-paid holds; 1099", async () => {
    const o = await carrierLeg();
    const list = await B.carrierBillsList(a);
    expect(list.length).toBe(2);
    const bill = list.find((x) => x.legSeq === 1)!.bill;
    expect(list.find((x) => x.legSeq === 2)!.bill.expectedCents).toBe(15000); // no tender: the planned carrier rate
    expect(bill.state).toBe("expected");
    expect(bill.expectedCents).toBe(45000);
    await expect(B.approveCarrierBill(a, bill.id, {})).rejects.toBeInstanceOf(TransitionError);
    await B.receiveCarrierBill(a, bill.id, { invoicedCents: 48000, carrierInvoiceNumber: "G-88" });
    const chk = await B.threeWay(a, bill.id);
    expect(chk).toMatchObject({ expected: 45000, invoiced: 48000, podPresent: false, rateMatch: false, difference: 3000 });
    await expect(B.approveCarrierBill(a, bill.id, {})).rejects.toThrow(/no POD/);
    await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    await expect(B.approveCarrierBill(a, bill.id, {})).rejects.toThrow(/approve the difference with a reason, or short-pay/);
    await expect(B.approveCarrierBill(a, bill.id, { approvedCents: 45000 })).rejects.toThrow(/short-pay needs a note/);
    const ap = await B.approveCarrierBill(a, bill.id, { approvedCents: 45000, shortPayNote: "no accessorial was approved; paying the tender rate" });
    expect(ap.state).toBe("approved");
    expect(ap.approvedCents).toBe(45000);
    // pay-when-paid: the customer invoice is not paid
    await update(a, "customer", f.rxo, { payWhenPaid: true, requiredDocs: ["POD"] });
    const inv = await B.createInvoice(a, [o.order.id]);
    await B.issueInvoice(a, inv.id);
    await expect(B.payCarrierBill(a, bill.id, { method: "ach" })).rejects.toThrow(/pay-when-paid/);
    await B.recordReceipt(a, inv.id, { amountCents: 285000 });
    const paid = await B.payCarrierBill(a, bill.id, { method: "ach", reference: "ACH-9" });
    expect(paid.state).toBe("paid");
    expect(paid.paidCents).toBe(45000);
    const y = await B.carrier1099(a, new Date().getUTCFullYear());
    expect(y[0]).toMatchObject({ name: "Transportes Garza", total: 45000 }); // the crossing bill is not paid yet
    expect((await B.carrierBillsList(await makeTenant("B"))).length).toBe(0);
  });

  it("quick-pay discount applies when paid within 7 days of approval", async () => {
    await update(a, "carrier", f.garza, { quickPayPct: 2 });
    await carrierLeg();
    const row = (await B.carrierBillsList(a)).find((x) => x.legSeq === 1)!;
    await B.receiveCarrierBill(a, row.bill.id, { invoicedCents: 45000 });
    await B.approveCarrierBill(a, row.bill.id, { allowNoPod: true });
    const paid = await B.payCarrierBill(a, row.bill.id, { method: "ach" });
    expect(paid.paidCents).toBe(44100);
  });
});

describe("driver settlements (7.7) and P&L (7.8)", () => {
  it("weekly statement from completed legs at per-mile pay, deductions, states, driver dispute, advance paid back", async () => {
    const o = await delivered(180000, 420);
    const { start, end } = B.weekOf(new Date());
    await B.addPayItem(a, f.reyes, { kind: "deduction", description: "Fuel advance", amountCents: 20000, remainingCents: 30000 });
    await B.addPayItem(a, f.reyes, { kind: "deduction", description: "Occupational insurance", amountCents: 4500, recurring: true });
    let st = await B.buildSettlement(a, f.reyes, start, end);
    const legLine = st.lines.find((l) => l.kind === "leg")!;
    expect(legLine.amountCents).toBe(420 * 62);
    expect(legLine.orderNumber).toBe(o.order.orderNumber);
    expect(st.grossCents).toBe(26040);
    expect(st.deductionsCents).toBe(24500);
    expect(st.netCents).toBe(1540);
    st = await B.addSettlementLine(a, st.id, { kind: "accessorial", description: "Border crossing", amountCents: 5000 });
    expect(st.netCents).toBe(6540);
    // the driver sees nothing while it is still open
    expect(await B.driverSettlements(a.tenantId, f.reyes)).toHaveLength(0);
    st = await B.settlementTransition(a, st.id, "reviewed");
    st = await B.settlementTransition(a, st.id, "approved");
    expect((await B.driverSettlements(a.tenantId, f.reyes)).map((x) => x.state)).toEqual(["approved"]);
    // another driver's token never sees it
    await expect(B.disputeSettlementLine(a.tenantId, "someone-else", st.id, legLine.id, "not mine")).rejects.toThrow(/not found/i);
    await expect(B.addSettlementLine(a, st.id, { kind: "adjustment", description: "x", amountCents: 1 })).rejects.toThrow(/reviewed/);
    await B.disputeSettlementLine(a.tenantId, f.reyes, st.id, legLine.id, "miles were 480 not 420");
    st = (await B.listSettlements(a))[0].st;
    expect(st.state).toBe("reviewed");
    expect(st.lines.find((l) => l.id === legLine.id)!.disputed).toContain("480");
    st = await B.settlementTransition(a, st.id, "approved");
    await expect(B.settlementTransition(a, st.id, "paid")).rejects.toBeInstanceOf(ValidationError);
    st = await B.settlementTransition(a, st.id, "paid", { method: "ach", reference: "PAY-1" });
    expect(st.state).toBe("paid");
    await expect(B.buildSettlement(a, f.reyes, start, end)).rejects.toThrow(/is paid/);
    // the advance has 10,000 left
    const { payItems } = await import("@/db/schema");
    const items = await db.select().from(payItems).where(eq(payItems.driverId, f.reyes));
    expect(items.find((i) => i.description === "Fuel advance")!.remainingCents).toBe(10000);

    const pnl = await B.orderPnl(a, o.order.id);
    expect(pnl.revenue).toBe(180000);
    expect(pnl.driverPay).toBe(26040);
    expect(pnl.fuel).toBe(420 * 65);
    expect(pnl.margin).toBe(180000 - 26040 - 27300);
    expect(pnl.marginPct).toBeGreaterThan(60);
  });

  it("percent-of-revenue and team split", async () => {
    await update(a, "driver", f.reyes, { payType: "pct", payRateCents: 2800 }); // 28%
    const co = await create(a, "driver", { name: "Co Driver", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "pct", payRateCents: 2800 });
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], template: "domestic", book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t2104, driverId: f.reyes, coDriverId: co.id });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
    const { start, end } = B.weekOf(new Date());
    const st = await B.buildSettlement(a, f.reyes, start, end);
    expect(st.grossCents).toBe(14000); // 28% of 1000 = 280, halved for the team
    const st2 = await B.buildSettlement(a, co.id, start, end);
    expect(st2.grossCents).toBe(14000);
  });
});

describe("the rate con read against the order", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("with the extractor connected, an uploaded rate con that disagrees with the order raises a yellow flag; one that agrees clears it", async () => {
    const { integrations, flags, documents } = await import("@/db/schema");
    const { eq, and } = await import("drizzle-orm");
    const { newId } = await import("@/lib/ids");
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 280000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    // nothing connected: the upload is plain
    const d0 = await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc.pdf", mimeType: "application/pdf", bytes: pdf });
    expect((await db.select().from(documents).where(eq(documents.id, d0.id)))[0].extractionNote).toBeNull();
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-ant-test" } });
    const answer = (rate: number) => async () => new Response(JSON.stringify({ model: "claude-sonnet-4-5", usage: { input_tokens: 700 }, content: [{ type: "tool_use", name: "record_fields", input: { rate: { value: rate, confidence: 0.9 }, currency: { value: "USD", confidence: 0.9 }, rateConNumber: { value: "RC-778812", confidence: 0.95 }, po: { value: null, confidence: 0 }, pickupDate: { value: null, confidence: 0 }, deliveryDate: { value: null, confidence: 0 } } }] }), { status: 200 });
    vi.stubGlobal("fetch", answer(2850));
    const d1 = await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc2.pdf", mimeType: "application/pdf", bytes: pdf });
    const [read] = await db.select().from(documents).where(eq(documents.id, d1.id));
    expect(read.extractionNote).toMatch(/rate con says 2850.00, order says 2800.00/);
    expect(read.extracted).toMatchObject({ rateConNumber: { value: "RC-778812" } });
    let fl = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "rate_con_differs")));
    expect(fl).toHaveLength(1);
    expect(fl[0].title).toBe("Rate con says $2,850.00; the order says $2,800.00");
    expect(fl[0].level).toBe("yellow");
    expect(fl[0].clearedAt).toBeNull();
    // the corrected paper agrees → cleared
    vi.stubGlobal("fetch", answer(2800));
    await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc3.pdf", mimeType: "application/pdf", bytes: pdf });
    fl = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "rate_con_differs")));
    expect(fl[0].clearedAt).toBeTruthy();
    // a model outage never blocks the upload
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }));
    const d3 = await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc4.pdf", mimeType: "application/pdf", bytes: pdf });
    expect((await db.select().from(documents).where(eq(documents.id, d3.id)))[0].extractionNote).toMatch(/^failed/);
  });
});
