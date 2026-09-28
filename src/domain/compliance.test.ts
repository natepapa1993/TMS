// Features: F-6 compliance — engine, subject documents, snooze, 24-h override, where it bites (assign picker), digest, incidents F-6.9 F-5.11
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update } from "@/data/records";
import { db } from "@/db/client";
import { outbox, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as C from "./compliance";
import { createOrder, planLeg, candidatesForLeg, EligibilityError, ValidationError } from "./orders";

const days = (n: number) => new Date(Date.now() + n * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let ids: { benja: string; t2117: string; medical: string; insurance: string; rxo: string; garza: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  const medical = await create(a, "documentType", { name: "Medical card", appliesTo: "driver", tracksExpiry: true, alertDays: [30, 7], required: true, blocksDispatch: true });
  const insurance = await create(a, "documentType", { name: "Insurance certificate", appliesTo: "carrier", tracksExpiry: true, alertDays: [30], required: true, blocksDispatch: true });
  await create(a, "documentType", { name: "Drug test consent", appliesTo: "driver", tracksExpiry: false, required: false, blocksDispatch: false });
  const t2117 = await create(a, "truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: days(200), mxPlateExpires: days(200), dotInspectionExpires: days(20) });
  const benja = await create(a, "driver", { name: "Benjamín Xochihua", driverType: "B1", mxLicenseExpires: days(400), fastExpires: days(400), i94Until: days(120), medicalExpires: days(300), licenseExpires: days(400), currentTruckId: t2117.id });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker" });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", caatExpires: days(100) });
  ids = { benja: benja.id, t2117: t2117.id, medical: medical.id, insurance: insurance.id, rxo: rxo.id, garza: garza.id };
});

const pdf = Buffer.from("%PDF-1.4 fixture");
/** Missing documents and dates, leaving out the qualification file (its own tests are in safety.test.ts). */
const docMissing = (st: { items: { key: string; status: string; label: string }[] }) => st.items.filter((i) => i.status === "missing" && !i.key.startsWith("dq:")).map((i) => i.label);

describe("engine (spec §6.1)", () => {
  it("a driver with no medical card document is missing it and blocked; uploading fixes it; expiring shows inside alert days", async () => {
    let st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(false);
    expect(docMissing(st)).toEqual(["Medical card"]);
    expect(st.items.find((i) => i.key === "field:i94Until")!.status).toBe("ok");
    expect(st.items.some((i) => i.key === "field:licenseExpires")).toBe(false); // B-1: US licence not applicable
    await expect(C.uploadSubjectDocument(a, "driver", ids.benja, { documentTypeId: ids.medical, fileName: "med.pdf", mimeType: "application/pdf", bytes: pdf })).rejects.toBeInstanceOf(ValidationError); // expiry required
    await C.uploadSubjectDocument(a, "driver", ids.benja, { documentTypeId: ids.medical, fileName: "med.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(20) });
    st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(true);
    expect(st.expiring).toEqual(["Medical card"]);
    // renewal supersedes; expired document blocks again
    await C.uploadSubjectDocument(a, "driver", ids.benja, { documentTypeId: ids.medical, fileName: "med2.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(-1) });
    st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(false);
    expect(st.expired).toEqual(["Medical card"]);
    const docs = await C.subjectDocuments(a, "driver", ids.benja);
    expect(docs.map((d) => d.status).sort()).toEqual(["present", "superseded"]);
    // wrong subject kind refused
    await expect(C.uploadSubjectDocument(a, "truck", ids.t2117, { documentTypeId: ids.medical, fileName: "x.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(1) })).rejects.toThrow(/applies to drivers/);
  });

  it("a renewal sent from the driver app counts for nothing until safety confirms it; rejected goes back to the driver with the reason", async () => {
    let st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(false);
    let own = await C.driverOwnItems(a.tenantId, ids.benja);
    const med = own.find((i) => i.documentTypeId === ids.medical)!;
    expect(med).toMatchObject({ label: "Medical card", status: "missing", tracksExpiry: true, pending: null, rejected: null });
    await expect(C.driverUploadRenewal(a.tenantId, ids.benja, { documentTypeId: ids.medical, fileName: "med.jpg", mimeType: "image/jpeg", bytes: pdf })).rejects.toBeInstanceOf(ValidationError); // expiry still required
    const sent = await C.driverUploadRenewal(a.tenantId, ids.benja, { documentTypeId: ids.medical, fileName: "med.jpg", mimeType: "image/jpeg", bytes: pdf, expiresAt: days(300) });
    expect(sent.status).toBe("pending");
    st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(false); // still blocked: nobody looked
    own = await C.driverOwnItems(a.tenantId, ids.benja);
    expect(own.find((i) => i.documentTypeId === ids.medical)!.pending?.fileName).toBe("med.jpg");
    const queue = await C.pendingUploads(a);
    expect(queue.map((q) => [q.driverName, q.typeName])).toEqual([["Benjamín Xochihua", "Medical card"]]);
    // sent back: blurry
    await expect(C.reviewSubjectDocument(a, sent.id, "reject", {})).rejects.toBeInstanceOf(ValidationError);
    await C.reviewSubjectDocument(a, sent.id, "reject", { reason: "blurry, take it in daylight" });
    own = await C.driverOwnItems(a.tenantId, ids.benja);
    expect(own.find((i) => i.documentTypeId === ids.medical)!.rejected?.reason).toBe("blurry, take it in daylight");
    expect((await C.pendingUploads(a)).length).toBe(0);
    await expect(C.reviewSubjectDocument(a, sent.id, "confirm", {})).rejects.toThrow(/rejected/);
    // second try, confirmed with a corrected expiry → on file, dispatchable
    const again = await C.driverUploadRenewal(a.tenantId, ids.benja, { documentTypeId: ids.medical, fileName: "med2.jpg", mimeType: "image/jpeg", bytes: pdf, expiresAt: days(300), number: "MED-9" });
    const ok = await C.reviewSubjectDocument(a, again.id, "confirm", { expiresAt: days(250) });
    expect(ok.status).toBe("verified");
    expect(ok.number).toBe("MED-9");
    st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(true);
    expect(st.items.find((i) => i.key === ids.medical)!.expiresAt!.slice(0, 10)).toBe(days(250).toISOString().slice(0, 10));
    expect((await C.driverOwnItems(a.tenantId, ids.benja)).some((i) => i.documentTypeId === ids.medical)).toBe(false);
    // a newer pending photo replaces an older unreviewed one; confirming supersedes the card on file
    const p1 = await C.driverUploadRenewal(a.tenantId, ids.benja, { documentTypeId: ids.medical, fileName: "p1.jpg", mimeType: "image/jpeg", bytes: pdf, expiresAt: days(700) });
    const p2 = await C.driverUploadRenewal(a.tenantId, ids.benja, { documentTypeId: ids.medical, fileName: "p2.jpg", mimeType: "image/jpeg", bytes: pdf, expiresAt: days(700) });
    const all = await C.subjectDocuments(a, "driver", ids.benja);
    expect(all.find((d) => d.id === p1.id)!.status).toBe("superseded");
    expect(all.find((d) => d.id === p2.id)!.status).toBe("pending");
    await C.reviewSubjectDocument(a, p2.id, "confirm", {});
    const after = await C.subjectDocuments(a, "driver", ids.benja);
    expect(after.filter((d) => d.status === "verified" || d.status === "present").map((d) => d.fileName)).toEqual(["p2.jpg"]);
  });

  it("truck: expiring inspection is yellow not a block; expired plate blocks and cannot be overridden", async () => {
    let st = await C.evaluateSubject(a, "truck", ids.t2117);
    expect(st.dispatchable).toBe(true);
    expect(st.expiring).toEqual(["Annual inspection"]);
    await update(a, "truck", ids.t2117, { mxPlateExpires: days(-2) });
    st = await C.evaluateSubject(a, "truck", ids.t2117);
    expect(st.dispatchable).toBe(false);
    expect(st.expired).toEqual(["MX plate"]);
    await expect(C.overrideDispatch(a, "truck", ids.t2117, "need it today")).rejects.toThrow(/legal document/);
  });

  it("grace period on a new rule prevents an instant block; snooze hides the alert with a reason", async () => {
    const dq = await create(a, "documentType", { name: "DQ file review", appliesTo: "driver", tracksExpiry: false, required: true, blocksDispatch: true, graceUntil: days(14) });
    let st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.missing).toContain("DQ file review");
    expect(st.items.find((i) => i.key === dq.id)!.blocksDispatch).toBe(false); // grace open
    await expect(C.snooze(a, "driver", ids.benja, dq.id, days(5), "")).rejects.toBeInstanceOf(ValidationError);
    await expect(C.snooze(a, "driver", ids.benja, dq.id, days(500), "x")).rejects.toBeInstanceOf(ValidationError);
    st = await C.snooze(a, "driver", ids.benja, dq.id, days(5), "renewal in progress");
    expect(st.items.find((i) => i.key === dq.id)!.status).toBe("snoozed");
    expect(st.missing).not.toContain("DQ file review");
  });

  it("owner override lets a blocked (non-legal) subject dispatch for 24 h and the picker says so", async () => {
    const o = await createOrder(a, { customerId: ids.rxo, rateTbd: true, stops: [{ type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }], template: "crossing_only", book: true });
    await C.evaluateSubject(a, "driver", ids.benja); // missing medical card → blocked
    let c = await candidatesForLeg(a, o.legs[0].id);
    expect(c[0].ok).toBe(false);
    expect(c[0].hardBlocked).toBe(false);
    expect(c[0].reason).toMatch(/Medical card missing/);
    await expect(planLeg(a, o.legs[0].id, { kind: "truck", truckId: ids.t2117, driverId: ids.benja })).rejects.toBeInstanceOf(EligibilityError);
    await expect(C.overrideDispatch({ ...a, role: "dispatcher" }, "driver", ids.benja, "card is in the truck, scan tonight")).rejects.toThrow(/permission/);
    const ov = await C.overrideDispatch(a, "driver", ids.benja, "card is in the truck, scan tonight");
    expect(ov.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    c = await candidatesForLeg(a, o.legs[0].id);
    expect(c[0].ok).toBe(true);
    expect(c[0].findings.map((f) => f.code)).toContain("compliance_override");
    const r = await planLeg(a, o.legs[0].id, { kind: "truck", truckId: ids.t2117, driverId: ids.benja });
    expect(r.leg.state).toBe("planned");
  });

  it("a rule scoped to some legs (FAST card: crossing only) blocks the crossing but not a US run; the safety board still lists it", async () => {
    await C.uploadSubjectDocument(a, "driver", ids.benja, { documentTypeId: ids.medical, fileName: "med.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(300) });
    await create(a, "documentType", { name: "FAST card", appliesTo: "driver", tracksExpiry: true, alertDays: [30], required: true, blocksDispatch: true, legScope: "crossing" });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: days(200), dotInspectionExpires: days(200) });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: days(400), medicalExpires: days(300), currentTruckId: t2104.id });
    await C.uploadSubjectDocument(a, "driver", reyes.id, { documentTypeId: ids.medical, fileName: "med.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(300) });
    const st = await C.evaluateSubject(a, "driver", reyes.id);
    expect(docMissing(st)).toEqual(["FAST card"]);
    expect(st.dispatchable).toBe(false); // the safety board: he has no FAST card on file
    expect(C.forLeg(st, "us").dispatchable).toBe(true);
    expect(docMissing({ items: st.items.filter((i) => C.scopeMatches(i.legScope, "domestic")) })).toEqual([]);
    expect(C.forLeg(st, "crossing").dispatchable).toBe(false);
    expect(C.scopeMatches("mx", "crossing")).toBe(true);
    expect(C.scopeMatches("us", "domestic")).toBe(true);
    expect(C.scopeMatches("crossing", "us")).toBe(false);
    const us = await createOrder(a, { customerId: ids.rxo, rateTbd: true, stops: [{ type: "pickup", name: "Laredo", country: "US" }, { type: "delivery", name: "Dallas", country: "US" }], book: true });
    const c = await candidatesForLeg(a, us.legs[0].id);
    const reyesRow = c.find((x) => x.driverId === reyes.id)!;
    expect(reyesRow.ok).toBe(true);
    expect(reyesRow.reason).not.toMatch(/FAST/);
    const r = await planLeg(a, us.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    expect(r.leg.state).toBe("planned");
    const x = await createOrder(a, { customerId: ids.rxo, rateTbd: true, stops: [{ type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }], template: "crossing_only", book: true });
    await expect(planLeg(a, x.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id })).rejects.toThrow(/FAST card missing/);
  });

  it("carrier without an insurance certificate cannot be tendered; with one it can", async () => {
    const o = await createOrder(a, { customerId: ids.rxo, rateTbd: true, stops: [{ type: "pickup", name: "MTY", country: "MX" }, { type: "border_yard", name: "Santa Fe", country: "MX" }], template: "mx_crossing", book: true }).catch(() => null);
    const o2 = o ?? (await createOrder(a, { customerId: ids.rxo, rateTbd: true, stops: [{ type: "pickup", name: "MTY", country: "MX" }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }], template: "mx_crossing", book: true }));
    await C.evaluateSubject(a, "carrier", ids.garza);
    const err = await planLeg(a, o2.legs[0].id, { kind: "carrier", carrierId: ids.garza }).catch((e) => e);
    expect(err).toBeInstanceOf(EligibilityError);
    expect(err.message).toMatch(/Insurance certificate missing/);
    await C.uploadSubjectDocument(a, "carrier", ids.garza, { documentTypeId: ids.insurance, fileName: "coi.pdf", mimeType: "application/pdf", bytes: pdf, expiresAt: days(200) });
    const r = await planLeg(a, o2.legs[0].id, { kind: "carrier", carrierId: ids.garza });
    expect(r.leg.state).toBe("planned");
  });

  it("dashboard tiles, CSV export, tenant isolation, and the daily digest", async () => {
    await C.evaluateAll(a);
    const d = await C.dashboard(a);
    expect(d.tiles.subjects).toBe(3);
    expect(d.tiles.blocked).toBe(2); // driver (medical) + carrier (insurance)
    expect(d.tiles.missing).toBe(2);
    expect(d.tiles.dq).toBe(1); // Benjamín's qualification file is empty
    const csv = C.dashboardCsv(d, "driver");
    expect(csv.split("\n")[0]).toContain("Medical card");
    expect(csv).toContain("Benjamín Xochihua");
    expect(csv).toContain("NO");
    const b = await makeTenant("B");
    expect((await C.dashboard(b)).tiles.subjects).toBe(0);
    await expect(C.statusFor(b, "driver", ids.benja)).rejects.toThrow(/not found/);
    // digest goes to owner/compliance users after 07:00 local, once a day
    await db.update(tenants).set({ timeZone: "Etc/UTC" }).where(eq(tenants.id, a.tenantId));
    const morning = new Date();
    morning.setUTCHours(8, 0, 0, 0);
    expect((await C.sendDigests(morning)).sent).toBeGreaterThanOrEqual(1);
    const mails = await db.select().from(outbox).where(eq(outbox.tenantId, a.tenantId));
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toMatch(/Compliance:/);
    expect(mails[0].body).toContain("Medical card missing");
    expect((await C.sendDigests(morning)).sent).toBe(0); // not twice
  });

  it("incidents register", async () => {
    await expect(C.saveIncident(a, null, { occurredAt: new Date(), description: "" })).rejects.toBeInstanceOf(ValidationError);
    const inc = await C.saveIncident(a, null, { occurredAt: new Date(), kind: "roadside_inspection", driverId: ids.benja, truckId: ids.t2117, description: "Level 2 inspection, no violations", location: "I-35 Laredo" });
    expect((await C.listIncidents(a)).length).toBe(1);
    await C.saveIncident(a, inc.id, { ...inc, status: "closed" });
    expect((await C.listIncidents(a))[0].status).toBe("closed");
    expect((await C.listIncidents(await makeTenant("C"))).length).toBe(0);
  });
});

describe("read a document before filing it", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("not connected says so; connected, the model's dates and number come back for the person to confirm; a failure is a reason, not a crash", async () => {
    const pdf = Buffer.from("%PDF-1.4 licence");
    expect(await C.readSubjectDocument(a, "driver", "Licencia federal", { fileName: "lic.pdf", mimeType: "application/pdf", bytes: pdf })).toMatchObject({ ran: false, reason: expect.stringMatching(/not connected/) });
    const { integrations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-ant-test" } });
    let prompt = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: { type: string; text?: string }[] }[] };
      prompt = body.messages[0].content.find((x) => x.type === "text")!.text!;
      return new Response(JSON.stringify({ model: "claude-sonnet-4-5", usage: { input_tokens: 500 }, content: [{ type: "tool_use", name: "record_fields", input: { holder: { value: "Benjamín Xochihua", confidence: 0.9 }, number: { value: "MX-0001", confidence: 0.95 }, issuedAt: { value: null, confidence: 0 }, expiresAt: { value: "2027-03-31T00:00:00Z", confidence: 0.85 } } }] }), { status: 200 });
    });
    const r = await C.readSubjectDocument(a, "driver", "Licencia federal", { fileName: "lic.pdf", mimeType: "application/pdf", bytes: pdf });
    expect(r).toMatchObject({ ran: true, model: "claude-sonnet-4-5", holder: { value: "Benjamín Xochihua" }, number: { value: "MX-0001" }, issuedAt: null, expiresAt: { value: "2027-03-31T00:00:00Z", confidence: 0.85 } });
    expect(prompt).toContain("Licencia federal");
    expect(prompt).toContain("Expiry date");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }));
    expect(await C.readSubjectDocument(a, "driver", "Licencia federal", { fileName: "lic.pdf", mimeType: "application/pdf", bytes: pdf })).toMatchObject({ ran: false, reason: expect.stringMatching(/529/) });
    const [integ] = await db.select().from(integrations).where(eq(integrations.tenantId, a.tenantId));
    expect(integ.lastError).toMatch(/529/);
  });
});
