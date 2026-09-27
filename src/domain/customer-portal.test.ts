// Features: F-13 customer portal — one link per customer: their loads with tracking, delivered loads with the POD, invoices and balance, a load request that lands on Dispatch; customer bound
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { flags } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { resolveToken } from "@/lib/tokens";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, bookOrder, board, NotFoundError, ValidationError } from "./orders";
import * as B from "./billing";
import * as P from "./customer-portal";

const future = new Date(Date.now() + 365 * 86400_000);
const pdf = Buffer.from("%PDF-1.4 fixture");
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; magna: string; t2104: string; reyes: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: ["POD"], billingEmail: "ap@rxo.test" });
  const magna = await create(a, "customer", { name: "Magna", kind: "customer", termsDays: 45, requiredDocs: [] });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future, dotInspectionExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id, phone: "+1 956 000 0003" });
  f = { rxo: rxo.id, magna: magna.id, t2104: t2104.id, reyes: reyes.id };
});

const usOrder = (customerId: string, po: string) => createOrder(a, { customerId, rateCents: 180000, refs: { po }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } }, { type: "delivery", name: "Toyota San Antonio", country: "US", address: { city: "San Antonio", state: "TX" } }], book: true });

describe("customer portal", () => {
  it("link is one per customer and revocable; the view shows only their loads, with a tracking link, the POD once delivered, and the invoice; nothing about carrier pay or the driver's phone", async () => {
    const link = await P.customerPortalLink(a, f.rxo);
    expect(link.url).toMatch(/\/cp\/[A-Za-z0-9_-]{20,}$/);
    expect((await P.customerPortalLink(a, f.rxo)).url).toBe(link.url);
    const token = link.url.split("/cp/")[1];
    expect((await resolveToken(token, "customer_portal"))?.subjectId).toBe(f.rxo);
    expect(await resolveToken(token, "carrier_portal")).toBeNull();

    const o = await usOrder(f.rxo, "PO-1");
    await usOrder(f.magna, "PO-M"); // someone else's
    let v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.company).toBe("24:7");
    expect(v.active).toHaveLength(1);
    expect(v.active[0]).toMatchObject({ orderNumber: o.order.orderNumber, stateLabel: "Booked", refs: { po: "PO-1" } });
    expect(v.active[0].stops.map((st) => st.name)).toEqual(["Laredo Yard", "Toyota San Antonio"]);
    expect(v.active[0].trackingUrl).toMatch(/\/track\//);
    expect(JSON.stringify(v)).not.toMatch(/PO-M|carrierRate|driverPhone|956 000/);
    // the same tracking link dispatch would send: issuing again reuses it
    expect((await P.customerPortalView(a.tenantId, f.rxo)).active[0].trackingUrl).toBe(v.active[0].trackingUrl);

    // run the load; the customer sees the step; the POD appears once uploaded; invoice once issued
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, leg, st, { source: "driver_app" });
    v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.active[0]).toMatchObject({ stateLabel: "In transit", step: "En route" });
    for (const st of ["at_delivery", "completed"] as const) await advanceLeg(a, leg, st, { source: "driver_app" });
    v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.active).toHaveLength(0);
    expect(v.delivered).toHaveLength(1);
    expect(v.delivered[0].docs).toEqual([]);
    await B.uploadOrderDocument(a, o.order.id, { code: "POD", fileName: "pod.pdf", mimeType: "application/pdf", bytes: pdf });
    await B.uploadOrderDocument(a, o.order.id, { code: "RATE_CON", fileName: "rc.pdf", mimeType: "application/pdf", bytes: pdf });
    v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.delivered[0].docs.map((d) => d.code).sort()).toEqual(["POD", "RATE_CON"]);
    const podId = v.delivered[0].docs.find((d) => d.code === "POD")!.id;
    const got = await P.portalDocument(a.tenantId, f.rxo, podId);
    expect(got.blob.mimeType).toBe("application/pdf");
    await expect(P.portalDocument(a.tenantId, f.magna, podId)).rejects.toBeInstanceOf(NotFoundError); // not theirs
    const inv = await B.createInvoice(a, [o.order.id]);
    expect((await P.customerPortalView(a.tenantId, f.rxo)).invoices).toHaveLength(0); // drafts are ours, not theirs
    await B.issueInvoice(a, inv.id);
    v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ state: "issued", totalCents: 180000, openCents: 180000, pastDueDays: 0, orders: [o.order.orderNumber] });
    expect(v.invoices[0].url).toMatch(/\/i\//);
    expect(v.delivered[0].invoice?.number).toBe(v.invoices[0].number);
    expect(v.balance.openCents).toBe(180000);
    await B.recordReceipt(a, inv.id, { amountCents: 180000, method: "ach" });
    v = await P.customerPortalView(a.tenantId, f.rxo);
    expect(v.balance.openCents).toBe(0);
    expect(v.invoices[0].state).toBe("paid");

    await P.revokeCustomerPortal(a, f.rxo);
    expect(await resolveToken(token, "customer_portal")).toBeNull();
    expect((await P.customerPortalLink(a, f.rxo)).url).not.toBe(link.url);
  });

  it("a load request becomes a draft order on Dispatch with a flag; a border request gets the yards; booking it clears the flag", async () => {
    await expect(P.portalRequestLoad(a.tenantId, f.magna, { pickup: { name: "", country: "US" }, delivery: { name: "x", country: "US" } })).rejects.toBeInstanceOf(ValidationError);
    const r = await P.portalRequestLoad(a.tenantId, f.magna, {
      pickup: { name: "Magna Ramos Arizpe", city: "Ramos Arizpe", state: "coah", country: "MX", windowStart: new Date(Date.now() + 86400_000) },
      delivery: { name: "Magna Arlington", city: "Arlington", state: "TX", country: "US" },
      equipment: "53_dry",
      po: "PO-9001",
      cargoNote: "26 pallets seats",
      contact: "Ana · +52 844 000 0000",
    });
    expect(r.order.state).toBe("draft");
    expect(r.order.source).toBe("portal");
    expect(r.order.customerId).toBe(f.magna);
    expect(r.order.rateTbd).toBe(true);
    expect(r.stops.map((st) => st.type)).toEqual(["pickup", "border_yard", "yard", "delivery"]);
    expect(r.stops[0].address?.state).toBe("COAH");
    expect(r.legs.map((l) => l.type)).toEqual(["mx", "crossing", "us"]);
    const fl = await db.select().from(flags).where(and(eq(flags.orderId, r.order.id), eq(flags.code, "portal_request")));
    expect(fl).toHaveLength(1);
    expect(fl[0].title).toBe("Load request from Magna");
    expect(fl[0].clearedAt).toBeNull();
    expect(await P.openPortalRequests(a)).toBe(1);
    // the customer sees it as requested; dispatch sees it in Pending with the flag
    const v = await P.customerPortalView(a.tenantId, f.magna);
    expect(v.requested).toHaveLength(1);
    expect(v.requested[0]).toMatchObject({ stateLabel: "Requested", refs: { po: "PO-9001" }, trackingUrl: null });
    const rows = await board(a);
    const row = rows.find((x) => x.order.id === r.order.id)!;
    expect(row.stage).toBe("pending");
    expect(row.openFlags.map((x) => x.code)).toContain("portal_request");
    await bookOrder(a, r.order.id);
    expect(await P.openPortalRequests(a)).toBe(0);
    expect((await P.customerPortalView(a.tenantId, f.magna)).active[0].stateLabel).toBe("Booked");
  });
});
