// Features: F-25.6 F-25.8 built-in credentials renewed from the phone, confirmed by Safety onto the record, versions kept; history without no-op lines
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get, update, history } from "@/data/records";
import * as C from "./compliance";

const DAY = 86400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const noon = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
const jpg = Buffer.from("\xff\xd8\xff fixture");

let a: Awaited<ReturnType<typeof makeTenant>>;
let jorge: string;
let unit: string;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  unit = (await create(a, "truck", { unitNumber: "203", usPlate: "TX203", usPlateExpires: days(300), dotInspectionExpires: days(200) })).id;
  jorge = (await create(a, "driver", { name: "Jorge Villarreal", driverType: "CDL", licenseNumber: "TX1", licenseExpires: days(400), medicalExpires: days(11), currentTruckId: unit })).id;
});

describe("renewing a built-in credential from the phone (blockers 2 and 3)", () => {
  it("the driver sends the medical card; nothing changes until Safety confirms; confirming sets the date dispatch reads, keeps the image and the old version", async () => {
    const was = (await get(a, "driver", jorge)).medicalExpires as Date;
    let own = await C.driverOwnItems(a.tenantId, jorge);
    const med = own.find((i) => i.key === "field:medicalExpires")!;
    expect(med).toMatchObject({ label: "Medical card", status: "expiring", uploadKey: "field:medicalExpires", tracksExpiry: true, pending: null });
    await expect(C.driverUploadRenewal(a.tenantId, jorge, { uploadKey: med.uploadKey, fileName: "med.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toThrow(/when does it expire/);
    const sent = await C.driverUploadRenewal(a.tenantId, jorge, { uploadKey: med.uploadKey, fileName: "med.jpg", mimeType: "image/jpeg", bytes: jpg, expiresAt: days(700) });
    expect(sent.status).toBe("pending");
    expect(((await get(a, "driver", jorge)).medicalExpires as Date).toISOString()).toBe(was.toISOString()); // unchanged until Safety looks
    own = await C.driverOwnItems(a.tenantId, jorge);
    expect(own.find((i) => i.key === "field:medicalExpires")!.pending?.fileName).toBe("med.jpg");
    expect((await C.pendingUploads(a)).map((p) => [p.driverName, p.typeName])).toEqual([["Jorge Villarreal", "Medical card"]]);

    // a dispatcher can't confirm it; Safety can, fixing the date the driver typed
    await expect(C.reviewSubjectDocument({ ...a, role: "dispatcher" }, sent.id, "confirm", {})).rejects.toThrow(/permission/);
    const exp = noon(days(730));
    await C.reviewSubjectDocument({ ...a, role: "compliance" }, sent.id, "confirm", { expiresAt: exp });
    const d = await get(a, "driver", jorge);
    expect((d.medicalExpires as Date).toISOString()).toBe(exp.toISOString());
    const st = await C.statusFor(a, "driver", jorge);
    const item = st.items.find((i) => i.key === "field:medicalExpires")!;
    expect(item.status).toBe("ok");
    expect(item.documentId).toBe(sent.id); // the image is on the credential
    const hist = await history(a, "driver", jorge);
    expect(hist.some((h) => h.note?.includes("Medical card renewal from the driver app confirmed") && h.changes?.medicalExpires)).toBe(true);

    // next year's renewal: the old image is kept as an earlier version
    const again = await C.uploadCredential({ ...a, role: "compliance" }, "driver", jorge, "field:medicalExpires", { fileName: "med2.pdf", mimeType: "application/pdf", bytes: jpg, expiresAt: noon(days(720)) });
    const docs = await C.subjectDocuments(a, "driver", jorge);
    expect(docs.filter((x) => x.code === "field:medicalExpires").map((x) => [x.version, x.status]).sort()).toEqual([[1, "superseded"], [2, "present"]]);
    expect(again.version).toBe(2);
  });

  it("a rejected photo goes back to the driver with the reason; a licence confirm also takes the number", async () => {
    await update(a, "driver", jorge, { licenseExpires: days(-2) });
    const sent = await C.driverUploadRenewal(a.tenantId, jorge, { uploadKey: "field:licenseExpires", fileName: "cdl.jpg", mimeType: "image/jpeg", bytes: jpg, expiresAt: days(1500), number: "TX-NEW-9" });
    await C.reviewSubjectDocument(a, sent.id, "reject", { reason: "that's the old one — send the new card" });
    const own = await C.driverOwnItems(a.tenantId, jorge);
    expect(own.find((i) => i.key === "field:licenseExpires")).toMatchObject({ status: "expired", rejected: { reason: "that's the old one — send the new card" } });
    const second = await C.driverUploadRenewal(a.tenantId, jorge, { uploadKey: "field:licenseExpires", fileName: "cdl2.jpg", mimeType: "image/jpeg", bytes: jpg, expiresAt: days(1500), number: "TX-NEW-9" });
    await C.reviewSubjectDocument(a, second.id, "confirm", {});
    const d = await get(a, "driver", jorge);
    expect(d.licenseNumber).toBe("TX-NEW-9");
    expect((await C.statusFor(a, "driver", jorge)).dispatchable).toBe(true);
  });

  it("only Safety or the owner puts a credential on file from the desktop; an inspection report with its date sets the due date 12 months on", async () => {
    await expect(C.uploadCredential({ ...a, role: "dispatcher" }, "truck", unit, "field:dotInspectionExpires", { fileName: "insp.pdf", mimeType: "application/pdf", bytes: jpg, issuedAt: days(-3) })).rejects.toThrow(/permission/);
    await expect(C.uploadCredential(a, "truck", unit, "field:medicalExpires", { fileName: "x.pdf", mimeType: "application/pdf", bytes: jpg, expiresAt: days(10) })).rejects.toThrow(/no field:medicalExpires on a truck/);
    const inspected = noon(days(-3));
    await C.uploadCredential(a, "truck", unit, "field:dotInspectionExpires", { fileName: "annual.pdf", mimeType: "application/pdf", bytes: jpg, issuedAt: inspected });
    const t = await get(a, "truck", unit);
    const due = new Date(inspected);
    due.setUTCFullYear(due.getUTCFullYear() + 1);
    expect((t.dotInspectionExpires as Date).toISOString()).toBe(due.toISOString());
    const st = await C.statusFor(a, "truck", unit);
    expect(st.items.find((i) => i.key === "field:dotInspectionExpires")).toMatchObject({ label: "Annual inspection", status: "ok", level: "hard" });
    expect(st.items.find((i) => i.key === "field:dotInspectionExpires")!.documentId).toBeTruthy();
  });
});

describe("medical certificate dates", () => {
  it("a medical certificate is good for 24 months at most: a later date is refused on upload and on confirm", async () => {
    await expect(C.uploadCredential(a, "driver", jorge, "field:medicalExpires", { fileName: "m.pdf", mimeType: "application/pdf", bytes: jpg, expiresAt: days(800) })).rejects.toThrow(/24 months at most/);
    const sent = await C.driverUploadRenewal(a.tenantId, jorge, { uploadKey: "field:medicalExpires", fileName: "m.jpg", mimeType: "image/jpeg", bytes: jpg, expiresAt: days(700) });
    await expect(C.reviewSubjectDocument(a, sent.id, "confirm", { expiresAt: days(1000) })).rejects.toThrow(/24 months at most/);
  });
});

describe("record history", () => {
  it("re-saving a date on the same day is not a change (no 'hireDate: 2025-08-24 → 2025-08-24')", async () => {
    const hire = new Date("2025-08-24T09:13:00Z");
    await update(a, "driver", jorge, { hireDate: hire });
    const before = (await history(a, "driver", jorge)).length;
    await update(a, "driver", jorge, { hireDate: new Date("2025-08-24T12:00:00Z"), licenseClass: "A" });
    const h = await history(a, "driver", jorge);
    expect(h.length).toBe(before + 1);
    expect(Object.keys(h[0].changes ?? {})).toEqual(["licenseClass"]);
    expect(((await get(a, "driver", jorge)).hireDate as Date).toISOString()).toBe(hire.toISOString());
  });
});
