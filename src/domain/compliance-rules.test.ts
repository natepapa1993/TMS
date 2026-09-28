// Features: F-25.5 F-25.8 block levels per rule, plain reasons, new-rule grace, year-safe CSV dates, full history lines
import { describe, it, expect } from "vitest";
import type { ComplianceItem } from "@/db/schema";
import { rollup, levelOf, builtInLevel, documentTypeLevel, documentTypeFormLevel, withNewRuleGrace, syncDocumentTypeLevel, blockSentence, BUILT_IN_LEVELS } from "./compliance-rules";
import { periodStart } from "./safety-rules";
import { csvDate, parseDate, FIELDS } from "@/data/fields";
import { changeLines } from "@/data/history";

const item = (over: Partial<ComplianceItem>): ComplianceItem => ({ key: "t1", label: "Thing", status: "ok", underlying: null, expiresAt: null, documentId: null, blocksDispatch: true, required: true, alertDays: 30, ...over });

describe("block levels", () => {
  it("hard items make the block un-overridable; override-level ones can be waved through; warn never blocks", () => {
    const annual = item({ key: "field:dotInspectionExpires", label: "Annual inspection", status: "expired", level: "hard" });
    const irp = item({ key: "irp", label: "IRP cab card", status: "missing", level: "override" });
    const fast = item({ key: "field:fastExpires", label: "FAST card", status: "expired", level: "warn", blocksDispatch: false });
    expect(rollup([irp, fast])).toMatchObject({ dispatchable: false, hard: false, blockers: ["IRP cab card missing"] });
    expect(rollup([irp, annual])).toMatchObject({ dispatchable: false, hard: true, blockers: ["Annual inspection expired", "IRP cab card missing"] });
    expect(rollup([fast]).dispatchable).toBe(true);
  });
  it("a snooze never lifts a block; a graced rule never blocks and stays out of the reason", () => {
    const snoozed = item({ status: "snoozed", underlying: "expired", level: "override" });
    expect(rollup([snoozed]).dispatchable).toBe(false);
    const graced = item({ label: "IFTA licence", status: "missing", blocksDispatch: false, level: "warn", graceUntil: "2026-10-31T12:00:00Z" });
    expect(rollup([graced])).toMatchObject({ dispatchable: true, blockers: [] });
  });
  it("items stored before levels keep the old behaviour: an expired licence-like name is hard, a missing one overridable", () => {
    expect(levelOf(item({ label: "Medical card", status: "expired" }))).toBe("hard");
    expect(levelOf(item({ label: "Medical card", status: "missing" }))).toBe("override");
    expect(levelOf(item({ key: "da:status", label: "Safety hold", status: "expired" }))).toBe("hard");
    expect(levelOf(item({ label: "IRP cab card", status: "expired" }))).toBe("override");
  });
  it("built-ins: the law's items are fixed; the annual inspection defaults hard and the company may soften it", () => {
    expect(builtInLevel("field:licenseExpires", { "field:licenseExpires": "warn" })).toBe("hard");
    expect(builtInLevel("dq:pre_employment_test", { "dq:pre_employment_test": "override" })).toBe("hard");
    expect(builtInLevel("field:dotInspectionExpires", {})).toBe("hard");
    expect(builtInLevel("field:dotInspectionExpires", { "field:dotInspectionExpires": "override" })).toBe("override");
    expect(builtInLevel("field:caatExpires", {})).toBe("hard");
    expect(builtInLevel("field:fastExpires", {})).toBe("warn");
    expect(builtInLevel("dq:application", {})).toBe("override");
    expect(Object.entries(BUILT_IN_LEVELS).filter(([, v]) => v.fixed).map(([k]) => k)).toContain("da:status");
  });
  it("document rules: an explicit level wins; an older rule with none keeps its name-based behaviour until someone picks one", () => {
    expect(documentTypeLevel({ name: "IFTA licence & decal", blocksDispatch: true, blockLevel: "override" })).toBe("override");
    expect(documentTypeLevel({ name: "IFTA licence & decal", blocksDispatch: true, blockLevel: null })).toBeUndefined();
    expect(documentTypeFormLevel({ name: "IFTA licence & decal", blocksDispatch: true, blockLevel: null })).toBe("hard");
    expect(documentTypeLevel({ name: "Hazmat endorsement", blocksDispatch: false, blockLevel: "hard" })).toBe("warn");
    expect(syncDocumentTypeLevel({ blockLevel: "hard" })).toMatchObject({ blocksDispatch: true });
    expect(syncDocumentTypeLevel({ blockLevel: "warn" })).toMatchObject({ blocksDispatch: false });
  });
  it("a new blocking rule gets 14 days' grace unless a date was given; a warn-only rule needs none", () => {
    const now = new Date("2026-09-28T15:00:00Z");
    expect((withNewRuleGrace({ name: "IRP cab card", required: true, blockLevel: "override" }, now).graceUntil as Date).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    const given = new Date("2026-11-01T12:00:00Z");
    expect(withNewRuleGrace({ required: true, blockLevel: "hard", graceUntil: given }, now).graceUntil).toBe(given);
    expect(withNewRuleGrace({ required: true, blockLevel: "warn" }, now).graceUntil).toBeUndefined();
    // quick-add has no Required box: a new blocking rule gets the grace anyway, and so does one made required later
    expect((withNewRuleGrace({ required: false, blockLevel: "hard" }, now).graceUntil as Date).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect((withNewRuleGrace({ required: true, blockLevel: "override", graceUntil: null }, now, { required: false, blocksDispatch: true, blockLevel: "override", graceUntil: null }).graceUntil as Date).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(withNewRuleGrace({ blockLevel: "override" }, now, { required: false, blocksDispatch: false, blockLevel: "warn" }).graceUntil).toBeInstanceOf(Date);
    // a blocking rule whose date Safety clears is enforced now
    expect(withNewRuleGrace({ required: true, blockLevel: "hard", graceUntil: null }, now, { required: true, blocksDispatch: true, blockLevel: "hard", graceUntil: new Date("2026-10-01") }).graceUntil).toBeNull();
  });
  it("the sentence dispatch reads comes from the reasons, with a fallback for old stored rows", () => {
    expect(blockSentence({ blockers: ["On a safety hold — ask Safety"], expired: ["Safety hold"], missing: [] })).toBe("On a safety hold — ask Safety");
    expect(blockSentence({ expired: ["Licence"], missing: ["Road test"] })).toBe("Licence expired, Road test missing");
  });
});

describe("dates in and out of CSV", () => {
  it("exports YYYY-MM-DD with the year, and the importer reads it back to the same day", () => {
    const d = new Date(Date.UTC(2028, 4, 20, 12));
    expect(csvDate(d)).toBe("2028-05-20");
    expect(csvDate(null)).toBe("");
    expect(parseDate(csvDate(d))!.toISOString()).toBe(d.toISOString());
  });
  it("never reads a date without its year (the old export's 'Sat May 20' would have come back as 2001)", () => {
    expect(parseDate("Sat May 20")).toBeNull();
    expect(parseDate("May 20, 2028")!.toISOString()).toBe("2028-05-20T12:00:00.000Z");
    expect(parseDate("5/20/28")!.toISOString()).toBe("2028-05-20T12:00:00.000Z");
  });
  it("random periods start on the first of the quarter or month", () => {
    expect(periodStart("2026-Q4")!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodStart("2026-11")!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(periodStart("2026-13")).toBeNull();
    expect(periodStart("Q4")).toBeNull();
  });
});

describe("record history", () => {
  it("shows every changed field by its label and drops lines where nothing visibly changed", () => {
    const changes: Record<string, { from: unknown; to: unknown }> = {
      licenseNumber: { from: null, to: "TX123" },
      licenseExpires: { from: null, to: "2030-01-01T12:00:00.000Z" },
      medicalExpires: { from: "2026-10-09T12:00:00.000Z", to: "2028-10-05T12:00:00.000Z" },
      elpAttestedAt: { from: null, to: "2026-09-01T12:00:00.000Z" },
      fastNumber: { from: null, to: "F1" },
      fastExpires: { from: null, to: "2030-01-01T12:00:00.000Z" },
      licenseClass: { from: null, to: "A" },
      hireDate: { from: "2025-08-24T09:00:00.000Z", to: "2025-08-24T12:00:00.000Z" },
    };
    const lines = changeLines(changes, FIELDS.driver);
    expect(lines).toHaveLength(7);
    expect(lines).toContain("License expires: — → 2030-01-01");
    expect(lines).toContain("Medical card expires: 2026-10-09 → 2028-10-05");
    expect(lines.some((l) => l.startsWith("Hire date"))).toBe(false);
  });
});
