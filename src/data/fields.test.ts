// Features: F-1.1
import { describe, it, expect } from "vitest";
import { FIELDS, KIND_META } from "./fields";
import { REGISTRY, type RecordKind } from "./records";

// Invariants the screens rely on (spec §1.1 quick-add must always be able to save).
describe("field definitions", () => {
  const kinds = Object.keys(FIELDS) as RecordKind[];
  it("every required field is in the quick-add popup, so a quick add can never fail on a hidden field", () => {
    for (const k of kinds) for (const f of FIELDS[k]) if (f.required) expect(f.quick, `${k}.${f.name} is required but not quick`).toBe(true);
  });
  it("every kind has a quick-add set, list columns, a label field first, and meta", () => {
    for (const k of kinds) {
      expect(FIELDS[k].filter((f) => f.quick).length, k).toBeGreaterThan(0);
      expect(FIELDS[k].filter((f) => f.column).length, k).toBeGreaterThan(0);
      expect(FIELDS[k][0].name, k).toBe(REGISTRY[k].labelField === "id" ? FIELDS[k][0].name : REGISTRY[k].labelField);
      expect(KIND_META[k].path).toMatch(/^[a-z-]+$/);
    }
  });
  it("unique keys used for import de-dup exist as fields", () => {
    for (const k of kinds) for (const u of REGISTRY[k].uniqueKey) expect(FIELDS[k].some((f) => f.name === u), `${k}.${u}`).toBe(true);
  });
  it("select options never repeat a value", () => {
    for (const k of kinds) for (const f of FIELDS[k]) if (f.options) expect(new Set(f.options.map((o) => o.value)).size).toBe(f.options.length);
  });
});
