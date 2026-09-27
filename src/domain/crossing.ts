import { and, eq, inArray, desc, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { CrossingState, Requirement } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { newToken, publicUrl } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { checkDriver, checkTruck, summarize, type Finding } from "./eligibility";
import { NotFoundError, ValidationError } from "./orders";
import { TransitionError } from "./states";
import { buildPacketPdf, buildSolicitudRetiro } from "./crossing-pdf";

/**
 * Crossing (spec §3). One crossing per crossing leg. Requirements come from crossing_doc_rules
 * (base + port + customer), documents are uploaded or generated against them, the cross-checks
 * compare the fields on those documents with what dispatch assigned, and the state is derived from
 * all of that until the packet is sent — after which the truck's physical progress drives it.
 */

// ---------- rules ----------

export type RuleSeed = Omit<typeof s.crossingDocRules.$inferInsert, "id" | "tenantId">;

/** Base rules every new company starts with. Editable in Settings; per-port / per-customer rows override by code. */
export const DEFAULT_CROSSING_RULES: RuleSeed[] = [
  { code: "carta_retiro", label: "Carta de retiro (Solicitud de Retiro)", providedBy: "us", requiredWhen: "always", allowNa: false, packetOrder: 10 },
  { code: "carta_porte", label: "Carta porte (CFDI complemento)", providedBy: "mx_broker", requiredWhen: "brown_plates", allowNa: true, packetOrder: 20 },
  { code: "doda", label: "DODA", providedBy: "mx_broker", requiredWhen: "always", allowNa: false, lastDocument: true, packetOrder: 30 },
  { code: "entry", label: "US entry (7501 / pre-file)", providedBy: "us_broker", requiredWhen: "optional", allowNa: true, packetOrder: 40 },
  { code: "ace_manifest", label: "ACE e-Manifest", providedBy: "us_broker", requiredWhen: "always", allowNa: false, packetOrder: 50 },
  { code: "dtops", label: "DTOPS decal / single-crossing receipt", providedBy: "us", requiredWhen: "optional", allowNa: true, packetOrder: 60 },
  { code: "bol", label: "Bill of lading", providedBy: "shipper", requiredWhen: "always", allowNa: false, packetOrder: 70 },
  { code: "invoice", label: "Commercial invoice", providedBy: "shipper", requiredWhen: "always", allowNa: true, packetOrder: 80 },
  { code: "packing_list", label: "Packing list", providedBy: "shipper", requiredWhen: "optional", allowNa: true, packetOrder: 90 },
];

export const PROVIDED_BY_LABEL: Record<string, string> = { us: "us", shipper: "shipper", mx_broker: "MX customs broker", us_broker: "US customs broker", carrier: "carrier" };

/** Fields each document carries for the cross-checks (spec §3.3 / §3.4). Humans can always type them. */
export const DOC_FIELDS: Record<string, { key: string; label: string; kind?: "text" | "number" | "datetime" }[]> = {
  carta_retiro: [
    { key: "trailer", label: "Caja / trailer #" },
    { key: "unit", label: "Unidad / tractor #" },
    { key: "usPlate", label: "US plate" },
    { key: "mxPlate", label: "MX plate" },
    { key: "driver", label: "Operador(es)" },
  ],
  carta_porte: [
    { key: "trailer", label: "Trailer #" },
    { key: "usPlate", label: "US plate" },
    { key: "mxPlate", label: "MX plate" },
    { key: "seal", label: "Seal #" },
    { key: "uuid", label: "Folio fiscal (UUID)" },
    { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
    { key: "pieces", label: "Pieces", kind: "number" },
  ],
  doda: [
    { key: "trailer", label: "Trailer #" },
    { key: "seal", label: "Seal #" },
    { key: "uuid", label: "Folio fiscal / CFDI ref" },
    { key: "pedimento", label: "Pedimento #" },
    { key: "patente", label: "Patente" },
  ],
  entry: [
    { key: "pedimento", label: "Pedimento #" },
    { key: "entryNumber", label: "Entry #" },
  ],
  ace_manifest: [
    { key: "trailer", label: "Trailer #" },
    { key: "driver", label: "Driver name" },
    { key: "usPlate", label: "US plate" },
    { key: "mxPlate", label: "MX plate" },
    { key: "scac", label: "SCAC" },
    { key: "submittedAt", label: "Submitted at", kind: "datetime" },
    { key: "estimatedArrival", label: "Estimated arrival", kind: "datetime" },
    { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
    { key: "pieces", label: "Pieces", kind: "number" },
    { key: "fast", label: "FAST lane (yes/no)" },
  ],
  bol: [
    { key: "trailer", label: "Trailer #" },
    { key: "seal", label: "Seal #" },
    { key: "pieces", label: "Pieces", kind: "number" },
    { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
  ],
  invoice: [
    { key: "seal", label: "Seal #" },
    { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
    { key: "pieces", label: "Pieces", kind: "number" },
  ],
  dtops: [
    { key: "year", label: "Year", kind: "number" },
    { key: "confirmation", label: "Confirmation #" },
  ],
  packing_list: [{ key: "pieces", label: "Pieces", kind: "number" }],
};

export async function ensureDefaultRules(ctx: Ctx, tx: Tx | typeof db = db) {
  const existing = await tx.select({ id: s.crossingDocRules.id }).from(s.crossingDocRules).where(eq(s.crossingDocRules.tenantId, ctx.tenantId)).limit(1);
  if (existing.length) return false;
  await tx.insert(s.crossingDocRules).values(DEFAULT_CROSSING_RULES.map((r) => ({ ...r, id: newId(), tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId })));
  return true;
}

// ---------- state machine ----------

export const CROSSING_ORDER: CrossingState[] = ["created", "awaiting_mx_arrival", "at_border_yard", "docs_in_progress", "awaiting_doda", "docs_complete", "docs_verified", "eligibility_checked", "ready_to_cross", "packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "cleared"];
const PHYSICAL: CrossingState[] = ["packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "cleared"];
export const CROSSING_LABEL: Record<CrossingState, string> = {
  created: "New",
  awaiting_mx_arrival: "MX leg rolling",
  at_border_yard: "At border yard",
  docs_in_progress: "Docs in progress",
  awaiting_doda: "Waiting on DODA",
  docs_complete: "Docs complete",
  docs_verified: "Docs verified",
  eligibility_checked: "Eligibility OK",
  ready_to_cross: "Ready to cross",
  packet_sent: "Packet sent",
  departed_yard: "Departed yard",
  at_mx_customs: "At MX customs",
  in_us_customs: "In US customs",
  cleared: "Cleared",
  held: "Held",
  returned: "Returned to MX",
  cancelled: "Cancelled",
};
export type Bucket = "waiting" | "verify" | "ready" | "crossing" | "held" | "cleared";
export const BUCKET_LABEL: Record<Bucket, string> = { waiting: "Waiting on docs", verify: "Verify", ready: "Ready", crossing: "Crossing", held: "Held / returned", cleared: "Cleared" };
export function bucketOf(state: CrossingState): Bucket {
  if (["created", "awaiting_mx_arrival", "at_border_yard", "docs_in_progress", "awaiting_doda"].includes(state)) return "waiting";
  if (["docs_complete", "docs_verified", "eligibility_checked"].includes(state)) return "verify";
  if (["ready_to_cross", "packet_sent"].includes(state)) return "ready";
  if (["departed_yard", "at_mx_customs", "in_us_customs"].includes(state)) return "crossing";
  if (state === "held" || state === "returned") return "held";
  return "cleared";
}

// ---------- loaders ----------

type Crossing = typeof s.crossings.$inferSelect;

async function load(ctx: Ctx, crossingId: string, tx: Tx | typeof db = db): Promise<Crossing> {
  const [c] = await tx.select().from(s.crossings).where(and(eq(s.crossings.tenantId, ctx.tenantId), eq(s.crossings.id, crossingId))).limit(1);
  if (!c) throw new NotFoundError("crossing", crossingId);
  return c;
}

async function event(tx: Tx | typeof db, ctx: Ctx, crossingId: string, e: { kind: string; fromState?: string | null; toState?: string | null; source?: string; verified?: boolean; note?: string | null; data?: Record<string, unknown>; at?: Date }) {
  await tx.insert(s.crossingEvents).values({ id: newId(), tenantId: ctx.tenantId, crossingId, at: e.at ?? new Date(), kind: e.kind, fromState: e.fromState ?? null, toState: e.toState ?? null, source: e.source ?? (ctx.role === "system" ? "system" : "dispatcher"), verified: e.verified ?? false, userId: ctx.userId, note: e.note ?? null, data: e.data });
}

/** Create the crossing for a crossing leg if it does not exist. Called when orders are created and on first open. */
export async function ensureCrossing(ctx: Ctx, legId: string) {
  assertCtx(ctx);
  const [existing] = await db.select().from(s.crossings).where(and(eq(s.crossings.tenantId, ctx.tenantId), eq(s.crossings.legId, legId))).limit(1);
  if (existing) return existing;
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  if (leg.type !== "crossing") throw new ValidationError("only a crossing leg has a crossing");
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  await ensureDefaultRules(ctx);
  const [c] = await db
    .insert(s.crossings)
    .values({ id: newId(), tenantId: ctx.tenantId, legId, orderId: leg.orderId, portId: order.portId ?? null, state: "created", createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning();
  await event(db, ctx, c.id, { kind: "transition", toState: "created", source: "system" });
  await writeAudit(db, ctx, "crossing", c.id, "create", undefined, `crossing for ${order.orderNumber} leg ${leg.seq}`);
  await recompute(ctx, c.id);
  return load(ctx, c.id);
}

export async function ensureCrossingsForOrder(ctx: Ctx, orderId: string) {
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId), eq(s.legs.type, "crossing")));
  for (const l of legs) await ensureCrossing(ctx, l.id);
}

// ---------- requirements ----------

/** Rules → checklist rows. Port- and customer-specific rows override the base row with the same code. */
export async function computeRequirements(ctx: Ctx, c: Crossing): Promise<Requirement[]> {
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const rules = await db.select().from(s.crossingDocRules).where(and(eq(s.crossingDocRules.tenantId, ctx.tenantId), eq(s.crossingDocRules.enabled, true)));
  const byCode = new Map<string, typeof rules[number]>();
  const specificity = (r: typeof rules[number]) => (r.customerId ? 2 : 0) + (r.portId ? 1 : 0);
  for (const r of rules) {
    if (r.portId && r.portId !== c.portId) continue;
    if (r.customerId && r.customerId !== order?.customerId && r.customerId !== order?.brokerId) continue;
    const cur = byCode.get(r.code);
    if (!cur || specificity(r) > specificity(cur)) byCode.set(r.code, r);
  }
  const docs = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, c.id), inArray(s.documents.status, ["present", "verified"])));
  const prev = new Map(c.requirements.map((r) => [r.code, r]));
  const out: Requirement[] = [];
  for (const r of [...byCode.values()].sort((p, q) => p.packetOrder - q.packetOrder)) {
    const required = r.requiredWhen === "always" || (r.requiredWhen === "brown_plates" && (!truck || truck.mxPlateClass !== "blue"));
    if (r.requiredWhen === "never") continue;
    const doc = docs.filter((d) => d.code === r.code).sort((p, q) => q.version - p.version)[0];
    const old = prev.get(r.code);
    let status: Requirement["status"] = doc ? (doc.status === "verified" ? "verified" : "present") : "missing";
    const humanNa = !doc && old?.status === "na" && old.naReason !== "optional";
    if (humanNa && (r.allowNa || !required)) status = "na";
    else if (!doc && !required) status = "na"; // not required for this truck / rule = not needed
    out.push({ code: r.code, label: r.label, providedBy: r.providedBy, allowNa: r.allowNa || !required, status, documentId: doc?.id ?? null, naReason: status === "na" ? (humanNa ? old!.naReason : "optional") : null, packetOrder: r.packetOrder, lastDocument: r.lastDocument });
  }
  return out;
}

// ---------- documents ----------

export type UploadInput = { code: string; fileName: string; mimeType: string; bytes: Buffer; source?: string; fields?: Record<string, unknown>; notes?: string | null };

export async function uploadDocument(ctx: Ctx, crossingId: string, input: UploadInput) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!input.bytes?.length) throw new ValidationError("empty file", "file");
  if (input.bytes.length > 15 * 1024 * 1024) throw new ValidationError("file is over 15 MB", "file");
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(input.mimeType)) throw new ValidationError("PDF, JPG or PNG only", "file");
  const c = await load(ctx, crossingId);
  if (!DOC_FIELDS[input.code] && !c.requirements.some((r) => r.code === input.code)) throw new ValidationError(`unknown document type ${input.code}`, "code");
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const doc = await db.transaction(async (tx) => {
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: input.mimeType, sizeBytes: input.bytes.length, bytes: input.bytes }).returning({ id: s.documentBlobs.id });
    const prior = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, crossingId), eq(s.documents.code, input.code), inArray(s.documents.status, ["present", "verified"])));
    for (const p of prior) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, p.id));
    const version = (Math.max(0, ...prior.map((p) => p.version)) || 0) + 1;
    const extracted: Record<string, { value: unknown; confidence: number }> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) if (v !== undefined && v !== null && v !== "") extracted[k] = { value: v, confidence: 1 };
    const [row] = await tx
      .insert(s.documents)
      .values({ id: newId(), tenantId: ctx.tenantId, code: input.code, subjectKind: "crossing", subjectId: crossingId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: input.source ?? "upload", status: "present", version, extracted, notes: input.notes ?? null, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning();
    await event(tx, ctx, crossingId, { kind: "document", note: `${input.code} v${version} ${input.source ?? "uploaded"}: ${input.fileName}`, data: { documentId: row.id, code: input.code } });
    await writeAudit(tx, ctx, "document", row.id, "create", undefined, `${input.code} on crossing ${crossingId}`);
    return row;
  });
  await recompute(ctx, crossingId);
  return doc;
}

/** Type or correct the fields on a document; Confirm marks it verified. */
export async function setDocumentFields(ctx: Ctx, documentId: string, fields: Record<string, unknown>, confirm = false) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.id, documentId))).limit(1);
  if (!doc) throw new NotFoundError("document", documentId);
  const extracted = { ...(doc.extracted ?? {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete extracted[k];
    else extracted[k] = { value: v, confidence: 1 };
  }
  await db.update(s.documents).set({ extracted, status: confirm ? "verified" : doc.status === "verified" ? "present" : doc.status, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, documentId));
  await writeAudit(db, ctx, "document", documentId, "update", { fields: { from: Object.keys(doc.extracted ?? {}), to: Object.keys(extracted) } }, confirm ? "confirmed" : undefined);
  if (doc.subjectKind === "crossing") await recompute(ctx, doc.subjectId);
}

export async function markNotApplicable(ctx: Ctx, crossingId: string, code: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const c = await load(ctx, crossingId);
  const req = c.requirements.find((r) => r.code === code);
  if (!req) throw new NotFoundError("requirement", code);
  if (!req.allowNa) throw new ValidationError(`${req.label} cannot be marked n/a under the current rules`);
  const requirements = c.requirements.map((r) => (r.code === code ? { ...r, status: "na" as const, naReason: reason.trim(), documentId: null } : r));
  await db.update(s.crossings).set({ requirements, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await event(db, ctx, crossingId, { kind: "document", note: `${req.label} marked n/a: ${reason.trim()}` });
  await recompute(ctx, crossingId);
}

export async function undoNotApplicable(ctx: Ctx, crossingId: string, code: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const c = await load(ctx, crossingId);
  const requirements = c.requirements.map((r) => (r.code === code ? { ...r, status: "missing" as const, naReason: null } : r));
  await db.update(s.crossings).set({ requirements, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await recompute(ctx, crossingId);
}

export async function readBlob(ctx: Ctx, storageKey: string) {
  assertCtx(ctx);
  const id = storageKey.replace(/^blob:/, "");
  const [b] = await db.select().from(s.documentBlobs).where(and(eq(s.documentBlobs.tenantId, ctx.tenantId), eq(s.documentBlobs.id, id))).limit(1);
  if (!b) throw new NotFoundError("file", id);
  return b;
}

// ---------- cross-checks (spec §3.3) ----------

export const CHECK_LABEL: Record<string, string> = {
  trailer: "Trailer number matches on every document",
  tractor_plates: "Tractor plates match the assigned truck",
  driver: "Driver on the manifest is the assigned driver",
  seal: "Seal number matches BOL / invoice / carta porte / DODA",
  folio_fiscal: "Carta porte UUID matches the DODA folio",
  pedimento: "Pedimento on DODA matches the entry",
  weight: "Gross weight agrees across carta porte / manifest / invoice",
  pieces: "Piece counts agree across invoice / carta porte / manifest",
  patente: "Patente on DODA is the customer's MX broker",
  scac: "SCAC on the manifest is the entity the truck runs under",
  plate_class: "Plate class rule: brown plates need a carta porte",
  expiry: "No driver / truck document expires before the crossing",
  dtops: "DTOPS on file for this truck and year",
  timing: "ACE manifest filed at least 1 h before arrival (30 min FAST)",
};

/** jsonb reorders keys, so compare values by content. */
const canon = (o: unknown): string => JSON.stringify(o, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : 1))) : v));

type CheckResult = { code: string; state: "pass" | "fail" | "skipped"; message: string; values: Record<string, unknown> };

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase().replace(/[\s\-]/g, "");
const words = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(String(v).replace(/[^0-9.]/g, "")));

export function runChecksPure(input: {
  now: Date;
  docs: Record<string, Record<string, unknown>>; // code → fields
  trailerNumber: string | null;
  truck: { unitNumber: string; usPlate: string | null; mxPlate: string | null; mxPlateClass: string | null; scac: string | null; entityScac: string | null; dtopsYear: number | null; dtopsConfirmation: string | null; usPlateExpires: Date | null; mxPlateExpires: Date | null; dotInspectionExpires: Date | null } | null;
  driver: { name: string; licenseExpires: Date | null; mxLicenseExpires: Date | null; medicalExpires: Date | null; fastExpires: Date | null; i94Until: Date | null } | null;
  mxBrokerPatente: string | null;
  weightTolerancePct?: number;
  requireSeal?: boolean;
}): CheckResult[] {
  const { docs, truck, driver } = input;
  const out: CheckResult[] = [];
  const has = (code: string) => !!docs[code];
  const field = (code: string, key: string) => docs[code]?.[key];
  const compareAcross = (code: string, key: string, sources: string[], extra?: { label: string; value: unknown }) => {
    const vals: Record<string, unknown> = {};
    for (const src of sources) if (has(src) && field(src, key) !== undefined && field(src, key) !== "") vals[src] = field(src, key);
    if (extra && extra.value) vals[extra.label] = extra.value;
    const distinct = new Set(Object.values(vals).map(norm).filter(Boolean));
    if (Object.keys(vals).length < 2) return out.push({ code, state: "skipped", message: "not enough documents to compare yet", values: vals });
    if (distinct.size > 1) return out.push({ code, state: "fail", message: `${key} differs: ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(", ")}`, values: vals });
    out.push({ code, state: "pass", message: `${key} agrees (${[...distinct][0]})`, values: vals });
  };

  compareAcross("trailer", "trailer", ["carta_retiro", "carta_porte", "doda", "ace_manifest", "bol"], { label: "assigned", value: input.trailerNumber });
  // plates
  {
    const vals: Record<string, unknown> = {};
    for (const src of ["carta_porte", "ace_manifest", "carta_retiro"]) {
      if (field(src, "usPlate")) vals[`${src}.us`] = field(src, "usPlate");
      if (field(src, "mxPlate")) vals[`${src}.mx`] = field(src, "mxPlate");
    }
    if (!truck || !Object.keys(vals).length) out.push({ code: "tractor_plates", state: "skipped", message: truck ? "no plates on any document yet" : "no truck assigned", values: vals });
    else {
      const bad = Object.entries(vals).filter(([k, v]) => (k.endsWith(".us") ? norm(v) !== norm(truck.usPlate) : norm(v) !== norm(truck.mxPlate)));
      out.push(bad.length ? { code: "tractor_plates", state: "fail", message: `plates differ from unit ${truck.unitNumber} (US ${truck.usPlate ?? "—"} / MX ${truck.mxPlate ?? "—"}): ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`, values: { ...vals, truck: `${truck.usPlate}/${truck.mxPlate}` } } : { code: "tractor_plates", state: "pass", message: `plates match unit ${truck.unitNumber}`, values: vals });
    }
  }
  // driver
  {
    const m = field("ace_manifest", "driver");
    if (!m || !driver) out.push({ code: "driver", state: "skipped", message: !driver ? "no driver assigned" : "no driver on the manifest yet", values: {} });
    else {
      const a = words(m);
      const b = words(driver.name);
      const overlap = a.filter((w) => b.includes(w)).length;
      const ok = overlap >= Math.min(2, b.length);
      out.push({ code: "driver", state: ok ? "pass" : "fail", message: ok ? `manifest driver ${m} is ${driver.name}` : `manifest shows ${m}, assigned driver is ${driver.name}`, values: { manifest: m, assigned: driver.name } });
    }
  }
  // seal
  {
    const vals: Record<string, unknown> = {};
    for (const src of ["bol", "invoice", "carta_porte", "doda"]) if (field(src, "seal")) vals[src] = field(src, "seal");
    const distinct = new Set(Object.values(vals).map(norm));
    if (!Object.keys(vals).length) out.push({ code: "seal", state: input.requireSeal ? "fail" : "skipped", message: input.requireSeal ? "customer requires a seal and none is recorded" : "no seal recorded yet", values: vals });
    else if (distinct.size > 1) out.push({ code: "seal", state: "fail", message: `seal differs: ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(", ")}`, values: vals });
    else out.push({ code: "seal", state: Object.keys(vals).length >= 2 ? "pass" : "skipped", message: Object.keys(vals).length >= 2 ? `seal ${[...distinct][0]} agrees` : `seal only on ${Object.keys(vals)[0]} so far`, values: vals });
  }
  compareAcross("folio_fiscal", "uuid", ["carta_porte", "doda"]);
  if (has("doda") && field("doda", "pedimento") && !has("entry")) out.push({ code: "pedimento", state: "pass", message: `pedimento ${field("doda", "pedimento")} on the DODA; no entry to compare (optional)`, values: { doda: field("doda", "pedimento") } });
  else compareAcross("pedimento", "pedimento", ["doda", "entry"]);
  // weight with tolerance
  {
    const tol = input.weightTolerancePct ?? 2;
    const vals: Record<string, number> = {};
    for (const src of ["carta_porte", "ace_manifest", "invoice", "bol"]) {
      const n = num(field(src, "grossWeight"));
      if (n != null && Number.isFinite(n)) vals[src] = n;
    }
    const ns = Object.values(vals);
    if (ns.length < 2) out.push({ code: "weight", state: "skipped", message: "weights on fewer than two documents", values: vals });
    else {
      const max = Math.max(...ns);
      const min = Math.min(...ns);
      const pct = max ? ((max - min) / max) * 100 : 0;
      out.push({ code: "weight", state: pct <= tol ? "pass" : "fail", message: pct <= tol ? `weights within ${tol}% (${min}–${max} kg)` : `weights differ by ${pct.toFixed(1)}%: ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(", ")}`, values: vals });
    }
  }
  compareAcross("pieces", "pieces", ["invoice", "carta_porte", "ace_manifest", "bol", "packing_list"]);
  // patente
  {
    const p = field("doda", "patente");
    if (!p || !input.mxBrokerPatente) out.push({ code: "patente", state: "skipped", message: !p ? "no patente on the DODA yet" : "customer has no MX broker patente on file", values: { doda: p ?? null, broker: input.mxBrokerPatente } });
    else out.push({ code: "patente", state: norm(p) === norm(input.mxBrokerPatente) ? "pass" : "fail", message: norm(p) === norm(input.mxBrokerPatente) ? `patente ${p} is the customer's broker` : `DODA patente ${p} is not the customer's broker (${input.mxBrokerPatente})`, values: { doda: p, broker: input.mxBrokerPatente } });
  }
  // scac
  {
    const m = field("ace_manifest", "scac");
    const ours = truck?.scac || truck?.entityScac || null;
    if (!m || !ours) out.push({ code: "scac", state: "skipped", message: !m ? "no SCAC on the manifest yet" : "no SCAC on the truck or its entity", values: { manifest: m ?? null, truck: ours } });
    else out.push({ code: "scac", state: norm(m) === norm(ours) ? "pass" : "fail", message: norm(m) === norm(ours) ? `manifest SCAC ${m} matches` : `manifest shows ${m}; unit ${truck?.unitNumber} runs under ${ours}`, values: { manifest: m, truck: ours } });
  }
  // plate class rule
  {
    if (!truck) out.push({ code: "plate_class", state: "skipped", message: "no truck assigned", values: {} });
    else if (truck.mxPlateClass === "brown" && !has("carta_porte")) out.push({ code: "plate_class", state: "fail", message: `unit ${truck.unitNumber} has brown plates and there is no carta porte`, values: { plateClass: "brown", cartaPorte: false } });
    else out.push({ code: "plate_class", state: "pass", message: truck.mxPlateClass === "brown" ? "brown plates with carta porte" : `${truck.mxPlateClass ?? "no"} plates`, values: { plateClass: truck.mxPlateClass, cartaPorte: has("carta_porte") } });
  }
  // expiry
  {
    const expired: string[] = [];
    const chk = (label: string, d: Date | null | undefined) => d && d.getTime() < input.now.getTime() && expired.push(`${label} (${d.toISOString().slice(0, 10)})`);
    if (truck) {
      chk("US plate", truck.usPlateExpires);
      chk("MX plate", truck.mxPlateExpires);
      chk("annual inspection", truck.dotInspectionExpires);
    }
    if (driver) {
      chk("licence", driver.licenseExpires);
      chk("licencia federal", driver.mxLicenseExpires);
      chk("medical", driver.medicalExpires);
      chk("FAST", driver.fastExpires);
      chk("I-94", driver.i94Until);
    }
    out.push(!truck && !driver ? { code: "expiry", state: "skipped", message: "no truck or driver assigned", values: {} } : expired.length ? { code: "expiry", state: "fail", message: `expired: ${expired.join(", ")}`, values: { expired } } : { code: "expiry", state: "pass", message: "nothing expired", values: {} });
  }
  // dtops
  {
    const year = input.now.getUTCFullYear();
    const onDoc = has("dtops");
    const onTruck = !!truck && truck.dtopsYear === year && !!truck.dtopsConfirmation;
    out.push(!truck ? { code: "dtops", state: "skipped", message: "no truck assigned", values: {} } : onDoc || onTruck ? { code: "dtops", state: "pass", message: onTruck ? `DTOPS ${year} on the truck record (${truck.dtopsConfirmation})` : "DTOPS receipt in the packet", values: { year, onTruck, onDoc } } : { code: "dtops", state: "fail", message: `no DTOPS ${year} decal or receipt for unit ${truck.unitNumber}`, values: { year } });
  }
  // timing
  {
    const sub = field("ace_manifest", "submittedAt");
    const eta = field("ace_manifest", "estimatedArrival");
    const fast = /^(y|yes|si|sí|true|1)$/i.test(String(field("ace_manifest", "fast") ?? ""));
    const a = sub ? new Date(String(sub)) : null;
    const b = eta ? new Date(String(eta)) : null;
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) out.push({ code: "timing", state: "skipped", message: "manifest submitted / arrival times not recorded", values: { submittedAt: sub ?? null, estimatedArrival: eta ?? null } });
    else {
      const minutes = (b.getTime() - a.getTime()) / 60000;
      const need = fast ? 30 : 60;
      out.push({ code: "timing", state: minutes >= need ? "pass" : "fail", message: minutes >= need ? `manifest filed ${Math.round(minutes)} min before arrival` : `manifest filed only ${Math.round(minutes)} min before arrival; earliest allowed arrival ${new Date(a.getTime() + need * 60000).toISOString()}`, values: { submittedAt: a.toISOString(), estimatedArrival: b.toISOString(), fast, need } });
    }
  }
  return out;
}

export async function runChecks(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const entity = truck?.entityId ? (await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, truck.entityId)).limit(1))[0] : null;
  const driver = leg?.driverId ? (await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1))[0] : null;
  const customer = order?.customerId ? (await db.select().from(s.customers).where(eq(s.customers.id, order.customerId)).limit(1))[0] : null;
  const broker = customer?.mxBrokerId ? (await db.select().from(s.customsBrokers).where(eq(s.customsBrokers.id, customer.mxBrokerId)).limit(1))[0] : null;
  const docs = await db.select().from(s.documents).where(and(eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, crossingId), inArray(s.documents.status, ["present", "verified"])));
  const byCode: Record<string, Record<string, unknown>> = {};
  for (const d of docs) if (d.code) byCode[d.code] = Object.fromEntries(Object.entries(d.extracted ?? {}).map(([k, v]) => [k, v.value]));
  const results = runChecksPure({
    now: new Date(),
    docs: byCode,
    trailerNumber: c.trailerNumber,
    truck: truck ? { unitNumber: truck.unitNumber, usPlate: truck.usPlate, mxPlate: truck.mxPlate, mxPlateClass: truck.mxPlateClass, scac: truck.scac, entityScac: entity?.scac ?? null, dtopsYear: truck.dtopsYear, dtopsConfirmation: truck.dtopsConfirmation, usPlateExpires: truck.usPlateExpires, mxPlateExpires: truck.mxPlateExpires, dotInspectionExpires: truck.dotInspectionExpires } : null,
    driver: driver ? { name: driver.name, licenseExpires: driver.licenseExpires, mxLicenseExpires: driver.mxLicenseExpires, medicalExpires: driver.medicalExpires, fastExpires: driver.fastExpires, i94Until: driver.i94Until } : null,
    mxBrokerPatente: broker?.patente ?? null,
    requireSeal: !!customer?.requiredDocs?.includes("SEAL"),
  });
  const existing = await db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, crossingId));
  for (const r of results) {
    const prev = existing.find((e) => e.code === r.code);
    // an override survives while the compared values are unchanged
    const keepOverride = prev?.state === "overridden" && r.state === "fail" && canon(prev.values) === canon(r.values);
    const state = keepOverride ? "overridden" : r.state;
    if (prev) await db.update(s.crossingChecks).set({ state, message: r.message, values: r.values, ranAt: new Date(), ...(keepOverride ? {} : { overrideReason: null, overrideBy: null, overrideAt: null }) }).where(eq(s.crossingChecks.id, prev.id));
    else await db.insert(s.crossingChecks).values({ id: newId(), tenantId: ctx.tenantId, crossingId, code: r.code, state, message: r.message, values: r.values });
  }
  return db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, crossingId));
}

export async function overrideCheck(ctx: Ctx, crossingId: string, code: string, reason: string) {
  assertCtx(ctx);
  if (!(ctx.role === "owner" || ctx.role === "mx_office" || ctx.role === "system")) requirePermission(ctx, "dispatch.override");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const [chk] = await db.select().from(s.crossingChecks).where(and(eq(s.crossingChecks.tenantId, ctx.tenantId), eq(s.crossingChecks.crossingId, crossingId), eq(s.crossingChecks.code, code))).limit(1);
  if (!chk) throw new NotFoundError("check", code);
  if (chk.state !== "fail") throw new ValidationError("only a failed check can be overridden");
  await db.update(s.crossingChecks).set({ state: "overridden", overrideReason: reason.trim(), overrideBy: ctx.userId, overrideAt: new Date() }).where(eq(s.crossingChecks.id, chk.id));
  await event(db, ctx, crossingId, { kind: "check", note: `override ${code}: ${reason.trim()}` });
  await writeAudit(db, ctx, "crossing", crossingId, "override", { check: { from: "fail", to: "overridden" } }, `${code}: ${reason.trim()}`);
  await recompute(ctx, crossingId);
}

// ---------- eligibility (Plan §7) ----------

export async function runEligibility(ctx: Ctx, c: Crossing) {
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const findings: Finding[] = [];
  if (!leg?.truckId) findings.push({ level: "red", code: "no_truck", message: "no crossing truck assigned", overridable: false });
  else {
    const [truck] = await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1);
    if (truck) findings.push(...checkTruck(truck, "crossing"));
  }
  if (!leg?.driverId) findings.push({ level: "red", code: "no_driver", message: "no crossing driver assigned", overridable: false });
  else {
    const [d] = await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1);
    if (d) findings.push(...checkDriver(d, "crossing"));
    if (leg.coDriverId) {
      const [co] = await db.select().from(s.drivers).where(eq(s.drivers.id, leg.coDriverId)).limit(1);
      if (co) findings.push(...checkDriver(co, "crossing"));
    }
  }
  const sum = summarize(findings);
  return { ok: sum.ok, hardBlocked: sum.hardBlocked, findings, at: new Date().toISOString() };
}

// ---------- derived state ----------

async function setState(tx: Tx | typeof db, ctx: Ctx, c: Crossing, to: CrossingState, e: { source?: string; verified?: boolean; note?: string | null; at?: Date } = {}, extra: Partial<typeof s.crossings.$inferInsert> = {}) {
  if (c.state === to) return c;
  const [after] = await tx
    .update(s.crossings)
    .set({ state: to, previousState: c.state, updatedAt: new Date(), updatedBy: ctx.userId, ...extra })
    .where(eq(s.crossings.id, c.id))
    .returning();
  await event(tx, ctx, c.id, { kind: "transition", fromState: c.state, toState: to, source: e.source, verified: e.verified, note: e.note, at: e.at });
  await writeAudit(tx, ctx, "crossing", c.id, "transition", { state: { from: c.state, to } }, e.note ?? undefined);
  return after;
}

/** Recompute requirements, checks, eligibility, and the document-driven state (1–9). Physical states are left alone. */
export async function recompute(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  let c = await load(ctx, crossingId);
  if (!c.arrivedYardAt) {
    // the dwell clock starts when the trailer is at the border yard: the crossing leg's pickup stop was reached
    const [leg] = await db.select({ fromStopId: s.legs.fromStopId }).from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
    const st = leg?.fromStopId ? (await db.select({ arrivedAt: s.stops.arrivedAt }).from(s.stops).where(eq(s.stops.id, leg.fromStopId)).limit(1))[0] : null;
    if (st?.arrivedAt) {
      await db.update(s.crossings).set({ arrivedYardAt: st.arrivedAt }).where(eq(s.crossings.id, crossingId));
      await event(db, ctx, crossingId, { kind: "note", note: "trailer at the border yard — dwell clock started", source: "system", at: st.arrivedAt });
      c = { ...c, arrivedYardAt: st.arrivedAt };
    }
  }
  const requirements = await computeRequirements(ctx, c);
  const eligibility = await runEligibility(ctx, c);
  await db.update(s.crossings).set({ requirements, eligibility, updatedAt: new Date() }).where(eq(s.crossings.id, crossingId));
  c = { ...c, requirements, eligibility };
  const checks = await runChecks(ctx, crossingId);
  if (PHYSICAL.includes(c.state) || ["held", "returned", "cancelled"].includes(c.state)) {
    // spec 3.5: a rule change can add a row while docs are in flight — surface it, but do not yank a moving truck backwards
    return load(ctx, crossingId);
  }
  const required = requirements.filter((r) => r.status !== "na");
  const present = required.filter((r) => r.status === "present" || r.status === "verified");
  const anyDoc = requirements.some((r) => r.status === "present" || r.status === "verified");
  const missingOnlyLast = required.length > 0 && required.every((r) => r.status !== "missing" || r.lastDocument) && required.some((r) => r.status === "missing" && r.lastDocument);
  const docsComplete = required.length > 0 && present.length === required.length;
  const checksClear = checks.every((k) => k.state !== "fail");
  const eligible = eligibility.ok || (!eligibility.hardBlocked && !!c.eligibilityOverride);
  let to: CrossingState;
  if (docsComplete && checksClear && eligible && c.packetBuiltAt) to = "ready_to_cross";
  else if (docsComplete && checksClear && eligible) to = "eligibility_checked";
  else if (docsComplete && checksClear) to = "docs_verified";
  else if (docsComplete) to = "docs_complete";
  else if (missingOnlyLast) to = "awaiting_doda";
  else if (anyDoc) to = "docs_in_progress";
  else if (c.arrivedYardAt) to = "at_border_yard";
  else {
    const [mx] = await db.select({ state: s.legs.state }).from(s.legs).where(and(eq(s.legs.orderId, c.orderId), eq(s.legs.type, "mx"))).limit(1);
    to = mx && ["loaded", "en_route", "at_delivery", "completed"].includes(mx.state) ? "awaiting_mx_arrival" : "created";
  }
  if (to !== c.state) await setState(db, ctx, c, to, { source: "system" });
  return load(ctx, crossingId);
}

export async function overrideEligibility(ctx: Ctx, crossingId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.override");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const c = await load(ctx, crossingId);
  if (c.eligibility?.hardBlocked) throw new ValidationError("a hard block cannot be overridden: fix the truck or driver");
  await db.update(s.crossings).set({ eligibilityOverride: { reason: reason.trim(), by: ctx.userId, at: new Date().toISOString() }, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await writeAudit(db, ctx, "crossing", crossingId, "override", { eligibility: { from: "red", to: "overridden" } }, reason.trim());
  await recompute(ctx, crossingId);
}

export async function setCrossingDetails(ctx: Ctx, crossingId: string, v: { trailerNumber?: string | null; sealNumber?: string | null; bridge?: string | null; portId?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const c = await load(ctx, crossingId);
  const patch: Record<string, unknown> = {};
  for (const k of ["trailerNumber", "sealNumber", "bridge", "portId"] as const) if (v[k] !== undefined) patch[k] = v[k] === "" ? null : v[k];
  await db.update(s.crossings).set({ ...patch, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await writeAudit(db, ctx, "crossing", crossingId, "update", Object.fromEntries(Object.entries(patch).map(([k, val]) => [k, { from: (c as unknown as Record<string, unknown>)[k] ?? null, to: val }])));
  await recompute(ctx, crossingId);
}

// ---------- yard arrival / physical steps ----------

export async function markArrivedYard(ctx: Ctx, crossingId: string, e: { source?: string; verified?: boolean; at?: Date } = {}) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  if (c.arrivedYardAt) return c;
  await db.update(s.crossings).set({ arrivedYardAt: e.at ?? new Date(), updatedAt: new Date() }).where(eq(s.crossings.id, crossingId));
  await event(db, ctx, crossingId, { kind: "note", note: "trailer at the border yard — dwell clock started", source: e.source, verified: e.verified, at: e.at });
  return recompute(ctx, crossingId);
}

const FORWARD: Partial<Record<CrossingState, CrossingState>> = { packet_sent: "departed_yard", departed_yard: "at_mx_customs", at_mx_customs: "in_us_customs", in_us_customs: "cleared" };
export const STEP_LABEL: Partial<Record<CrossingState, { en: string; es: string }>> = {
  departed_yard: { en: "Departed the yard", es: "Salí del patio" },
  at_mx_customs: { en: "At Mexican customs", es: "En aduana mexicana" },
  in_us_customs: { en: "At US customs", es: "En aduana americana" },
  cleared: { en: "Cleared — on the US side", es: "Liberado — lado americano" },
};

/** One physical step forward (driver tap, GPS, or dispatcher). Backwards needs the owner. */
export async function step(ctx: Ctx, crossingId: string, to: CrossingState, e: { source?: string; verified?: boolean; note?: string | null; at?: Date } = {}) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  if (to === "held" || to === "returned" || to === "cancelled") throw new ValidationError("use hold / markReturned / cancel");
  const expected = FORWARD[c.state];
  if (expected !== to) {
    const forwardIdx = CROSSING_ORDER.indexOf(to);
    const curIdx = CROSSING_ORDER.indexOf(c.state);
    if (forwardIdx < curIdx && ctx.role !== "owner" && ctx.role !== "system") throw new TransitionError("leg", c.state, to, "moving a crossing backwards needs the owner");
    if (forwardIdx > curIdx + 1 && !["gps", "system"].includes(e.source ?? "")) throw new TransitionError("leg", c.state, to, "one step at a time");
    if (curIdx < CROSSING_ORDER.indexOf("packet_sent") && !["gps", "system"].includes(e.source ?? "")) throw new TransitionError("leg", c.state, to, c.state === "ready_to_cross" ? "send the packet first" : "the packet is not ready");
  }
  const extra: Partial<typeof s.crossings.$inferInsert> = {};
  if (to === "departed_yard") extra.departedYardAt = e.at ?? new Date();
  if (to === "cleared") extra.clearedAt = e.at ?? new Date();
  if (to !== "cleared" && CROSSING_ORDER.indexOf(to) < CROSSING_ORDER.indexOf("packet_sent") && !c.packetSentAt && ["gps"].includes(e.source ?? "")) {
    // spec 3.5: truck crossing without the packet sent
    await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: c.orderId, legId: c.legId, code: "crossed_without_packet", level: "red", title: "Truck moving at the border without the packet sent", detail: `GPS put it at ${to} while the crossing was ${CROSSING_LABEL[c.state]}`, owner: "owner" });
  }
  return setState(db, ctx, c, to, e, extra);
}

export async function hold(ctx: Ctx, crossingId: string, reason: string, source = "dispatcher") {
  assertCtx(ctx);
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const c = await load(ctx, crossingId);
  if (c.state === "held") throw new TransitionError("leg", c.state, "held", "already on hold");
  await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: c.orderId, legId: c.legId, code: "crossing_hold", level: "red", title: `Crossing held: ${reason.trim()}`, detail: `was ${CROSSING_LABEL[c.state]}`, owner: "dispatch" });
  return setState(db, ctx, c, "held", { source, note: reason.trim() }, { heldReason: reason.trim(), heldAt: new Date() });
}

export async function release(ctx: Ctx, crossingId: string, note?: string) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  if (c.state !== "held") throw new TransitionError("leg", c.state, "release", "not on hold");
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.legId, c.legId), eq(s.flags.code, "crossing_hold"), isNull(s.flags.clearedAt)));
  const back = c.previousState && c.previousState !== "held" ? c.previousState : "docs_complete";
  const after = await setState(db, ctx, c, back, { note: note ?? `released after ${Math.round((Date.now() - (c.heldAt?.getTime() ?? Date.now())) / 60000)} min` }, { heldReason: null });
  return PHYSICAL.includes(back) ? after : recompute(ctx, crossingId);
}

export async function markReturned(ctx: Ctx, crossingId: string, reason: string, source = "dispatcher") {
  assertCtx(ctx);
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const c = await load(ctx, crossingId);
  await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: c.orderId, legId: c.legId, code: "crossing_returned", level: "red", title: `Returned to the MX side: ${reason.trim()}`, detail: `was ${CROSSING_LABEL[c.state]}`, owner: "dispatch" });
  return setState(db, ctx, c, "returned", { source, note: reason.trim() }, { returnedReason: reason.trim(), packetSentAt: null, packetAckAt: null });
}

/** After a return: fix the docs, then re-verify from docs_complete. */
export async function reverify(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  if (c.state !== "returned") throw new TransitionError("leg", c.state, "docs_complete", "only a returned crossing is re-verified");
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.legId, c.legId), eq(s.flags.code, "crossing_returned"), isNull(s.flags.clearedAt)));
  await setState(db, ctx, c, "docs_complete", { note: "re-verifying after return" }, { packetBuiltAt: null, packetStorageKey: null });
  return recompute(ctx, crossingId);
}

// ---------- packet ----------

export async function generateCartaRetiro(ctx: Ctx, crossingId: string, input: { yardName?: string | null; authorizedBy?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const c = await load(ctx, crossingId);
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const [tenant] = await db.select().from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const drivers = await db.select().from(s.drivers).where(inArray(s.drivers.id, [leg?.driverId, leg?.coDriverId].filter((x): x is string => !!x).length ? [leg!.driverId, leg!.coDriverId].filter((x): x is string => !!x) : ["-"]));
  const fromStop = leg?.fromStopId ? (await db.select().from(s.stops).where(eq(s.stops.id, leg.fromStopId)).limit(1))[0] : null;
  if (!c.trailerNumber) throw new ValidationError("enter the trailer (caja) number first", "trailerNumber");
  if (!truck) throw new ValidationError("assign the crossing truck first");
  if (!drivers.length) throw new ValidationError("assign the crossing driver first");
  const entity = truck.entityId ? (await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, truck.entityId)).limit(1))[0] : null;
  const data = {
    companyName: entity?.dba || entity?.legalName || tenant.name,
    legalName: entity?.legalName || tenant.name,
    date: new Date(),
    yardName: input.yardName || fromStop?.name || "patio",
    trailerNumber: c.trailerNumber,
    transfer: entity?.dba || tenant.name,
    drivers: drivers.map((d) => d.name),
    unitNumber: truck.unitNumber,
    usPlate: truck.usPlate ?? "",
    mxPlate: truck.mxPlate ?? "",
    orderNumber: order.orderNumber,
    authorizedBy: input.authorizedBy || "",
  };
  const bytes = await buildSolicitudRetiro(data);
  const doc = await uploadDocument(ctx, crossingId, { code: "carta_retiro", fileName: `Solicitud de retiro ${c.trailerNumber}.pdf`, mimeType: "application/pdf", bytes: Buffer.from(bytes), source: "generated", fields: { trailer: c.trailerNumber, unit: truck.unitNumber, usPlate: truck.usPlate ?? "", mxPlate: truck.mxPlate ?? "", driver: data.drivers.join(" / ") } });
  await setDocumentFields(ctx, doc.id, {}, true); // we made it; it is verified by construction
  return (await db.select().from(s.documents).where(eq(s.documents.id, doc.id)).limit(1))[0];
}

export async function buildPacket(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const c = await recompute(ctx, crossingId);
  if (!["eligibility_checked", "ready_to_cross"].includes(c.state)) throw new TransitionError("leg", c.state, "ready_to_cross", c.state === "docs_verified" ? "eligibility is not green" : c.state === "docs_complete" ? "a cross-check is failing" : "documents are missing");
  const ids = c.requirements.filter((r) => r.documentId).sort((p, q) => p.packetOrder - q.packetOrder).map((r) => r.documentId!);
  const docs = ids.length ? await db.select().from(s.documents).where(inArray(s.documents.id, ids)) : [];
  const parts: { name: string; mimeType: string; bytes: Uint8Array }[] = [];
  for (const id of ids) {
    const d = docs.find((x) => x.id === id)!;
    const blob = await readBlob(ctx, d.storageKey);
    parts.push({ name: `${c.requirements.find((r) => r.documentId === id)?.label ?? d.code}`, mimeType: d.mimeType, bytes: new Uint8Array(blob.bytes) });
  }
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const pdf = await buildPacketPdf({ title: `Crossing packet ${order.orderNumber}${c.trailerNumber ? ` · caja ${c.trailerNumber}` : ""}`, parts });
  const sha = createHash("sha256").update(pdf).digest("hex");
  const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
  await db.update(s.crossings).set({ packetStorageKey: `blob:${blob.id}`, packetBuiltAt: new Date(), packetToken: c.packetToken ?? newToken(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await event(db, ctx, crossingId, { kind: "packet", note: `packet built: ${parts.length} documents, ${(pdf.length / 1024).toFixed(0)} KB` });
  return recompute(ctx, crossingId);
}

export async function sendPacket(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const c = await recompute(ctx, crossingId);
  if (c.state !== "ready_to_cross") throw new TransitionError("leg", c.state, "packet_sent", c.packetBuiltAt ? "not ready to cross" : "build the packet first");
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  if (!leg?.driverId) throw new ValidationError("assign the crossing driver first");
  const [driver] = await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const link = publicUrl(`/p/${c.packetToken}`);
  const body = `${driver.name}: packet for ${order.orderNumber}${c.trailerNumber ? ` (caja ${c.trailerNumber})` : ""} is ready. Open it in your app or here: ${link}`;
  await enqueue(ctx, { channel: "whatsapp", to: driver.whatsapp || driver.phone || "driver", body, subjectKind: "crossing", subjectId: crossingId });
  await deliverQueued().catch(() => null);
  const after = await setState(db, ctx, c, "packet_sent", { note: `packet sent to ${driver.name}` }, { packetSentAt: new Date() });
  return after;
}

/** The driver opened the packet (ack). Token in the URL is the authorization. */
export async function packetByToken(token: string) {
  if (!token || token.length < 16) return null;
  const [c] = await db.select().from(s.crossings).where(eq(s.crossings.packetToken, token)).limit(1);
  if (!c || !c.packetStorageKey) return null;
  const ctx = systemCtx(c.tenantId);
  if (c.packetSentAt && !c.packetAckAt) {
    await db.update(s.crossings).set({ packetAckAt: new Date() }).where(eq(s.crossings.id, c.id));
    await event(db, ctx, c.id, { kind: "packet", note: "driver opened the packet", source: "driver_app" });
  }
  return { ctx, crossing: c };
}

// ---------- board / page loaders ----------

export async function crossingBoard(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const rows = await db
    .select({ c: s.crossings, orderNumber: s.orders.orderNumber, customerId: s.orders.customerId, brokerId: s.orders.brokerId, legState: s.legs.state, truckId: s.legs.truckId, driverId: s.legs.driverId })
    .from(s.crossings)
    .innerJoin(s.orders, eq(s.orders.id, s.crossings.orderId))
    .innerJoin(s.legs, eq(s.legs.id, s.crossings.legId))
    .where(and(eq(s.crossings.tenantId, ctx.tenantId), sql`${s.crossings.state} <> 'cancelled'`, sql`${s.orders.state} not in ('cancelled','paid','invoiced')`))
    .orderBy(desc(s.crossings.updatedAt))
    .limit(500);
  return rows;
}

export async function crossingPage(ctx: Ctx, crossingId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const c = await recompute(ctx, crossingId);
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const [checks, events, docs, port] = await Promise.all([
    db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, crossingId)),
    db.select().from(s.crossingEvents).where(eq(s.crossingEvents.crossingId, crossingId)).orderBy(desc(s.crossingEvents.at)).limit(200),
    db.select().from(s.documents).where(and(eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, crossingId))).orderBy(desc(s.documents.createdAt)),
    c.portId ? db.select().from(s.ports).where(eq(s.ports.id, c.portId)).limit(1).then((r) => r[0] ?? null) : Promise.resolve(null),
  ]);
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const driver = leg?.driverId ? (await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1))[0] : null;
  const coDriver = leg?.coDriverId ? (await db.select().from(s.drivers).where(eq(s.drivers.id, leg.coDriverId)).limit(1))[0] : null;
  const customer = order?.customerId ? (await db.select().from(s.customers).where(eq(s.customers.id, order.customerId)).limit(1))[0] : null;
  const broker = customer?.mxBrokerId ? (await db.select().from(s.customsBrokers).where(eq(s.customsBrokers.id, customer.mxBrokerId)).limit(1))[0] : null;
  const waitingOn = c.requirements.find((r) => r.status === "missing") ?? null;
  return { crossing: c, leg, order, checks, events, docs, port, truck, driver, coDriver, customer, broker, waitingOn };
}

/** Job: dwell watch (spec 3.5). Yellow at the threshold, red at 2×; once each. */
export async function flagDwell(now = new Date(), thresholdHours = 24) {
  const rows = await db.select().from(s.crossings).where(and(sql`${s.crossings.arrivedYardAt} is not null`, sql`${s.crossings.departedYardAt} is null`, sql`${s.crossings.state} not in ('cleared','cancelled')`));
  let flagged = 0;
  for (const c of rows) {
    const hours = (now.getTime() - c.arrivedYardAt!.getTime()) / 3600_000;
    if (hours < thresholdHours) continue;
    const level = hours >= thresholdHours * 2 ? "red" : "yellow";
    const [open] = await db.select().from(s.flags).where(and(eq(s.flags.legId, c.legId), eq(s.flags.code, "dwell"), isNull(s.flags.clearedAt))).limit(1);
    if (open && open.level === level) continue;
    if (open) await db.update(s.flags).set({ level, title: `At the border yard ${Math.round(hours)} h`, detail: `waiting on: ${c.requirements.find((r) => r.status === "missing")?.label ?? "—"}` }).where(eq(s.flags.id, open.id));
    else await db.insert(s.flags).values({ id: newId(), tenantId: c.tenantId, orderId: c.orderId, legId: c.legId, code: "dwell", level, title: `At the border yard ${Math.round(hours)} h`, detail: `waiting on: ${c.requirements.find((r) => r.status === "missing")?.label ?? "—"}`, owner: "mx_office" });
    flagged++;
  }
  return { flagged };
}

/** Job: packet sent but never opened (spec 3.5) → red after 30 min, once. */
export async function flagUnacknowledgedPackets(now = new Date(), minutes = 30) {
  const rows = await db.select().from(s.crossings).where(and(eq(s.crossings.state, "packet_sent"), isNull(s.crossings.packetAckAt), lt(s.crossings.packetSentAt, new Date(now.getTime() - minutes * 60000))));
  let flagged = 0;
  for (const c of rows) {
    const [open] = await db.select({ id: s.flags.id }).from(s.flags).where(and(eq(s.flags.legId, c.legId), eq(s.flags.code, "packet_unacked"), isNull(s.flags.clearedAt))).limit(1);
    if (open) continue;
    await db.insert(s.flags).values({ id: newId(), tenantId: c.tenantId, orderId: c.orderId, legId: c.legId, code: "packet_unacked", level: "red", title: `Packet not opened after ${minutes} min`, detail: "call the driver; resend by WhatsApp", owner: "dispatch" });
    flagged++;
  }
  return { flagged };
}

export { CROSSING_STATES } from "@/db/schema";
export type { Crossing };
