import { and, eq, inArray, desc, gt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { ComplianceItem } from "@/db/schema";
import { newId } from "@/lib/ids";
import { zoneOf, touches, crosses, type LegZone } from "./zones";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/outbox";
import { ValidationError, NotFoundError } from "./orders";
import { dqLines, dqComplianceItems, daStanding, daComplianceItem } from "./safety-rules";

/**
 * Compliance engine (spec §6). Rules = document types the owner edits. For each driver / truck /
 * trailer / carrier the engine produces one row: every required document type and every built-in
 * expiry field with ok / expiring / expired / missing, and a `dispatchable` boolean the assign picker,
 * tender panel and crossing eligibility read.
 */

export type SubjectKind = "driver" | "truck" | "trailer" | "carrier";
export const SUBJECT_KINDS: SubjectKind[] = ["driver", "truck", "trailer", "carrier"];

/** Built-in dated fields that are compliance items even without a document type (spec §6.5). */
export const FIELD_ITEMS: Record<SubjectKind, { key: string; label: string; blocks: boolean; appliesWhen?: (r: Record<string, unknown>) => boolean }[]> = {
  driver: [
    { key: "licenseExpires", label: "Licence", blocks: true, appliesWhen: (d) => d.driverType !== "B1" },
    { key: "medicalExpires", label: "Medical card", blocks: true },
    { key: "mxLicenseExpires", label: "Licencia federal", blocks: true, appliesWhen: (d) => d.driverType === "B1" || d.driverType === "DUAL" },
    { key: "fastExpires", label: "FAST card", blocks: false },
    { key: "i94Until", label: "I-94", blocks: true, appliesWhen: (d) => d.driverType === "B1" },
  ],
  truck: [
    { key: "usPlateExpires", label: "US plate", blocks: true, appliesWhen: (t) => !!t.usPlate },
    { key: "mxPlateExpires", label: "MX plate", blocks: true, appliesWhen: (t) => !!t.mxPlate },
    { key: "caPlateExpires", label: "Canadian plate", blocks: true, appliesWhen: (t) => !!t.caPlate },
    { key: "dotInspectionExpires", label: "Annual inspection", blocks: true },
  ],
  trailer: [{ key: "inspectionExpires", label: "Inspection", blocks: true }],
  carrier: [
    { key: "caatExpires", label: "CAAT", blocks: true, appliesWhen: (c) => c.country === "MX" },
    { key: "sctPermitExpires", label: "SCT permit", blocks: false, appliesWhen: (c) => c.country === "MX" },
    { key: "ctpatExpires", label: "C-TPAT", blocks: false, appliesWhen: (c) => !!c.ctpat },
    // US / Canadian for-hire authority carries insurance on file with FMCSA; Mexican carriers' póliza is a document rule of your own
    { key: "autoLiabilityExpires", label: "Auto liability insurance", blocks: true, appliesWhen: (c) => c.country !== "MX" },
    { key: "cargoInsuranceExpires", label: "Cargo insurance", blocks: false, appliesWhen: (c) => c.country !== "MX" },
  ],
};

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

/** Built-in items (dates on the record, the qualification file): a blank one blocks only with the company's "missing dates block" switch. */
export const isBuiltIn = (key: string) => key.startsWith("field:") || key.startsWith("dq:");

/** Legal prerequisites nobody can override: licence, medical card, I-94, plates, and a drug & alcohol hold. */
export const HARD_BLOCK = /licen|medical|I-94|plate|Safety hold/i;

/** The lists and the dispatchable flag from a set of items (the whole subject, or the items that apply to one leg). */
export function rollup(items: ComplianceItem[]) {
  // a snoozed item still names itself when it blocks (the snooze only quiets the reminder)
  const real = (i: ComplianceItem) => (i.status === "snoozed" ? (i.underlying ?? "ok") : i.status);
  const expired = items.filter((i) => real(i) === "expired").map((i) => i.label);
  const expiring = items.filter((i) => i.status === "expiring").map((i) => i.label);
  const missing = items.filter((i) => i.status === "missing" || (i.status === "snoozed" && i.underlying === "missing" && i.blocksDispatch)).map((i) => i.label);
  // A snooze hides the reminder, never the block: a snoozed item counts as what it really is.
  // A missing built-in date blocks only when the company says so ("missing dates block dispatch");
  // expired ones and missing required documents always do.
  const dispatchable = !items.some((i) => i.blocksDispatch && (real(i) === "expired" || (real(i) === "missing" && (!isBuiltIn(i.key) || !!i.blocksWhenMissing))));
  return { expired, expiring, missing, dispatchable };
}

/** A subject's status as it applies to one leg type: a FAST card scoped to the crossing does not block a US run. */
export function forLeg<T extends { items: ComplianceItem[] }>(st: T, legType: LegZone | string | null | undefined): T & ReturnType<typeof rollup> {
  if (!legType) return { ...st, ...rollup(st.items) };
  return { ...st, ...rollup(st.items.filter((i) => scopeMatches(i.legScope, legType))) };
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
  const strictMissing = !!(tenant?.settings as Record<string, unknown> | null)?.missingDatesBlock;

  for (const t of types) {
    const doc = docs.filter((d) => d.documentTypeId === t.id).sort((p, q) => (q.expiresAt?.getTime() ?? 0) - (p.expiresAt?.getTime() ?? 0))[0];
    const alertDays = Math.max(...(t.alertDays.length ? t.alertDays : [30]));
    const graceOpen = !!t.graceUntil && t.graceUntil.getTime() > now.getTime();
    let status: ComplianceItem["status"] = doc ? statusOf(doc.expiresAt, alertDays, now, t.tracksExpiry) : t.required ? "missing" : "ok";
    const snooze = snoozes.find((z) => z.itemKey === t.id);
    const underlying = status === "ok" ? null : (status as "expiring" | "expired" | "missing");
    if (snooze && status !== "ok") status = "snoozed";
    items.push({ key: t.id, label: t.name, status, underlying: snooze ? underlying : null, expiresAt: doc?.expiresAt?.toISOString() ?? null, documentId: doc?.id ?? null, blocksDispatch: t.blocksDispatch && !graceOpen, required: t.required, alertDays, snoozedUntil: snooze?.until.toISOString() ?? null, snoozeReason: snooze?.reason ?? null, legScope: t.legScope ?? null });
  }
  for (const f of FIELD_ITEMS[kind]) {
    if (f.appliesWhen && !f.appliesWhen(r)) continue;
    const d = r[f.key] as Date | null;
    // an optional date left blank is "not on file", never a green "ok"
    let status: ComplianceItem["status"] = d ? statusOf(d, 30, now, true) : f.blocks ? "missing" : "na";
    const snooze = snoozes.find((z) => z.itemKey === `field:${f.key}`);
    const underlying = status === "ok" || status === "na" ? null : (status as "expiring" | "expired" | "missing");
    if (snooze && underlying) status = "snoozed";
    items.push({ key: `field:${f.key}`, label: f.label, status, underlying: snooze ? underlying : null, blocksWhenMissing: f.blocks && strictMissing, expiresAt: d?.toISOString() ?? null, documentId: null, blocksDispatch: f.blocks, required: true, alertDays: 30, snoozedUntil: snooze?.until.toISOString() ?? null, snoozeReason: snooze?.reason ?? null });
  }
  if (kind === "driver") items.push(...(await driverSafetyItems(ctx, r, subjectId, strictMissing, now)));
  const { expired, expiring, missing, dispatchable } = rollup(items);
  const [existing] = await db.select({ id: s.complianceStatus.id }).from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  const row = { dispatchable, expired, expiring, missing, items, ranAt: now };
  if (existing) await db.update(s.complianceStatus).set(row).where(eq(s.complianceStatus.id, existing.id));
  else await db.insert(s.complianceStatus).values({ id: newId(), tenantId: ctx.tenantId, subjectKind: kind, subjectId, ...row });
  return { kind, subjectId, ...row };
}

/** The qualification file and the drug & alcohol standing of a driver, as compliance items. */
async function driverSafetyItems(ctx: Ctx, driver: Record<string, unknown>, driverId: string, strictMissing: boolean, now: Date) {
  const [records, tests] = await Promise.all([
    db.select().from(s.dqRecords).where(and(eq(s.dqRecords.tenantId, ctx.tenantId), eq(s.dqRecords.driverId, driverId))),
    db.select().from(s.daTests).where(and(eq(s.daTests.tenantId, ctx.tenantId), eq(s.daTests.driverId, driverId))),
  ]);
  const standing = daStanding(tests);
  const lines = dqLines({ driverType: String(driver.driverType), licenseState: driver.licenseState as string | null, hireDate: driver.hireDate as Date | null }, records, standing.preEmploymentNegativeAt, now);
  return [...dqComplianceItems(lines, strictMissing), daComplianceItem(standing.prohibited)];
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

export type ComplianceRead = { dispatchable: boolean; expired: string[]; expiring: string[]; missing: string[]; items: ComplianceItem[]; ranAt: Date; override: { reason: string; expiresAt: Date } | null };

/** Read the stored result (evaluating on first sight). Includes any live 24-h override. */
export async function statusFor(ctx: Ctx, kind: SubjectKind, subjectId: string): Promise<ComplianceRead> {
  assertCtx(ctx);
  let [row] = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  if (!row) {
    await evaluateSubject(ctx, kind, subjectId);
    [row] = await db.select().from(s.complianceStatus).where(and(eq(s.complianceStatus.tenantId, ctx.tenantId), eq(s.complianceStatus.subjectKind, kind), eq(s.complianceStatus.subjectId, subjectId))).limit(1);
  }
  const [ov] = await db.select().from(s.complianceOverrides).where(and(eq(s.complianceOverrides.tenantId, ctx.tenantId), eq(s.complianceOverrides.subjectKind, kind), eq(s.complianceOverrides.subjectId, subjectId), gt(s.complianceOverrides.expiresAt, new Date()))).orderBy(desc(s.complianceOverrides.createdAt)).limit(1);
  return { dispatchable: row.dispatchable, expired: row.expired, expiring: row.expiring, missing: row.missing, items: row.items, ranAt: row.ranAt, override: ov ? { reason: ov.reason, expiresAt: ov.expiresAt } : null };
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
  if (!doc || !doc.documentTypeId) throw new NotFoundError("document", documentId);
  if (doc.status !== "pending") throw new ValidationError(`this document is ${doc.status}, not waiting for review`);
  const kind = doc.subjectKind as SubjectKind;
  const [type] = await db.select().from(s.documentTypes).where(eq(s.documentTypes.id, doc.documentTypeId)).limit(1);
  if (!type) throw new NotFoundError("document type", doc.documentTypeId);
  if (decision === "reject") {
    if (!input.reason?.trim()) throw new ValidationError("tell the driver what is wrong (blurry, wrong side, expired…)", "reason");
    await db.update(s.documents).set({ status: "rejected", notes: input.reason.trim(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, doc.id));
    await writeAudit(db, ctx, kind, doc.subjectId, "update", { [type.name]: { from: "pending review", to: "rejected" } }, input.reason.trim());
    return { ...doc, status: "rejected" as const };
  }
  const expiresAt = input.expiresAt === undefined ? doc.expiresAt : input.expiresAt;
  if (type.tracksExpiry && !expiresAt) throw new ValidationError(`${type.name} needs an expiry date`, "expiresAt");
  const row = await db.transaction(async (tx) => {
    const prior = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, kind), eq(s.documents.subjectId, doc.subjectId), eq(s.documents.documentTypeId, type.id), inArray(s.documents.status, ["present", "verified"])));
    for (const p of prior) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id));
    const [row] = await tx.update(s.documents).set({ status: "verified", expiresAt, issuedAt: input.issuedAt === undefined ? doc.issuedAt : input.issuedAt, number: input.number === undefined ? doc.number : input.number || null, notes: "Confirmed from the driver app", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, doc.id)).returning();
    await writeAudit(tx, ctx, kind, doc.subjectId, "update", { [type.name]: { from: prior[0]?.expiresAt ?? null, to: expiresAt ?? "present" } }, `${type.name} from the driver app confirmed`);
    return row;
  });
  await evaluateSubject(ctx, kind, doc.subjectId);
  return row;
}

/** What drivers sent from the app and nobody has looked at yet. */
export async function pendingUploads(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const rows = await db
    .select({ id: s.documents.id, subjectKind: s.documents.subjectKind, subjectId: s.documents.subjectId, documentTypeId: s.documents.documentTypeId, fileName: s.documents.fileName, expiresAt: s.documents.expiresAt, number: s.documents.number, createdAt: s.documents.createdAt, typeName: s.documentTypes.name, driverName: s.drivers.name })
    .from(s.documents)
    .leftJoin(s.documentTypes, eq(s.documentTypes.id, s.documents.documentTypeId))
    .leftJoin(s.drivers, eq(s.drivers.id, s.documents.subjectId))
    .where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.status, "pending")))
    .orderBy(s.documents.createdAt);
  return rows;
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
  if (st.expired.some((l) => HARD_BLOCK.test(l))) throw new ValidationError(`cannot override an expired legal document (${st.expired.join(", ")})`);
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
    const why = [...st.expired.map((x) => `${x} expired`), ...st.missing.map((x) => `${x} missing`)].join(", ");
    out.push({ level: "red", code: "compliance_block", message: `${label}: ${why}`, overridable: !st.expired.some((l) => HARD_BLOCK.test(l)) });
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
  const tiles = { expired: 0, expiring: 0, missing: 0, blocked: 0, subjects: 0, dq: 0, lastRun: null as Date | null };
  for (const r of status) {
    // the qualification file counts once per driver in its own tile, not item by item among the documents
    const docs = r.items.filter((i) => !i.key.startsWith("dq:"));
    const real = (i: ComplianceItem) => (i.status === "snoozed" ? i.underlying : i.status);
    tiles.subjects++;
    tiles.expired += docs.filter((i) => real(i) === "expired").length;
    tiles.expiring += docs.filter((i) => i.status === "expiring").length;
    tiles.missing += docs.filter((i) => real(i) === "missing").length;
    if (r.items.some((i) => i.key.startsWith("dq:") && (real(i) === "missing" || real(i) === "expired"))) tiles.dq++;
    if (!r.dispatchable) tiles.blocked++;
    if (!tiles.lastRun || r.ranAt > tiles.lastRun) tiles.lastRun = r.ranAt;
  }
  return { types, status, subjects, overrides, tiles };
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

/** Driver app: the driver's own expiring items (spec §6.3). */
export type DriverOwnItem = { key: string; label: string; status: string; expiresAt: string | null; documentTypeId: string | null; tracksExpiry: boolean; pending: { fileName: string; at: string } | null; rejected: { reason: string; at: string } | null };

/** What the driver sees under "Your documents": what is expiring, expired or missing, and what they already sent. */
export async function driverOwnItems(tenantId: string, driverId: string): Promise<DriverOwnItem[]> {
  const ctx = systemCtx(tenantId);
  const st = await statusFor(ctx, "driver", driverId).catch(() => null);
  if (!st) return [];
  const [types, sent] = await Promise.all([
    db.select({ id: s.documentTypes.id, tracksExpiry: s.documentTypes.tracksExpiry }).from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, tenantId), eq(s.documentTypes.appliesTo, "driver"))),
    db.select({ documentTypeId: s.documents.documentTypeId, status: s.documents.status, fileName: s.documents.fileName, notes: s.documents.notes, at: s.documents.updatedAt }).from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "driver"), eq(s.documents.subjectId, driverId), eq(s.documents.source, "driver_app"), inArray(s.documents.status, ["pending", "rejected"]))).orderBy(desc(s.documents.updatedAt)),
  ]);
  return st.items
    // the qualification file and the drug & alcohol program are the office's work, not uploads from the driver
    .filter((i) => !i.key.startsWith("dq:") && !i.key.startsWith("da:") && (i.status === "expiring" || i.status === "expired" || i.status === "missing"))
    .map((i) => {
      const typeId = i.key.startsWith("field:") ? null : i.key;
      const p = typeId ? sent.find((d) => d.documentTypeId === typeId && d.status === "pending") : null;
      const r = typeId && !p ? sent.find((d) => d.documentTypeId === typeId && d.status === "rejected") : null;
      return { key: i.key, label: i.label, status: i.status, expiresAt: i.expiresAt, documentTypeId: typeId, tracksExpiry: types.find((t) => t.id === typeId)?.tracksExpiry ?? false, pending: p ? { fileName: p.fileName, at: p.at.toISOString() } : null, rejected: r ? { reason: r.notes ?? "", at: r.at.toISOString() } : null };
    });
}

/** The driver sends a renewal from the app: a photo of the new card, the expiry they read off it. Waits for safety. */
export async function driverUploadRenewal(tenantId: string, driverId: string, input: { documentTypeId: string; fileName: string; mimeType: string; bytes: Buffer; expiresAt?: Date | null; number?: string | null }) {
  const ctx = systemCtx(tenantId);
  const [driver] = await db.select({ id: s.drivers.id }).from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  return uploadSubjectDocument(ctx, "driver", driverId, { ...input, source: "driver_app", status: "pending", notes: "Sent from the driver app — check the photo and confirm" });
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
