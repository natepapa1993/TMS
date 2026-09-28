// Features: F-21.4
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant, connectEmail } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { orders as ordersT, outbox, invoices, invoiceBatches } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { createOrder } from "./orders";
import * as B from "./billing";
import { resolveDelivery, planBatch, runBatch, deliverInvoice, invoicePacket, sendFactorSchedule, awaitingFactor } from "./invoicing";

let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { entity: string; acme: string; rxo: string; portal: string };
let pdf: Buffer;

afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Batch Carrier");
  await connectEmail(a); // these runs really send: an email provider is connected
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  pdf = Buffer.from(await doc.save());
  const entity = await create(a, "billingEntity", { legalName: "Batch Carrier LLC", country: "US", invoicePrefix: "BC", nextInvoiceNumber: 1, isDefault: true, remitTo: { line1: "1 Main St", city: "Canton", state: "MI" } });
  const acme = await create(a, "customer", { name: "Acme Foods", kind: "customer", billingEmail: "ap@acme.test", invoiceCc: "ops@acme.test, cfo@acme.test", requiredDocs: ["POD"], invoiceMode: "summary" });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", requiredDocs: ["POD"] });
  const portal = await create(a, "customer", { name: "Portal Co", kind: "customer", requiredDocs: [], invoiceDelivery: "portal", portalUrl: "https://portal.test" });
  f = { entity: entity.id, acme: acme.id, rxo: rxo.id, portal: portal.id };
});

async function deliveredLoad(customerId: string, rateCents: number, pod = true, from = "Laredo Yard") {
  const o = await createOrder(a, { customerId, rateCents, refs: { po: `PO-${rateCents}` }, stops: [{ type: "pickup", name: from, country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }], book: true });
  await db.update(ordersT).set({ state: "delivered", deliveredAt: new Date() }).where(eq(ordersT.id, o.order.id));
  if (pod) await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
  return o.order;
}

describe("delivery method", () => {
  it("auto: factor when the entity factors everything, EDI when the partner takes 210s, else email; an explicit choice wins", () => {
    expect(resolveDelivery({ invoiceDelivery: "auto", billingEmail: null }, { factorAll: false, factorEmail: null, factorName: null }, false)).toBe("email");
    expect(resolveDelivery({ invoiceDelivery: "auto", billingEmail: null }, null, true)).toBe("edi");
    expect(resolveDelivery({ invoiceDelivery: "auto", billingEmail: null }, { factorAll: true, factorEmail: "f@x", factorName: "Factor" }, true)).toBe("factor");
    expect(resolveDelivery({ invoiceDelivery: "email", billingEmail: null }, { factorAll: true, factorEmail: "f@x", factorName: "Factor" }, true)).toBe("email");
    expect(resolveDelivery({ invoiceDelivery: "portal", billingEmail: null }, null, false)).toBe("portal");
  });
});

describe("billing runs", () => {
  it("summary customers get one invoice for all their loads, others one per load; loads not ready are left out with the reason", async () => {
    const a1 = await deliveredLoad(f.acme, 100000);
    const a2 = await deliveredLoad(f.acme, 150000, true, "Houston Yard");
    const r1 = await deliveredLoad(f.rxo, 90000);
    const r2 = await deliveredLoad(f.rxo, 80000);
    const bad = await deliveredLoad(f.rxo, 70000, false);
    const plan = await planBatch(a, [a1.id, a2.id, r1.id, r2.id, bad.id]);
    expect(plan.invoices.map((i) => [i.customerName, i.orderIds.length, i.totalCents, i.mode, i.method])).toEqual([
      ["Acme Foods", 2, 250000, "summary", "email"],
      ["RXO", 1, 90000, "per_load", "email"],
      ["RXO", 1, 80000, "per_load", "email"],
    ]);
    expect(plan.skipped).toEqual([{ orderId: bad.id, orderNumber: bad.orderNumber, reason: "missing POD" }]);

    const run = await runBatch(a, [a1.id, a2.id, r1.id, r2.id, bad.id], { issue: true, send: true });
    expect(run.number).toBe(1);
    expect(run.results.map((r) => [r.customerName, r.state, r.ok])).toEqual([
      ["Acme Foods", "sent", true],
      ["RXO", "sent", true],
      ["RXO", "sent", true],
    ]);
    const acmeInv = (await db.select().from(invoices).where(eq(invoices.customerId, f.acme)))[0];
    expect(acmeInv.orderIds.length).toBe(2);
    expect(acmeInv.batchId).toBe(run.batchId);
    expect(acmeInv.snapshot!.loads!.map((l) => [l.orderNumber, l.amountCents, l.from, l.refs])).toEqual([
      [a1.orderNumber, 100000, "Laredo Yard", "PO-100000"],
      [a2.orderNumber, 150000, "Houston Yard", "PO-150000"],
    ]);
    expect(acmeInv.deliveries.map((d) => [d.method, d.to])).toEqual([["email", "ap@acme.test, ops@acme.test, cfo@acme.test"]]);
    // the email carries the packet: the invoice and both PODs
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectId, acmeInv.id));
    expect(mail.to).toBe("ap@acme.test");
    expect(mail.meta?.cc).toEqual(["ops@acme.test", "cfo@acme.test"]);
    expect(mail.body).toContain("covers 2 loads");
    expect(mail.meta?.attachments?.[0].fileName).toBe(`Invoice ${acmeInv.number}.pdf`);
    const packet = await invoicePacket(a, acmeInv.id);
    expect(packet.count).toBe(3);
    const doc = await PDFDocument.load(packet.pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4); // cover + invoice + 2 PODs
    const [batch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, run.batchId));
    expect(batch.invoiceIds.length).toBe(3);
    expect(batch.totalCents).toBe(420000);
  });

  it("drafts only when not issuing; MXN left as a draft without a rate; portal invoices wait to be recorded", async () => {
    const p1 = await deliveredLoad(f.portal, 50000, false);
    const mx = await createOrder(a, { customerId: f.rxo, rateCents: 900000, currency: "MXN", stops: [{ type: "pickup", name: "Monterrey", country: "MX" }, { type: "delivery", name: "Saltillo", country: "MX" }], book: true });
    await db.update(ordersT).set({ state: "delivered", deliveredAt: new Date() }).where(eq(ordersT.id, mx.order.id));
    await B.uploadOrderDocument(a, mx.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    const run = await runBatch(a, [p1.id, mx.order.id], { issue: true, send: true });
    const byCust = Object.fromEntries(run.results.map((r) => [r.customerName, r]));
    expect(byCust["Portal Co"]).toMatchObject({ state: "issued", method: "portal" });
    expect(byCust["Portal Co"].note).toMatch(/portal/);
    expect(byCust.RXO).toMatchObject({ state: "draft" });
    expect(byCust.RXO.note).toMatch(/exchange rate/);
    const recorded = await deliverInvoice(a, byCust["Portal Co"].invoiceId!, { reference: "CONF-889" });
    expect(recorded.state).toBe("sent");
    expect(recorded.deliveries[0]).toMatchObject({ method: "portal", to: "https://portal.test", reference: "CONF-889" });
    await expect(deliverInvoice(a, byCust.RXO.invoiceId!, {})).rejects.toThrow(/issue the invoice first/);
    await expect(deliverInvoice(a, byCust["Portal Co"].invoiceId!, { method: "edi" })).rejects.toThrow(/no EDI partner/);
  });
});

describe("factoring", () => {
  it("factored invoices carry the factor's remit-to and notice; they go on one schedule of accounts to the factor", async () => {
    await update(a, "billingEntity", f.entity, { factorName: "Prime Factoring", factorEmail: "schedules@prime.test", factorRemitTo: { line1: "PO Box 9", city: "Dallas", state: "TX" }, factorAll: true });
    await update(a, "customer", f.rxo, { invoiceDelivery: "email" }); // opted out: billed direct
    const a1 = await deliveredLoad(f.acme, 100000);
    const r1 = await deliveredLoad(f.rxo, 90000);
    const run = await runBatch(a, [a1.id, r1.id], { issue: true, send: false });
    const [acmeInv] = await db.select().from(invoices).where(eq(invoices.customerId, f.acme));
    const [rxoInv] = await db.select().from(invoices).where(eq(invoices.customerId, f.rxo));
    expect(acmeInv.factored).toBe(true);
    expect(acmeInv.snapshot!.entity.remitTo).toMatchObject({ line1: "1 Main St" }); // our own address stays in the header
    expect(acmeInv.snapshot!.factor!.remitTo).toMatchObject({ line1: "PO Box 9", city: "Dallas" });
    expect(acmeInv.snapshot!.factor!.notice).toContain("Prime Factoring");
    expect(rxoInv.factored).toBe(false);
    expect(rxoInv.snapshot!.entity.remitTo).toMatchObject({ line1: "1 Main St" });
    expect(run.results.every((r) => r.state === "issued")).toBe(true);
    expect((await awaitingFactor(a)).map((i) => i.id)).toEqual([acmeInv.id]);

    await expect(sendFactorSchedule(a, [acmeInv.id, rxoInv.id])).resolves.toBeTruthy(); // any issued invoice can be assigned
    const [after] = await db.select().from(invoices).where(inArray(invoices.id, [rxoInv.id]));
    expect(after.factored).toBe(true);
    expect(after.state).toBe("sent");
    const [sch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.kind, "factor_schedule"));
    expect(sch).toMatchObject({ number: 1, totalCents: 190000, sentTo: "schedules@prime.test" });
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectId, sch.id));
    expect(mail.to).toBe("schedules@prime.test");
    expect(mail.body).toContain(acmeInv.number!);
    expect((await awaitingFactor(a)).length).toBe(0);
  });

  it("a billing run sends factored invoices together on one schedule; no factor email → a clear error, other invoices still go", async () => {
    await update(a, "billingEntity", f.entity, { factorName: "Prime Factoring", factorRemitTo: { line1: "PO Box 9", city: "Dallas", state: "TX" }, factorAll: true });
    const a1 = await deliveredLoad(f.acme, 100000);
    await update(a, "customer", f.rxo, { invoiceDelivery: "email" });
    const r1 = await deliveredLoad(f.rxo, 90000);
    let run = await runBatch(a, [a1.id, r1.id], { issue: true, send: true });
    const acme = run.results.find((r) => r.customerName === "Acme Foods")!;
    expect(acme.ok).toBe(false);
    expect(acme.note).toMatch(/add the email Prime Factoring takes invoices at/);
    expect(run.results.find((r) => r.customerName === "RXO")!.state).toBe("sent");

    await update(a, "billingEntity", f.entity, { factorEmail: "schedules@prime.test" });
    const a2 = await deliveredLoad(f.acme, 50000);
    const a3 = await deliveredLoad(f.acme, 60000);
    await update(a, "customer", f.acme, { invoiceMode: "per_load" });
    run = await runBatch(a, [a2.id, a3.id], { issue: true, send: true });
    expect(run.schedule).toMatchObject({ count: 2 });
    expect(run.results.map((r) => r.state)).toEqual(["sent", "sent"]);
  });
});
