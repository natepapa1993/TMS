import { and, eq, inArray, desc, gt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { ComplianceItem } from "@/db/schema";
import { newId } from "@/lib/ids";
import { zoneOf, touches, crosses, type LegZone } from "./zones";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/outbox";
import { ValidationError, NotFoundError } from "./orders";
import { dqLines, dqComplianceItems, daStanding, daComplianceItem } from "./safety-rules";
import { rollup, isBuiltIn, builtInLevel, documentTypeLevel, blockSentence, isBlocking, levelOf, blockReason, BUILT_IN_LEVELS, BLOCK_LEVELS } from "./compliance-rules";

/**
 * Compliance engine (spec §6). Rules = document types the owner edits. For each driver / truck /
 * trailer / carrier the engine produces one row: every required document type and every built-in
 * expiry field with ok / expiring / expired / missing, and a `dispatchable` boolean the assign picker,
 * tender panel and crossing eligibility read.
 */

export type SubjectKind = "driver" | "truck" | "trailer" | "carrier";
export const SUBJECT_KINDS: SubjectKind[] = ["driver", "truck", "trailer", "carrier"];

/**
 * Built-in dated fields that are compliance items even without a document type (spec §6.5). Each is one
 * credential: the date (and number) on the record is what compliance and dispatch read; photos of it are
 * documents coded `field:<key>` with their versions (a renewal from the driver app, a scan Safety attaches).
 * `blocks` is the default; how hard it blocks is BUILT_IN_LEVELS (the law's, or the company's setting).
 */
export const FIELD_ITEMS: Record<SubjectKind, { key: string; label: string; blocks: boolean; numberKey?: string; appliesWhen?: (r: Record<string, unknown>) => boolean }[]> = {
  driver: [
    { key: "licenseExpires", label: "Licence", blocks: true, numberKey: "licenseNumber", appliesWhen: (d) => d.driverType !== "B1" },
    { key: "medicalExpires", label: "Medical card", blocks: true },
    { key: "mxLicenseExpires", label: "Licencia federal", blocks: true, numberKey: "mxLicenseNumber", appliesWhen: (d) => d.driverType === "B1" || d.driverType === "DUAL" },
    { key: "fastExpires", label: "FAST card", blocks: false, numberKey: "fastNumber" },
    { key: "i94Until", label: "I-94", blocks: true, appliesWhen: (d) => d.driverType === "B1" },
  ],
  truck: [
    { key: "usPlateExpires", label: "US plate", blocks: true, numberKey: "usPlate", appliesWhen: (t) => !!t.usPlate },
    { key: "mxPlateExpires", label: "MX plate", blocks: true, numberKey: "mxPlate", appliesWhen: (t) => !!t.mxPlate },
    { key: "caPlateExpires", label: "Canadian plate", blocks: true, numberKey: "caPlate", appliesWhen: (t) => !!t.caPlate },
    { key: "dotInspectionExpires", label: "Annual inspection", blocks: true },
  ],
  trailer: [{ key: "inspectionExpires", label: "Annual inspection", blocks: true }],
  carrier: [
    { key: "caatExpires", label: "CAAT", blocks: true, numberKey: "caat", appliesWhen: (c) => c.country === "MX" },
    { key: "sctPermitExpires", label: "SCT permit", blocks: false, numberKey: "sctPermit", appliesWhen: (c) => c.country === "MX" },
    { key: "ctpatExpires", label: "C-TPAT", blocks: false, appliesWhen: (c) => !!c.ctpat },
    // US / Canadian for-hire authority carries insurance on file with FMCSA; Mexican carriers' póliza is a document rule of your own
    { key: "autoLiabilityExpires", label: "Auto liability insurance", blocks: true, appliesWhen: (c) => c.country !== "MX" },
    { key: "cargoInsuranceExpires", label: "Cargo insurance", blocks: false, appliesWhen: (c) => c.country !== "MX" },
  ],
};

/** The credential a `field:<key>` refers to, for a kind. */
export const fieldItem = (kind: SubjectKind, key: string) => FIELD_ITEMS[kind].find((f) => f.key === key.replace(/^field:/, "")) ?? null;

/** The annual inspection is kept as its due date: an inspection done on a day is good for 12 months (396.17). */
export const INSPECTION_KEYS = ["dotInspectionExpires", "inspectionExpires"];
export function inspectionDue(doneOn: Date) {
  const d = new Date(doneOn);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

const TABLE: Record<SubjectKind, typeof s.drivers | typeof s.trucks | typeof s.trailers | typeof s.carriers> = { driver: s.drivers, truck: s.trucks, trailer: s.trailers, carrier: s.carriers };

function statusOf(expiresAt: Date | null, alertDays: number, now: Date, tracksExpiry: boolean): ComplianceItem["status"] {
  if (!tracksExpiry) return "ok";
  if (!expiresAt) return "ok"; // present, no date known: the human left it blank on purpose
  if (expiresAt.getTime() < now.getTime()) return "expired";
  if (expiresAt.getTime() < now.getTime() + alertDays * 86400_000) return "expiring";
  return "ok";
}

/** Does a document type scoped to some legs apply to this leg? By the countries the leg touches: "mx", "us", "ca"; "crossing" when it crosses a border. */
export function scopeMatches(scope: string | null | undefined, leg: LegZone | string) {
  if (!scope) return true;
  const z = zoneOf(leg);
  if (scope === "mx") return touches(z, "MX");
  if (scope === "us") return touches(z, "US");
  if (scope === "ca") return touches(z, "CA");
  if (scope === "crossing") return crosses(z);
  return scope === z.type;
}

export { rollup, isBuiltIn } from "./compliance-rules";

/** A subject's status as it applies to one leg type: a FAST card scoped to the crossing does not block a US run. */
export function forLeg<T extends { items: ComplianceItem[] }>(st: T, legType: LegZone | string | null | undefined): T & ReturnType<typeof rollup> {
  if (!legType) return { ...st, ...rollup(st.items) };
  return { ...st, ...rollup(st.items.filter((i) => scopeMatches(i.legScope, legType))) };
}

/** The company's compliance settings: blank dates block, per-item levels, a grace period for qualification files. */
export type ComplianceSettings = { strictMissing: boolean; levels: Record<string, unknown>; dqGraceUntil: Date | null };
export function complianceSettings(settings: Record<string, unknown> | null | undefined): ComplianceSettings {
  const st = settings ?? {};
  const g = typeof st.dqGraceUntil === "string" ? new Date(st.dqGraceUntil) : null;
  return { strictMissing: !!st.missingDatesBlock, levels: (st.blockLevels as Record<string, unknown>) ?? {}, dqGraceUntil: g && !Number.isNaN(g.getTime()) ? g : null };
}

/** Evaluate one subject and store the result. */
export async function evaluateSubject(ctx: Ctx, kind: SubjectKind, subjectId: string, now = new Date()) {
  assertCtx(ctx);
  const table = TABLE[kind];
  const [rec] = await db.select().from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, subjectId))).limit(1);
  if (!rec) throw new NotFoundError(kind, subjectId);
  const r = rec as unknown as Record<string, unknown>;
  const types = await db.select().from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, ctx.tenantId), eq(s.documentTypes.appliesTo, kind), sql`${s.documentTypes.archivedAt} is null`));
  const docs = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, subjectId), inArray(s.documents.status, ["present", "verified"])));
  const snoozes = await db.select().from(s.complianceSnoozes).where(and(eq(s.complianceSnoozes.tenantId, ctx.tenantId), eq(s.complianceSnoozes.subjectKind, kind), eq(s.complianceSnoozes.subjectId, subjectId), gt(s.complianceSnoozes.until, now)));
  const items: ComplianceItem[] = [];
  const [tenant] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const cfg = complianceSettings(tenant?.settings as Record<string, unknown> | null);

  for (const t of types) {
    const doc = docs.filter((d) => d.documentTypeId === t.id).sort((p, q) => (q.expiresAt?.getTime() ?? 0) - (p.expiresAt?.getTime() ?? 0))[0];
    const alertDays = Math.max(...(t.alertDays.length ? t.alertDays : [30]));
    const graceOpen = !!t.graceUntil && t.graceUntil.getTime() > now.getTime();
    const level = documentTypeLevel(t);
    let status: ComplianceItem["status"] = doc ? statusOf(doc.expiresAt, alertDays, now, t.tracksExpiry) : t.required ? "missing" : "na";
    const snooze = snoozes.find((z) => z.itemKey === t.id);
    const underlying = status === "ok" || status === "na" ? null : (status as "expiring" | "expired" | "missing");
    if (snooze && underlying) status = "snoozed";
    items.push({ key: t.id, label: t.name, status, underlying: snooze ? underlying : null, expiresAt: doc?.expiresAt?.toISOString() ?? null, documentId: doc?.id ?? null, blocksDispatch: level !== "warn" && !graceOpen, ...(graceOpen ? { level: "warn" as const } : level ? { level } : {}), graceUntil: graceOpen && level !== "warn" ? t.graceUntil!.toISOString() : null, required: t.required, alertDays, snoozedUntil: snooze?.until.toISOString() ?? null, snoozeReason: snooze?.reason ?? null, legScope: t.legScope ?? null });
  }
  for (const f of FIELD_ITEMS[kind]) {
    if (f.appliesWhen && !f.appliesWhen(r)) continue;
    const key = `field:${f.key}`;
    const level = builtInLevel(key, cfg.levels);
    const blocks = level !== "warn";
    const d = r[f.key] as Date | null;
    // an optional date left blank is "not on file", never a green "ok"
    let status: ComplianceItem["status"] = d ? statusOf(d, 30, now, true) : blocks ? "missing" : "na";
    const snooze = snoozes.find((z) => z.itemKey === key);
    const underlying = status === "ok" || status === "na" ? null : (status as "expiring" | "expired" | "missing");
    if (snooze && underlying) status = "snoozed";
    // the latest photo or scan of this credential on file
    const scan = docs.filter((x) => x.code === key).sort((p, q) => q.createdAt.getTime() - p.createdAt.getTime())[0];
    items.push({ key, label: f.label, status, underlying: snooze ? underlying : null, blocksWhenMissing: blocks && cfg.strictMissing, expiresAt: d?.toISOString() ?? null, documentId: scan?.id ?? null, blocksDispatch: blocks, level, required: true, alertDays: 30, snoozedUntil: snooze?.until.toISOString() ?? null, snoozeReason: snooze?.reason ?? null });
  }
  if (kind === "driver") items.push(...(await driverSafetyItems(ctx, r, subjectId, cfg, now)));
  const { expired, expiring, missing, dispatchable } = rollup(items);
  const [existing] = await db.select({ id: s.complianceStatus.id }).from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  const row = { dispatchable, expired, expiring, missing, items, ranAt: now };
  if (existing) await db.update(s.complianceStatus).set(row).where(eq(s.complianceStatus.id, existing.id));
  else await db.insert(s.complianceStatus).values({ id: newId(), tenantId: ctx.tenantId, subjectKind: kind, subjectId, ...row });
  return { kind, subjectId, ...row };
}

/**
 * The qualification file and the drug & alcohol standing of a driver, as compliance items. The hire
 * prerequisites (application, road test, Clearinghouse full query, a negative pre-employment drug test)
 * block dispatch by default, whatever the "blank dates" switch says; a company can give itself a grace
 * date while it enters existing drivers' files.
 */
async function driverSafetyItems(ctx: Ctx, driver: Record<string, unknown>, driverId: string, cfg: ComplianceSettings, now: Date) {
  const [records, tests] = await Promise.all([
    db.select().from(s.dqRecords).where(and(eq(s.dqRecords.tenantId, ctx.tenantId), eq(s.dqRecords.driverId, driverId))),
    db.select().from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.driverId, driverId))),
  ]);
  const standing = daStanding(tests);
  const lines = dqLines({ driverType: String(driver.driverType), licenseState: driver.licenseState as string | null, hireDate: driver.hireDate as Date | null }, records, standing.preEmploymentNegativeAt, now);
  const grace = cfg.dqGraceUntil && cfg.dqGraceUntil.getTime() > now.getTime() ? cfg.dqGraceUntil : null;
  return [...dqComplianceItems(lines, { levels: cfg.levels, graceUntil: grace, strictMissing: cfg.strictMissing, preEmploymentPending: standing.preEmploymentPending }), daComplianceItem(standing.prohibited)];
}

/** Evaluate every active subject of a tenant (nightly, on rule change, on demand). */
export async function evaluateAll(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  let n = 0;
  let blocked = 0;
  for (const kind of SUBJECT_KINDS) {
    const table = TABLE[kind];
    const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.tenantId, ctx.tenantId), sql`${table.archivedAt} is null`));
    for (const r of rows) {
      const res = await evaluateSubject(ctx, kind, r.id, now);
      n++;
      if (!res.dispatchable) blocked++;
    }
  }
  return { evaluated: n, blocked };
}

/** Job: every tenant, once an hour is plenty (spec says nightly + on save; the on-save path is immediate). */
export async function evaluateAllTenants(now = new Date()) {
  const tenants = await db.select({ id: s.tenants.id }).from(s.tenants);
  let evaluated = 0;
  for (const t of tenants) evaluated += (await evaluateAll(systemCtx(t.id), now)).evaluated;
  return { tenants: tenants.length, evaluated };
}

export type ComplianceRead = { dispatchable: boolean; expired: string[]; expiring: string[]; missing: string[]; items: ComplianceItem[]; ranAt: Date; override: { reason: string; expiresAt: Date } | null; hard: boolean; blockers: string[] };

/** Read the stored result (evaluating on first sight). Includes any live 24-h override. */
export async function statusFor(ctx: Ctx, kind: SubjectKind, subjectId: string): Promise<ComplianceRead> {
  assertCtx(ctx);
  let [row] = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  if (!row) {
    await evaluateSubject(ctx, kind, subjectId);
    [row] = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  }
  const [ov] = await db.select().from(s.complianceOverrides).where(and(eq(s.complianceOverrides.tenantId, ctx.tenantId), eq(s.complianceOverrides.subjectKind, kind), eq(s.complianceOverrides.subjectId, subjectId), gt(s.complianceOverrides.expiresAt, new Date()))).orderBy(desc(s.complianceOverrides.createdAt)).limit(1);
  const { hard, blockers } = rollup(row.items);
  return { dispatchable: row.dispatchable, expired: row.expired, expiring: row.expiring, missing: row.missing, items: row.items, ranAt: row.ranAt, override: ov ? { reason: ov.reason, expiresAt: ov.expiresAt } : null, hard, blockers };
}

export async function statusMap(ctx: Ctx, kind: SubjectKind) {
  assertCtx(ctx);
  const rows = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind)));
  const ovs = await db.select().from(s.complianceOverrides).where(and(eq(s.complianceOverrides.tenantId, ctx.tenantId), eq(s.complianceOverrides.subjectKind, kind), gt(s.complianceOverrides.expiresAt, new Date())));
  return new Map(rows.map((r) => [r.subjectId, { ...r, override: ovs.find((o) => o.subjectId === r.subjectId) ?? null }]));
}

// ---------- subject documents ----------

export type SubjectUpload = { documentTypeId: string; fileName: string; mimeType: string; bytes: Buffer; expiresAt?: Date | null; issuedAt?: Date | null; number?: string | null; notes?: string | null; source?: string; status?: "present" | "pending" };

export async function uploadSubjectDocument(ctx: Ctx, kind: SubjectKind, subjectId: string, input: SubjectUpload) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  if (!input.bytes?.length) throw new ValidationError("empty file", "file");
  if (input.bytes.length > 15 * 1024 * 1024) throw new ValidationError("file is over 15 MB", "file");
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(input.mimeType)) throw new ValidationError("PDF, JPG or PNG only", "file");
  const [type] = await db.select().from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, ctx.tenantId), eq(s.documentTypes.id, input.documentTypeId))).limit(1);
  if (!type) throw new NotFoundError("document type", input.documentTypeId);
  if (type.appliesTo !== kind) throw new ValidationError(`${type.name} applies to ${type.appliesTo}s, not ${kind}s`, "documentTypeId");
  if (type.tracksExpiry && !input.expiresAt) throw new ValidationError(`${type.name} needs an expiry date`, "expiresAt");
  const pending = input.status === "pending"; // from the driver's phone: counts only once safety confirms it
  const table = TABLE[kind];
  const [rec] = await db.select({ id: table.id }).from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, subjectId))).limit(1);
  if (!rec) throw new NotFoundError(kind, subjectId);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const doc = await db.transaction(async (tx) => {
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: input.mimeType, sizeBytes: input.bytes.length, bytes: input.bytes }).returning({ id: s.documentBlobs.id });
    const prior = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, subjectId), eq(s.documents.documentTypeId, type.id), inArray(s.documents.status, ["present", "verified"])));
    if (!pending) for (const p of prior) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id));
    const older = await tx.select({ id: s.documents.id }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, subjectId), eq(s.documents.documentTypeId, type.id), eq(s.documents.status, "pending")));
    for (const p of older) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id)); // a newer photo replaces an unreviewed one
    const [row] = await tx
      .insert(s.documents)
      .values({ id: newId(), tenantId: ctx.tenantId, documentTypeId: type.id, code: null, subjectKind: kind, subjectId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, issuedAt: input.issuedAt ?? null, expiresAt: input.expiresAt ?? null, number: input.number ?? null, source: input.source ?? "upload", status: pending ? "pending" : "present", version: (Math.max(0, ...prior.map((p) => p.version)) || 0) + 1, notes: input.notes ?? null, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning();
    await writeAudit(tx, ctx, kind, subjectId, "update", { [type.name]: { from: prior[0]?.expiresAt ?? null, to: pending ? "pending review" : (input.expiresAt ?? "present") } }, `${type.name} ${pending ? "sent from the driver app" : "uploaded"}: ${input.fileName}`);
    return row;
  });
  if (!pending) await evaluateSubject(ctx, kind, subjectId);
  return doc;
}

/**
 * Safety looks at what a driver sent from the app (spec §5.2 "document upload for renewals"): confirm it,
 * fixing the dates if the driver typed them wrong, and it becomes the document on file and compliance
 * re-runs; or reject it with a reason the driver sees in the app. Until then it counts for nothing.
 */
export async function reviewSubjectDocument(ctx: Ctx, documentId: string, decision: "confirm" | "reject", input: { expiresAt?: Date | null; issuedAt?: Date | null; number?: string | null; reason?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.id, documentId))).limit(1);
  if (!doc || (!doc.documentTypeId && !doc.code?.startsWith("field:"))) throw new NotFoundError("document", documentId);
  if (doc.status !== "pending") throw new ValidationError(`this document is ${doc.status}, not waiting for review`);
  const kind = doc.subjectKind as SubjectKind;
  // a built-in credential (licence, medical card, I-94…): confirming it sets the date dispatch reads
  const cred = doc.code?.startsWith("field:") ? fieldItem(kind, doc.code) : null;
  const [type] = doc.documentTypeId ? await db.select().from(s.documentTypes).where(eq(s.documentTypes.id, doc.documentTypeId)).limit(1) : [];
  if (!cred && !type) throw new NotFoundError("document type", doc.documentTypeId ?? doc.code ?? "");
  const name = cred?.label ?? type!.name;
  if (decision === "reject") {
    if (!input.reason?.trim()) throw new ValidationError("tell the driver what is wrong (blurry, wrong side, expired…)", "reason");
    await db.update(s.documents).set({ status: "rejected", notes: input.reason.trim(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, doc.id));
    await writeAudit(db, ctx, kind, doc.subjectId, "update", { [name]: { from: "pending review", to: "rejected" } }, input.reason.trim());
    return { ...doc, status: "rejected" as const };
  }
  const expiresAt = input.expiresAt === undefined ? doc.expiresAt : input.expiresAt;
  if ((cred || type!.tracksExpiry) && !expiresAt) throw new ValidationError(`${name} needs an expiry date`, "expiresAt");
  if (cred) checkCredentialDate(cred.key, expiresAt!);
  const number = input.number === undefined ? doc.number : input.number || null;
  const row = await db.transaction(async (tx) => {
    const same = cred ? eq(s.documents.code, doc.code!) : eq(s.documents.documentTypeId, type!.id);
    const prior = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, doc.subjectId), same, inArray(s.documents.status, ["present", "verified"])));
    for (const p of prior) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id));
    const [row] = await tx.update(s.documents).set({ status: "verified", expiresAt, issuedAt: input.issuedAt === undefined ? doc.issuedAt : input.issuedAt, number, notes: "Confirmed from the driver app", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, doc.id)).returning();
    if (cred) await applyCredential(tx, ctx, kind, doc.subjectId, cred, { expiresAt: expiresAt!, number }, `${name} renewal from the driver app confirmed`);
    else await writeAudit(tx, ctx, kind, doc.subjectId, "update", { [name]: { from: prior[0]?.expiresAt ?? null, to: expiresAt ?? "present" } }, `${name} from the driver app confirmed`);
    return row;
  });
  await evaluateSubject(ctx, kind, doc.subjectId);
  return row;
}

/** Put a confirmed credential on the record: the date (and number) compliance and dispatch read, audited. */
async function applyCredential(tx: Tx, ctx: Ctx, kind: SubjectKind, subjectId: string, f: (typeof FIELD_ITEMS)[SubjectKind][number], v: { expiresAt: Date; number?: string | null }, note: string) {
  const table = TABLE[kind];
  const [rec] = await tx.select().from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, subjectId))).limit(1);
  if (!rec) throw new NotFoundError(kind, subjectId);
  const r = rec as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = { [f.key]: v.expiresAt };
  if (f.numberKey && v.number?.trim()) set[f.numberKey] = v.number.trim();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, val] of Object.entries(set)) if (JSON.stringify(r[k] ?? null) !== JSON.stringify(val)) changes[k] = { from: r[k] ?? null, to: val };
  await tx.update(table).set({ ...set, updatedAt: new Date(), updatedBy: ctx.userId } as never).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, subjectId)));
  await writeAudit(tx, ctx, kind, subjectId, "update", changes, note);
}

export type CredentialUpload = { fileName: string; mimeType: string; bytes: Buffer; expiresAt?: Date | null; issuedAt?: Date | null; number?: string | null; notes?: string | null; source?: string; status?: "present" | "pending" };

/**
 * A photo or scan of a built-in credential (licence, medical card, licencia federal, FAST, I-94, plates,
 * annual inspection, CAAT…): one record per credential — the date and number on the subject, the images
 * as versions. From Safety it goes straight on file and sets the date; from the driver's phone it waits
 * for Safety's confirm. An annual inspection report can carry the inspection date instead: the due date
 * is 12 months later.
 */
export async function uploadCredential(ctx: Ctx, kind: SubjectKind, subjectId: string, fieldKey: string, input: CredentialUpload) {
  assertCtx(ctx);
  const pending = input.status === "pending";
  // the dates are Safety's: a dispatcher can't make a driver dispatchable by uploading a new card
  requirePermission(ctx, pending ? "records.edit" : "compliance.edit");
  const f = fieldItem(kind, fieldKey);
  if (!f) throw new ValidationError(`no ${fieldKey} on a ${kind}`, "fieldKey");
  if (!input.bytes?.length) throw new ValidationError("empty file", "file");
  if (input.bytes.length > 15 * 1024 * 1024) throw new ValidationError("file is over 15 MB", "file");
  if (!/^(application\/pdf|image\/(jpeg|png|heic|webp))$/.test(input.mimeType)) throw new ValidationError("PDF, JPG or PNG only", "file");
  const expiresAt = input.expiresAt ?? (INSPECTION_KEYS.includes(f.key) && input.issuedAt ? inspectionDue(input.issuedAt) : null);
  if (!expiresAt) throw new ValidationError(INSPECTION_KEYS.includes(f.key) ? "the inspection date (or when it expires)" : `${f.label}: when does it expire?`, "expiresAt");
  if (INSPECTION_KEYS.includes(f.key) && input.issuedAt && input.issuedAt.getTime() > Date.now() + 86400_000) throw new ValidationError("the inspection date is in the future", "issuedAt");
  checkCredentialDate(f.key, expiresAt);
  const table = TABLE[kind];
  const [rec] = await db.select({ id: table.id }).from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, subjectId))).limit(1);
  if (!rec) throw new NotFoundError(kind, subjectId);
  const code = `field:${f.key}`;
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const doc = await db.transaction(async (tx) => {
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: input.mimeType, sizeBytes: input.bytes.length, bytes: input.bytes }).returning({ id: s.documentBlobs.id });
    const all = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, subjectId), eq(s.documents.code, code)));
    // a newer photo replaces one nobody looked at; a confirmed one replaces what was on file
    for (const p of all.filter((x) => x.status === "pending" || (!pending && (x.status === "present" || x.status === "verified")))) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id));
    const [row] = await tx
      .insert(s.documents)
      .values({ id: newId(), tenantId: ctx.tenantId, documentTypeId: null, code, subjectKind: kind, subjectId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, issuedAt: input.issuedAt ?? null, expiresAt, number: input.number?.trim() || null, source: input.source ?? "upload", status: pending ? "pending" : "present", version: Math.max(0, ...all.map((p) => p.version)) + 1, notes: input.notes ?? null, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning();
    if (pending) await writeAudit(tx, ctx, kind, subjectId, "update", { [f.label]: { from: null, to: "pending review" } }, `${f.label} sent from the driver app: ${input.fileName}`);
    else await applyCredential(tx, ctx, kind, subjectId, f, { expiresAt, number: input.number }, `${f.label} on file: ${input.fileName}${input.issuedAt && INSPECTION_KEYS.includes(f.key) ? ` (inspected ${input.issuedAt.toISOString().slice(0, 10)})` : ""}`);
    return row;
  });
  if (!pending) await evaluateSubject(ctx, kind, subjectId);
  return doc;
}

/** A medical examiner's certificate is good for 24 months at most (391.45): a later date is a typo or the wrong card. */
function checkCredentialDate(key: string, expiresAt: Date) {
  if (key === "medicalExpires" && expiresAt.getTime() > Date.now() + (2 * 365 + 2) * 86400_000) throw new ValidationError("a medical certificate is good for 24 months at most — check the date on the card", "expiresAt");
}

/** How a document is called on screen: its rule's name, the credential it shows, or the qualification-file item. */
export function documentLabel(d: { documentTypeId: string | null; code: string | null; subjectKind: string }, typeName?: string | null) {
  if (typeName) return typeName;
  if (d.code?.startsWith("field:")) return fieldItem(d.subjectKind as SubjectKind, d.code)?.label ?? "Document";
  if (d.code?.startsWith("dq:")) return "Qualification file";
  return "Document";
}

/** What drivers sent from the app and nobody has looked at yet. */
export async function pendingUploads(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const rows = await db
    .select({ id: s.documents.id, subjectKind: s.documents.subjectKind, subjectId: s.documents.subjectId, documentTypeId: s.documents.documentTypeId, code: s.documents.code, fileName: s.documents.fileName, expiresAt: s.documents.expiresAt, number: s.documents.number, createdAt: s.documents.createdAt, typeName: s.documentTypes.name, driverName: s.drivers.name })
    .from(s.documents)
    .leftJoin(s.documentTypes, eq(s.documentTypes.id, s.documents.documentTypeId))
    .leftJoin(s.drivers, eq(s.drivers.id, s.documents.subjectId))
    .where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.status, "pending")))
    .orderBy(s.documents.createdAt);
  return rows.map((r) => ({ ...r, typeName: r.typeName ?? documentLabel({ documentTypeId: r.documentTypeId, code: r.code, subjectKind: r.subjectKind }) }));
}

export async function subjectDocuments(ctx: Ctx, kind: SubjectKind, subjectId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "records.view");
  return db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, subjectId))).orderBy(desc(s.documents.createdAt));
}

export async function snooze(ctx: Ctx, kind: SubjectKind, subjectId: string, itemKey: string, until: Date, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  if (until.getTime() < Date.now()) throw new ValidationError("snooze date is in the past", "until");
  if (until.getTime() > Date.now() + 90 * 86400_000) throw new ValidationError("snooze at most 90 days", "until");
  await db.insert(s.complianceSnoozes).values({ id: newId(), tenantId: ctx.tenantId, subjectKind: kind, subjectId, itemKey, until, reason: reason.trim(), createdBy: ctx.userId });
  await writeAudit(db, ctx, kind, subjectId, "update", { snooze: { from: null, to: itemKey } }, `${reason.trim()} until ${until.toISOString().slice(0, 10)}`);
  return evaluateSubject(ctx, kind, subjectId);
}

/**
 * The company's policy for built-in dates (licence, medical card, annual inspection, I-94…) left blank:
 * off = shown as missing but dispatchable (while the dates are being entered), on = a blank date on a
 * blocking item stops dispatch like an expired one. Safety or the owner decides; everything re-evaluates.
 */
export async function setMissingDatesBlock(ctx: Ctx, on: boolean) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.override");
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  await db.update(s.tenants).set({ settings: { ...((t?.settings as Record<string, unknown>) ?? {}), missingDatesBlock: on } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { missingDatesBlock: { from: !on, to: on } });
  return evaluateAll(ctx);
}

/**
 * The company's choice of how hard each built-in item blocks (the ones the law doesn't fix): the annual
 * inspection, FAST, insurance, the application and road test… Everything re-evaluates.
 */
export async function setBlockLevels(ctx: Ctx, levels: Record<string, string>) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.override");
  for (const [k, v] of Object.entries(levels)) {
    const def = BUILT_IN_LEVELS[k];
    if (!def) throw new ValidationError(`unknown item ${k}`, "levels");
    if (def.fixed) throw new ValidationError(`${k.replace(/^\w+:/, "")} is set by law and can't be changed`, "levels");
    if (!(BLOCK_LEVELS as string[]).includes(v)) throw new ValidationError("hard, override or warn", "levels");
  }
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const settings = (t?.settings as Record<string, unknown>) ?? {};
  const before = (settings.blockLevels as Record<string, string>) ?? {};
  const after = { ...before, ...levels };
  await db.update(s.tenants).set({ settings: { ...settings, blockLevels: after } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", Object.fromEntries(Object.entries(levels).filter(([k, v]) => before[k] !== v).map(([k, v]) => [`blocks: ${k}`, { from: before[k] ?? BUILT_IN_LEVELS[k].level, to: v }])));
  return evaluateAll(ctx);
}

/** The company's grace on qualification files: blank hire prerequisites don't block until the date (null = enforce now). */
export async function setDqGrace(ctx: Ctx, until: Date | null) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.override");
  if (until && until.getTime() > Date.now() + 90 * 86400_000) throw new ValidationError("a grace of at most 90 days", "until");
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const settings = (t?.settings as Record<string, unknown>) ?? {};
  await db.update(s.tenants).set({ settings: { ...settings, dqGraceUntil: until ? until.toISOString() : null } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { dqGraceUntil: { from: settings.dqGraceUntil ?? null, to: until ? until.toISOString().slice(0, 10) : null } });
  return evaluateAll(ctx);
}

/** Built-in blocking dates left blank, by subject kind: what would block if "missing dates block" were on. */
export async function blankBlockingDates(ctx: Ctx) {
  assertCtx(ctx);
  const rows = await db.select({ kind: s.complianceStatus.subjectKind, items: s.complianceStatus.items }).from(s.complianceStatus).where(eq(s.complianceStatus.tenantId, ctx.tenantId));
  const out: Record<string, number> = {};
  for (const r of rows) if (r.items.some((i) => isBuiltIn(i.key) && i.blocksDispatch && (i.status === "missing" || (i.status === "snoozed" && i.underlying === "missing")))) out[r.kind] = (out[r.kind] ?? 0) + 1;
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  return { on: !!(t?.settings as Record<string, unknown> | null)?.missingDatesBlock, counts: out };
}

/** End a snooze early: the reminder comes back now. */
export async function unsnooze(ctx: Ctx, kind: SubjectKind, subjectId: string, itemKey: string) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  await db.update(s.complianceSnoozes).set({ until: new Date() }).where(and(eq(s.complianceSnoozes.tenantId, ctx.tenantId), eq(s.complianceSnoozes.subjectKind, kind), eq(s.complianceSnoozes.subjectId, subjectId), eq(s.complianceSnoozes.itemKey, itemKey), gt(s.complianceSnoozes.until, new Date())));
  await writeAudit(db, ctx, kind, subjectId, "update", { snooze: { from: itemKey, to: null } }, "snooze ended");
  return evaluateSubject(ctx, kind, subjectId);
}

/** Safety (or owner) override: dispatch a blocked subject today. Logged, gone in 24 h. */
export async function overrideDispatch(ctx: Ctx, kind: SubjectKind, subjectId: string, reason: string) {
  assertCtx(ctx);
  if (ctx.role !== "system") requirePermission(ctx, "compliance.override");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const st = await statusFor(ctx, kind, subjectId);
  if (st.hard) {
    const hard = st.items.filter((i) => isBlocking(i) && levelOf(i) === "hard").map(blockReason);
    throw new ValidationError(`cannot override ${hard.join(", ")}: nobody can wave that through`);
  }
  const expiresAt = new Date(Date.now() + 24 * 3600_000);
  await db.insert(s.complianceOverrides).values({ id: newId(), tenantId: ctx.tenantId, subjectKind: kind, subjectId, reason: reason.trim(), expiresAt, createdBy: ctx.userId });
  await writeAudit(db, ctx, kind, subjectId, "override", { dispatchable: { from: false, to: "24h" } }, reason.trim());
  return { expiresAt };
}

// ---------- where it bites (spec §6.3) ----------

/** Findings for the eligibility engine: a blocked subject is red; expiring is yellow. */
export async function complianceFindings(ctx: Ctx, kind: SubjectKind, subjectId: string, label: string, legType?: LegZone | string | null) {
  const raw = await statusFor(ctx, kind, subjectId).catch(() => null);
  if (!raw) return [];
  const st = forLeg(raw, legType);
  const out: { level: "red" | "yellow"; code: string; message: string; overridable: boolean }[] = [];
  if (!st.dispatchable && !st.override) {
    out.push({ level: "red", code: "compliance_block", message: `${label}: ${blockSentence(st)}`, overridable: !st.hard });
  } else if (st.override) out.push({ level: "yellow", code: "compliance_override", message: `${label}: dispatch override until ${st.override.expiresAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" })} (${st.override.reason})`, overridable: true });
  if (st.expiring.length) out.push({ level: "yellow", code: "compliance_expiring", message: `${label}: ${st.expiring.join(", ")} expiring soon`, overridable: true });
  return out;
}

// ---------- dashboard ----------

export async function dashboard(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const [types, status] = await Promise.all([db.select().from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, ctx.tenantId), sql`${s.documentTypes.archivedAt} is null`)), db.select().from(s.complianceStatus).where(eq(s.complianceStatus.tenantId, ctx.tenantId))]);
  const subjects: Record<SubjectKind, { id: string; label: string; sub: string; archived: boolean }[]> = { driver: [], truck: [], trailer: [], carrier: [] };
  const [d, t, tr, c] = await Promise.all([db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), sql`${s.drivers.archivedAt} is null`)), db.select().from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), sql`${s.trucks.archivedAt} is null`)), db.select().from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), sql`${s.trailers.archivedAt} is null`)), db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), sql`${s.carriers.archivedAt} is null`))]);
  subjects.driver = d.map((x) => ({ id: x.id, label: x.name, sub: x.driverType, archived: false }));
  subjects.truck = t.map((x) => ({ id: x.id, label: x.unitNumber, sub: `${x.usPlate ?? "—"} / ${x.mxPlate ?? "—"}`, archived: false }));
  subjects.trailer = tr.map((x) => ({ id: x.id, label: x.unitNumber, sub: x.kind, archived: false }));
  subjects.carrier = c.map((x) => ({ id: x.id, label: x.name, sub: x.country, archived: false }));
  const overrides = await db.select().from(s.complianceOverrides).where(and(eq(s.complianceOverrides.tenantId, ctx.tenantId), gt(s.complianceOverrides.expiresAt, new Date())));
  // tiles count subjects (drivers, units, carriers) the way the table's filters do, per kind, so a tile and its filtered table agree
  const live = new Set(SUBJECT_KINDS.flatMap((k) => subjects[k].map((x) => `${k}:${x.id}`)));
  const rows = status.filter((r) => live.has(`${r.subjectKind}:${r.subjectId}`));
  const count = (kind: SubjectKind) => {
    const mine = rows.filter((r) => r.subjectKind === kind);
    return { blocked: mine.filter((r) => !r.dispatchable).length, expired: mine.filter((r) => r.expired.length).length, expiring: mine.filter((r) => r.expiring.length).length, missing: mine.filter((r) => r.missing.length).length, dq: mine.filter((r) => r.items.some((i) => i.key.startsWith("dq:") && ["missing", "expired"].includes(i.status === "snoozed" ? (i.underlying ?? "") : i.status))).length };
  };
  const byKind = Object.fromEntries(SUBJECT_KINDS.map((k) => [k, count(k)])) as Record<SubjectKind, ReturnType<typeof count>>;
  const lastRun = rows.reduce<Date | null>((m, r) => (!m || r.ranAt > m ? r.ranAt : m), null);
  const tiles = { ...SUBJECT_KINDS.reduce((acc, k) => ({ blocked: acc.blocked + byKind[k].blocked, expired: acc.expired + byKind[k].expired, expiring: acc.expiring + byKind[k].expiring, missing: acc.missing + byKind[k].missing, dq: acc.dq + byKind[k].dq }), { blocked: 0, expired: 0, expiring: 0, missing: 0, dq: 0 }), subjects: rows.length, lastRun, byKind };
  const [tenant] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  return { types, status, subjects, overrides, tiles, settings: complianceSettings(tenant?.settings as Record<string, unknown> | null) };
}

export function dashboardCsv(data: Awaited<ReturnType<typeof dashboard>>, kind: SubjectKind) {
  const types = data.types.filter((t) => t.appliesTo === kind);
  const fields = FIELD_ITEMS[kind];
  const head = ["Subject", "Detail", "Dispatchable", "Expired", "Expiring", "Missing", ...types.map((t) => t.name), ...fields.map((f) => f.label), "Last run"];
  const lines = [head];
  for (const sub of data.subjects[kind]) {
    const st = data.status.find((x) => x.subjectKind === kind && x.subjectId === sub.id);
    const cell = (key: string) => {
      const it = st?.items.find((i) => i.key === key);
      return it ? (it.expiresAt ? `${it.status} ${it.expiresAt.slice(0, 10)}` : it.status) : "";
    };
    lines.push([sub.label, sub.sub, st ? (st.dispatchable ? "yes" : "NO") : "", st?.expired.join("; ") ?? "", st?.expiring.join("; ") ?? "", st?.missing.join("; ") ?? "", ...types.map((t) => cell(t.id)), ...fields.map((f) => cell(`field:${f.key}`)), st?.ranAt.toISOString() ?? ""]);
  }
  return lines.map((l) => l.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
}

// ---------- alerts (spec §6.4) ----------

/** Daily digest to the compliance role: expired + expiring, once per day per tenant. */
export async function sendDigests(now = new Date()) {
  const tenants = await db.select().from(s.tenants);
  let sent = 0;
  for (const t of tenants) {
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const last = settings.complianceDigestAt ? new Date(String(settings.complianceDigestAt)) : null;
    const hourLocal = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: t.timeZone }).format(now));
    if (hourLocal < 7) continue;
    if (last && now.getTime() - last.getTime() < 20 * 3600_000) continue;
    const ctx = systemCtx(t.id);
    const rows = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, t.id), sql`(cardinality(${s.complianceStatus.expired}) > 0 or cardinality(${s.complianceStatus.expiring}) > 0 or cardinality(${s.complianceStatus.missing}) > 0)`));
    const recipients = await db.select({ email: s.users.email, name: s.users.name }).from(s.users).where(and(eq(s.users.tenantId, t.id), inArray(s.users.role, ["compliance", "owner"]), sql`${s.users.archivedAt} is null`));
    await db.update(s.tenants).set({ settings: { ...settings, complianceDigestAt: now.toISOString() } }).where(eq(s.tenants.id, t.id));
    if (!rows.length || !recipients.length) continue;
    const names = await labelsFor(ctx, rows.map((r) => ({ kind: r.subjectKind as SubjectKind, id: r.subjectId })));
    const line = (r: (typeof rows)[number]) => `${r.subjectKind} ${names.get(`${r.subjectKind}:${r.subjectId}`) ?? r.subjectId}: ${[...r.expired.map((x) => `${x} EXPIRED`), ...r.expiring.map((x) => `${x} expiring`), ...r.missing.map((x) => `${x} missing`)].join(", ")}`;
    const body = [`Compliance digest for ${t.name} — ${now.toLocaleDateString("en-US", { timeZone: t.timeZone })}`, "", `${rows.filter((r) => !r.dispatchable).length} subject(s) blocked from dispatch.`, "", ...rows.sort((p, q) => Number(q.expired.length > 0) - Number(p.expired.length > 0)).map(line), "", `Open the compliance board: ${(process.env.APP_URL ?? "").replace(/\/$/, "")}/compliance`].join("\n");
    for (const rcp of recipients) await enqueue(ctx, { channel: "email", to: rcp.email, subject: `Compliance: ${rows.filter((r) => r.expired.length).length} expired, ${rows.filter((r) => r.expiring.length).length} expiring`, body, subjectKind: "compliance_digest", subjectId: t.id });
    sent++;
  }
  return { sent };
}

async function labelsFor(ctx: Ctx, subs: { kind: SubjectKind; id: string }[]) {
  const out = new Map<string, string>();
  for (const kind of SUBJECT_KINDS) {
    const ids = subs.filter((x) => x.kind === kind).map((x) => x.id);
    if (!ids.length) continue;
    const table = TABLE[kind];
    const rows = await db.select().from(table).where(and(eq(table.tenantId, ctx.tenantId), inArray(table.id, ids)));
    for (const r of rows as unknown as Record<string, string>[]) out.set(`${kind}:${r.id}`, r.name ?? r.unitNumber ?? r.id);
  }
  return out;
}

/** Driver app: the driver's own expiring items (spec §6.3). uploadKey: what a photo of the renewal files against (a rule's id or field:<credential>). */
export type DriverOwnItem = { key: string; label: string; status: string; expiresAt: string | null; documentTypeId: string | null; uploadKey: string | null; tracksExpiry: boolean; pending: { fileName: string; at: string } | null; rejected: { reason: string; at: string } | null };

/** What the driver sees under "Your documents": what is expiring, expired or missing, and what they already sent. */
export async function driverOwnItems(tenantId: string, driverId: string): Promise<DriverOwnItem[]> {
  const ctx = systemCtx(tenantId);
  const st = await statusFor(ctx, "driver", driverId).catch(() => null);
  if (!st) return [];
  const [types, sent] = await Promise.all([
    db.select({ id: s.documentTypes.id, tracksExpiry: s.documentTypes.tracksExpiry }).from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, tenantId), eq(s.documentTypes.appliesTo, "driver"))),
    db.select({ documentTypeId: s.documents.documentTypeId, code: s.documents.code, status: s.documents.status, fileName: s.documents.fileName, notes: s.documents.notes, at: s.documents.updatedAt }).from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "driver"), eq(s.documents.subjectId, driverId), eq(s.documents.source, "driver_app"), inArray(s.documents.status, ["pending", "rejected"]))).orderBy(desc(s.documents.updatedAt)),
  ]);
  return st.items
    // the qualification file and the drug & alcohol program are the office's work, not uploads from the driver
    .filter((i) => !i.key.startsWith("dq:") && !i.key.startsWith("da:") && (i.status === "expiring" || i.status === "expired" || i.status === "missing" || (i.status === "snoozed" && !!i.underlying)))
    .map((i) => {
      const field = i.key.startsWith("field:");
      const typeId = field ? null : i.key;
      const mine = (d: (typeof sent)[number]) => (field ? d.code === i.key : d.documentTypeId === typeId);
      // the newest thing the driver sent for it: waiting for the office, or sent back
      const last = sent.find(mine);
      const p = last?.status === "pending" ? last : null;
      const r = last?.status === "rejected" ? last : null;
      return { key: i.key, label: i.label, status: i.status === "snoozed" ? i.underlying! : i.status, expiresAt: i.expiresAt, documentTypeId: typeId, uploadKey: i.key, tracksExpiry: field ? true : (types.find((t) => t.id === typeId)?.tracksExpiry ?? false), pending: p ? { fileName: p.fileName, at: p.at.toISOString() } : null, rejected: r ? { reason: r.notes ?? "", at: r.at.toISOString() } : null };
    });
}

/**
 * The driver sends a renewal from the app: a photo of the new card and the expiry they read off it — for a
 * rule of the company's own (documentTypeId) or a built-in credential (uploadKey field:medicalExpires…).
 * It waits for Safety; nothing counts until confirmed.
 */
export async function driverUploadRenewal(tenantId: string, driverId: string, input: { documentTypeId?: string | null; uploadKey?: string | null; fileName: string; mimeType: string; bytes: Buffer; expiresAt?: Date | null; number?: string | null }) {
  const ctx = systemCtx(tenantId);
  const [driver] = await db.select({ id: s.drivers.id }).from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  const key = input.uploadKey || input.documentTypeId || "";
  const common = { fileName: input.fileName, mimeType: input.mimeType, bytes: input.bytes, expiresAt: input.expiresAt ?? null, number: input.number ?? null, source: "driver_app", status: "pending" as const, notes: "Sent from the driver app — check the photo and confirm" };
  if (key.startsWith("field:")) return uploadCredential(ctx, "driver", driverId, key, common);
  return uploadSubjectDocument(ctx, "driver", driverId, { ...common, documentTypeId: key });
}

// ---------- incidents ----------

export async function listIncidents(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  return db.select().from(s.incidents).where(and(eq(s.incidents.tenantId, ctx.tenantId), sql`${s.incidents.archivedAt} is null`)).orderBy(desc(s.incidents.occurredAt)).limit(500);
}

/** An accident with an injury treated away from the scene or a tow-away is DOT-recordable (49 CFR 390.5); the box can also be ticked by hand. */
export async function saveIncident(ctx: Ctx, id: string | null, v: Partial<typeof s.incidents.$inferInsert>) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.edit");
  if (!v.description?.trim()) throw new ValidationError("describe what happened", "description");
  if (!v.occurredAt) throw new ValidationError("when did it happen?", "occurredAt");
  const safe = { occurredAt: v.occurredAt, kind: v.kind ?? "accident", driverId: v.driverId ?? null, truckId: v.truckId ?? null, trailerId: v.trailerId ?? null, orderId: v.orderId ?? null, location: v.location ?? null, description: v.description.trim(), dotRecordable: !!v.dotRecordable || ((v.kind ?? "accident") === "accident" && (!!v.injuries || !!v.towAway || !!v.fatality)), injuries: !!v.injuries, towAway: !!v.towAway, fatality: !!v.fatality, citation: !!v.citation, preventable: v.preventable === "preventable" || v.preventable === "not_preventable" ? v.preventable : null, policeReport: v.policeReport ?? null, claimNumber: v.claimNumber ?? null, status: v.status ?? "open" };
  if (id) {
    const [row] = await db.update(s.incidents).set({ ...safe, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.incidents.tenantId, ctx.tenantId), eq(s.incidents.id, id))).returning();
    if (!row) throw new NotFoundError("incident", id);
    await writeAudit(db, ctx, "incident", id, "update");
    return row;
  }
  const [row] = await db.insert(s.incidents).values({ id: newId(), tenantId: ctx.tenantId, ...safe, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
  await writeAudit(db, ctx, "incident", row.id, "create", undefined, safe.description.slice(0, 120));
  return row;
}

// ---------- read a document before it is filed ----------

/**
 * Read a licence, medical card, FAST card, insurance certificate… with the AI extractor before the
 * upload, so the expiry, number and holder are typed by the model and confirmed by the person. Nothing
 * is stored here; the upload that follows carries what the person accepted.
 */
export async function readSubjectDocument(ctx: Ctx, kind: SubjectKind, typeName: string, file: { fileName: string; mimeType: string; bytes: Buffer }, fetchImpl?: typeof fetch) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  if (!file.bytes?.length) throw new ValidationError("empty file", "file");
  const [integ] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, ctx.tenantId), eq(s.integrations.provider, "extractor"))).limit(1);
  if (!integ?.enabled || !integ.config.apiKey) return { ran: false as const, reason: "AI extractor not connected (Settings → Integrations)" };
  const { extractWithModel } = await import("@/integrations/extractor");
  const fields = [
    { key: "holder", label: `Name of the ${kind} the document belongs to` },
    { key: "number", label: "Document, licence or policy number" },
    { key: "issuedAt", label: "Issue date", kind: "datetime" as const },
    { key: "expiresAt", label: "Expiry date", kind: "datetime" as const },
  ];
  try {
    const r = await extractWithModel({ apiKey: integ.config.apiKey, model: integ.config.model || undefined }, { code: typeName, label: typeName, mimeType: file.mimeType, bytes: file.bytes }, fields, fetchImpl);
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: null, lastResult: `${r.model} · ${typeName}` }).where(eq(s.integrations.id, integ.id));
    const v = (k: string) => {
      const x = r.fields[k];
      return x && x.value != null && x.value !== "" ? { value: String(x.value), confidence: x.confidence } : null;
    };
    return { ran: true as const, model: r.model, holder: v("holder"), number: v("number"), issuedAt: v("issuedAt"), expiresAt: v("expiresAt") };
  } catch (e) {
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: (e as Error).message }).where(eq(s.integrations.id, integ.id));
    return { ran: false as const, reason: (e as Error).message };
  }
}
