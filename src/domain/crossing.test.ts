// Features: F-3 F-3.10 F-31.3 F-31.7 crossing — rules → checklist, documents, cross-checks, eligibility, packet, Solicitud de Retiro, 16-state machine, dwell
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { crossings, crossingDocRules, flags, documents, legs } from "@/db/schema";
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

afterEach(() => vi.unstubAllGlobals());

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

const getLegState = async (legId: string) => (await db.select({ state: legs.state }).from(legs).where(eq(legs.id, legId)))[0].state;

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
  entry: { pedimento: "26 24 3456 6001234", entryNumber: "PAPS-4471" },
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
    expect(codes).toContain("entry:missing"); // entering the US always needs the entry / PAPS pre-file (M16)
    expect(codes).toContain("dtops:missing"); // and DTOPS: no truck on the leg yet, so nothing on file
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
    await up("entry");
    // DTOPS is on the truck record for this year: that counts, no upload needed
    expect((await X.recompute(a, c.id)).requirements.find((r) => r.code === "dtops")).toMatchObject({ status: "verified", onFile: expect.stringContaining("DT-1") });
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
    // billing cannot waive a check; the dispatcher can, with a reason (audited) — M16
    await expect(X.overrideCheck({ ...a, role: "billing" }, c.id, "seal", "seal replaced at the yard, S-772 recorded")).rejects.toThrow(/permission/);
    await X.overrideCheck({ ...a, role: "dispatcher" }, c.id, "seal", "seal replaced at the yard, S-772 recorded");
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
    expect(packet.getPageCount()).toBe(1 + 7); // cover + one page per document
    // B3: the crossing leg is only planned — the packet does not go out without it, unless dispatch sends both
    await expect(X.sendPacket(a, c.id)).rejects.toThrow(/not sent to Benjamín Xochihua yet/);
    cur = await X.sendPacket(a, c.id, { dispatchLeg: true });
    expect(cur.state).toBe("packet_sent");
    expect(cur.packetSentAt).not.toBeNull();
    expect((await getLegState(o.legs[1].id))).toBe("dispatched");

    // the driver opens it (ack), then taps through the border
    const opened = await X.packetByToken(cur.packetToken!);
    expect(opened).not.toBeNull();
    expect((await X.crossingPage(a, c.id)).crossing.packetAckAt).not.toBeNull();
    await expect(X.step(a, c.id, "in_us_customs", { source: "driver_app" })).rejects.toBeInstanceOf(TransitionError); // one step at a time
    // the border steps wait for the caja to be picked up at the yard
    await expect(X.step(a, c.id, "departed_yard", { source: "driver_app" })).rejects.toThrow(/Loaded/);
    for (const st of ["accepted", "en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, o.legs[1].id, st, { source: "driver_app" });
    cur = await X.step(a, c.id, "departed_yard", { source: "driver_app", verified: true });
    expect(await getLegState(o.legs[1].id)).toBe("en_route"); // left the yard = the leg is rolling
    for (const st of ["at_mx_customs", "in_us_customs", "cleared"] as const) cur = await X.step(a, c.id, st, { source: "driver_app", verified: true });
    expect(cur.state).toBe("cleared");
    expect(cur.clearedAt).not.toBeNull();
    expect(await getLegState(o.legs[1].id)).toBe("completed"); // cleared = delivered at the Laredo yard
    expect(X.bucketOf(cur.state)).toBe("cleared");
    // a document arriving now does not yank the state back
    await X.uploadDocument(a, c.id, { code: "packing_list", fileName: "pl.pdf", mimeType: "application/pdf", bytes: await pdf("pl"), fields: { pieces: 26 } });
    expect((await X.recompute(a, c.id)).state).toBe("cleared");
  }, 30_000); // many documents, the packet, the border: slow on a busy machine

  it("packet unacknowledged → red flag; hold and release; returned → re-verify", async () => {
    const { o, c } = await crossingOrder();
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: f.t2117, driverId: f.benja });
    await X.setCrossingDetails(a, c.id, { trailerNumber: "10743" });
    await X.generateCartaRetiro(a, c.id, {});
    for (const code of ["carta_porte", "doda", "ace_manifest", "bol", "invoice", "entry"] as const) await X.uploadDocument(a, c.id, { code, fileName: `${code}.pdf`, mimeType: "application/pdf", bytes: await pdf(code), fields: goodDocs[code] as Record<string, unknown> });
    await X.buildPacket(a, c.id);
    await dispatchLeg(a, o.legs[1].id);
    let cur = await X.sendPacket(a, c.id);
    await db.update(crossings).set({ packetSentAt: new Date(Date.now() - 45 * 60000) }).where(eq(crossings.id, c.id));
    expect((await X.flagUnacknowledgedPackets(new Date())).flagged).toBe(1);
    expect((await X.flagUnacknowledgedPackets(new Date())).flagged).toBe(0);

    // the office can say it left once the caja was at the yard: the leg walks forward to en route with it
    await expect(X.step(a, c.id, "departed_yard", { source: "dispatcher" })).rejects.toThrow(/not at the yard yet/);
    await X.markArrivedYard(a, c.id);
    cur = await X.step(a, c.id, "departed_yard", { source: "dispatcher" });
    expect(await getLegState(o.legs[1].id)).toBe("en_route");
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
  }, 30_000); // many documents, the packet, the border: slow on a busy machine

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

  it("AI extractor (F-3.4): runs on upload when connected, fills blanks with confidence < 1, never overrides a typed value, values count only after a person confirms", async () => {
    const { c } = await crossingOrder();
    // not connected: upload works, nothing read
    const d0 = await X.uploadDocument(a, c.id, { code: "carta_porte", fileName: "cp.pdf", mimeType: "application/pdf", bytes: await pdf("cp") });
    expect(d0.extractionAt).toBeNull();
    expect(await X.extractDocumentFields(a, d0.id)).toMatchObject({ ran: false, reason: expect.stringMatching(/not connected/) });
    const { integrations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-ant-test" } });
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: { type: string; text?: string }[] }[] };
      seen.push(body.messages[0].content.find((x) => x.type === "text")!.text!);
      return new Response(JSON.stringify({ model: "claude-sonnet-4-5", usage: { input_tokens: 900 }, content: [{ type: "tool_use", name: "record_fields", input: { trailer: { value: "10743", confidence: 0.95 }, seal: { value: "SL-77", confidence: 0.6 }, uuid: { value: null, confidence: 0.1 }, grossWeight: { value: 18540, confidence: 0.9 } } }] }), { status: 200 });
    });
    // typed seal survives the AI read; the rest is filled
    const d1 = await X.uploadDocument(a, c.id, { code: "carta_porte", fileName: "cp2.pdf", mimeType: "application/pdf", bytes: await pdf("cp2"), fields: { seal: "SL-99" } });
    const [after] = await db.select().from(documents).where(eq(documents.id, d1.id));
    expect(after.extracted).toMatchObject({ seal: { value: "SL-99", confidence: 1, source: "human" }, trailer: { value: "10743", confidence: 0.95, source: "ai" }, grossWeight: { value: 18540, confidence: 0.9, source: "ai" } });
    expect(after.extracted?.uuid).toBeUndefined();
    expect(after.extractionNote).toMatch(/claude-sonnet-4-5 · 900 tokens · 2 field\(s\)/);
    expect(seen[0]).toContain("Carta porte");
    expect(seen[0]).toContain("Carta Porte");
    // AI values do not verify the document: checks still wait for a person
    expect(after.status).toBe("present");
    await X.setDocumentFields(a, d1.id, { trailer: "10743", seal: "SL-99", grossWeight: 18540 }, true);
    const [confirmed] = await db.select().from(documents).where(eq(documents.id, d1.id));
    expect(confirmed.status).toBe("verified");
    expect(confirmed.extracted?.trailer).toMatchObject({ confidence: 1, source: "human" });
    // a failing model call is recorded on the document and the integration, and does not break the upload
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }));
    const d2 = await X.uploadDocument(a, c.id, { code: "doda", fileName: "doda.pdf", mimeType: "application/pdf", bytes: await pdf("doda") });
    const [failed] = await db.select().from(documents).where(eq(documents.id, d2.id));
    expect(failed.extractionNote).toMatch(/^failed: extractor 529: overloaded/);
    await expect(X.extractDocumentFields(a, d2.id)).rejects.toThrow(/529/);
    const [integ] = await db.select().from(integrations).where(eq(integrations.provider, "extractor"));
    expect(integ.lastError).toMatch(/overloaded/);
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

describe("Canada crossings", () => {
  const usToCa = [
    { type: "pickup" as const, name: "Shipper Detroit", country: "US" },
    { type: "delivery" as const, name: "Consignee Toronto", country: "CA" },
  ];
  it("US → Canada gets the Canadian checklist (PARS, ACI), not the Mexican or US-entry documents", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 150000, stops: usToCa, book: true });
    expect(o.legs.map((l) => l.type)).toEqual(["crossing"]);
    const [c] = await db.select().from(crossings).where(eq(crossings.legId, o.legs[0].id));
    expect([c.fromCountry, c.toCountry]).toEqual(["US", "CA"]);
    const codes = c.requirements.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["pars", "aci_emanifest", "bol", "invoice"]));
    for (const mx of ["carta_retiro", "carta_porte", "doda", "ace_manifest", "dtops", "entry"]) expect(codes).not.toContain(mx);
    expect(X.crossingStateLabel("in_us_customs", c)).toBe("In CA customs");
    expect(X.crossingStateLabel("at_mx_customs", c)).toBe("At US customs");
    expect(X.stepLabel("cleared", c)?.en).toBe("Cleared — on the CA side");
  });

  it("Canada → US needs the ACE manifest and no Canadian entry documents", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 150000, stops: [...usToCa].reverse().map((s, i) => ({ ...s, type: i === 0 ? ("pickup" as const) : ("delivery" as const) })), book: true });
    const [c] = await db.select().from(crossings).where(eq(crossings.legId, o.legs[0].id));
    const codes = c.requirements.map((r) => r.code);
    expect(codes).toContain("ace_manifest");
    expect(codes).not.toContain("pars");
    expect(codes).not.toContain("doda");
  });

  it("Mexico → US keeps the Mexican checklist and labels", async () => {
    const { c } = await crossingOrder();
    expect(c.requirements.map((r) => r.code)).toEqual(expect.arrayContaining(["carta_retiro", "doda", "ace_manifest"]));
    expect(c.requirements.map((r) => r.code)).not.toContain("pars");
    expect(X.crossingStateLabel("at_mx_customs", c)).toBe("At MX customs");
  });

  it("a company set up before Canada gets the Canadian rules added, keeping its own edits", async () => {
    await X.ensureDefaultRules(a);
    await db.update(crossingDocRules).set({ label: "DODA (ours)" }).where(and(eq(crossingDocRules.tenantId, a.tenantId), eq(crossingDocRules.code, "doda")));
    await db.delete(crossingDocRules).where(and(eq(crossingDocRules.tenantId, a.tenantId), eq(crossingDocRules.code, "pars")));
    expect(await X.ensureDefaultRules(a)).toBe(true);
    const rules = await db.select().from(crossingDocRules).where(eq(crossingDocRules.tenantId, a.tenantId));
    expect(rules.map((r) => r.code)).toContain("pars");
    expect(rules.find((r) => r.code === "doda")?.label).toBe("DODA (ours)");
    expect(rules.length).toBe(X.DEFAULT_CROSSING_RULES.length);
  });

  it("checks into Canada read the ACI eManifest and skip the Mexico- and US-only checks", () => {
    const docs = { aci_emanifest: { trailer: "10743", driver: "Benjamin Xochihua", usPlate: "RC59022", caPlate: "AB12345", submittedAt: "2026-09-27T10:00:00Z", estimatedArrival: "2026-09-27T10:20:00Z" }, bol: { trailer: "10743", seal: "S-1" } };
    const r = runChecksPure({ now: new Date(), docs, trailerNumber: "10743", truck: { ...truck, caPlate: "AB12345", dtopsYear: null, dtopsConfirmation: null, mxPlateExpires: past }, driver: { ...driver, mxLicenseExpires: past }, mxBrokerPatente: null, fromCountry: "US", toCountry: "CA" });
    const by = Object.fromEntries(r.map((x) => [x.code, x]));
    for (const code of ["dtops", "plate_class", "scac", "patente", "pedimento", "folio_fiscal"]) expect(by[code]).toBeUndefined();
    expect(by.expiry.state).toBe("pass"); // MX plate and licencia federal don't matter going to Canada
    expect(by.tractor_plates.state).toBe("pass");
    expect(by.driver.state).toBe("pass");
    expect(by.timing.state).toBe("fail");
    expect(by.timing.message).toContain("ACI eManifest");
  });
});
