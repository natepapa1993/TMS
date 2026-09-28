// Features: F-26.1 F-26.2 F-26.3
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder } from "./orders";
import * as B from "./billing";
import * as C from "./cash";
import { suggest } from "./cash-rules";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; t1: string; d1: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Cash Carrier");
  await create(a, "billingEntity", { legalName: "Cash Carrier LLC", country: "US", invoicePrefix: "CC", nextInvoiceNumber: 100, isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, billingEmail: "ap@rxo.test", requiredDocs: [], billingAddress: { line1: "11215 N Community House Rd", city: "Charlotte", state: "NC", postalCode: "28277", country: "US" } });
  const t1 = await create(a, "truck", { unitNumber: "101", usPlate: "TX101", usPlateExpires: future });
  const d1 = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
  f = { rxo: rxo.id, t1: t1.id, d1: d1.id };
});

async function delivered(rate = 100000, refs: Record<string, string> = {}) {
  const o = await createOrder(a, { customerId: f.rxo, rateCents: rate, refs, stops: [{ type: "pickup", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas", country: "US" }], book: true });
  await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d1 });
  await dispatchLeg(a, o.legs[0].id);
  await acceptLeg(a, o.legs[0].id);
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st);
  return o;
}
async function issued(rate = 100000, refs: Record<string, string> = {}) {
  const o = await delivered(rate, refs);
  const inv = await B.issueInvoice(a, (await B.createInvoice(a, [o.order.id])).id);
  return { o, inv };
}

describe("extras the customer approves", () => {
  it("an extra waits for approval; bill without it; approved later it goes on a supplemental invoice; rejected never bills", async () => {
    const o = await delivered();
    const lumper = await B.addCharge(a, o.order.id, { kind: "lumper", rateCents: 15000 });
    const det = await B.addCharge(a, o.order.id, { kind: "detention", rateCents: 7500, qty: 200, unit: "h" });
    let q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q).toMatchObject({ chargesCents: 100000, mismatch: false, pending: { count: 2, cents: 30000 } });
    await expect(B.createInvoice(a, [o.order.id])).rejects.toThrow(/2 extra charges waiting/);
    await expect(B.approveCharge(a, lumper.id, { by: " " })).rejects.toThrow(/who approved/);
    const inv = await B.createInvoice(a, [o.order.id], { withoutPending: true });
    expect(inv.totalCents).toBe(100000);
    // approved while the draft is open: it joins the draft
    await B.approveCharge(a, lumper.id, { by: "Maria at RXO", ref: "email 9/26" });
    expect((await B.invoiceById(a, inv.id)).invoice.totalCents).toBe(115000);
    const issuedInv = await B.issueInvoice(a, inv.id);
    expect(issuedInv.snapshot!.billTo.address?.city).toBe("Charlotte");
    expect(issuedInv.snapshot!.loadNumbers).toEqual([o.order.orderNumber]);
    // approved after the invoice went out: a supplemental invoice for it alone; the load stays invoiced
    await B.approveCharge(a, det.id, { by: "Maria at RXO" });
    q = (await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!;
    expect(q).toMatchObject({ supplemental: true, chargesCents: 15000, pending: { count: 0 } });
    const sup = await B.createInvoice(a, [o.order.id]);
    expect(sup.kind).toBe("supplemental");
    const supIssued = await B.issueInvoice(a, sup.id);
    expect(supIssued.totalCents).toBe(15000);
    expect(supIssued.number).not.toBe(issuedInv.number);
    expect((await getOrder(a, o.order.id)).order.state).toBe("invoiced");
    // rejected: on the load for the record, never billed
    const extra = await B.addCharge(a, o.order.id, { kind: "storage", rateCents: 5000 });
    await B.rejectCharge(a, extra.id, "no storage agreed");
    expect((await B.billingQueue(a)).find((x) => x.order.id === o.order.id)).toBeUndefined();
  });
  it("a customer that doesn't ask for approvals bills extras straight away; accepting with a note approves what's waiting", async () => {
    await update(a, "customer", f.rxo, { accessorialApproval: false });
    const o = await delivered();
    const c = await B.addCharge(a, o.order.id, { kind: "lumper", rateCents: 15000 });
    expect(c.approvalState).toBe("none");
    await update(a, "customer", f.rxo, { accessorialApproval: true });
    const o2 = await delivered();
    await B.addCharge(a, o2.order.id, { kind: "detention", rateCents: 7500 });
    await B.acceptRateConMismatch(a, o2.order.id, "detention OK'd by RXO on the phone");
    expect((await B.billingQueue(a)).find((x) => x.order.id === o2.order.id)!.pending.count).toBe(0);
    // a typed line haul is a rate-con difference, not an approval
    await B.addCharge(a, o.order.id, { kind: "fuel", rateCents: 9000 });
    expect((await B.billingQueue(a)).find((x) => x.order.id === o.order.id)!.mismatch).toBe(true);
  });
});

describe("rebill", () => {
  it("voids with the reason and opens a linked draft for the same loads; not once money is on it", async () => {
    const { o, inv } = await issued();
    await expect(B.rebillInvoice(a, inv.id, "")).rejects.toThrow(/why/);
    const draft = await B.rebillInvoice(a, inv.id, "RXO wants their PO 88123 on it");
    expect(draft).toMatchObject({ state: "draft", kind: "rebill", rebillOf: inv.id, totalCents: 100000 });
    const [old] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(old.state).toBe("void");
    expect(old.voidReason).toBe("Rebilled: RXO wants their PO 88123 on it");
    expect((await getOrder(a, o.order.id)).order.state).toBe("ready_to_bill");
    const again = await B.issueInvoice(a, draft.id);
    await B.recordReceipt(a, again.id, { amountCents: 1000 });
    await expect(B.rebillInvoice(a, again.id, "again")).rejects.toThrow(/payments on it/);
  });
});

describe("cash application", () => {
  it("matches the remittance first, else oldest due first; what doesn't fit stays on account", () => {
    const invs = [
      { id: "a", number: "CC-000100", openCents: 50000, loads: [{ orderNumber: "26-00001", refs: ["PO-7788"] }] },
      { id: "b", number: "CC-000101", openCents: 30000, loads: [{ orderNumber: "26-00002", refs: [] }] },
      { id: "c", number: "CC-000102", openCents: 20000, loads: [{ orderNumber: "26-00003", refs: [] }] },
    ];
    expect(suggest(invs, 60000).map((x) => x.applyCents)).toEqual([50000, 10000, 0]);
    const named = suggest(invs, 60000, "Paying CC-000102 and PO-7788");
    expect(named.map((x) => [x.invoiceId, x.applyCents])).toEqual([["a", 50000], ["c", 10000], ["b", 0]]);
  });
  it("one check over three invoices: one short pay left open, one disputed; the overage on account and used on the next invoice", async () => {
    const i1 = (await issued(100000)).inv;
    const i2 = (await issued(80000)).inv;
    const i3 = (await issued(50000)).inv;
    const r = await C.applyPayment(a, {
      customerId: f.rxo,
      amountCents: 220000,
      method: "check",
      reference: "CHK 5521",
      applications: [
        { invoiceId: i1.id, amountCents: 100000 },
        { invoiceId: i2.id, amountCents: 70000 },
        { invoiceId: i3.id, amountCents: 40000, shortPay: "dispute", reason: "lumper not approved" },
      ],
    });
    expect(r.onAccountCents).toBe(10000);
    expect(r.applied.map((x) => x.after)).toEqual(["paid", "$100.00 still open", "short pay $100.00 disputed"]);
    const after = await C.openItems(a, f.rxo);
    expect(after.invoices.map((i) => [i.number, i.openCents, i.state])).toEqual([
      [i2.number, 10000, "partially_paid"],
      [i3.number, 10000, "disputed"],
    ]);
    expect(after.onAccount).toHaveLength(1);
    await C.applyOnAccount(a, r.paymentId, i2.id, 10000);
    expect((await B.invoiceById(a, i2.id)).invoice.state).toBe("paid");
    const list = await C.listPayments(a);
    expect(list[0]).toMatchObject({ reference: "CHK 5521", unappliedCents: 0 });
    expect(list[0].applications).toHaveLength(4); // three at the time, one later from on account
    expect((await C.onAccountByCustomer(a)).get(f.rxo)).toBeUndefined();
  });
  it("refuses over-application, a write-off without the owner, and mixed currencies", async () => {
    const i1 = (await issued(100000)).inv;
    await expect(C.applyPayment(a, { customerId: f.rxo, amountCents: 50000, applications: [{ invoiceId: i1.id, amountCents: 60000 }] })).rejects.toThrow(/more than the \$500.00 received/);
    await expect(C.applyPayment(a, { customerId: f.rxo, amountCents: 200000, applications: [{ invoiceId: i1.id, amountCents: 150000 }] })).rejects.toThrow(/more than the \$1,000.00 open/);
    await expect(C.applyPayment({ ...a, role: "billing" }, { customerId: f.rxo, amountCents: 90000, applications: [{ invoiceId: i1.id, amountCents: 90000, shortPay: "write_off", reason: "fuel short" }] })).rejects.toThrow(/owner/);
    // the owner writes the short pay off with a credit memo: paid in full
    const r = await C.applyPayment(a, { customerId: f.rxo, amountCents: 90000, applications: [{ invoiceId: i1.id, amountCents: 90000, shortPay: "write_off", reason: "fuel surcharge short" }] });
    expect(r.applied[0].after).toBe("short pay $100.00 written off");
    const d = await B.invoiceById(a, i1.id);
    expect(d.invoice.state).toBe("paid");
    expect(d.creditMemos[0].reason).toBe("Short pay: fuel surcharge short");
  });
});

describe("invoice list filters", () => {
  it("finds invoices by load reference, overdue, not sent; the CSV has the open amount", async () => {
    const { inv } = await issued(100000, { po: "PO-445566" });
    await issued(50000);
    expect((await B.listInvoices(a, { q: "445566" })).map((i) => i.id)).toEqual([inv.id]);
    expect((await B.listInvoices(a, { q: "rxo" })).length).toBe(2);
    expect((await B.listInvoices(a, { view: "unsent" })).length).toBe(2);
    await db.update(invoices).set({ dueAt: new Date(Date.now() - 86400_000) }).where(eq(invoices.id, inv.id));
    expect((await B.listInvoices(a, { view: "overdue" })).map((i) => i.id)).toEqual([inv.id]);
    const csv = B.invoicesCsv(await B.listInvoices(a, {}), () => "RXO");
    expect(csv.split("\n")[0]).toBe("Number,Kind,Customer,State,Issued,Due,Currency,Total,Paid,Credited,Open,Factored,Loads");
    expect(csv).toContain(",1000.00,0.00,0.00,1000.00,");
  });
});

