// Features: F-25.2 F-25.3 F-25.4 F-25.7
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get } from "@/data/records";
import { parseDate } from "@/data/fields";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import * as S from "./safety";
import { repairInstant, oosReleaseNeedsReason, lookupViolation } from "./safety-rules";

// Safety round-2 retest fixes: same-day repair sign-off (N1), a reason to take an OOS finding off (N3), 393.9 (N11)

const DAY = 86400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { d1: string; t1: string; tr: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Round Two Carrier");
  await db.update(tenants).set({ timeZone: "America/Chicago" }).where(eq(tenants.id, a.tenantId));
  const t1 = await create(a, "truck", { unitNumber: "Q317", dotInspectionExpires: days(300) });
  const tr = await create(a, "trailer", { unitNumber: "Q5501", inspectionExpires: days(300) });
  const d1 = await create(a, "driver", { name: "Fernando Aguilar", driverType: "CDL", licenseState: "TX", licenseExpires: days(400), medicalExpires: days(400), hireDate: days(-100) });
  f = { d1: d1.id, t1: t1.id, tr: tr.id };
});

describe("same-day roadside repair sign-off (safety N1)", () => {
  // TX level 1 at 1:10 PM CDT; the mechanic fixes it on the spot
  const inspectedAt = new Date("2026-09-20T18:10:00Z");
  const brake = () => S.saveInspection(a, null, { inspectedAt, country: "US", jurisdiction: "TX", level: 1, truckId: f.t1, reportNumber: "TXQA2-0101", violations: [{ code: "393.47(e)", oos: true }] });

  it("'Repaired on' the inspection's day is accepted: signed off after the inspection, not at midnight before it", async () => {
    const i = await brake();
    const signed = await S.signOffRepair(a, i.id, { note: "brake adjusted at the scale", at: parseDate("2026-09-20"), dateOnly: true }, new Date("2026-09-20T20:30:00Z"));
    expect(signed.repair!.at).toBe("2026-09-20T20:30:00.000Z");
    expect((await get(a, "truck", f.t1)).status).toBe("active");
  });

  it("a repair time the same afternoon is accepted; before the inspection or tomorrow is refused", async () => {
    const i = await brake();
    const now = new Date("2026-09-20T21:00:00Z");
    await expect(S.signOffRepair(a, i.id, { note: "x", at: new Date("2026-09-20T17:00:00Z") }, now)).rejects.toThrow(/after the inspection/);
    await expect(S.signOffRepair(a, i.id, { note: "x", at: parseDate("2026-09-21"), dateOnly: true }, now)).rejects.toThrow(/in the future/);
    const ok = await S.signOffRepair(a, i.id, { note: "slack adjuster replaced", at: new Date("2026-09-20T19:45:00Z") }, now);
    expect(ok.repair!.at).toBe("2026-09-20T19:45:00.000Z");
  });

  it("repairInstant: a date alone on the inspection's day becomes now, or the inspection's time if now is later than a day", () => {
    const at = parseDate("2026-09-20")!;
    expect(repairInstant(at, inspectedAt, { dateOnly: true, sameDay: true, now: new Date("2026-09-20T19:00:00Z") }).toISOString()).toBe("2026-09-20T19:00:00.000Z");
    expect(repairInstant(at, inspectedAt, { dateOnly: true, sameDay: true, now: new Date("2026-09-25T19:00:00Z") }).toISOString()).toBe(inspectedAt.toISOString());
    expect(repairInstant(at, inspectedAt, { dateOnly: false, sameDay: true, now: new Date() })).toBe(at);
    expect(repairInstant(parseDate("2026-09-19")!, inspectedAt, { dateOnly: true, sameDay: false, now: new Date() }).toISOString().slice(0, 10)).toBe("2026-09-19");
  });
});

describe("taking an OOS finding off needs a reason (safety N3)", () => {
  const input = () => ({ inspectedAt: days(-0.2), country: "CA", jurisdiction: "ON", level: 2, truckId: f.t1, reportNumber: "ONQA2-0202", violations: [{ code: "NSC 11", description: "Brake out of adjustment", unit: "vehicle" as const, oos: true }] });

  it("unticking OOS on an edit is refused without a reason; with one the unit comes back and the overrides log says why", async () => {
    const i = await S.saveInspection(a, null, input());
    expect((await get(a, "truck", f.t1)).status).toBe("oos");
    const unticked = { ...input(), violations: [{ ...input().violations[0], oos: false }] };
    await expect(S.saveInspection(a, i.id, unticked)).rejects.toThrow(/Why is the out-of-service finding coming off/);
    expect((await get(a, "truck", f.t1)).status).toBe("oos");
    await S.saveInspection(a, i.id, { ...unticked, oosReleaseReason: "Data entry error — it wasn't OOS on the report" });
    expect((await get(a, "truck", f.t1)).status).toBe("active");
    const log = await S.overrideLog(a);
    expect(log[0]).toMatchObject({ kind: "paperwork", subject: "Inspection ON ONQA2-0202", reason: "Data entry error — it wasn't OOS on the report" });
    expect(log[0].what).toMatch(/removed without a repair \(unit Q317\)/);
  });

  it("deleting the violation or the whole inspection needs a reason too; editing other fields doesn't", async () => {
    const i = await S.saveInspection(a, null, input());
    await S.saveInspection(a, i.id, { ...input(), location: "Hwy 401 Windsor" }); // nothing released
    await expect(S.saveInspection(a, i.id, { ...input(), violations: [] })).rejects.toThrow(/Why/);
    await expect(S.deleteInspection(a, i.id)).rejects.toThrow(/Say why/);
    await S.deleteInspection(a, i.id, "Logged on the wrong truck");
    expect((await get(a, "truck", f.t1)).status).toBe("active");
    expect((await S.overrideLog(a))[0].reason).toBe("Logged on the wrong truck");
  });

  it("after a repair sign-off nothing is released, so no reason; a DataQs acceptance is its own reason", () => {
    const v = { code: "393.47(e)", description: "", basic: "vehicle" as const, severity: 4, oos: true, unit: "vehicle" as const };
    expect(oosReleaseNeedsReason({ violations: [v], repair: { at: "x" } }, { violations: [] }).released).toBe(false);
    expect(oosReleaseNeedsReason({ violations: [v] }, { violations: [{ ...v, removed: true }], dataQs: "accepted" })).toEqual({ released: true, defaultReason: "DataQs accepted — violation removed" });
    expect(oosReleaseNeedsReason({ violations: [v] }, { violations: [{ ...v, removed: true }], dataQs: "filed" })).toEqual({ released: true, defaultReason: null });
  });
});

describe("the violation table (safety N11)", () => {
  it("393.9 as typed finds the lamp violation", () => {
    expect(lookupViolation("393.9")).toMatchObject({ basic: "vehicle", severity: 6 });
    expect(lookupViolation("49 CFR 393.9")).toMatchObject({ severity: 6 });
    expect(lookupViolation("393.47")).toBeNull(); // several paragraphs with different weights: not guessed
  });
});
