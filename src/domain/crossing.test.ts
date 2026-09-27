// Features: F-3 crossing — rules → checklist, documents, cross-checks, eligibility, packet, Solicitud de Retiro, 16-state machine, dwell
import { describe, it, expect, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { crossings, crossingDocRules, flags, documents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, ValidationError } from "./orders";
import * as X from "./crossing";
import { runChecksPure } from "./crossing";
import { TransitionError } from "./states";

const future = new Date(Date.now() + 365 * 86400_000);
const past = new Date(Date.now() - 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; t2117: string; benja: string; martin: string; garza: string; entity: string; broker: string };

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
  a = await makeTenant("24:7");
  const entity = await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", dba: "24/7 Expedite", country: "US", invoicePrefix: "247", scac: "TSEX" });
  const broker = await create(a, "customsBroker", { name: "Agencia Demo", country: "MX", patente: "3456" });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", mxBrokerId: broker.id });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", caatExpires: future });
  const t2117 = await create(a, "truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future, entityId: entity.id, scac: "TSEX", dtopsYear: new Date().getUTCFullYear(), dtopsConfirmation: "DT-1" });
  const benja = await create(a, "driver", { name: "Benjamín Xochihua", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future, currentTruckId: t2117.id, whatsapp: "+52 867 000 0001" });
  const martin = await create(a, "driver", { name: "Martín Martínez", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future });
  f = { rxo: rxo.id, t2117: t2117.id, benja: benja.id, martin: martin.id, garza: garza.id, entity: entity.id, broker: broker.id };
});

async function crossingOrder() {
  const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
  const [c] = await db.select().from(crossings).where(eq(crossings.legId, o.legs[1].id));
  return { o, c };
}

const goodDocs = {
  carta_retiro: { trailer: "10743", unit: "2117", usPlate: "RC59022", mxPlate: "35ES3A", driver: "Benjamín Xochihua / Martín Martínez" },
  carta_porte: { trailer: "10743", usPlate: "RC59022", mxPlate: "35ES3A", seal: "S-771", uuid: "AB12-UUID", grossWeight: 18200, pieces: 26 },
  doda: { trailer: "10743", seal: "S-771", uuid: "AB12-UUID", pedimento: "26 24 3456 6001234", patente: "3456" },
  ace_manifest: { trailer: "10743", driver: "Benjamin Xochihua", usPlate: "RC59022", mxPlate: "35ES3A", scac: "TSEX", submittedAt: "2026-09-27T10:00:00Z", estimatedArrival: "2026-09-27T12:00:00Z", grossWeight: 18300, pieces: 26, fast: "yes" },
  bol: { trailer: "10743", seal: "S-771", pieces: 26, grossWeight: 18250 },
  invoice: { seal: "S-771", grossWeight: 18200, pieces: 26 },
};
const truck = { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", scac: "TSEX", entityScac: "TSEX", dtopsYear: new Date().getUTCFullYear(), dtopsConfirmation: "DT-1", usPlateExpires: future, mxPlateExpires: future, dotInspectionExpires: future };
const driver = { name: "Benjamín Xochihua", licenseExpires: future, mxLicenseExpires: future, medicalExpires: future, fastExpires: future, i94Until: future };

describe("cross-checks (spec §3.3), pure", () => {
  it("a consistent packet passes all 14 checks", () => {
    const r = runChecksPure({ now: new Date(), docs: goodDocs, trailerNumber: "10743", truck, driver, mxBrokerPatente: "3456" });
    expect(r.length).toBe(14);
    expect(r.filter((x) => x.state !== "pass").map((x) => `${x.code}:${x.state}`)).toEqual([]);
  });
  it("catches the real-world mismatches with plain-English messages", () => {
    const docs = JSON.parse(JSON.stringify(goodDocs));
    docs.doda.seal = "S-772"; // seal replaced at the yard
    docs.ace_manifest.scac = "45KM"; // broker filed under the wrong SCAC
    docs.ace_manifest.driver = "Juan Perez";
    docs.ace_manifest.submittedAt = "2026-09-27T11:45:00Z"; // 15 min before ETA
    docs.invoice.grossWeight = 20000; // > 2%
    docs.bol.trailer = "10744";
    const r = runChecksPure({ now: new Date(), docs, trailerNumber: "10743", truck, driver, mxBrokerPatente: "9999" });
    const by = Object.fromEntries(r.map((x) => [x.code, x]));
    expect(by.seal.state).toBe("fail");
    expect(by.seal.message).toContain("S-772");
    expect(by.scac.state).toBe("fail");
    expect(by.scac.message).toContain("45KM");
    expect(by.driver.state).toBe("fail");
    expect(by.timing.state).toBe("fail");
    expect(by.timing.message).toContain("earliest allowed arrival");
    expect(by.weight.state).toBe("fail");
    expect(by.trailer.state).toBe("fail");
    expect(by.trailer.message).toContain("10744");
    expect(by.patente.state).toBe("fail");
    expect(by.folio_fiscal.state).toBe("pass");
  });
  it("brown plates without a carta porte fail the plate rule; expired FAST fails expiry; missing DTOPS fails", () => {
    const docs = { ...goodDocs } as Record<string, Record<string, unknown>>;
    delete docs.carta_porte;
    const r = runChecksPure({ now: new Date(), docs, trailerNumber: "10743", truck: { ...truck, dtopsConfirmation: null, dtopsYear: null }, driver: { ...driver, fastExpires: past }, mxBrokerPatente: "3456" });
    const by = Object.fromEntries(r.map((x) => [x.code, x]));
    expect(by.plate_class.state).toBe("fail");
    expect(by.expiry.state).toBe("fail");
    expect(by.expiry.message).toContain("FAST");
    expect(by.dtops.state).toBe("fail");
  });
  it("with nothing uploaded, checks are skipped, not failed", () => {
    const r = runChecksPure({ now: new Date(), docs: {}, trailerNumber: null, truck: null, driver: null, mxBrokerPatente: null });
    expect(r.every((x) => x.state === "skipped")).toBe(true);
  });
});

describe("crossing lifecycle (spec §3.1)", () => {
  it("is created with the order and gets the base checklist from the rules", async () => {
    const { c } = await crossingOrder();
    expect(c).toBeTruthy();
    expect(c.state).toBe("created");
    const codes = c.requirements.map((r) => `${r.code}:${r.status}`);
    expect(codes).toContain("carta_retiro:missing");
    expect(codes).toContain("doda:missing");
    expect(codes).toContain("entry:na"); // optional
    const rules = await db.select().from(crossingDocRules).where(eq(crossingDocRules.tenantId, a.tenantId));
    expect(rules.length).toBe(X.DEFAULT_CROSSING_RULES.length);
  });

  it("MX leg loaded → awaiting arrival; MX leg at the border yard → at_border_yard with the dwell clock", async () => {
    const { o, c } = await crossingOrder();
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: f.garza });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, o.legs[0].id, st, { source: "carrier" });
    expect((await X.recompute(a, c.id)).state).toBe("awaiting_mx_arrival");
    await advanceLeg(a, o.legs[0].id, "en_route", { source: "carrier" });
    await advanceLeg(a, o.legs[0].id, "at_delivery", { source: "carrier" });
    const c2 = await X.recompute(a, c.id);
    expect(c2.state).toBe("at_border_yard");
    expect(c2.arrivedYardAt).not.toBeNull();
    // dwell watchdog
    await db.update(crossings).set({ arrivedYardAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(crossings.id, c.id));
    expect((await X.flagDwell(new Date())).flagged).toBe(1);
    let fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "dwell")));
    expect(fl[0].level).toBe("yellow");
    await db.update(crossings).set({ arrivedYardAt: new Date(Date.now() - 66 * 3600_000) }).where(eq(crossings.id, c.id));
    await X.flagDwell(new Date());
    fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "dwell")));
    expect(fl.length).toBe(1);
    expect(fl[0].level).toBe("red");
    expect(fl[0].title).toContain("66 h");
  });

  it("documents walk the state up: in progress → waiting on DODA → complete → verified → eligible → packet → sent → crossed", async () => {
    const { o, c } = await crossingOrder();
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: f.t2117, driverId: f.benja, coDriverId: f.martin });
    await X.setCrossingDetails(a, c.id, { trailerNumber: "10743" });

    // the carta de retiro is generated by us, from the real letter's fields
    const retiro = await X.generateCartaRetiro(a, c.id, { yardName: "Santa Fe Yard", authorizedBy: "Nate Papa" });
    expect(retiro.source).toBe("generated");
    expect(retiro.status).toBe("verified");
    const blob = await X.readBlob(a, retiro.storageKey);
    const pdfDoc = await PDFDocument.load(blob.bytes);
    expect(pdfDoc.getPageCount()).toBe(1);
    expect((await X.recompute(a, c.id)).state).toBe("docs_in_progress");

    const up = async (code: keyof typeof goodDocs, fields = goodDocs[code] as Record<string, unknown>) => X.uploadDocument(a, c.id, { code, fileName: `${code}.pdf`, mimeType: "application/pdf", bytes: await pdf(code), fields });
    await up("carta_porte");
    await up("ace_manifest");
    await up("bol");
    await up("invoice");
    expect((await X.recompute(a, c.id)).state).toBe("awaiting_doda");
    let page = await X.crossingPage(a, c.id);
    expect(page.waitingOn?.code).toBe("doda");

    // the DODA arrives with a different seal (replaced at the yard)
    await up("doda", { ...goodDocs.doda, seal: "S-772" });
    let cur = await X.recompute(a, c.id);
    expect(cur.state).toBe("docs_complete");
    page = await X.crossingPage(a, c.id);
    const seal = page.checks.find((k) => k.code === "seal")!;
    expect(seal.state).toBe("fail");
    await expect(X.buildPacket(a, c.id)).rejects.toThrow(/cross-check is failing/);
    // dispatcher role cannot override, owner can
    await expect(X.overrideCheck({ ...a, role: "dispatcher" }, c.id, "seal", "seal replaced at the yard, S-772 recorded")).rejects.toThrow(/permission/);
    await X.overrideCheck(a, c.id, "seal", "seal replaced at the yard, S-772 recorded");
    cur = await X.recompute(a, c.id);
    expect(cur.state).toBe("eligibility_checked"); // docs verified + brown plates w/ carta porte, B-1 team on the crossing = green
    expect(cur.eligibility?.ok).toBe(true);

    // the override survives re-runs while the values are unchanged, and is dropped when the doc changes
    await X.recompute(a, c.id);
    expect((await X.crossingPage(a, c.id)).checks.find((k) => k.code === "seal")!.state).toBe("overridden");
    await up("doda", { ...goodDocs.doda, seal: "S-771" });
    expect((await X.crossingPage(a, c.id)).checks.find((k) => k.code === "seal")!.state).toBe("pass");
    const versions = await db.select().from(documents).where(and(eq(documents.subjectId, c.id), eq(documents.code, "doda")));
    expect(versions.map((v) => `${v.version}:${v.status}`).sort()).toEqual(["1:superseded", "2:present"]);

    await expect(X.sendPacket(a, c.id)).rejects.toThrow(/build the packet/);
    cur = await X.buildPacket(a, c.id);
    expect(cur.state).toBe("ready_to_cross");
    const packet = await PDFDocument.load((await X.readBlob(a, cur.packetStorageKey!)).bytes);
    expect(packet.getPageCount()).toBe(1 + 6); // cover + one page per document
    cur = await X.sendPacket(a, c.id);
    expect(cur.state).toBe("packet_sent");
    expect(cur.packetSentAt).not.toBeNull();

    // the driver opens it (ack), then taps through the border
    const opened = await X.packetByToken(cur.packetToken!);
    expect(opened).not.toBeNull();
    expect((await X.crossingPage(a, c.id)).crossing.packetAckAt).not.toBeNull();
    await expect(X.step(a, c.id, "in_us_customs", { source: "driver_app" })).rejects.toBeInstanceOf(TransitionError); // one step at a time
    for (const st of ["departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as const) cur = await X.step(a, c.id, st, { source: "driver_app", verified: true });
    expect(cur.state).toBe("cleared");
    expect(cur.clearedAt).not.toBeNull();
    expect(X.bucketOf(cur.state)).toBe("cleared");
    // a document arriving now does not yank the state back
    await X.uploadDocument(a, c.id, { code: "packing_list", fileName: "pl.pdf", mimeType: "application/pdf", bytes: await pdf("pl"), fields: { pieces: 26 } });
    expect((await X.recompute(a, c.id)).state).toBe("cleared");
  });

  it("packet unacknowledged → red flag; hold and release; returned → re-verify", async () => {
    const { o, c } = await crossingOrder();
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: f.t2117, driverId: f.benja });
    await X.setCrossingDetails(a, c.id, { trailerNumber: "10743" });
    await X.generateCartaRetiro(a, c.id, {});
    for (const code of ["carta_porte", "doda", "ace_manifest", "bol", "invoice"] as const) await X.uploadDocument(a, c.id, { code, fileName: `${code}.pdf`, mimeType: "application/pdf", bytes: await pdf(code), fields: goodDocs[code] as Record<string, unknown> });
    await X.buildPacket(a, c.id);
    let cur = await X.sendPacket(a, c.id);
    await db.update(crossings).set({ packetSentAt: new Date(Date.now() - 45 * 60000) }).where(eq(crossings.id, c.id));
    expect((await X.flagUnacknowledgedPackets(new Date())).flagged).toBe(1);
    expect((await X.flagUnacknowledgedPackets(new Date())).flagged).toBe(0);

    cur = await X.step(a, c.id, "departed_yard", { source: "driver_app" });
    cur = await X.step(a, c.id, "at_mx_customs", { source: "driver_app" });
    await expect(X.hold(a, c.id, "")).rejects.toBeInstanceOf(ValidationError);
    cur = await X.hold(a, c.id, "CBP secondary");
    expect(cur.state).toBe("held");
    let fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "crossing_hold")));
    expect(fl[0].clearedAt).toBeNull();
    cur = await X.release(a, c.id);
    expect(cur.state).toBe("at_mx_customs");
    fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "crossing_hold")));
    expect(fl[0].clearedAt).not.toBeNull();

    cur = await X.step(a, c.id, "in_us_customs", { source: "gps", verified: true });
    cur = await X.markReturned(a, c.id, "rejected: manifest SCAC wrong");
    expect(cur.state).toBe("returned");
    expect(cur.packetSentAt).toBeNull();
    cur = await X.reverify(a, c.id);
    expect(["docs_complete", "docs_verified", "eligibility_checked"]).toContain(cur.state);
    expect(cur.packetBuiltAt).toBeNull();
  });

  it("rules: a customer-specific row overrides the base; blue plates make carta porte optional; n/a needs a reason", async () => {
    const { c } = await crossingOrder();
    await expect(X.markNotApplicable(a, c.id, "doda", "x")).rejects.toThrow(/cannot be marked n\/a/);
    await expect(X.markNotApplicable(a, c.id, "carta_porte", "")).rejects.toBeInstanceOf(ValidationError);
    await X.markNotApplicable(a, c.id, "carta_porte", "blue plates");
    expect((await X.recompute(a, c.id)).requirements.find((r) => r.code === "carta_porte")!.status).toBe("na");
    await X.undoNotApplicable(a, c.id, "carta_porte");
    // RXO requires a packing list
    await db.insert(crossingDocRules).values({ id: "rule-rxo-pl", tenantId: a.tenantId, code: "packing_list", label: "Packing list (RXO)", providedBy: "shipper", requiredWhen: "always", allowNa: false, packetOrder: 90, customerId: f.rxo });
    const cur = await X.recompute(a, c.id);
    expect(cur.requirements.find((r) => r.code === "packing_list")).toMatchObject({ status: "missing", label: "Packing list (RXO)" });
    // blue-plate truck: carta porte becomes optional (n/a automatically)
    await update(a, "truck", f.t2117, { mxPlateClass: "blue" });
    const { o: o2, c: c2 } = await crossingOrder();
    await planLeg(a, o2.legs[1].id, { kind: "truck", truckId: f.t2117, driverId: f.benja });
    expect((await X.recompute(a, c2.id)).requirements.find((r) => r.code === "carta_porte")!.status).toBe("na");
  });

  it("uploads are validated and tenant-scoped", async () => {
    const { c } = await crossingOrder();
    await expect(X.uploadDocument(a, c.id, { code: "bol", fileName: "x.exe", mimeType: "application/octet-stream", bytes: Buffer.from("x") })).rejects.toBeInstanceOf(ValidationError);
    await expect(X.uploadDocument(a, c.id, { code: "bol", fileName: "x.pdf", mimeType: "application/pdf", bytes: Buffer.alloc(0) })).rejects.toBeInstanceOf(ValidationError);
    const b = await makeTenant("B");
    await expect(X.crossingPage(b, c.id)).rejects.toThrow(/not found/);
    await expect(X.uploadDocument(b, c.id, { code: "bol", fileName: "x.pdf", mimeType: "application/pdf", bytes: await pdf("x") })).rejects.toThrow(/not found/);
    expect((await X.crossingBoard(b)).length).toBe(0);
    expect((await X.crossingBoard(a)).length).toBe(1);
  });
});
