import type { ComplianceItem } from "@/db/schema";

/**
 * Pure compliance rules: how hard each rule blocks dispatch, what counts as a block, and the plain
 * sentence dispatch sees. No database here, so the engine, the picker, the planner and the tests share it.
 */

/** hard = nobody can override it; override = the owner or Safety can wave it through for 24 h with a reason; warn = shown, never blocks. */
export type BlockLevel = "hard" | "override" | "warn";
export const BLOCK_LEVELS: BlockLevel[] = ["hard", "override", "warn"];
export const BLOCK_LEVEL_LABEL: Record<BlockLevel, string> = {
  hard: "Blocks — nobody can override",
  override: "Blocks — owner or Safety can override",
  warn: "Warn only",
};

/**
 * The built-in items (dates on the record, the qualification file) and how hard each blocks by default.
 * `fixed` = the law decides, the company can't soften it: driving without a valid licence, medical
 * certificate, licencia federal or I-94, on an expired plate or CAAT, or before the pre-employment drug
 * test and the Clearinghouse full query (382.301, 382.701(a)) is never a judgement call.
 * The rest are the company's call: an annual inspection (396.17) is the law too but fleets track it
 * loosely, so it defaults to hard and can be relaxed; an application or road test that is on paper but
 * not yet recorded can be vouched for by the owner.
 */
export const BUILT_IN_LEVELS: Record<string, { label: string; kind: "Drivers" | "Trucks" | "Trailers" | "Carriers"; level: BlockLevel; fixed?: boolean; why: string }> = {
  "field:licenseExpires": { label: "Licence", kind: "Drivers", level: "hard", fixed: true, why: "391.11 / 383.23: no valid licence, no driving" },
  "field:medicalExpires": { label: "Medical card", kind: "Drivers", level: "hard", fixed: true, why: "391.41: no current medical certificate, no driving" },
  "field:mxLicenseExpires": { label: "Licencia federal", kind: "Drivers", level: "hard", fixed: true, why: "Licencia federal is the B-1 driver's licence" },
  "field:i94Until": { label: "I-94", kind: "Drivers", level: "hard", fixed: true, why: "Past the I-94 admit-until date the B-1 driver may not work in the US" },
  "field:fastExpires": { label: "FAST card", kind: "Drivers", level: "warn", why: "FAST is for the FAST lane; the crossing check still asks for it on FAST loads" },
  "field:usPlateExpires": { label: "US plate", kind: "Trucks", level: "hard", fixed: true, why: "Expired registration" },
  "field:mxPlateExpires": { label: "MX plate", kind: "Trucks", level: "hard", fixed: true, why: "Expired registration" },
  "field:caPlateExpires": { label: "Canadian plate", kind: "Trucks", level: "hard", fixed: true, why: "Expired registration" },
  "field:dotInspectionExpires": { label: "Annual inspection", kind: "Trucks", level: "hard", why: "396.17: no periodic inspection in the last 12 months, the unit may not run" },
  "field:inspectionExpires": { label: "Annual inspection", kind: "Trailers", level: "hard", why: "396.17: no periodic inspection in the last 12 months, the trailer may not run" },
  "field:caatExpires": { label: "CAAT", kind: "Carriers", level: "hard", fixed: true, why: "No CAAT, no crossing" },
  "field:sctPermitExpires": { label: "SCT permit", kind: "Carriers", level: "warn", why: "Company's call" },
  "field:ctpatExpires": { label: "C-TPAT", kind: "Carriers", level: "warn", why: "Company's call" },
  "field:autoLiabilityExpires": { label: "Auto liability insurance", kind: "Carriers", level: "override", why: "A stale certificate is often a renewal nobody uploaded: call the insurer, then override" },
  "field:cargoInsuranceExpires": { label: "Cargo insurance", kind: "Carriers", level: "warn", why: "Company's call" },
  "dq:application": { label: "Employment application", kind: "Drivers", level: "override", why: "391.21: the owner can vouch for a signed application not yet recorded" },
  "dq:road_test": { label: "Road test (or CDL in lieu)", kind: "Drivers", level: "override", why: "391.31: the owner can vouch for a road test or CDL in lieu not yet recorded" },
  "dq:clearinghouse_full": { label: "Clearinghouse full query", kind: "Drivers", level: "hard", fixed: true, why: "382.701(a): no safety-sensitive work before the full query" },
  "dq:pre_employment_test": { label: "Pre-employment drug test", kind: "Drivers", level: "hard", fixed: true, why: "382.301: no safety-sensitive work before a negative pre-employment drug test" },
  "da:status": { label: "Drug & alcohol hold", kind: "Drivers", level: "hard", fixed: true, why: "40.285 / 382.501: a positive or a refusal keeps the driver off until return-to-duty" },
};

/** The level a built-in item runs at: the law's where it's fixed, else the company's setting, else the default. */
export function builtInLevel(key: string, companyLevels?: Record<string, unknown> | null): BlockLevel {
  const def = BUILT_IN_LEVELS[key];
  if (!def) return "warn";
  if (def.fixed) return def.level;
  const set = companyLevels?.[key];
  return typeof set === "string" && (BLOCK_LEVELS as string[]).includes(set) ? (set as BlockLevel) : def.level;
}

/** Rules written before per-rule levels existed: the old name match decided which ones nobody could override. */
const LEGACY_HARD = /licen|medical|I-94|plate|Safety hold/i;

/**
 * A document rule's level: its setting. A blocking rule saved before the setting existed has none, and keeps
 * behaving as it did (undefined here → levelOf: hard only when expired and the name reads like a licence,
 * medical card, I-94 or plate; overridable otherwise) until someone picks a level for it.
 */
export function documentTypeLevel(t: { name: string; blocksDispatch: boolean; blockLevel?: string | null }): BlockLevel | undefined {
  if (!t.blocksDispatch || t.blockLevel === "warn") return "warn";
  if (t.blockLevel === "hard" || t.blockLevel === "override") return t.blockLevel;
  return undefined;
}

/** The level the rule form shows: its setting, or for an older rule the nearest one to how it behaved. */
export function documentTypeFormLevel(t: { name: string; blocksDispatch: boolean; blockLevel?: string | null }): BlockLevel {
  return documentTypeLevel(t) ?? (LEGACY_HARD.test(t.name) ? "hard" : "override");
}

const real = (i: ComplianceItem) => (i.status === "snoozed" ? (i.underlying ?? "ok") : i.status);

/** Built-in items: dates on the record and the qualification file (a blank one blocks only when told to). */
export const isBuiltIn = (key: string) => key.startsWith("field:") || key.startsWith("dq:");

/** The level an item blocks at (items stored before levels existed: expired legal documents were hard, the rest overridable). */
export function levelOf(i: ComplianceItem): BlockLevel {
  if (!i.blocksDispatch) return "warn";
  if (i.level) return i.level;
  return i.key === "da:status" || (LEGACY_HARD.test(i.label) && real(i) === "expired") ? "hard" : "override";
}

/** Does this item stop dispatch right now? A snooze never lifts a block; a graced rule never blocks. */
export function isBlocking(i: ComplianceItem) {
  if (levelOf(i) === "warn") return false;
  const r = real(i);
  if (r === "expired") return true;
  // a missing document someone requires always blocks; a blank built-in date only when the company says so (blocksWhenMissing)
  return r === "missing" && (!isBuiltIn(i.key) || !!i.blocksWhenMissing);
}

/** What dispatch reads: "Medical card expired", "Pre-employment drug test result not in", "On a safety hold — ask Safety". */
export function blockReason(i: ComplianceItem) {
  if (i.reason) return i.reason;
  return `${i.label} ${real(i) === "missing" ? "missing" : "expired"}`;
}

/** The lists, the dispatchable flag, whether anyone may override, and the plain reasons — from a set of items. */
export function rollup(items: ComplianceItem[]) {
  const expired = items.filter((i) => real(i) === "expired").map((i) => i.label);
  const expiring = items.filter((i) => i.status === "expiring").map((i) => i.label);
  const missing = items.filter((i) => i.status === "missing" || (i.status === "snoozed" && i.underlying === "missing" && i.blocksDispatch)).map((i) => i.label);
  const blocking = items.filter(isBlocking);
  const dispatchable = blocking.length === 0;
  // hard first: that's the reason nobody can wave it through
  const ordered = [...blocking].sort((p, q) => Number(levelOf(q) === "hard") - Number(levelOf(p) === "hard"));
  return { expired, expiring, missing, dispatchable, hard: blocking.some((i) => levelOf(i) === "hard"), blockers: ordered.map(blockReason) };
}

/** "Licence expired, Pre-employment drug test result not in" — or a fallback when an old stored row has no reasons. */
export function blockSentence(st: { blockers?: string[]; expired: string[]; missing: string[] }) {
  if (st.blockers?.length) return st.blockers.join(", ");
  return [...st.expired.map((x) => `${x} expired`), ...st.missing.map((x) => `${x} missing`)].join(", ") || "paperwork blocks dispatch";
}

/**
 * A new company starts with 30 days to enter its existing drivers' qualification files: blank hire
 * prerequisites show as missing without blocking until then (a pending pre-employment test still blocks).
 * Safety can end the grace early from the compliance board.
 */
export const DQ_GRACE_DAYS = 30;
export const newCompanySettings = (now = new Date()) => ({ dqGraceUntil: new Date(now.getTime() + DQ_GRACE_DAYS * 86400_000).toISOString() });

/** Keep the old on/off column in step with the level (other screens and exports read it). */
export function syncDocumentTypeLevel(values: Record<string, unknown>) {
  if (!("blockLevel" in values)) return values;
  const l = values.blockLevel;
  const level = l === "hard" || l === "override" || l === "warn" ? l : null;
  return { ...values, blockLevel: level, blocksDispatch: level === "hard" || level === "override" };
}

/**
 * A new rule that blocks, made in the rule form, gets 14 days' grace unless a date was given: adding
 * "IRP cab card" must not stop the whole fleet mid-shift (dispatch M21). Clearing the date enforces it now.
 */
export const NEW_RULE_GRACE_DAYS = 14;
export function withNewRuleGrace(values: Record<string, unknown>, now = new Date(), before?: Record<string, unknown> | null) {
  const v = syncDocumentTypeLevel(values);
  if (v.graceUntil) return v;
  const after = { ...(before ?? {}), ...v };
  const blocksNow = !!after.blocksDispatch;
  // a rule starts blocking when it's made blocking, or a blocking rule is made required (then a missing document blocks too)
  const starts = before ? (blocksNow && !before.blocksDispatch) || (blocksNow && !!after.required && !before.required) : blocksNow;
  if (!starts) return v;
  // a grace already running on the rule stays as it is
  if (before?.graceUntil && new Date(before.graceUntil as Date).getTime() > now.getTime() && !("graceUntil" in v)) return v;
  return { ...v, graceUntil: new Date(now.getTime() + NEW_RULE_GRACE_DAYS * 86400_000) };
}
