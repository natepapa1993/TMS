// Features: F-30.6 F-30.5
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant, connectEmail } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { orders as ordersT, invoices, outbox } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, waivePod } from "./orders";
import * as B from "./billing";
import { runBatch } from "./invoicing";

let a: Awaited<ReturnType<typeof makeTenant>>;
let rxo: string;
let pdf: Buffer;

afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("One Click Carrier");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  pdf = Buffer.from(await doc.save());
  await create(a, "billingEntity", { legalName: "One Click LLC", country: "US", invoicePrefix: "OC", nextInvoiceNumber: 1, isDefault: true, remitTo: { line1: "1 Main St", city: "Canton", state: "MI" } });
  rxo = (await create(a, "customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", requiredDocs: ["POD"] })).id;
});

async function delivered(pod: boolean) {
  const o = await createOrder(a, { customerId: rxo, rateCents: 185000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Dallas DC", country: "US" }], book: true });
  await db.update(ordersT).set({ state: "delivered", deliveredAt: new Date() }).where(eq(ordersT.id, o.order.id));
  if (pod) await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
  return o.order;
}

describe("one click from the billing queue: create, issue and send one load (billing #12)", () => {
  it("makes the invoice, numbers it and emails it in one call", async () => {
    await connectEmail(a);
    const o = await delivered(true);
    const r = await runBatch(a, [o.id], { issue: true, send: true });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ ok: true, state: "sent", number: "OC-000001", method: "email" });
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, r.results[0].invoiceId!));
    expect(inv.state).toBe("sent");
    const mail = await db.select().from(outbox).where(eq(outbox.tenantId, a.tenantId));
    expect(mail.some((m) => m.to === "ap@rxo.test")).toBe(true);
  });

  it("a load without its POD can't go in one click — until dispatch says to bill it without one", async () => {
    const o = await delivered(false);
    await expect(runBatch(a, [o.id], { issue: true, send: true })).rejects.toThrow(/missing POD/);
    await waivePod(a, o.id, "receiver signs electronically; POD by email later");
    const r = await runBatch(a, [o.id], { issue: true, send: true });
    expect(r.results[0].ok).toBe(true);
  });
});
