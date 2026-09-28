import type { ComplianceItem } from "@/db/schema";
import type { Violation } from "@/db/schema";
import { builtInLevel } from "./compliance-rules";

/**
 * Pure rules for the safety file: no database here, so the compliance engine and the pages share them
 * and the tests exercise them directly.
 */

const DAY = 86400_000;
const YEAR = 365 * DAY;

export const CA_PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];

export type DqDriver = { driverType: string; licenseState?: string | null; hireDate?: Date | string | null };

/** Where the driver's licence comes from: sets what the motor-vehicle record is called. */
export function licenceCountry(d: DqDriver): "US" | "CA" | "MX" {
  if (d.driverType === "B1") return "MX";
  if (d.licenseState && CA_PROVINCES.includes(d.licenseState.toUpperCase())) return "CA";
  return "US";
}

export type DqItemDef = {
  key: string;
  label: (d: DqDriver) => string;
  cite: string;
  /** once = done at hire; annual = every 12 months; within30 = within 30 days of hire */
  cadence: "once" | "annual" | "within30";
  /** a prerequisite to driving: blocks dispatch (missing blocks only with the company's "missing dates block" switch) */
  blocks: boolean;
  hint: string;
};

const mvr = (d: DqDriver) => ({ US: "MVR", CA: "Driver's abstract", MX: "LIFIS record (licencia federal)" })[licenceCountry(d)];

/** The driver qualification file, 49 CFR 391.51 plus the Clearinghouse queries (382.701). Drivers of every licence country run in the US, so all of it applies. */
export const DQ_ITEMS: DqItemDef[] = [
  { key: "application", label: () => "Employment application", cite: "391.21", cadence: "once", blocks: true, hint: "Signed, with 3 years of employers (10 for CDL drivers) and every licence held." },
  { key: "mvr_hire", label: (d) => `${mvr(d)} at hire`, cite: "391.23(a)(1)", cadence: "within30", blocks: false, hint: "Within 30 days of hire, from every state, province or country the driver held a licence in during the last 3 years." },
  { key: "road_test", label: () => "Road test certificate (or CDL in lieu)", cite: "391.31 / 391.33", cadence: "once", blocks: true, hint: "Certificate of road test, or a copy of the CDL accepted in place of it." },
  { key: "clearinghouse_full", label: () => "Clearinghouse full query (pre-employment)", cite: "382.701(a)", cadence: "once", blocks: true, hint: "With the driver's electronic consent in the Clearinghouse, before the first safety-sensitive work." },
  { key: "pre_employment_test", label: () => "Pre-employment drug test (negative)", cite: "382.301", cadence: "once", blocks: true, hint: "Filled from the drug & alcohol program; record an exception here if 382.301(b) applies." },
  { key: "prior_employers", label: () => "Previous employers' safety history (3 years)", cite: "391.23(a)(2)", cadence: "within30", blocks: false, hint: "Due within 30 days of hire; keep the responses, or proof of a good-faith effort." },
  { key: "mvr_annual", label: (d) => `Annual ${mvr(d)}`, cite: "391.25(a)", cadence: "annual", blocks: false, hint: "At least once every 12 months." },
  { key: "annual_review", label: () => "Annual review of driving record", cite: "391.25(b)", cadence: "annual", blocks: false, hint: "The reviewer's name and date, on the annual record." },
  { key: "clearinghouse_annual", label: () => "Clearinghouse limited query (annual)", cite: "382.701(b)", cadence: "annual", blocks: false, hint: "At least once every 12 months (a full query also counts)." },
];

export type DqRecordLike = { itemKey: string; completedAt: Date | string | null; notRequired: boolean; note?: string | null; createdAt: Date | string; documentId?: string | null };
export type DqLine = { key: string; label: string; cite: string; hint: string; cadence: DqItemDef["cadence"]; blocks: boolean; status: ComplianceItem["status"]; completedAt: string | null; dueAt: string | null; notRequired: boolean; note: string | null; documentId: string | null };

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Status of every DQ item from the records (latest counts) and, for the pre-employment test, the D&A tests. */
export function dqLines(d: DqDriver, records: DqRecordLike[], preEmploymentNegativeAt: Date | string | null, now = new Date()): DqLine[] {
  const hire = d.hireDate ? new Date(d.hireDate) : null;
  return DQ_ITEMS.map((def) => {
    const recs = records.filter((r) => r.itemKey === def.key).sort((p, q) => new Date(q.createdAt).getTime() - new Date(p.createdAt).getTime());
    const latest = recs[0] ?? null;
    let done: Date | null = latest && !latest.notRequired && latest.completedAt ? new Date(latest.completedAt) : null;
    if (def.key === "pre_employment_test" && preEmploymentNegativeAt && (!done || new Date(preEmploymentNegativeAt) > done)) done = new Date(preEmploymentNegativeAt);
    // the annual query can be met by a newer full query
    if (def.key === "clearinghouse_annual") {
      const full = records.filter((r) => r.itemKey === "clearinghouse_full" && r.completedAt && !r.notRequired).map((r) => new Date(r.completedAt!));
      for (const f of full) if (!done || f > done) done = f;
    }
    const base = { key: def.key, label: def.label(d), cite: def.cite, hint: def.hint, cadence: def.cadence, blocks: def.blocks, notRequired: !!latest?.notRequired && !(def.key === "pre_employment_test" && preEmploymentNegativeAt), note: latest?.note ?? null, documentId: latest?.documentId ?? null, completedAt: iso(done) };
    if (base.notRequired) return { ...base, status: "ok" as const, dueAt: null };
    if (def.cadence === "once") return { ...base, status: done ? ("ok" as const) : ("missing" as const), dueAt: null };
    if (def.cadence === "within30") {
      if (done) return { ...base, status: "ok" as const, dueAt: null };
      if (!hire) return { ...base, status: "missing" as const, dueAt: null };
      const due = new Date(hire.getTime() + 30 * DAY);
      return { ...base, status: due < now ? ("expired" as const) : ("expiring" as const), dueAt: due.toISOString() };
    }
    // annual: 12 months from the last one, or from hire when there is none yet
    const from = done ?? hire;
    if (!from) return { ...base, status: "missing" as const, dueAt: null };
    const due = new Date(from.getTime() + YEAR);
    const status = due < now ? "expired" : due.getTime() < now.getTime() + 30 * DAY ? "expiring" : "ok";
    return { ...base, status: status as ComplianceItem["status"], dueAt: due.toISOString() };
  });
}

/**
 * The DQ lines as compliance items (key dq:<item>). The hire prerequisites (●) block dispatch whether or
 * not the company blocks on blank dates: a driver without them is not qualified to drive (391.11, 382.301,
 * 382.701(a)). During the company's qualification-file grace period they block only with the blank-dates
 * switch, as before. A pre-employment test collected but not back yet reads "result not in".
 */
export function dqComplianceItems(lines: DqLine[], opts: { levels?: Record<string, unknown> | null; graceUntil?: Date | null; strictMissing?: boolean; preEmploymentPending?: boolean } = {}): ComplianceItem[] {
  return lines.map((l) => {
    const key = `dq:${l.key}`;
    const level = l.blocks ? builtInLevel(key, opts.levels) : "warn";
    const blocks = level !== "warn";
    const reason =
      l.key === "pre_employment_test" && l.status === "missing"
        ? opts.preEmploymentPending
          ? "Pre-employment drug test result not in"
          : "No pre-employment drug test"
        : l.key === "clearinghouse_full" && l.status === "missing"
          ? "No Clearinghouse pre-employment query"
          : null;
    // a test collected and waiting is a hire in progress: it blocks even while the company's grace runs
    const inProgress = l.key === "pre_employment_test" && !!opts.preEmploymentPending;
    const graced = !!opts.graceUntil && !opts.strictMissing && !inProgress;
    return { key, label: l.label, status: l.status, underlying: null, blocksWhenMissing: blocks && !graced, expiresAt: l.dueAt, documentId: l.documentId, blocksDispatch: blocks, level, reason, graceUntil: blocks && graced && l.status === "missing" ? opts.graceUntil!.toISOString() : null, required: true, alertDays: 30 };
  });
}

// ---------- drug & alcohol ----------

export const REASON_LABEL: Record<string, string> = { pre_employment: "Pre-employment", random: "Random", post_accident: "Post-accident", reasonable_suspicion: "Reasonable suspicion", return_to_duty: "Return to duty", follow_up: "Follow-up" };
export const RESULT_LABEL: Record<string, string> = { selected: "Selected — not collected yet", pending: "Collected — waiting for result", negative: "Negative", negative_dilute: "Negative-dilute", positive: "Positive (verified)", refusal: "Refusal to test", cancelled: "Cancelled" };

export type DaTestLike = { id: string; driverId: string; reason: string; substance: string; result: string; collectedAt: Date | string | null; resultAt: Date | string | null; selectedAt?: Date | string | null; followUpPlanned?: number | null; clearinghouseReportedAt?: Date | string | null; incidentId?: string | null };

const at = (t: DaTestLike) => new Date(t.resultAt ?? t.collectedAt ?? t.selectedAt ?? 0).getTime();

/**
 * A driver with a verified positive or a refusal may not do safety-sensitive work until the return-to-duty
 * process ends with a negative return-to-duty test (49 CFR 40.285, 382.501–503).
 */
export function daStanding<T extends DaTestLike>(tests: T[]) {
  const sorted = [...tests].sort((p, q) => at(p) - at(q));
  const violation = [...sorted].reverse().find((t) => t.result === "positive" || t.result === "refusal") ?? null;
  const rtd = violation ? (sorted.find((t) => t.reason === "return_to_duty" && ["negative", "negative_dilute"].includes(t.result) && at(t) > at(violation)) ?? null) : null;
  const prohibited = !!violation && !rtd;
  const followUps = rtd ? sorted.filter((t) => t.reason === "follow_up" && at(t) > at(rtd) && t.result !== "cancelled" && t.result !== "selected" && t.result !== "pending") : [];
  const preEmployment = sorted.find((t) => t.reason === "pre_employment" && t.substance === "drug" && ["negative", "negative_dilute"].includes(t.result)) ?? null;
  // collected (or ordered) and waiting: a pending result is not a negative one
  const preEmploymentPending = !preEmployment && sorted.some((t) => t.reason === "pre_employment" && t.substance === "drug" && (t.result === "pending" || t.result === "selected"));
  return {
    prohibited,
    violation,
    rtd,
    followUp: rtd?.followUpPlanned ? { done: followUps.length, planned: rtd.followUpPlanned } : null,
    preEmploymentNegativeAt: preEmployment ? new Date(preEmployment.resultAt ?? preEmployment.collectedAt ?? 0).toISOString() : null,
    preEmploymentPending,
  };
}

/** The compliance item for D&A: a neutral label, because dispatch sees it and the reason is confidential. */
export function daComplianceItem(prohibited: boolean): ComplianceItem {
  return { key: "da:status", label: "Safety hold", status: prohibited ? "expired" : "ok", underlying: null, expiresAt: null, documentId: null, blocksDispatch: true, level: "hard", reason: "On a safety hold — ask Safety", required: true, alertDays: 0 };
}

/** What the employer itself must report to the Clearinghouse (382.705(b)): alcohol ≥ 0.04, refusals, and the negative return-to-duty result. The MRO reports verified drug positives. */
export function clearinghouseDuty(t: DaTestLike): string | null {
  if (t.result === "refusal") return "Report the refusal to the Clearinghouse within 3 business days";
  if (t.result === "positive" && t.substance === "alcohol") return "Report the alcohol result (0.04 or more) to the Clearinghouse within 3 business days";
  if (t.reason === "return_to_duty" && ["negative", "negative_dilute"].includes(t.result)) return "Report the negative return-to-duty result to the Clearinghouse";
  return null;
}

/** Random tests required for a year: the annual rate × the average pool across the year's draws (382.305). */
export function randomRequirement(draws: { poolSize: number; drugRate: number; alcoholRate: number }[]) {
  if (!draws.length) return { avgPool: 0, drug: 0, alcohol: 0 };
  const avgPool = draws.reduce((a, d) => a + d.poolSize, 0) / draws.length;
  const rate = (k: "drugRate" | "alcoholRate") => Math.max(...draws.map((d) => d[k])) / 100;
  return { avgPool, drug: Math.ceil(avgPool * rate("drugRate")), alcohol: Math.ceil(avgPool * rate("alcoholRate")) };
}

/** How many to pick in one draw: the annual rate spread over the year's draws, rounded up. */
export const perDraw = (pool: number, ratePct: number, drawsPerYear: number) => (pool === 0 || ratePct === 0 ? 0 : Math.min(pool, Math.ceil((pool * ratePct) / 100 / drawsPerYear)));

/** When a random period starts: 2026-Q4 → Oct 1, 2026; 2026-11 → Nov 1, 2026 (UTC). */
export function periodStart(period: string): Date | null {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) return new Date(Date.UTC(+q[1], (+q[2] - 1) * 3, 1));
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m && +m[2] >= 1 && +m[2] <= 12) return new Date(Date.UTC(+m[1], +m[2] - 1, 1));
  return null;
}

/** Pick n distinct items with a random source (crypto in the app, seeded in tests). */
export function pick<T>(pool: T[], n: number, rand: (max: number) => number): T[] {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

/**
 * Post-accident testing (382.303): after a fatality, always; otherwise when the driver was cited and
 * someone was treated away from the scene or a vehicle was towed. Alcohol within 8 hours, drugs within 32.
 */
export function postAccidentDuty(inc: { kind: string; occurredAt: Date | string; fatality?: boolean; citation?: boolean; injuries?: boolean; towAway?: boolean }) {
  if (inc.kind !== "accident") return null;
  const required = !!inc.fatality || (!!inc.citation && (!!inc.injuries || !!inc.towAway));
  if (!required) return null;
  const t = new Date(inc.occurredAt).getTime();
  return { alcoholBy: new Date(t + 8 * 3600_000).toISOString(), alcoholIdeal: new Date(t + 2 * 3600_000).toISOString(), drugBy: new Date(t + 32 * 3600_000).toISOString(), why: inc.fatality ? "a fatality" : `a citation with ${inc.injuries ? "an injury treated away from the scene" : "a tow-away"}` };
}

// ---------- roadside inspections & the BASICs ----------

export const BASICS = [
  { key: "unsafe", label: "Unsafe Driving", norm: "power" },
  { key: "hos", label: "HOS Compliance", norm: "driver" },
  { key: "fitness", label: "Driver Fitness", norm: "driver" },
  { key: "substances", label: "Controlled Substances/Alcohol", norm: "driver" },
  { key: "vehicle", label: "Vehicle Maintenance", norm: "vehicle" },
  { key: "hm", label: "Hazardous Materials Compliance", norm: "hm" },
  { key: "crash", label: "Crash Indicator", norm: "power" },
] as const;
export type BasicKey = (typeof BASICS)[number]["key"];

/** The BASIC a violation falls in, from its CFR part (the person can change it; SMS has a few exceptions). */
export function basicOf(code: string): Violation["basic"] | null {
  const c = code.trim().replace(/^49\s*CFR\s*/i, "");
  const m = /^(\d{3})(?:\.(\d+))?/.exec(c);
  if (!m) return null;
  const part = Number(m[1]);
  const sec = m[2] ? Number(m[2]) : null;
  if (part === 392 && (sec === 4 || sec === 5)) return "substances";
  if (part === 382) return "substances";
  if (part === 392) return "unsafe";
  if (part === 395) return "hos";
  if (part === 391 || part === 383) return "fitness";
  if (part === 393 || part === 396) return "vehicle";
  if (part === 397 || (part >= 171 && part <= 180)) return "hm";
  return null;
}

/**
 * Common US violations with their SMS severity weight (Appendix A of the SMS methodology), so the weight
 * isn't typed from memory. The person can change any of it; codes not here are typed as before.
 */
export const VIOLATION_CODES: { code: string; description: string; basic: NonNullable<Violation["basic"]>; severity: number }[] = [
  { code: "392.2-SLLS2", description: "Speeding 6–10 mph over the limit", basic: "unsafe", severity: 4 },
  { code: "392.2-SLLS3", description: "Speeding 11–14 mph over the limit", basic: "unsafe", severity: 7 },
  { code: "392.2-SLLS4", description: "Speeding 15 or more mph over the limit", basic: "unsafe", severity: 10 },
  { code: "392.2-SLLSWZ", description: "Speeding in a work zone", basic: "unsafe", severity: 10 },
  { code: "392.2FC", description: "Following too close", basic: "unsafe", severity: 5 },
  { code: "392.2LC", description: "Improper lane change", basic: "unsafe", severity: 5 },
  { code: "392.2C", description: "Failure to obey a traffic control device", basic: "unsafe", severity: 5 },
  { code: "392.16", description: "Failing to use a seat belt", basic: "unsafe", severity: 7 },
  { code: "392.80(a)", description: "Texting while driving", basic: "unsafe", severity: 10 },
  { code: "392.82(a)(1)", description: "Using a hand-held phone while driving", basic: "unsafe", severity: 10 },
  { code: "392.4(a)", description: "Driver uses or is in possession of drugs", basic: "substances", severity: 10 },
  { code: "392.5(a)", description: "Alcohol within 4 hours of duty / possession", basic: "substances", severity: 5 },
  { code: "395.3(a)(1)", description: "Driving beyond the 11-hour limit", basic: "hos", severity: 7 },
  { code: "395.3(a)(2)", description: "Driving beyond the 14-hour window", basic: "hos", severity: 7 },
  { code: "395.3(a)(3)(ii)", description: "30-minute break not taken", basic: "hos", severity: 7 },
  { code: "395.3(b)", description: "Driving beyond the 60/70-hour limit", basic: "hos", severity: 7 },
  { code: "395.8(a)", description: "No record of duty status (ELD) when required", basic: "hos", severity: 5 },
  { code: "395.8(e)", description: "False report of the record of duty status", basic: "hos", severity: 7 },
  { code: "395.8(f)(1)", description: "Record of duty status not current", basic: "hos", severity: 5 },
  { code: "395.8(k)(2)", description: "Previous 7 days' records not kept", basic: "hos", severity: 5 },
  { code: "383.23(a)(2)", description: "Operating a CMV without a valid CDL", basic: "fitness", severity: 8 },
  { code: "391.11(b)(2)", description: "Driver can't read or speak English sufficiently", basic: "fitness", severity: 4 },
  { code: "391.41(a)", description: "No medical certificate in the driver's possession", basic: "fitness", severity: 1 },
  { code: "391.45(b)", description: "Expired medical certificate", basic: "fitness", severity: 1 },
  { code: "393.9", description: "Inoperable required lamp", basic: "vehicle", severity: 6 },
  { code: "393.9(a)", description: "Inoperable required lamp", basic: "vehicle", severity: 6 },
  { code: "393.9H", description: "Inoperable head lamps", basic: "vehicle", severity: 6 },
  { code: "393.9T", description: "Inoperable tail lamp", basic: "vehicle", severity: 6 },
  { code: "393.9TS", description: "Inoperative turn signal", basic: "vehicle", severity: 6 },
  { code: "393.11", description: "Lamps or reflective devices missing / not as required", basic: "vehicle", severity: 3 },
  { code: "393.45", description: "Brake hose or tubing damaged", basic: "vehicle", severity: 4 },
  { code: "393.47(e)", description: "Clamp or roto-chamber brake out of adjustment", basic: "vehicle", severity: 4 },
  { code: "393.48(a)", description: "Inoperative or defective brakes", basic: "vehicle", severity: 4 },
  { code: "393.75(a)", description: "Flat tire or fabric exposed", basic: "vehicle", severity: 8 },
  { code: "393.75(c)", description: "Tire tread depth less than 2/32 inch", basic: "vehicle", severity: 8 },
  { code: "393.95(a)", description: "No or discharged fire extinguisher", basic: "vehicle", severity: 2 },
  { code: "393.100(b)", description: "Cargo not secured against shifting", basic: "vehicle", severity: 7 },
  { code: "396.3(a)(1)", description: "Inspection, repair and maintenance of parts and accessories", basic: "vehicle", severity: 4 },
  { code: "396.17(c)", description: "No periodic (annual) inspection", basic: "vehicle", severity: 4 },
];

/** The violation for a code as typed on the report ("49 CFR 393.47(e)", "393.47E"), or null. */
export function lookupViolation(code: string) {
  const norm = (c: string) => c.trim().replace(/^49\s*CFR\s*/i, "").replace(/\s+/g, "").toUpperCase();
  const c = norm(code);
  if (!c) return null;
  return VIOLATION_CODES.find((v) => norm(v.code) === c || norm(v.code).replace(/[()]/g, "") === c.replace(/[()]/g, "")) ?? null;
}

/** Driver-side or vehicle-side, for the OOS rates. */
export const unitOf = (basic: Violation["basic"]): Violation["unit"] => (basic === "vehicle" || basic === "hm" ? "vehicle" : "driver");

/** What an inspection's out-of-service findings take off the road: the truck, the trailer, the driver. */
export function roadsideOos(i: { violations: Violation[]; truckId?: string | null; trailerId?: string | null; driverId?: string | null }) {
  const live = i.violations.filter((v) => v.oos && !v.removed);
  const vehicle = live.filter((v) => v.unit === "vehicle");
  const onOf = (v: Violation) => v.on ?? (i.truckId ? "truck" : "trailer");
  return {
    truck: i.truckId ? vehicle.filter((v) => onOf(v) === "truck") : [],
    trailer: i.trailerId ? vehicle.filter((v) => onOf(v) === "trailer") : [],
    driver: i.driverId ? live.filter((v) => v.unit === "driver") : [],
  };
}

/** Out-of-service findings still in force on an inspection (ticked OOS, not removed). */
export const liveOos = (vs: Violation[]) => vs.filter((v) => v.oos && !v.removed);

/**
 * Whether an edit takes an out-of-service finding away (unticked, removed, deleted) from an inspection whose
 * repair was never signed off: that puts a unit or driver back to work without a repair, so it needs a reason
 * on the record (safety N3). A DataQs acceptance is its own reason.
 */
export function oosReleaseNeedsReason(before: { violations: Violation[]; repair?: unknown }, after: { violations: Violation[]; dataQs?: string | null }) {
  if (before.repair) return { released: false, defaultReason: null };
  const was = liveOos(before.violations);
  const now = liveOos(after.violations);
  const key = (v: Violation) => `${v.code}|${v.unit}|${v.on ?? ""}`;
  const still = new Set(now.map(key));
  const gone = was.filter((v) => !still.has(key(v)));
  if (!gone.length && now.length >= was.length) return { released: false, defaultReason: null };
  // every finding that went away was marked "removed" and the DataQ was accepted: that is the reason
  const viaDataQs = after.dataQs === "accepted" && gone.every((g) => after.violations.some((v) => key(v) === key(g) && v.removed));
  return { released: true, defaultReason: viaDataQs ? "DataQs accepted — violation removed" : null };
}

/**
 * When a repair after an out-of-service order was done. A date alone (the form's day, noon UTC) on the day of the
 * inspection means that day, after the inspection: a same-day roadside repair is signed off at the inspection's
 * time or now, whichever is later (safety N1). A date and time is taken as given.
 */
export function repairInstant(at: Date, inspectedAt: Date, opts: { dateOnly: boolean; sameDay: boolean; now: Date }) {
  if (!opts.dateOnly || at.getTime() >= inspectedAt.getTime() || !opts.sameDay) return at;
  return opts.now.getTime() > inspectedAt.getTime() && opts.now.getTime() - inspectedAt.getTime() < 86400_000 ? opts.now : inspectedAt;
}

/** SMS time weight: 3 in the last 6 months, 2 for 6–12, 1 for 12–24, 0 older. */
export function timeWeight(when: Date | string, now = new Date()) {
  const age = now.getTime() - new Date(when).getTime();
  if (age < 0) return 3;
  if (age <= 182.5 * DAY) return 3;
  if (age <= YEAR) return 2;
  if (age <= 2 * YEAR) return 1;
  return 0;
}

/** Levels that look at the driver / the vehicle (CVSA): 1, 2, 3, 6 check the driver; 1, 2, 5, 6 the vehicle. */
const DRIVER_LEVELS = [1, 2, 3, 6];
const VEHICLE_LEVELS = [1, 2, 5, 6];

export type InspectionLike = { id: string; inspectedAt: Date | string; country: string; level: number; hazmat: boolean; violations: Violation[]; driverId?: string | null; truckId?: string | null };
export type CrashLike = { occurredAt: Date | string; kind: string; dotRecordable: boolean; injuries: boolean; fatality?: boolean; towAway: boolean; preventable?: string | null };

/**
 * SMS-style measures per BASIC over the last 24 months, from US inspections only (Canadian and Mexican
 * inspections go to CVOR / NSC and SCT, not to SMS). Severity per inspection per BASIC = Σ(weight, +2 when
 * OOS), capped at 30; × time weight; divided by time-weighted relevant inspections (driver / vehicle / HM
 * BASICs) or by power units (Unsafe Driving, Crash). These are measures, not FMCSA's percentiles, which need
 * the national peer group.
 */
export function basicMeasures(list: InspectionLike[], crashes: CrashLike[], powerUnits: number, now = new Date()) {
  const us = list.filter((i) => i.country === "US" && timeWeight(i.inspectedAt, now) > 0);
  const out = BASICS.map((b) => ({ key: b.key as BasicKey, label: b.label, measure: 0, inspections: 0, withViolations: 0, points: 0, oos: 0 }));
  const get = (k: BasicKey) => out.find((o) => o.key === k)!;
  for (const b of out) {
    if (b.key === "crash") continue;
    const norm = BASICS.find((x) => x.key === b.key)!.norm;
    let num = 0;
    let den = 0;
    for (const i of us) {
      const tw = timeWeight(i.inspectedAt, now);
      const relevant = norm === "driver" ? DRIVER_LEVELS.includes(i.level) : norm === "vehicle" ? VEHICLE_LEVELS.includes(i.level) : norm === "hm" ? i.hazmat : true;
      const vs = i.violations.filter((v) => !v.removed && v.basic === b.key);
      if (relevant) {
        den += tw;
        b.inspections++;
      }
      if (!vs.length) continue;
      const sev = Math.min(30, vs.reduce((a, v) => a + Math.max(1, Math.min(10, v.severity)) + (v.oos ? 2 : 0), 0));
      num += tw * sev;
      b.points += tw * sev;
      b.withViolations++;
      if (vs.some((v) => v.oos)) b.oos++;
    }
    b.measure = norm === "power" ? (powerUnits > 0 ? num / powerUnits : 0) : den > 0 ? num / den : 0;
  }
  // crashes: 1 for a tow-away, 2 with an injury or a fatality; not-preventable crashes (CPDP) left out
  const crash = get("crash");
  let cnum = 0;
  for (const c of crashes) {
    if (c.kind !== "accident" || !c.dotRecordable || c.preventable === "not_preventable") continue;
    const tw = timeWeight(c.occurredAt, now);
    if (!tw) continue;
    const sev = c.fatality || c.injuries ? 2 : 1;
    cnum += tw * sev;
    crash.inspections++;
    crash.withViolations++;
  }
  crash.points = cnum;
  crash.measure = powerUnits > 0 ? cnum / powerUnits : 0;
  for (const b of out) b.measure = Math.round(b.measure * 100) / 100;
  return out;
}

/** Out-of-service rates by country and side (driver / vehicle), over the window. */
export function oosRates(list: InspectionLike[], now = new Date(), days = 730) {
  const since = now.getTime() - days * DAY;
  const rows = list.filter((i) => new Date(i.inspectedAt).getTime() >= since);
  return (["US", "CA", "MX"] as const).map((country) => {
    const r = rows.filter((i) => i.country === country);
    const dI = r.filter((i) => DRIVER_LEVELS.includes(i.level));
    const vI = r.filter((i) => VEHICLE_LEVELS.includes(i.level));
    const dO = dI.filter((i) => i.violations.some((v) => !v.removed && v.oos && v.unit === "driver")).length;
    const vO = vI.filter((i) => i.violations.some((v) => !v.removed && v.oos && v.unit === "vehicle")).length;
    return { country, inspections: r.length, clean: r.filter((i) => !i.violations.some((v) => !v.removed)).length, driver: { inspections: dI.length, oos: dO, rate: dI.length ? dO / dI.length : null }, vehicle: { inspections: vI.length, oos: vO, rate: vI.length ? vO / vI.length : null } };
  });
}

/** Per driver: inspections, clean ones, time-weighted points, OOS — who needs coaching. */
export function driverPoints(list: InspectionLike[], now = new Date()) {
  const m = new Map<string, { driverId: string; inspections: number; clean: number; points: number; oos: number; last: string }>();
  for (const i of list) {
    if (!i.driverId) continue;
    const tw = timeWeight(i.inspectedAt, now);
    if (!tw) continue;
    const r = m.get(i.driverId) ?? { driverId: i.driverId, inspections: 0, clean: 0, points: 0, oos: 0, last: new Date(0).toISOString() };
    const vs = i.violations.filter((v) => !v.removed && v.unit === "driver");
    r.inspections++;
    if (!i.violations.some((v) => !v.removed)) r.clean++;
    r.points += tw * vs.reduce((a, v) => a + v.severity + (v.oos ? 2 : 0), 0);
    if (vs.some((v) => v.oos)) r.oos++;
    if (new Date(i.inspectedAt).toISOString() > r.last) r.last = new Date(i.inspectedAt).toISOString();
    m.set(i.driverId, r);
  }
  return [...m.values()].sort((p, q) => q.points - p.points);
}
