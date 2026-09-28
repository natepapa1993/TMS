// Features: F-7.30 F-7.31 F-7.32 F-7.33 F-7.34 F-7.36 QuickBooks export completeness; month-end close guardrails; honest "Sent"; customer portal money per currency and in Spanish; payment auto-match; FX at receipt
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { truncateAll, makeTenant, connectEmail } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { payItems, invoices as invoicesT, payments as paymentsT } from "@/db/schema";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg } from "./orders";
import { updateCompany, getCompany } from "./company";
import * as B from "./billing";
import * as C from "./cash";
import * as A from "./accounting";
import * as R from "./reports";
import * as P from "./customer-portal";
import * as Run from "./settlement-run";
import { PDFDocument } from "pdf-lib";
import { runBatch } from "./invoicing";
import { ownerToday } from "./today";
import { notEmailed, sendOutcome, NOT_EMAILED } from "./delivery-rules";
import { toHome } from "./fx-rules";
import { zonedDate } from "@/lib/time";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { entity: string; usCust: string; mxCust: string; t1: string; hector: string };

afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  const entity = await create(a, "billingEntity", { legalName: "Frontera Freight LLC", country: "US", invoicePrefix: "FF", nextInvoiceNumber: 2401, isDefault: true, remitTo: { line1: "4100 Mines Rd", city: "Laredo", state: "TX", postalCode: "78045", country: "US" } });
  const usCust = await create(a, "customer", { name: "Summit Logistics", kind: "broker", termsDays: 30, billingEmail: "ap@summit.test", requiredDocs: [], accessorialApproval: false });
  const mxCust = await create(a, "customer", { name: "Sierra Madre Cantú", country: "MX", termsDays: 30, billingEmail: "cxp@sierra.test", requiredDocs: [] });
  const t1 = await create(a, "truck", { unitNumber: "204", usPlate: "TX204", usPlateExpires: future });
  const hector = await create(a, "driver", { name: "Héctor Salazar", driverType: "CDL", licenseExpires: future, medicalExpires: future, payType: "per_mile", payRateCents: 62, currentTruckId: t1.id });
  f = { entity: entity.id, usCust: usCust.id, mxCust: mxCust.id, t1: t1.id, hector: hector.id };
});

async function delivered(o: { customerId: string; rateCents: number; currency?: string; miles?: number; at?: Date }) {
  const ord = await createOrder(a, { customerId: o.customerId, rateCents: o.rateCents, currency: o.currency ?? "USD", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }], template: "domestic", book: true });
  const leg = ord.legs[0].id;
  await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.hector }, { plannedMiles: o.miles ?? 400 });
  await dispatchLeg(a, leg);
  await acceptLeg(a, leg, "driver_app");
  for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st, o.at ? { at: o.at } : {});
  return ord;
}
const invoice = async (orderId: string, rate?: string, issuedAt?: Date) => B.issueInvoice(a, (await B.createInvoice(a, [orderId])).id, { ...(rate ? { exchangeRate: rate } : {}), ...(issuedAt ? { issuedAt } : {}) });
const today = () => zonedDate(new Date(), "America/Detroit"); // the test company's zone
const daysAgo = (n: number) => zonedDate(new Date(Date.now() - n * 86400_000), "America/Detroit");
/** every IIF transaction nets to zero */
function balanced(iif: string) {
  let bal = 0;
  for (const l of iif.split("\r\n")) {
    const c = l.split("\t");
    if (c[0] === "TRNS" || c[0] === "SPL") bal += Math.round(Number(c[7]) * 100);
    if (c[0] === "ENDTRNS") {
      if (bal !== 0) return false;
      bal = 0;
    }
  }
  return true;
}

describe("QuickBooks export: nothing silently left out", () => {
  it("an advance goes out when it is paid (Driver Advances from the bank) and the statements that recover it bring the asset back to zero", async () => {
    const lastWeek = B.weekOf(new Date(Date.now() - 7 * 86400_000));
    await delivered({ customerId: f.usCust, rateCents: 100000, miles: 500, at: new Date(lastWeek.start.getTime() + 86400_000) }); // $310
    await B.addPayItem(a, f.hector, { kind: "advance", description: "Cash advance Nuevo Laredo", amountCents: 10000, remainingCents: 30000 }); // $300, $100 a week
    let st = await B.buildSettlement(a, f.hector, lastWeek.start, lastWeek.end);
    for (const to of ["reviewed", "approved"] as const) st = await B.settlementTransition(a, st.id, to);
    await B.settlementTransition(a, st.id, "paid", { method: "ach" });
    // the statement PDF: a name that says whose and which week, and the advance still owed
    const pdf = await Run.settlementPdf(a, st.id);
    expect(pdf.fileName).toBe(`Pay statement - Hector Salazar - week of ${zonedDate(lastWeek.start, "America/Detroit")}.pdf`);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const run = await A.createExport(a, { format: "iif", from: today(), to: today(), onlyNew: true });
    const iif = (await A.exportFiles(a, run.id)).files[0].body;
    const lines = iif.split("\r\n");
    // paid out: +300 to Driver Advances (named for the driver), -300 from Checking
    expect(lines.some((l) => l.startsWith("TRNS\t\tGENERAL JOURNAL") && l.includes("\tDriver Advances\tHéctor Salazar\t\t300.00\t"))).toBe(true);
    expect(lines.some((l) => l.startsWith("SPL\t\tGENERAL JOURNAL") && l.includes("\tChecking\t\t\t-300.00\t"))).toBe(true);
    // recovered: -100 on the statement bill
    expect(lines.some((l) => l.startsWith("SPL\t\tBILL") && l.includes("\tDriver Advances\t") && l.includes("\t-100.00\t"))).toBe(true);
    expect(balanced(iif)).toBe(true);
    const [adv] = await db.select().from(payItems).where(eq(payItems.kind, "advance"));
    expect(adv.exportedAt).not.toBeNull();
    // the next "only new" run doesn't send the advance again
    expect((await A.previewExport(a, { from: today(), to: today(), onlyNew: true })).advances).toBe(0);
  });

  it("\"only new\" catches never-exported records dated before the From date, and says how many", async () => {
    const old = await invoice((await delivered({ customerId: f.usCust, rateCents: 525000 })).order.id, undefined, new Date(Date.now() - 40 * 86400_000));
    const p = await A.previewExport(a, { from: daysAgo(5), to: today(), onlyNew: true });
    expect(p).toMatchObject({ invoices: 1, older: 1 });
    // without "only new", the window is the window
    expect((await A.previewExport(a, { from: daysAgo(5), to: today(), onlyNew: false })).invoices).toBe(0);
    const run = await A.createExport(a, { format: "qbo", from: daysAgo(5), to: today(), onlyNew: true });
    expect(run.counts.invoices).toBe(1);
    expect((await db.select().from(invoicesT).where(eq(invoicesT.id, old.id)))[0].exportedAt).not.toBeNull();
    expect((await A.previewExport(a, { from: daysAgo(5), to: today(), onlyNew: true })).invoices).toBe(0);
  });

  it("a credit memo is applied to its invoice, money on account used later goes out as an application, and every transaction balances", async () => {
    const i1 = await invoice((await delivered({ customerId: f.usCust, rateCents: 240000 })).order.id);
    await B.creditMemo(a, i1.id, { amountCents: 40000, reason: "lumper not approved" });
    // an overpayment: $1,000 on account, exported
    const i2 = await invoice((await delivered({ customerId: f.usCust, rateCents: 100000 })).order.id);
    await C.applyPayment(a, { customerId: f.usCust, amountCents: 200000, currency: "USD", method: "ach", reference: "ACH-77", applications: [{ invoiceId: i2.id, amountCents: 100000 }] });
    const r1 = await A.createExport(a, { format: "iif", from: today(), to: today(), onlyNew: true });
    const iif1 = (await A.exportFiles(a, r1.id)).files[0].body.split("\r\n");
    // the credit memo is applied: a $0 payment taking the invoice down and the credit off
    const cmApp = iif1.findIndex((l) => l.startsWith("TRNS\t\tPAYMENT") && l.includes("\t0.00\tFF-CM-000001\t"));
    expect(cmApp).toBeGreaterThan(-1);
    expect(iif1[cmApp + 1]).toContain(`\t-400.00\t${i1.number}\t`);
    expect(iif1[cmApp + 2]).toContain("\t400.00\tFF-CM-000001\t");
    expect(balanced(iif1.join("\r\n"))).toBe(true);
    // later: the $1,000 on account pays the next invoice
    const i3 = await invoice((await delivered({ customerId: f.usCust, rateCents: 67000 })).order.id);
    const [pay] = await db.select().from(paymentsT);
    await C.applyOnAccount(a, pay.id, i3.id, 67000);
    const p2 = await A.previewExport(a, { from: today(), to: today(), onlyNew: true });
    expect(p2).toMatchObject({ invoices: 1, receipts: 0, applications: 1 });
    const r2 = await A.createExport(a, { format: "qbo", from: today(), to: today(), onlyNew: true });
    const files = (await A.exportFiles(a, r2.id)).files;
    const apps = files.find((x) => x.name.endsWith("applications.csv"))!.body.split("\r\n");
    expect(apps[0]).toBe("Date,Customer,InvoiceNo,Amount,From,FromRef,Memo,Currency");
    expect(apps[1]).toContain(`,Summit Logistics,${i3.number},670.00,Money on account,ACH-77,`);
    // and only once
    expect((await A.previewExport(a, { from: today(), to: today(), onlyNew: true })).applications).toBe(0);
    // reopening the run puts it back
    await A.reopenExport(a, r2.id);
    expect((await A.previewExport(a, { from: today(), to: today(), onlyNew: true })).applications).toBe(1);
  });

  it("the IIF is Windows-1252: accented names are one byte each, dashes too", async () => {
    expect([...A.toWindows1252("Héctor Cantú — año €5 “ok”")]).toEqual([0x48, 0xe9, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x43, 0x61, 0x6e, 0x74, 0xfa, 0x20, 0x97, 0x20, 0x61, 0xf1, 0x6f, 0x20, 0x80, 0x35, 0x20, 0x93, 0x6f, 0x6b, 0x94]);
    expect(Buffer.from(A.toWindows1252("Łódź ✓")).toString("latin1")).toBe("Lódz ?");
    await invoice((await delivered({ customerId: f.mxCust, rateCents: 100000 })).order.id);
    const run = await A.createExport(a, { format: "iif", from: today(), to: today(), onlyNew: true });
    const file = (await A.exportFiles(a, run.id)).files[0];
    expect(file.charset).toBe("windows-1252");
    const bytes = Buffer.from(file.bytes!);
    expect(bytes.includes(Buffer.from("Sierra Madre Cantú", "latin1"))).toBe(true);
    expect(bytes.includes(Buffer.from("Cantú", "utf8"))).toBe(false); // no UTF-8 sequences
  });

  it("escrow paid back to a driver comes out of Driver Escrow, not an expense", () => {
    const qb = { reimbursementAccount: "Driver Reimbursements", escrowAccount: "Driver Escrow", driverPayAccount: "Driver Pay", advanceAccount: "Driver Advances", deductionAccount: "Driver Deductions" } as never;
    expect(A.settlementAccount(qb, { kind: "reimbursement", amountCents: 5000, source: "escrow release" })).toBe("Driver Escrow");
    expect(A.settlementAccount(qb, { kind: "reimbursement", amountCents: 5000, source: "one-off" })).toBe("Driver Reimbursements");
  });
});

describe("FX at receipt", () => {
  it("a peso payment keeps the day's rate; the bank gets dollars at it; the difference from the invoice's rate is the realized gain or loss, in reports and the export", async () => {
    const inv = await invoice((await delivered({ customerId: f.mxCust, rateCents: 5310000, currency: "MXN" })).order.id, "18.45");
    await expect(C.applyPayment(a, { customerId: f.mxCust, amountCents: 5310000, currency: "MXN", exchangeRate: "0.054", applications: [{ invoiceId: inv.id, amountCents: 5310000 }] })).rejects.toThrow(/doesn't look right/);
    await C.applyPayment(a, { customerId: f.mxCust, amountCents: 5310000, currency: "MXN", exchangeRate: "18.00", method: "wire", reference: "SPEI 7731", applications: [{ invoiceId: inv.id, amountCents: 5310000 }] });
    const [pay] = await db.select().from(paymentsT);
    expect(pay.exchangeRate).toBe(180000);
    const bank = toHome(5310000, "MXN", 180000); // $2,950.00
    const ar = toHome(5310000, "MXN", 184500); // $2,878.05
    const dash = await R.dashboard(a, R.defaultPeriod(new Date(), "America/Detroit"));
    expect(dash.fxRealizedCents).toBe(bank - ar); // a gain: the peso got stronger
    const run = await A.createExport(a, { format: "iif", from: today(), to: today(), onlyNew: true });
    const iif = (await A.exportFiles(a, run.id)).files[0].body;
    const lines = iif.split("\r\n");
    expect(lines.find((l) => l.startsWith("TRNS\t\tPAYMENT"))!.split("\t")[7]).toBe((bank / 100).toFixed(2));
    expect(lines.some((l) => l.startsWith("SPL\t\tPAYMENT") && l.includes(`\t-${(ar / 100).toFixed(2)}\t${inv.number}\t`))).toBe(true);
    expect(lines.some((l) => l.includes("\tExchange Gain or Loss\t") && l.includes(`\t-${((bank - ar) / 100).toFixed(2)}\t`))).toBe(true);
    expect(lines).toContain("ACCNT\tExchange Gain or Loss\tEXEXP");
    expect(balanced(iif)).toBe(true);
    // without a rate typed, the company's is used
    const inv2 = await invoice((await delivered({ customerId: f.mxCust, rateCents: 1000000, currency: "MXN" })).order.id, "18.45");
    await B.recordReceipt(a, inv2.id, { amountCents: 1000000, method: "wire" });
    const { receipts } = await import("@/db/schema");
    const rc = (await db.select().from(receipts).where(eq(receipts.invoiceId, inv2.id)))[0];
    expect(rc.exchangeRate).toBe((await getCompany(a)).settings.fx.MXN!.rateE4);
  });

  it("money can't be received tomorrow; the dialog's day is the company's", async () => {
    const inv = await invoice((await delivered({ customerId: f.usCust, rateCents: 100000 })).order.id);
    const tomorrow = new Date(Date.now() + 36 * 3600_000);
    await expect(C.applyPayment(a, { customerId: f.usCust, amountCents: 1000, receivedAt: tomorrow, applications: [{ invoiceId: inv.id, amountCents: 1000 }] })).rejects.toThrow(/in the future/);
    await expect(B.recordReceipt(a, inv.id, { amountCents: 1000, receivedAt: tomorrow })).rejects.toThrow(/in the future/);
    const items = await C.openItems(a, f.usCust);
    expect(items.today).toBe(today());
    expect(items.latestCurrency).toBe("USD");
  });
});

describe("payment matching", () => {
  it("\"Apply payment\" with nothing split by hand pays the one open invoice the remittance names, in the payment's currency; an unclear remittance stays on account", async () => {
    const i1 = await invoice((await delivered({ customerId: f.usCust, rateCents: 480000 })).order.id);
    const i2 = await invoice((await delivered({ customerId: f.usCust, rateCents: 120000 })).order.id);
    const r = await C.applyPayment(a, { customerId: f.usCust, amountCents: 480000, currency: "USD", method: "check", reference: "10442", remittance: `Pay ${i1.number} 4,800.00`, applications: [] });
    expect(r).toMatchObject({ autoMatched: true, onAccountCents: 0 });
    expect(r.applied.map((x) => [x.number, x.appliedCents])).toEqual([[i1.number, 480000]]);
    expect((await B.invoiceById(a, i1.id)).invoice.state).toBe("paid");
    // names two, amount isn't what they have open: nothing guessed
    const i3 = await invoice((await delivered({ customerId: f.usCust, rateCents: 50000 })).order.id);
    const r2 = await C.applyPayment(a, { customerId: f.usCust, amountCents: 100000, currency: "USD", remittance: `${i2.number} ${i3.number}`, applications: [] });
    expect(r2).toMatchObject({ autoMatched: false, onAccountCents: 100000 });
    // names two and pays exactly both
    const r3 = await C.applyPayment(a, { customerId: f.usCust, amountCents: 170000, currency: "USD", remittance: `${i2.number}, ${i3.number}`, applications: [] });
    expect(r3).toMatchObject({ autoMatched: true, onAccountCents: 0 });
    // a peso payment never auto-pays a dollar invoice it names
    const i4 = await invoice((await delivered({ customerId: f.mxCust, rateCents: 90000 })).order.id);
    const r4 = await C.applyPayment(a, { customerId: f.mxCust, amountCents: 90000, currency: "MXN", remittance: `${i4.number}`, applications: [] });
    expect(r4).toMatchObject({ autoMatched: false, onAccountCents: 90000 });
    expect(C.autoMatch([{ id: "x", number: "FF-1", openCents: 100, currency: "USD", loads: [] }], 100, "", "USD")).toEqual([]);
  });
});

describe("honest Sent", () => {
  it("with no email provider an invoice 'sent' is logged, stays issued, is listed and counted as not emailed; the billing run says so", async () => {
    const o = await delivered({ customerId: f.usCust, rateCents: 185000 });
    const run = await runBatch(a, [o.order.id], { issue: true, send: true });
    expect(run.results[0]).toMatchObject({ ok: true, state: "issued", note: NOT_EMAILED });
    const [inv] = await db.select().from(invoicesT).where(eq(invoicesT.id, run.results[0].invoiceId!));
    expect(notEmailed(inv)).toBe(true);
    expect(sendOutcome(inv)).toBe(NOT_EMAILED);
    expect((await ownerToday(a)).billing!.notEmailed).toBe(1);
    // connected: it really goes, and stops counting
    await connectEmail(a);
    const sent = await B.sendInvoice(a, inv.id);
    expect(sent.state).toBe("sent");
    expect(notEmailed(sent)).toBe(false);
    expect(sendOutcome(sent)).toBe("Sent");
    expect((await ownerToday(a)).billing!.notEmailed).toBe(0);
  });
});

describe("month-end close guardrails", () => {
  it("refuses today and later days, in the company zone; the close is the end of that day there", async () => {
    await updateCompany(a, { timeZone: "America/Chicago" });
    const now = new Date("2026-09-01T03:30:00Z"); // Aug 31, 10:30 PM in Laredo
    await expect(B.closePeriod(a, "2026-08-31", now)).rejects.toThrow(/today \(2026-08-31\) hasn't ended/);
    await expect(B.closePeriod(a, "2026-12-31", now)).rejects.toThrow(/in the future.*2026-08-30/);
    expect(await B.closePeriod(a, "2026-08-30", now)).toEqual({ through: "2026-08-30" });
    const c = await getCompany(a);
    expect(zonedDate(new Date(c.settings.closedThrough!), "America/Chicago")).toBe("2026-08-30");
    expect(new Date(c.settings.closedThrough!).toISOString()).toBe("2026-08-31T04:59:59.999Z");
    // 11 PM in Laredo on the 30th is closed; 1 AM on the 31st is open
    await expect(B.assertOpenPeriod(a, new Date("2026-08-31T04:00:00Z"))).rejects.toThrow(/closed through 2026-08-30/);
    await B.assertOpenPeriod(a, new Date("2026-08-31T06:00:00Z"));
  });
});

describe("customer portal money", () => {
  it("balances per currency (never pesos plus dollars), status labels in Spanish", async () => {
    const mx = await invoice((await delivered({ customerId: f.mxCust, rateCents: 5300000, currency: "MXN" })).order.id, "18.52");
    await invoice((await delivered({ customerId: f.mxCust, rateCents: 245000 })).order.id, undefined, new Date(Date.now() - 45 * 86400_000));
    const v = await P.customerPortalView(a.tenantId, f.mxCust);
    expect(v.balances).toEqual([
      { currency: "USD", openCents: 245000, pastDueCents: 245000 },
      { currency: "MXN", openCents: 5300000, pastDueCents: 0 },
    ]);
    expect(v.balance).toMatchObject({ currency: "USD", openCents: 245000 });
    expect(v.delivered[0]).toMatchObject({ stateLabel: "Delivered", stateLabelEs: "Entregado" });
    expect(P.CUSTOMER_STATE.dispatched).toBe("Assigned");
    expect(P.CUSTOMER_STATE_ES.in_transit).toBe("En tránsito");
    expect(v.invoices.find((i) => i.id === mx.id)!.currency).toBe("MXN");
  });
});
