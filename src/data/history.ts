import type { Field } from "./fields";

/** One value as the history shows it: dates as YYYY-MM-DD, blanks as a dash. */
export function historyValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Every changed field of an audit entry as "Label: from → to", by the field's label, leaving out lines
 * where nothing visibly changed (a date re-saved on the same day).
 */
export function changeLines(changes: Record<string, { from: unknown; to: unknown }>, fields: Field[] = [], names?: Map<string, string>): string[] {
  const label = (k: string) => fields.find((f) => f.name === k)?.label ?? k;
  // owner N9: a broker by its name, an address as an address, a choice by its label — never an id or JSON
  const show = (k: string, v: unknown) => {
    const f = fields.find((x) => x.name === k);
    if (v == null || v === "") return "—";
    if (f?.type === "ref" && typeof v === "string" && names) return names.get(v) ?? "(removed record)";
    if (f?.type === "select" && typeof v === "string") return f.options?.find((o) => o.value === v)?.label ?? v;
    if (typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const a = v as Record<string, unknown>;
      if (["line1", "city", "state", "postalCode", "country"].some((x) => x in a)) return [a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter((x) => x != null && String(x).trim()).join(", ") || "—";
    }
    if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") || "—";
    return historyValue(v);
  };
  return Object.entries(changes)
    .map(([k, c]) => ({ k, from: show(k, c.from), to: show(k, c.to) }))
    .filter((x) => x.from !== x.to)
    .map((x) => `${label(x.k)}: ${x.from} → ${x.to}`);
}
