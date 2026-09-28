// Features: F-32.21 F-3 F-8.2 F-30.1 one document counted everywhere (owner #8): load, leg, crossing, driver app, carrier portal
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { crossings, documents, orders, carrierBills } from "@/db/schema";
import { newId } from "@/lib/ids";
import { createOrder } from "./orders";
import * as X from "./crossing";
import * as B from "./billing";
import { loadDocuments } from "./load-docs";
import { docKey, whereItCounts, supersedeScope, latestOf, docLabel } from "./load-docs-rules";
import { customerPortalView, portalDocument } from "./customer-portal";

let a: Awaited<ReturnType<typeof makeTenant>>;
let rxo: string;
let garza: string;

async function pdf(text: string) {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 14 });
  return Buffer.from(await d.save());
}

const stops = [
  { type: "pickup" as const, name: "Planta Monterrey", country: "MX" },
  { type: "border_yard" as const, name: "Santa Fe Yard", country: "MX" },
  { type: "yard" as const, name: "Laredo Yard", country: "US" },
  { type: "delivery" as const, name: "GM Arlington", country: "US" },
];

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Docs Once");
  await create(a, "billingEntity", { legalName: "Docs Once LLC", country: "US", invoicePrefix: "DO", isDefault: true });
  const broker = await create(a, "customsBroker", { name: "Agencia Demo", country: "MX", patente: "3456" });
  rxo = (await create(a, "customer", { name: "RXO", kind: "broker", mxBrokerId: broker.id, requiredDocs: ["POD", "BOL", "RATE_CON"] })).id;
  garza = (await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", caatExpires: new Date(Date.now() + 365 * 86400_000) })).id;
});

async function crossingOrder() {
  const o = await createOrder(a, { customerId: rxo, rateCents: 285000, stops, book: true });
  const [c] = await db.select().from(crossings).where(eq(crossings.legId, o.legs[1].id));
  return { o, c };
}
const file = async (name: string) => ({ fileName: name, mimeType: "application/pdf", bytes: await pdf(name) });

describe("rules (pure)", () => {
  it("one key per paper whatever screen it came in on", () => {
    expect(docKey("bol")).toBe("BOL");
    expect(docKey("BOL")).toBe("BOL");
    expect(docKey(" carta_porte ")).toBe("CARTA_PORTE");
    expect(docLabel("invoice")).toBe("Commercial invoice");
    expect(supersedeScope("DODA")).toBe("crossing");
    expect(supersedeScope("CARRIER_INVOICE")).toBe("leg");
    expect(supersedeScope("BOL")).toBe("load");
  });
  it("says every place a document counts", () => {
    const ctx = { billing: ["POD", "BOL", "RATE_CON"], crossing: ["carta_porte", "doda", "bol", "invoice"], carrierLeg: true };
    expect(whereItCounts("bol", ctx)).toEqual(["Billing", "Invoice packet", "Crossing checklist", "Customer portal"]);
    expect(whereItCounts("POD", ctx)).toEqual(["Billing", "Invoice packet", "Carrier bill", "Customer portal"]);
    expect(whereItCounts("CARRIER_INVOICE", ctx)).toEqual(["Carrier bill"]);
    expect(whereItCounts("DODA", ctx)).toEqual(["Crossing checklist"]);
    expect(whereItCounts("LUMPER", { ...ctx, packet: ["LUMPER"] })).toEqual(["Invoice packet"]);
  });
  it("the newest upload is the one that counts", () => {
    const docs = [
      { key: "BOL", createdAt: "2026-09-01T10:00:00Z", id: "old" },
      { key: "BOL", createdAt: "2026-09-02T10:00:00Z", id: "new" },
    ];
    expect(latestOf(docs, "bol")?.id).toBe("new");
    expect(latestOf(docs, "POD")).toBeNull();
  });
});

describe("upload once, counts everywhere", () => {
  it("a BOL uploaded on the crossing satisfies billing, the portal and the crossing checklist", async () => {
    const { o, c } = await crossingOrder();
    await X.uploadDocument(a, c.id, { code: "bol", ...(await file("bol.pdf")), fields: { trailer: "10743" } });
    const docs = await loadDocuments(a.tenantId, [o.order.id]);
    expect(docs.map((d) => [d.key, d.on, d.orderId])).toEqual([["BOL", "crossing", o.order.id]]);

    // billing's docs gate on the delivered load
    await db.update(orders).set({ state: "delivered", deliveredAt: new Date() }).where(eq(orders.id, o.order.id));
    const row = (await B.billingQueue(a)).find((r) => r.order.id === o.order.id)!;
    expect(row.requiredDocs.find((r) => r.code === "BOL")?.present).toBe(true);
    expect(row.requiredDocs.find((r) => r.code === "POD")?.present).toBe(false);

    // the customer sees it on their portal and can open it
    const view = await customerPortalView(a.tenantId, rxo);
    const load = view.delivered.find((l) => l.id === o.order.id)!;
    expect(load.docs.map((d) => d.code)).toEqual(["BOL"]);
    const got = await portalDocument(a.tenantId, rxo, load.docs[0].id);
    expect(got.doc.fileName).toBe("bol.pdf");
  });

  it("a BOL uploaded on the load ticks the crossing checklist, and replaces the crossing's copy (one live record)", async () => {
    const { o, c } = await crossingOrder();
    const first = await X.uploadDocument(a, c.id, { code: "bol", ...(await file("bol-v1.pdf")) });
    const second = await B.uploadOrderDocument(a, o.order.id, { code: "BOL", ...(await file("bol-v2.pdf")) });
    const [old] = await db.select().from(documents).where(eq(documents.id, first.id));
    expect(old.status).toBe("superseded");
    expect(second.version).toBe(2);
    const [x] = await db.select().from(crossings).where(eq(crossings.id, c.id));
    const bol = x.requirements.find((r) => r.code === "bol")!;
    expect(bol.status).toBe("present");
    expect(bol.documentId).toBe(second.id);
    // the crossing page lists it, marked as uploaded on the load
    const page = await X.crossingPage(a, c.id);
    const shown = page.docs.find((d) => d.id === second.id)!;
    expect(shown.code).toBe("bol");
    expect(shown.fromLoad).toBe(true);
    expect((await loadDocuments(a.tenantId, [o.order.id])).filter((d) => d.key === "BOL").length).toBe(1);
  });

  it("a DODA uploaded on the load is filed on its crossing", async () => {
    const { o, c } = await crossingOrder();
    const d = await B.uploadOrderDocument(a, o.order.id, { code: "DODA", ...(await file("doda.pdf")) });
    expect(d.subjectKind).toBe("crossing");
    expect(d.subjectId).toBe(c.id);
    const [x] = await db.select().from(crossings).where(eq(crossings.id, c.id));
    expect(x.requirements.find((r) => r.code === "doda")?.status).toBe("present");
  });

  it("a carrier's invoice uploaded on its leg is the bill's document, and the POD from the load counts for the three-way match", async () => {
    const { o } = await crossingOrder();
    const leg = o.legs[2];
    const billId = newId();
    await db.insert(carrierBills).values({ id: billId, tenantId: a.tenantId, carrierId: garza, orderId: o.order.id, legId: leg.id, expectedCents: 50000, currency: "USD" });
    let [chk] = await B.threeWayMany(a, await db.select().from(carrierBills).where(eq(carrierBills.id, billId)));
    expect(chk.podPresent).toBe(false);
    expect(chk.invoiceDocId).toBeNull();
    const inv = await B.uploadOrderDocument(a, o.order.id, { code: "CARRIER_INVOICE", legId: leg.id, ...(await file("garza-inv.pdf")) });
    expect(inv.subjectKind).toBe("leg");
    await B.uploadOrderDocument(a, o.order.id, { code: "POD", ...(await file("pod.pdf")) });
    [chk] = await B.threeWayMany(a, await db.select().from(carrierBills).where(eq(carrierBills.id, billId)));
    expect(chk.podPresent).toBe(true);
    expect(chk.invoiceDocId).toBe(inv.id);
    // recording the bill links the invoice already on file
    const after = await B.receiveCarrierBill(a, billId, { invoicedCents: 50000, carrierInvoiceNumber: "F-1" });
    expect(after.carrierInvoiceDocId).toBe(inv.id);
    // a second carrier's invoice on another leg does not replace the first
    await B.uploadOrderDocument(a, o.order.id, { code: "CARRIER_INVOICE", legId: o.legs[1].id, ...(await file("transfer-inv.pdf")) });
    const live = await db.select().from(documents).where(and(eq(documents.tenantId, a.tenantId), eq(documents.code, "CARRIER_INVOICE"), eq(documents.status, "present")));
    expect(live.length).toBe(2);
  });
});
