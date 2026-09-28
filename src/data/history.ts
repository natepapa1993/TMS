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
export function changeLines(changes: Record<string, { from: unknown; to: unknown }>, fields: Field[] = []): string[] {
  const label = (k: string) => fields.find((f) => f.name === k)?.label ?? k;
  return Object.entries(changes)
    .map(([k, c]) => ({ k, from: historyValue(c.from), to: historyValue(c.to) }))
    .filter((x) => x.from !== x.to)
    .map((x) => `${label(x.k)}: ${x.from} → ${x.to}`);
}
