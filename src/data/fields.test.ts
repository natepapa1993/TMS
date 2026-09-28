// Features: F-1.1 F-1.7
import { describe, it, expect } from "vitest";
import { FIELDS, KIND_META, coerce, fieldDisplay } from "./fields";
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
  it("a checkbox the quick-add did not show keeps the database default; a shown-but-empty one saves false; clearing on edit saves null", () => {
    const quick = coerce("ediPartner", { theirId: "RXO", customerId: "c1", theirQualifier: "ZZ", scac: "BSTW", ourId: "BSTW", usage: "T" });
    expect(quick.ok).toBe(true);
    expect("enabled" in quick.values).toBe(false);
    expect("send214" in quick.values).toBe(false);
    const full = coerce("ediPartner", { theirId: "RXO", customerId: "c1", theirQualifier: "ZZ", scac: "BSTW", ourId: "BSTW", usage: "T", enabled: "" });
    expect(full.values.enabled).toBe(false);
    const edit = coerce("customer", { detentionFreeMinutes: "" }, { partial: true });
    expect(edit.values.detentionFreeMinutes).toBeNull();
    const list = coerce("customer", { requiredDocs: "pod, rate con", reminderDays: "none" }, { partial: true });
    expect(list.values.requiredDocs).toEqual(["POD", "RATE_CON"]);
    expect(list.values.reminderDays).toEqual([]);
  });

  it("select options never repeat a value", () => {
    for (const k of kinds) for (const f of FIELDS[k]) if (f.options) expect(new Set(f.options.map((o) => o.value)).size).toBe(f.options.length);
  });

  it("a user's password is validated but never becomes a column; blank on edit keeps the current one", () => {
    const missing = coerce("user", { name: "Dee", email: "dee@x.test", role: "dispatcher" });
    expect(missing.errors.password).toMatch(/required/);
    const short = coerce("user", { name: "Dee", email: "dee@x.test", role: "dispatcher", password: "short" });
    expect(short.errors.password).toMatch(/10 characters/);
    const ok = coerce("user", { name: "Dee", email: "dee@x.test", role: "dispatcher", password: "long-enough-1" });
    expect(ok.ok).toBe(true);
    expect("password" in ok.values).toBe(false);
    const edit = coerce("user", { name: "Dee", password: "" }, { partial: true });
    expect(edit.ok).toBe(true);
    expect("password" in edit.values).toBe(false);
  });

  it("contacts: one per line, names required, emails checked; bridges keep their words; document codes are normalized", () => {
    const c = coerce("customer", { contacts: "Ana Ruiz | ops | ana@magna.test | +52 844 000 0000\nBob | | | +1 956 000 0000" }, { partial: true });
    expect(c.ok).toBe(true);
    expect(c.values.contacts).toEqual([{ name: "Ana Ruiz", role: "ops", email: "ana@magna.test", phone: "+52 844 000 0000", whatsapp: undefined }, { name: "Bob", role: undefined, email: undefined, phone: "+1 956 000 0000", whatsapp: undefined }]);
    expect(coerce("customer", { contacts: "Ana | ops | not-an-email" }, { partial: true }).errors.contacts).toMatch(/not a valid email/);
    expect(coerce("customer", { contacts: " | ops | a@b.co" }, { partial: true }).errors.contacts).toMatch(/needs a name/);
    expect(coerce("customer", { contacts: JSON.stringify([{ name: "Cy", email: "cy@x.test" }]) }, { partial: true }).values.contacts).toEqual([{ name: "Cy", email: "cy@x.test" }]);
    expect(fieldDisplay(FIELDS.customer.find((f) => f.name === "contacts")!, [{ name: "Ana", role: "ops", email: "a@b.co" }])).toBe("Ana | ops | a@b.co");
    expect(coerce("port", { bridges: "World Trade Bridge, Colombia Solidarity Bridge" }, { partial: true }).values.bridges).toEqual(["World Trade Bridge", "Colombia Solidarity Bridge"]);
    expect(coerce("customer", { requiredDocs: "pod, rate con" }, { partial: true }).values.requiredDocs).toEqual(["POD", "RATE_CON"]);
    expect(coerce("documentType", { alertDays: "30, 7" }, { partial: true }).values.alertDays).toEqual([30, 7]);
  });
});
