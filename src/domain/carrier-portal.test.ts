// Features: F-10 carrier portal — one link per carrier: offers, active loads with steps and driver, rate con PDF, compliance uploads, invoice against the leg, scorecard; tenant and carrier bound
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { positions } from "@/db/schema";
import { newId } from "@/lib/ids";
import { resolveToken } from "@/lib/tokens";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, ValidationError, NotFoundError } from "./orders";
import { sendTender } from "./tenders";
import * as B from "./billing";
import * as P from "./carrier-portal";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; garza: string; lone: string; coiType: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", dba: "24/7 Expedite", country: "US", invoicePrefix: "247", isDefault: true, mcNumber: "123456" });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: [] });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", caatExpires: future });
  const lone = await create(a, "carrier", { name: "Lone Star", country: "US", kind: "us", dispatchEmail: "d@ls.test" });
  f = { rxo: rxo.id, garza: garza.id, lone: lone.id, coiType: "" };
});

async function mxOrder() {
  return createOrder(a, { customerId: f.rxo, rateCents: 285000, refs: { po: "4500991" }, stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" }, windowEnd: new Date(Date.now() + 2 * 86400_000) }, { type: "border_yard", name: "Santa Fe", country: "MX", windowEnd: new Date(Date.now() + 3 * 86400_000) }, { type: "yard", name: "Laredo", country: "US" }], template: "mx_crossing", book: true });
}

describe("carrier portal", () => {
  it("link is one per carrier and revocable; the view shows offers, the carrier answers from the portal with a driver, then walks the load, sets the driver, and it shows as completed with the bill expected", async () => {
    const link = await P.carrierPortalLink(a, f.garza);
    expect(link.url).toMatch(/\/c\/[A-Za-z0-9_-]{20,}$/);
    expect((await P.carrierPortalLink(a, f.garza)).url).toBe(link.url);
    const token = link.url.split("/c/")[1];
    const res = await resolveToken(token, "carrier_portal");
    expect(res?.subjectId).toBe(f.garza);

    const o = await mxOrder();
    const mx = o.legs[0].id;
    await sendTender(a, mx, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 120, message: "Ask for gate 3" });
    let v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.company).toBe("24:7");
    expect(v.offers).toHaveLength(1);
    expect(v.offers[0]).toMatchObject({ orderNumber: o.order.orderNumber, type: "Mexico", rateCents: 45000, message: "Ask for gate 3" });
    expect(v.offers[0].from?.city).toBe("Monterrey");
    expect(v.active).toHaveLength(0);
    // the other carrier sees nothing of it
    expect((await P.carrierPortalView(a.tenantId, f.lone)).offers).toHaveLength(0);
    await expect(P.portalRespond(a.tenantId, f.lone, v.offers[0].id, { accept: true, name: "x", driverName: "y" })).rejects.toBeInstanceOf(NotFoundError);

    await P.portalRespond(a.tenantId, f.garza, v.offers[0].id, { accept: true, name: "Luis", driverName: "Pedro Ruiz", driverPhone: "+52 81 555 0101", unitNumber: "MX-77" });
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.offers).toHaveLength(0);
    expect(v.active).toHaveLength(1);
    expect(v.active[0]).toMatchObject({ state: "accepted", driverName: "Pedro Ruiz", unitNumber: "MX-77", rateCents: 45000 });
    expect(v.active[0].next).toMatchObject({ to: "en_route_to_pickup", es: "En camino a cargar" });
    // steps only in order, only their own legs
    await expect(P.portalAdvance(a.tenantId, f.garza, mx, "loaded")).rejects.toBeInstanceOf(ValidationError);
    await expect(P.portalAdvance(a.tenantId, f.lone, mx, "en_route_to_pickup")).rejects.toBeInstanceOf(NotFoundError);
    await P.portalAdvance(a.tenantId, f.garza, mx, "en_route_to_pickup");
    await P.portalSetDriver(a.tenantId, f.garza, mx, { driverName: "Pedro Ruiz", driverPhone: "+52 81 555 0101", unitNumber: "MX-77", trailerNumber: "10743" });
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.active[0].trailerNumber).toBe("10743");
    for (const st of ["at_pickup", "loaded", "en_route"] as const) await P.portalAdvance(a.tenantId, f.garza, mx, st);
    // the POD only once at the delivery; their leg only
    const jpg = Buffer.from("jpg fixture");
    await expect(P.portalUploadPod(a.tenantId, f.garza, mx, { fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toThrow(/at the delivery/);
    await P.portalAdvance(a.tenantId, f.garza, mx, "at_delivery");
    await expect(P.portalUploadPod(a.tenantId, f.lone, mx, { fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toBeInstanceOf(NotFoundError);
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.active[0].podOnFile).toBe(false);
    await P.portalUploadPod(a.tenantId, f.garza, mx, { fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg });
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.active[0].podOnFile).toBe(true);
    await P.portalAdvance(a.tenantId, f.garza, mx, "completed");
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.active).toHaveLength(0);
    expect(v.completed).toHaveLength(1);
    expect(v.completed[0].bill).toMatchObject({ state: "expected", expectedCents: 45000 });
    expect(v.completed[0].podOnFile).toBe(true);

    // rate con PDF for the leg, not for another carrier
    const pdf = await P.rateConPdf(a.tenantId, f.garza, mx);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    await expect(P.rateConPdf(a.tenantId, f.lone, mx)).rejects.toBeInstanceOf(NotFoundError);

    // the carrier invoices the leg: received, waiting for our three-way check; twice is refused once approved
    await expect(P.portalSubmitInvoice(a.tenantId, f.garza, mx, { amountCents: 0, invoiceNumber: "G-1" })).rejects.toBeInstanceOf(ValidationError);
    const bill = await P.portalSubmitInvoice(a.tenantId, f.garza, mx, { amountCents: 45000, invoiceNumber: "G-1001", fileName: "g1001.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 x") });
    expect(bill.state).toBe("received");
    expect(bill.carrierInvoiceDocId).toBeTruthy();
    const chk = await B.threeWay(a, bill.id);
    expect(chk.invoiced).toBe(45000);
    expect(chk.podPresent).toBe(true); // the carrier's own POD satisfies the three-way check
    await B.approveCarrierBill(a, bill.id, { approvedCents: 45000 });
    await expect(P.portalSubmitInvoice(a.tenantId, f.garza, mx, { amountCents: 45000, invoiceNumber: "G-1001" })).rejects.toThrow(/already approved/);
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.completed[0].bill?.state).toBe("approved");

    // the revoked link stops working
    await P.revokeCarrierPortal(a, f.garza);
    expect(await resolveToken(token, "carrier_portal")).toBeNull();
  });

  it("documents: the carrier uploads its COI against the company's document types and goes dispatchable; scorecard counts offers, on-time and tracking", async () => {
    const coi = await create(a, "documentType", { name: "Certificate of insurance", appliesTo: "carrier", tracksExpiry: true, required: true, blocksDispatch: true });
    f.coiType = coi.id;
    const { evaluateSubject } = await import("./compliance");
    await evaluateSubject(a, "carrier", f.garza);
    let v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.types.map((t) => t.name)).toEqual(["Certificate of insurance"]);
    expect(v.compliance?.dispatchable).toBe(false);
    await expect(P.portalUploadDocument(a.tenantId, f.garza, { documentTypeId: f.coiType, fileName: "coi.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF") })).rejects.toThrow(/expir/i);
    await P.portalUploadDocument(a.tenantId, f.garza, { documentTypeId: f.coiType, fileName: "coi.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF"), expiresAt: future, number: "POL-9" });
    v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.compliance?.dispatchable).toBe(true);
    expect(v.docs[0]).toMatchObject({ typeName: "Certificate of insurance", number: "POL-9" });

    // scorecard: 2 offers, 1 accepted 1 declined; the accepted load delivered inside its window with a position
    const o = await mxOrder();
    const t1 = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000 });
    await P.portalRespond(a.tenantId, f.garza, t1.tender.id, { accept: true, name: "Luis", driverName: "Pedro" });
    const t2 = await sendTender(a, o.legs[1].id, { carrierId: f.garza, rateCents: 15000 });
    await P.portalRespond(a.tenantId, f.garza, t2.tender.id, { accept: false, name: "Luis", note: "no crossing unit" });
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, o.legs[0].id, st, { source: "carrier" });
    await db.insert(positions).values({ id: newId(), tenantId: a.tenantId, source: "carrier", lat: "25.6", lng: "-100.3", recordedAt: new Date(), at: new Date(), legId: o.legs[0].id });
    const sc = await P.scorecard(a, f.garza);
    expect(sc).toMatchObject({ offered: 2, answered: 2, accepted: 1, declined: 1, expired: 0, acceptancePct: 50, loads: 1, onTimePct: 100, onTimeOf: 1, trackedPct: 100 });
    expect((await P.scorecard(a, f.lone)).acceptancePct).toBeNull();
  });

  it("a leg given by phone with no tender still gets a driver from the portal, and a load in another tenant is invisible", async () => {
    const o = await mxOrder();
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: f.garza, carrierRateCents: 40000 });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id, "carrier");
    await P.portalSetDriver(a.tenantId, f.garza, o.legs[0].id, { driverName: "Martín Martínez", unitNumber: "2117", by: "Luis" });
    const v = await P.carrierPortalView(a.tenantId, f.garza);
    expect(v.active[0]).toMatchObject({ driverName: "Martín Martínez", unitNumber: "2117", rateCents: 40000 });
    const b = await makeTenant("B");
    await expect(P.carrierPortalView(b.tenantId, f.garza)).rejects.toBeInstanceOf(NotFoundError);
  });
});
