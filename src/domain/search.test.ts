// Features: F-30.4
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { crossings, tenders, invoices, creditMemos, carrierBills, payments, documents, stops as stopsT } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { searchAll } from "./search";
import { createOrder } from "./orders";
import { fold, foldIncludes } from "@/lib/fold";

let a: Awaited<ReturnType<typeof makeTenant>>;
let order: Awaited<ReturnType<typeof createOrder>>;
let ids: { cust: string; carrier: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Search Carrier");
  const cust = await create(a, "customer", { name: "Bajío Autopartes", kind: "customer" });
  const carrier = await create(a, "carrier", { name: "Transportes del Norte", country: "MX", rfc: "TDN010203AB1" });
  await create(a, "driver", { name: "Óscar Héctor Treviño", driverType: "B1" });
  ids = { cust: cust.id, carrier: carrier.id };
  order = await createOrder(a, {
    customerId: cust.id,
    rateCents: 250000,
    book: true,
    refs: { po: "SUM-9001" },
    stops: [
      { type: "pickup", name: "Planta Querétaro", country: "MX", address: { city: "Querétaro", state: "QRO" } },
      { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAM" } },
      { type: "delivery", name: "DC San Antonio", country: "US", address: { city: "San Antonio", state: "TX" } },
    ],
  });
});

const found = async (q: string, kind?: string) => (await searchAll(a, q)).filter((h) => !kind || h.kind === kind);

describe("⌘K search (M19, billing #21, owner #16)", () => {
  it("is accent- and case-blind for people, companies and places", async () => {
    expect((await found("Oscar", "driver")).map((h) => h.title)).toContain("Óscar Héctor Treviño");
    expect((await found("hector", "driver")).length).toBe(1);
    expect((await found("HÉCTOR", "driver")).length).toBe(1);
    expect((await found("Bajio", "customer")).map((h) => h.title)).toContain("Bajío Autopartes");
    expect((await found("queretaro", "load")).map((h) => h.id)).toContain(order.order.id);
  });

  it("puts the customer before its loads", async () => {
    const hits = await found("bajio");
    expect(hits[0].kind).toBe("customer");
    expect(hits.some((h) => h.kind === "load")).toBe(true);
  });

  it("finds a load by caja, seal (crossing and stop), pedimento and a partner carrier's driver", async () => {
    const leg = order.legs.find((l) => l.type === "crossing") ?? order.legs[0];
    const [x] = await db.select().from(crossings).where(eq(crossings.legId, leg.id));
    const crossingId = x?.id ?? newId();
    if (!x) await db.insert(crossings).values({ id: crossingId, tenantId: a.tenantId, legId: leg.id, orderId: order.order.id });
    await db.update(crossings).set({ trailerNumber: "CAJA-7702", sealNumber: "SM-448812" }).where(eq(crossings.id, crossingId));
    await db.update(stopsT).set({ sealOut: "ST-11" }).where(eq(stopsT.id, order.stops[0].id));
    await db.insert(tenders).values({ id: newId(), tenantId: a.tenantId, legId: order.legs[0].id, orderId: order.order.id, carrierId: ids.carrier, token: newId(), expiresAt: new Date(Date.now() + 3600_000), state: "accepted", driverName: "Juan Pérez", unitNumber: "MX-77" });
    await db.insert(documents).values({ id: newId(), tenantId: a.tenantId, code: "pedimento", subjectKind: "crossing", subjectId: crossingId, fileName: "ped.pdf", mimeType: "application/pdf", storageKey: "x", number: "26 24 3456 6001234" });
    for (const q of ["caja-7702", "7702", "SM-448812", "st-11", "juan perez", "MX-77"]) expect((await found(q)).some((h) => h.title === order.order.orderNumber), q).toBe(true);
    const ped = await found("3456 6001234");
    expect(ped[0]).toMatchObject({ kind: "crossing", href: `/crossing/${crossingId}` });
  });

  it("billing finds invoice #, credit memo #, carrier invoice # and a payment reference", async () => {
    const inv = newId();
    await db.insert(invoices).values({ id: inv, tenantId: a.tenantId, entityId: "e1", customerId: ids.cust, number: "FF-002409", state: "sent", orderIds: [order.order.id], totalCents: 250000 });
    await db.insert(creditMemos).values({ id: newId(), tenantId: a.tenantId, invoiceId: inv, number: "CM-000012", amountCents: 40000, reason: "short pay" });
    await db.insert(carrierBills).values({ id: newId(), tenantId: a.tenantId, carrierId: ids.carrier, orderId: order.order.id, legId: order.legs[0].id, carrierInvoiceNumber: "TDN-5540", expectedCents: 48000 });
    await db.insert(payments).values({ id: newId(), tenantId: a.tenantId, customerId: ids.cust, receivedAt: new Date(), amountCents: 250000, currency: "MXN", reference: "SPEI 7731" });
    expect((await found("FF-002409", "invoice"))[0]).toMatchObject({ href: `/billing/invoices/${inv}` });
    expect((await found("cm-000012", "credit")).length).toBe(1);
    expect((await found("TDN-5540", "bill"))[0].href).toBe(`/orders/${order.order.id}?tab=money`);
    const pay = await found("spei 7731", "payment");
    expect(pay[0].sub).toContain("MX$2,500.00");
    // a role without billing never sees money
    const disp = { ...a, role: "compliance" as const };
    expect((await searchAll(disp, "FF-002409")).some((h) => h.kind === "invoice")).toBe(false);
  });

  it("folds the way the client filters fold", () => {
    expect(fold("Bajío Querétaro ÑANDÚ")).toBe("bajio queretaro nandu");
    expect(foldIncludes("Óscar", "osc")).toBe(true);
    expect(foldIncludes(null, "x")).toBe(false);
  });
});
