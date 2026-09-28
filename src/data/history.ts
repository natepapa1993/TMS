import { fieldDisplay, type Field } from "./fields";

/** One value as the history shows it: dates as YYYY-MM-DD, blanks as a dash. */
export function historyValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Columns that are not on the record screen but show up in the history, in words. */
const OTHER_LABELS: Record<string, string> = { status: "Status", oosReason: "Out-of-service reason", oosUntil: "Out of service until", oosInspectionId: "Roadside inspection", passwordHash: "Password", archivedAt: "Archived", lastLoginAt: "Last sign-in", blocksDispatch: "Blocks dispatch", driverApp: "Driver app", snooze: "Snooze", document: "Document" };
const STATUS_WORDS: Record<string, string> = { oos: "out of service", active: "active", inactive: "inactive" };
/** "oosReason" → "Oos reason": never a raw column name (safety N12). */
const humanize = (k: string) => OTHER_LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);

/**
 * Every changed field of an audit entry as "Label: from → to", by the field's label, leaving out lines
 * where nothing visibly changed (a date re-saved on the same day). A reference reads as the name it points to
 * ("Current unit: — → Q316", not the id), a pick-list value as its label, an address as one line.
 */
export function changeLines(changes: Record<string, { from: unknown; to: unknown }>, fields: Field[] = [], names?: Map<string, string>): string[] {
  const shown = (f: Field | undefined, k: string, v: unknown) => {
    if (v == null || v === "") return "—";
    if (f && ["ref", "select", "address", "cents", "list"].includes(f.type)) return fieldDisplay(f, v, names) || "—";
    if (!f && k === "status" && typeof v === "string") return STATUS_WORDS[v] ?? v;
    if (!f && k.endsWith("Id") && typeof v === "string") return names?.get(v) ?? v;
    return historyValue(v);
  };
  return Object.entries(changes)
    .map(([k, c]) => {
      const f = fields.find((x) => x.name === k);
      return { label: f?.label ?? humanize(k), from: shown(f, k, c.from), to: shown(f, k, c.to) };
    })
    .filter((x) => x.from !== x.to)
    .map((x) => `${x.label}: ${x.from} → ${x.to}`);
}
