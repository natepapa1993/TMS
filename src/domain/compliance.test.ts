// Features: F-6 compliance — engine, subject documents, snooze, 24-h override, where it bites (assign picker), digest, incidents
import { describe, it, expect, beforeEach } from "vitest";
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

describe("engine (spec §6.1)", () => {
  it("a driver with no medical card document is missing it and blocked; uploading fixes it; expiring shows inside alert days", async () => {
    let st = await C.evaluateSubject(a, "driver", ids.benja);
    expect(st.dispatchable).toBe(false);
    expect(st.missing).toEqual(["Medical card"]);
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
    expect(st.missing).toEqual(["FAST card"]);
    expect(st.dispatchable).toBe(false); // the safety board: he has no FAST card on file
    expect(C.forLeg(st, "us").dispatchable).toBe(true);
    expect(C.forLeg(st, "domestic").missing).toEqual([]);
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
