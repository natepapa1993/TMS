import { and, eq, inArray, desc, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { CrossingState, LegState, Requirement } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, can, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { newToken, publicUrl } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { checkDriver, checkTruck, summarize, type Finding } from "./eligibility";
import { NotFoundError, ValidationError } from "./orders";
import { TransitionError } from "./states";
import { buildPacketPdf, buildSolicitudRetiro } from "./crossing-pdf";
import { extractWithModel } from "@/integrations/extractor";

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
  // Mexico border (either direction)
  { code: "carta_retiro", label: "Carta de retiro (Solicitud de Retiro)", providedBy: "us", requiredWhen: "always", allowNa: false, packetOrder: 10, border: "mx", direction: "into_us" },
  { code: "carta_porte", label: "Carta porte (CFDI complemento)", providedBy: "mx_broker", requiredWhen: "brown_plates", allowNa: true, packetOrder: 20, border: "mx" },
  { code: "doda", label: "DODA", providedBy: "mx_broker", requiredWhen: "always", allowNa: false, lastDocument: true, packetOrder: 30, border: "mx" },
  // entering the US (from Mexico or Canada)
  { code: "entry", label: "US entry (7501 / pre-file / PAPS)", providedBy: "us_broker", requiredWhen: "always", allowNa: true, packetOrder: 40, border: "any", direction: "into_us" },
  { code: "ace_manifest", label: "ACE e-Manifest", providedBy: "us_broker", requiredWhen: "always", allowNa: false, packetOrder: 50, border: "any", direction: "into_us" },
  { code: "dtops", label: "DTOPS decal / single-crossing receipt", providedBy: "us", requiredWhen: "always", allowNa: true, packetOrder: 60, border: "any", direction: "into_us" },
  // entering Canada
  { code: "pars", label: "PARS / cargo control # (CA customs broker)", providedBy: "ca_broker", requiredWhen: "always", allowNa: false, lastDocument: true, packetOrder: 35, border: "ca", direction: "into_ca" },
  { code: "aci_emanifest", label: "ACI eManifest (CBSA)", providedBy: "us", requiredWhen: "always", allowNa: false, packetOrder: 45, border: "ca", direction: "into_ca" },
  { code: "cci", label: "Canada customs invoice (CCI)", providedBy: "shipper", requiredWhen: "optional", allowNa: true, packetOrder: 85, border: "ca", direction: "into_ca" },
  // every border
  { code: "bol", label: "Bill of lading", providedBy: "shipper", requiredWhen: "always", allowNa: false, packetOrder: 70, border: "any" },
  { code: "invoice", label: "Commercial invoice", providedBy: "shipper", requiredWhen: "always", allowNa: true, packetOrder: 80, border: "any" },
  { code: "packing_list", label: "Packing list", providedBy: "shipper", requiredWhen: "optional", allowNa: true, packetOrder: 90, border: "any" },
];

/** Which border a crossing is on: Canada when either side is Canada, otherwise Mexico. */
export const borderOf = (c: { fromCountry: string; toCountry: string }) => (c.fromCountry === "CA" || c.toCountry === "CA" ? "ca" : "mx");
/** A rule applies to a crossing when it is for that border (or any) and that direction (or any). */
export const ruleApplies = (r: { border?: string | null; direction?: string | null }, c: { fromCountry: string; toCountry: string }) => (!r.border || r.border === "any" || r.border === borderOf(c)) && (!r.direction || r.direction === "any" || r.direction === `into_${c.toCountry.toLowerCase()}`);

export const PROVIDED_BY_LABEL: Record<string, string> = { us: "us", shipper: "shipper", mx_broker: "MX customs broker", us_broker: "US customs broker", ca_broker: "CA customs broker", carrier: "carrier" };

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
  pars: [
    { key: "ccn", label: "Cargo control # (CCN)" },
    { key: "transactionNumber", label: "Transaction #" },
  ],
  aci_emanifest: [
    { key: "trailer", label: "Trailer #" },
    { key: "driver", label: "Driver name" },
    { key: "usPlate", label: "US plate" },
    { key: "caPlate", label: "CA plate" },
    { key: "ccn", label: "Cargo control # (CCN)" },
    { key: "submittedAt", label: "Submitted at", kind: "datetime" },
    { key: "estimatedArrival", label: "Estimated arrival", kind: "datetime" },
  ],
  cci: [
    { key: "pieces", label: "Pieces", kind: "number" },
    { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
  ],
};

export async function ensureDefaultRules(ctx: Ctx, tx: Tx | typeof db = db) {
  const existing = await tx.select({ code: s.crossingDocRules.code }).from(s.crossingDocRules).where(and(eq(s.crossingDocRules.tenantId, ctx.tenantId), isNull(s.crossingDocRules.portId), isNull(s.crossingDocRules.customerId)));
  // A company that started before a border was supported gets that border's documents added; its own edits stay.
  const have = new Set(existing.map((r) => r.code));
  const missing = DEFAULT_CROSSING_RULES.filter((r) => !have.has(r.code));
  if (!missing.length) return false;
  await tx.insert(s.crossingDocRules).values(missing.map((r) => ({ ...r, id: newId(), tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId })));
  return true;
}

// ---------- state machine ----------

export const CROSSING_ORDER: CrossingState[] = ["created", "awaiting_mx_arrival", "at_border_yard", "docs_in_progress", "awaiting_doda", "docs_complete", "docs_verified", "eligibility_checked", "ready_to_cross", "packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "cleared"];
const PHYSICAL: CrossingState[] = ["packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "cleared"];
/** Still on the paperwork (not sent, not rolling, not held or returned): a leg that rolls from here takes the crossing with it. */
const beforePacket = (st: CrossingState) => CROSSING_ORDER.indexOf(st) >= 0 && CROSSING_ORDER.indexOf(st) < CROSSING_ORDER.indexOf("packet_sent");
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
const COUNTRY_WORD: Record<string, { en: string; adj: string; es: string }> = { MX: { en: "MX", adj: "Mexican", es: "mexicana" }, US: { en: "US", adj: "US", es: "americana" }, CA: { en: "CA", adj: "Canadian", es: "canadiense" } };
const word = (c: string) => COUNTRY_WORD[c] ?? { en: c, adj: c, es: c };
/** The state label for this crossing's direction: "At MX customs" northbound from Mexico, "At US customs" / "In CA customs" going into Canada. */
export function crossingStateLabel(state: CrossingState, c?: { fromCountry: string; toCountry: string } | null): string {
  if (!c || (c.fromCountry === "MX" && c.toCountry === "US")) return CROSSING_LABEL[state];
  if (state === "awaiting_mx_arrival") return "Leg to the border rolling";
  if (state === "at_mx_customs") return `At ${word(c.fromCountry).en} customs`;
  if (state === "in_us_customs") return `In ${word(c.toCountry).en} customs`;
  if (state === "returned") return `Returned to ${word(c.fromCountry).en}`;
  if (state === "awaiting_doda" && borderOf(c) === "ca") return "Waiting on PARS";
  return CROSSING_LABEL[state];
}

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
  await tx.insert(s.crossingEvents).values({ id: newId(), tenantId: ctx.tenantId, crossingId, at: e.at ?? new Date(), kind: e.kind, fromState: e.fromState ?? null, toState: e.toState ?? null, source: e.source ?? (ctx.role === "system" ? "system" : "dispatcher"), verified: e.verified ?? false, userId: e.source === "system" ? null : ctx.userId, note: e.note ?? null, data: e.data });
}

/**
 * A partner transfer carrier on the crossing leg: the carrier, and what it told us when it accepted (driver, unit,
 * plates, caja) — the latest accepted tender. Null when our own truck runs it (or nobody does yet).
 */
export async function partnerOnLeg(leg: Pick<typeof s.legs.$inferSelect, "id" | "assigneeKind" | "carrierId"> | null | undefined) {
  if (!leg || leg.assigneeKind !== "carrier" || !leg.carrierId) return null;
  const [carrier] = await db.select().from(s.carriers).where(eq(s.carriers.id, leg.carrierId)).limit(1);
  if (!carrier) return null;
  const [tender] = await db.select().from(s.tenders).where(and(eq(s.tenders.legId, leg.id), eq(s.tenders.carrierId, carrier.id), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1);
  return { carrier, tender: tender ?? null };
}

const MX_STATE_NAME: Record<string, string> = { TAMS: "Tamaulipas", TAM: "Tamaulipas", TAMPS: "Tamaulipas", NL: "Nuevo León", COAH: "Coahuila", CHIH: "Chihuahua", SON: "Sonora", BC: "Baja California" };

/**
 * The caja number reached us from the field (a carrier's acceptance, a partner driver's drop at the border yard):
 * it goes onto the crossing(s) of this load at or after that leg, unless dispatch already typed another one — then
 * both are on the crossing's timeline for someone to settle. The seal, when given, goes on too.
 */
export async function cajaFromCarrier(ctx: Ctx, orderId: string, legId: string, caja: string, source: string, seal?: string | null) {
  assertCtx(ctx);
  const v = caja.trim().toUpperCase();
  if (!v) return 0;
  const [leg] = await db.select({ seq: s.legs.seq }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  const rows = await db.select({ c: s.crossings, seq: s.legs.seq }).from(s.crossings).innerJoin(s.legs, eq(s.legs.id, s.crossings.legId)).where(and(eq(s.crossings.tenantId, ctx.tenantId), eq(s.crossings.orderId, orderId)));
  let n = 0;
  for (const { c, seq } of rows) {
    if (seq < leg.seq || ["cleared", "cancelled"].includes(c.state)) continue;
    const patch: Partial<typeof s.crossings.$inferInsert> = {};
    if (!c.trailerNumber) patch.trailerNumber = v;
    if (seal?.trim() && !c.sealNumber) patch.sealNumber = seal.trim().toUpperCase();
    if (Object.keys(patch).length) {
      await db.update(s.crossings).set({ ...patch, updatedAt: new Date() }).where(eq(s.crossings.id, c.id));
      await writeAudit(db, ctx, "crossing", c.id, "update", Object.fromEntries(Object.entries(patch).map(([k, val]) => [k, { from: null, to: val }])), `from ${source}`);
    }
    const differs = c.trailerNumber && norm(c.trailerNumber) !== norm(v);
    await event(db, ctx, c.id, { kind: "note", note: differs ? `${source}: caja ${v} — the crossing has ${c.trailerNumber}; check which is right` : `${source}: caja ${v}${seal?.trim() ? `, seal ${seal.trim().toUpperCase()}` : ""}`, source: ctx.userId ? "dispatcher" : "carrier" });
    await recompute(ctx, c.id);
    n++;
  }
  return n;
}

/**
 * What the crossing leg's driver does next, as one ordered flow for the leg and the border (B3): the leg's own
 * steps up to picking up the caja at the yard (Loaded); then the border steps once the packet is sent — Departed
 * the yard (the leg is en route), at customs on each side, Cleared (the leg delivers at the yard on the other side).
 * No border step is offered before the caja is picked up. Pure; exhaustive over both state machines.
 */
export type CrossingNext = { kind: "leg"; to: LegState } | { kind: "border"; to: CrossingState } | { kind: "wait"; en: string; es: string } | { kind: "hold" } | { kind: "none" };
const LEG_NEXT: Partial<Record<LegState, LegState>> = { dispatched: "accepted", accepted: "en_route_to_pickup", en_route_to_pickup: "at_pickup", at_pickup: "loaded", loaded: "en_route", en_route: "at_delivery", at_delivery: "completed" };
export function crossingDriverNext(leg: LegState, x: CrossingState): CrossingNext {
  if (["completed", "cancelled", "unassigned", "planned", "declined"].includes(leg)) return { kind: "none" };
  if (x === "cancelled") return LEG_NEXT[leg] ? { kind: "leg", to: LEG_NEXT[leg]! } : { kind: "none" };
  if (x === "held") return { kind: "hold" };
  if (x === "returned") return { kind: "wait", en: "Returned at the border — call dispatch", es: "Regresado en la frontera — llama a despacho" };
  if (["dispatched", "accepted", "en_route_to_pickup", "at_pickup"].includes(leg)) return { kind: "leg", to: LEG_NEXT[leg]! };
  if (leg === "at_delivery") return { kind: "leg", to: "completed" };
  if (x === "cleared") return { kind: "leg", to: leg === "loaded" ? "en_route" : "at_delivery" };
  // loaded with no packet sent: the leg can still roll (a company that keeps its papers elsewhere); the border steps follow
  if (leg === "loaded") return x === "packet_sent" ? { kind: "border", to: "departed_yard" } : PHYSICAL.includes(x) ? { kind: "border", to: FORWARD[x]! } : { kind: "leg", to: "en_route" };
  // en route with the caja: the border steps, from wherever the crossing is
  if (x === "packet_sent" || !PHYSICAL.includes(x)) return { kind: "border", to: x === "packet_sent" ? "departed_yard" : "at_mx_customs" };
  return { kind: "border", to: FORWARD[x]! };
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
  const ends = await db.select({ id: s.stops.id, country: s.stops.country }).from(s.stops).where(inArray(s.stops.id, [leg.fromStopId, leg.toStopId].filter((x): x is string => !!x)));
  const fromCountry = (ends.find((x) => x.id === leg.fromStopId)?.country ?? "MX").toUpperCase();
  const toCountry = (ends.find((x) => x.id === leg.toStopId)?.country ?? "US").toUpperCase();
  const [c] = await db
    .insert(s.crossings)
    .values({ id: newId(), tenantId: ctx.tenantId, legId, orderId: leg.orderId, portId: order.portId ?? null, fromCountry, toCountry, state: "created", createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning();
  await event(db, ctx, c.id, { kind: "transition", toState: "created", source: "system" });
  await writeAudit(db, ctx, "crossing", c.id, "create", undefined, `crossing for ${order.orderNumber} leg ${leg.seq}`);
  await recompute(ctx, c.id);
  return load(ctx, c.id);
}

/** Every crossing leg on a live order has a crossing row. Self-heals data from before crossings existed or any path that skipped ensureCrossing. */
export async function backfillCrossings(ctx: Ctx) {
  assertCtx(ctx);
  const missing = await db
    .select({ id: s.legs.id })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .leftJoin(s.crossings, eq(s.crossings.legId, s.legs.id))
    .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.type, "crossing"), isNull(s.crossings.id), sql`${s.orders.state} not in ('draft','cancelled')`))
    .limit(200);
  for (const l of missing) await ensureCrossing(ctx, l.id);
  return missing.length;
}

export async function ensureCrossingsForOrder(ctx: Ctx, orderId: string) {
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId), eq(s.legs.type, "crossing")));
  for (const l of legs) await ensureCrossing(ctx, l.id);
}

// ---------- requirements ----------

/** Rules → checklist rows. Port- and customer-specific rows override the base row with the same code. */
/**
 * Requirements that the direction decides, whatever a company's older rule rows say (M16/M17):
 * entering the US always needs the entry / PAPS pre-file and DTOPS; the carta de retiro is a letter to a
 * Mexican yard for a northbound caja — a southbound truck leaves our own US yard and needs none.
 */
export function directionRule(code: string, c: { fromCountry: string; toCountry: string }): "required" | "skip" | null {
  if (c.toCountry === "US" && (code === "entry" || code === "dtops")) return "required";
  if (code === "carta_retiro" && !(c.fromCountry === "MX" && c.toCountry === "US")) return "skip";
  return null;
}

export async function computeRequirements(ctx: Ctx, c: Crossing): Promise<Requirement[]> {
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const year = new Date().getUTCFullYear();
  const rules = await db.select().from(s.crossingDocRules).where(and(eq(s.crossingDocRules.tenantId, ctx.tenantId), eq(s.crossingDocRules.enabled, true)));
  const byCode = new Map<string, typeof rules[number]>();
  const specificity = (r: typeof rules[number]) => (r.customerId ? 2 : 0) + (r.portId ? 1 : 0);
  for (const r of rules) {
    if (!ruleApplies(r, c)) continue;
    if (r.portId && r.portId !== c.portId) continue;
    if (r.customerId && r.customerId !== order?.customerId && r.customerId !== order?.brokerId) continue;
    const cur = byCode.get(r.code);
    if (!cur || specificity(r) > specificity(cur)) byCode.set(r.code, r);
  }
  // one upload counts everywhere (owner #8): the load's BOL or commercial invoice ticks this checklist too
  const docs = (await crossingDocs(ctx.tenantId, c)).map((d) => ({ ...d, code: d.key.toLowerCase() }));
  const prev = new Map(c.requirements.map((r) => [r.code, r]));
  const out: Requirement[] = [];
  for (const r of [...byCode.values()].sort((p, q) => p.packetOrder - q.packetOrder)) {
    if (r.requiredWhen === "never") continue;
    const dir = directionRule(r.code, c);
    if (dir === "skip") continue;
    const required = dir === "required" || r.requiredWhen === "always" || (r.requiredWhen === "brown_plates" && (!truck || truck.mxPlateClass !== "blue"));
    const doc = docs.filter((d) => d.code === r.code).sort((p, q) => q.version - p.version)[0];
    const old = prev.get(r.code);
    let status: Requirement["status"] = doc ? (doc.status === "verified" ? "verified" : "present") : "missing";
    // a DTOPS decal for this year on the truck record is the document
    const onFile = !doc && r.code === "dtops" && truck && truck.dtopsYear === year && truck.dtopsConfirmation ? `DTOPS ${year} decal on unit ${truck.unitNumber} (${truck.dtopsConfirmation})` : null;
    if (onFile) status = "verified";
    const humanNa = !doc && !onFile && old?.status === "na" && old.naReason !== "optional";
    if (humanNa && (r.allowNa || !required)) status = "na";
    else if (!doc && !onFile && !required) status = "na"; // not required for this truck / rule = not needed
    out.push({ code: r.code, label: r.label, providedBy: r.providedBy, allowNa: r.allowNa || !required, status, documentId: doc?.id ?? null, naReason: status === "na" ? (humanNa ? old!.naReason : "optional") : null, packetOrder: r.packetOrder, lastDocument: r.lastDocument, onFile });
  }
  // a tailgate trip crosses with every shipment's own paperwork (invoice / packing list): one line per shipment, held ones excluded
  if (order?.kind === "trip") {
    const ships = await db.select().from(s.orders).where(and(eq(s.orders.tripId, order.id), inArray(s.orders.state, ["booked", "dispatched", "in_transit"]))).orderBy(s.orders.loadSeq);
    const customers = ships.length ? await db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(inArray(s.customers.id, ships.map((x) => x.customerId ?? ""))) : [];
    ships.forEach((sh, i) => {
      const code = `shipment:${sh.id}`;
      const doc = docs.filter((d) => d.code === code.toLowerCase()).sort((p, q) => q.version - p.version)[0];
      const old = prev.get(code);
      const humanNa = !doc && old?.status === "na" && old.naReason !== "optional";
      const refs = Object.values(sh.refs).filter(Boolean).slice(0, 2).join(" ");
      out.push({ code, label: `Shipment docs · ${customers.find((c) => c.id === sh.customerId)?.name ?? "?"} · ${sh.orderNumber}${refs ? ` (${refs})` : ""}`, providedBy: "shipper", allowNa: true, status: doc ? (doc.status === "verified" ? "verified" : "present") : humanNa ? "na" : "missing", documentId: doc?.id ?? null, naReason: humanNa ? old!.naReason : null, packetOrder: 75 + i * 0.01, lastDocument: false });
    });
  }
  return out;
}

// ---------- documents ----------

/** The paper this crossing sees: its own, plus the load's (and its legs') that is not another crossing's. */
async function crossingDocs(tenantId: string, c: Pick<Crossing, "id" | "orderId">) {
  const { loadDocuments } = await import("./load-docs");
  const { CROSSING_ONLY } = await import("./load-docs-rules");
  return (await loadDocuments(tenantId, [c.orderId])).filter((d) => d.crossingId === c.id || !CROSSING_ONLY.has(d.key));
}

export type UploadInput = { code: string; fileName: string; mimeType: string; bytes: Buffer; source?: string; fields?: Record<string, unknown>; notes?: string | null; extract?: boolean };

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
    // the same paper uploaded on the load (a BOL) is replaced too: one record, counted everywhere
    const { supersedePrior } = await import("./load-docs");
    const version = await supersedePrior(tx, ctx.tenantId, { orderId: c.orderId, crossingId, legId: c.legId }, input.code, ctx.userId);
    const extracted: Record<string, { value: unknown; confidence: number; source?: "ai" | "human" }> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) if (v !== undefined && v !== null && v !== "") extracted[k] = { value: v, confidence: 1, source: "human" };
    const [row] = await tx
      .insert(s.documents)
      .values({ id: newId(), tenantId: ctx.tenantId, code: input.code, subjectKind: "crossing", subjectId: crossingId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: input.source ?? "upload", status: "present", version, extracted, notes: input.notes ?? null, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning();
    await event(tx, ctx, crossingId, { kind: "document", note: `${input.code} v${version} ${input.source ?? "uploaded"}: ${input.fileName}`, data: { documentId: row.id, code: input.code } });
    await writeAudit(tx, ctx, "document", row.id, "create", undefined, `${input.code} on crossing ${crossingId}`);
    return row;
  });
  await recompute(ctx, crossingId);
  // AI read when the company has an extractor key: fills blanks with confidence, never overrides a person
  if (input.extract !== false && DOC_FIELDS[input.code]?.length) {
    try {
      await extractDocumentFields(ctx, doc.id);
    } catch (e) {
      console.error(`[extractor] ${doc.id}: ${String(e)}`);
    }
  }
  return doc;
}

/** Read the document's fields with the AI extractor (spec F-3.4). Human values stay; AI fills the rest with confidence < 1. */
export async function extractDocumentFields(ctx: Ctx, documentId: string, fetchImpl?: typeof fetch) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.id, documentId))).limit(1);
  if (!doc) throw new NotFoundError("document", documentId);
  const fields = DOC_FIELDS[doc.code ?? ""] ?? [];
  if (!fields.length) return { ran: false as const, reason: "no fields on this document type" };
  const [integ] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, ctx.tenantId), eq(s.integrations.provider, "extractor"))).limit(1);
  if (!integ?.enabled || !integ.config.apiKey) return { ran: false as const, reason: "AI extractor not connected (Settings → Integrations)" };
  const blob = await readBlob(ctx, doc.storageKey);
  const label = DEFAULT_CROSSING_RULES.find((r) => r.code === doc.code)?.label ?? doc.code ?? "document";
  try {
    const r = await extractWithModel({ apiKey: integ.config.apiKey, model: integ.config.model || undefined }, { code: doc.code ?? "", label, mimeType: blob.mimeType, bytes: Buffer.from(blob.bytes) }, fields, fetchImpl);
    const extracted = { ...(doc.extracted ?? {}) };
    let filled = 0;
    for (const [k, v] of Object.entries(r.fields)) {
      const cur = extracted[k];
      if (cur && (cur.source === "human" || cur.confidence >= 1)) continue; // a person typed it
      extracted[k] = v;
      filled++;
    }
    const note = `${r.model}${r.inputTokens ? ` · ${r.inputTokens} tokens` : ""} · ${filled} field(s)`;
    await db.update(s.documents).set({ extracted, extractionAt: new Date(), extractionNote: note, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, documentId));
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: null, lastResult: note }).where(eq(s.integrations.id, integ.id));
    if (doc.subjectKind === "crossing") {
      await event(db, ctx, doc.subjectId, { kind: "document", note: `${doc.code}: AI read ${filled} field(s) — confirm them`, data: { documentId } });
      await recompute(ctx, doc.subjectId);
    } else await recomputeFor(ctx, doc);
    return { ran: true as const, filled, fields: r.fields, note };
  } catch (e) {
    const msg = (e as Error).message;
    await db.update(s.documents).set({ extractionAt: new Date(), extractionNote: `failed: ${msg}` }).where(eq(s.documents.id, documentId));
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: msg }).where(eq(s.integrations.id, integ.id));
    throw e;
  }
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
    else extracted[k] = { value: v, confidence: 1, source: "human" };
  }
  await db.update(s.documents).set({ extracted, status: confirm ? "verified" : doc.status === "verified" ? "present" : doc.status, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, documentId));
  await writeAudit(db, ctx, "document", documentId, "update", { fields: { from: Object.keys(doc.extracted ?? {}), to: Object.keys(extracted) } }, confirm ? "confirmed" : undefined);
  if (doc.subjectKind === "crossing") await recompute(ctx, doc.subjectId);
  else await recomputeFor(ctx, doc);
}

/** A load-level document's fields feed the crossing's checks too. */
async function recomputeFor(ctx: Ctx, doc: typeof s.documents.$inferSelect) {
  const { orderOfDocument } = await import("./load-docs");
  const orderId = await orderOfDocument(doc);
  if (!orderId) return;
  const { recomputeCrossingsOf } = await import("./billing");
  await recomputeCrossingsOf(ctx, orderId);
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
  seal: "Seal number agrees across the documents",
  folio_fiscal: "Carta porte UUID matches the DODA folio",
  pedimento: "Pedimento on DODA matches the entry",
  weight: "Gross weight agrees across the documents",
  pieces: "Piece counts agree across the documents",
  patente: "Patente on DODA is the customer's MX broker",
  scac: "SCAC on the manifest is the entity the truck runs under",
  plate_class: "Plate class rule: brown plates need a carta porte",
  expiry: "No driver / truck document expires before the crossing",
  dtops: "DTOPS on file for this truck and year",
  timing: "Manifest (ACE into the US, ACI into Canada) filed at least 1 h before arrival (30 min FAST into the US)",
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
  truck: { unitNumber: string; usPlate: string | null; mxPlate: string | null; caPlate?: string | null; mxPlateClass: string | null; scac: string | null; entityScac: string | null; dtopsYear: number | null; dtopsConfirmation: string | null; usPlateExpires: Date | null; mxPlateExpires: Date | null; caPlateExpires?: Date | null; dotInspectionExpires: Date | null } | null;
  driver: { name: string; licenseExpires: Date | null; mxLicenseExpires: Date | null; medicalExpires: Date | null; fastExpires: Date | null; i94Until: Date | null } | null;
  mxBrokerPatente: string | null;
  weightTolerancePct?: number;
  requireSeal?: boolean;
  /** the seal dispatch typed on the crossing (or the driver recorded): compared with the documents' */
  sealNumber?: string | null;
  /** a partner carrier runs the crossing: its unit is not in our Fleet, so plate / DTOPS / SCAC checks say so */
  partner?: { carrier: string; unit: string | null; plates: string | null } | null;
  /** the side the truck leaves and the side it enters; Mexico → US when not given */
  fromCountry?: string;
  toCountry?: string;
}): CheckResult[] {
  const { docs, truck, driver } = input;
  const from = input.fromCountry ?? "MX";
  const into = input.toCountry ?? "US";
  const touchesMx = from === "MX" || into === "MX";
  const touchesCa = from === "CA" || into === "CA";
  const intoUs = into === "US";
  const manifest = into === "CA" ? "aci_emanifest" : "ace_manifest";
  const manifestName = into === "CA" ? "ACI eManifest" : "ACE manifest";
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

  compareAcross("trailer", "trailer", ["carta_retiro", "carta_porte", "doda", "ace_manifest", "aci_emanifest", "bol"], { label: "assigned", value: input.trailerNumber });
  // plates
  {
    const vals: Record<string, unknown> = {};
    for (const src of ["carta_porte", "ace_manifest", "aci_emanifest", "carta_retiro"]) {
      if (field(src, "usPlate")) vals[`${src}.us`] = field(src, "usPlate");
      if (field(src, "mxPlate")) vals[`${src}.mx`] = field(src, "mxPlate");
      if (field(src, "caPlate")) vals[`${src}.ca`] = field(src, "caPlate");
    }
    if (!truck && input.partner) {
      // a partner's tractor: compare the documents with the plates the carrier gave at acceptance
      const given = input.partner.plates;
      const ok = new Set(String(given ?? "").split(/[/,;]/).map(norm).filter(Boolean));
      const bad = given ? Object.entries(vals).filter(([, v]) => !ok.has(norm(v))) : [];
      out.push(!given || !Object.keys(vals).length ? { code: "tractor_plates", state: "skipped", message: !given ? `${input.partner.carrier} gave no plates for unit ${input.partner.unit ?? "?"}` : "no plates on any document yet", values: vals } : bad.length ? { code: "tractor_plates", state: "fail", message: `plates differ from what ${input.partner.carrier} gave (${given}): ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`, values: { ...vals, carrier: given } } : { code: "tractor_plates", state: "pass", message: `plates match ${input.partner.carrier}'s unit ${input.partner.unit ?? ""}`.trim(), values: vals });
    } else if (!truck || !Object.keys(vals).length) out.push({ code: "tractor_plates", state: "skipped", message: truck ? "no plates on any document yet" : "no truck assigned", values: vals });
    else {
      const plateOf = (k: string) => (k.endsWith(".us") ? truck.usPlate : k.endsWith(".ca") ? (truck.caPlate ?? null) : truck.mxPlate);
      const bad = Object.entries(vals).filter(([k, v]) => norm(v) !== norm(plateOf(k)));
      const onTruck = [`US ${truck.usPlate ?? "—"}`, touchesMx ? `MX ${truck.mxPlate ?? "—"}` : null, touchesCa ? `CA ${truck.caPlate ?? "—"}` : null].filter(Boolean).join(" / ");
      out.push(bad.length ? { code: "tractor_plates", state: "fail", message: `plates differ from unit ${truck.unitNumber} (${onTruck}): ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`, values: { ...vals, truck: onTruck } } : { code: "tractor_plates", state: "pass", message: `plates match unit ${truck.unitNumber}`, values: vals });
    }
  }
  // driver
  {
    const m = field(manifest, "driver");
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
    for (const src of ["bol", "invoice", "cci", "carta_porte", "doda"]) if (field(src, "seal")) vals[src] = field(src, "seal");
    if (input.sealNumber) vals.typed = input.sealNumber;
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
    for (const src of ["carta_porte", "ace_manifest", "invoice", "cci", "bol"]) {
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
  compareAcross("pieces", "pieces", ["invoice", "cci", "carta_porte", "ace_manifest", "bol", "packing_list"]);
  // patente
  {
    const p = field("doda", "patente");
    if (!touchesMx) out.push({ code: "patente", state: "skipped", message: "not a Mexico crossing", values: {} });
    else if (!p || !input.mxBrokerPatente) out.push({ code: "patente", state: "skipped", message: !p ? "no patente on the DODA yet" : "customer has no MX broker patente on file", values: { doda: p ?? null, broker: input.mxBrokerPatente } });
    else out.push({ code: "patente", state: norm(p) === norm(input.mxBrokerPatente) ? "pass" : "fail", message: norm(p) === norm(input.mxBrokerPatente) ? `patente ${p} is the customer's broker` : `DODA patente ${p} is not the customer's broker (${input.mxBrokerPatente})`, values: { doda: p, broker: input.mxBrokerPatente } });
  }
  // scac
  {
    const m = field("ace_manifest", "scac");
    const ours = truck?.scac || truck?.entityScac || null;
    if (!intoUs) out.push({ code: "scac", state: "skipped", message: "SCAC is compared on the US (ACE) manifest; not entering the US", values: {} });
    else if (!m || !ours) out.push({ code: "scac", state: "skipped", message: !m ? "no SCAC on the manifest yet" : "no SCAC on the truck or its entity", values: { manifest: m ?? null, truck: ours } });
    else out.push({ code: "scac", state: norm(m) === norm(ours) ? "pass" : "fail", message: norm(m) === norm(ours) ? `manifest SCAC ${m} matches` : `manifest shows ${m}; unit ${truck?.unitNumber} runs under ${ours}`, values: { manifest: m, truck: ours } });
  }
  // plate class rule
  {
    if (!touchesMx) out.push({ code: "plate_class", state: "skipped", message: "not a Mexico crossing", values: {} });
    else if (!truck) out.push({ code: "plate_class", state: "skipped", message: "no truck assigned", values: {} });
    else if (truck.mxPlateClass === "brown" && !has("carta_porte")) out.push({ code: "plate_class", state: "fail", message: `unit ${truck.unitNumber} has brown plates and there is no carta porte`, values: { plateClass: "brown", cartaPorte: false } });
    else out.push({ code: "plate_class", state: "pass", message: truck.mxPlateClass === "brown" ? "brown plates with carta porte" : `${truck.mxPlateClass ?? "no"} plates`, values: { plateClass: truck.mxPlateClass, cartaPorte: has("carta_porte") } });
  }
  // expiry
  {
    const expired: string[] = [];
    const chk = (label: string, d: Date | null | undefined) => d && d.getTime() < input.now.getTime() && expired.push(`${label} (${d.toISOString().slice(0, 10)})`);
    if (truck) {
      chk("US plate", truck.usPlateExpires);
      if (touchesMx) chk("MX plate", truck.mxPlateExpires);
      if (touchesCa) chk("CA plate", truck.caPlateExpires);
      chk("annual inspection", truck.dotInspectionExpires);
    }
    if (driver) {
      chk("licence", driver.licenseExpires);
      if (touchesMx) chk("licencia federal", driver.mxLicenseExpires);
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
    out.push(!intoUs ? { code: "dtops", state: "skipped", message: "DTOPS is for entering the US", values: {} } : !truck && onDoc ? { code: "dtops", state: "pass", message: "DTOPS receipt in the packet", values: { year, onDoc } } : !truck ? { code: "dtops", state: "skipped", message: input.partner ? `${input.partner.carrier}'s unit is not in our Fleet: attach its DTOPS receipt` : "no truck assigned", values: {} } : onDoc || onTruck ? { code: "dtops", state: "pass", message: onTruck ? `DTOPS ${year} on the truck record (${truck.dtopsConfirmation})` : "DTOPS receipt in the packet", values: { year, onTruck, onDoc } } : { code: "dtops", state: "fail", message: `no DTOPS ${year} decal or receipt for unit ${truck.unitNumber}`, values: { year } });
  }
  // timing
  {
    const sub = field(manifest, "submittedAt");
    const eta = field(manifest, "estimatedArrival");
    const fast = intoUs && /^(y|yes|si|sí|true|1)$/i.test(String(field(manifest, "fast") ?? ""));
    const a = sub ? new Date(String(sub)) : null;
    const b = eta ? new Date(String(eta)) : null;
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) out.push({ code: "timing", state: "skipped", message: "manifest submitted / arrival times not recorded", values: { submittedAt: sub ?? null, estimatedArrival: eta ?? null } });
    else {
      const minutes = (b.getTime() - a.getTime()) / 60000;
      const need = fast ? 30 : 60;
      out.push({ code: "timing", state: minutes >= need ? "pass" : "fail", message: minutes >= need ? `${manifestName} filed ${Math.round(minutes)} min before arrival` : `${manifestName} filed only ${Math.round(minutes)} min before arrival; earliest allowed arrival ${new Date(a.getTime() + need * 60000).toISOString()}`, values: { submittedAt: a.toISOString(), estimatedArrival: b.toISOString(), fast, need } });
    }
  }
  // checks that belong to another border are not shown at all
  const MX_ONLY = ["folio_fiscal", "pedimento", "patente", "plate_class"];
  const US_ENTRY_ONLY = ["dtops", "scac"];
  return out.filter((r) => (touchesMx || !MX_ONLY.includes(r.code)) && (intoUs || !US_ENTRY_ONLY.includes(r.code)));
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
  const docs = (await crossingDocs(ctx.tenantId, c)).sort((p, q) => p.createdAt.getTime() - q.createdAt.getTime());
  const byCode: Record<string, Record<string, unknown>> = {};
  for (const d of docs) if (d.code) byCode[d.key.toLowerCase()] = Object.fromEntries(Object.entries(d.extracted ?? {}).map(([k, v]) => [k, v.value]));
  const partner = await partnerOnLeg(leg);
  const results = runChecksPure({
    now: new Date(),
    docs: byCode,
    trailerNumber: c.trailerNumber,
    sealNumber: c.sealNumber,
    partner: partner ? { carrier: partner.carrier.name, unit: partner.tender?.unitNumber ?? null, plates: partner.tender?.unitPlate ?? null } : null,
    fromCountry: c.fromCountry,
    toCountry: c.toCountry,
    truck: truck ? { unitNumber: truck.unitNumber, usPlate: truck.usPlate, mxPlate: truck.mxPlate, caPlate: truck.caPlate, caPlateExpires: truck.caPlateExpires, mxPlateClass: truck.mxPlateClass, scac: truck.scac, entityScac: entity?.scac ?? null, dtopsYear: truck.dtopsYear, dtopsConfirmation: truck.dtopsConfirmation, usPlateExpires: truck.usPlateExpires, mxPlateExpires: truck.mxPlateExpires, dotInspectionExpires: truck.dotInspectionExpires } : null,
    driver: driver ? { name: driver.name, licenseExpires: driver.licenseExpires, mxLicenseExpires: driver.mxLicenseExpires, medicalExpires: driver.medicalExpires, fastExpires: driver.fastExpires, i94Until: driver.i94Until } : partner?.tender?.driverName ? { name: partner.tender.driverName, licenseExpires: null, mxLicenseExpires: null, medicalExpires: null, fastExpires: null, i94Until: null } : null,
    mxBrokerPatente: broker?.patente ?? null,
    requireSeal: !!customer?.requiredDocs?.includes("SEAL"),
  });
  const existing = await db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, crossingId));
  const stale = existing.filter((e) => !results.some((r) => r.code === e.code)).map((e) => e.id);
  if (stale.length) await db.delete(s.crossingChecks).where(inArray(s.crossingChecks.id, stale));
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

/** Waive a failed cross-check with a reason (the dispatcher, the MX office, Safety or the owner); it is audited and on the crossing's timeline. */
export async function overrideCheck(ctx: Ctx, crossingId: string, code: string, reason: string) {
  assertCtx(ctx);
  if (!(ctx.role === "owner" || ctx.role === "mx_office" || ctx.role === "system" || can(ctx, "dispatch.override"))) requirePermission(ctx, "compliance.override");
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
  const { zoneForLeg } = await import("./orders");
  const zone = leg ? await zoneForLeg(db, leg) : ("crossing" as const);
  const partner = await partnerOnLeg(leg);
  if (partner) {
    // a partner transfer carrier runs it: the carrier's own eligibility, and the driver and unit it named when it accepted
    const { eligibilityFor } = await import("./orders");
    const e = await eligibilityFor(ctx.role === "system" ? ctx : { ...ctx, role: "system" }, zone, { kind: "carrier", carrierId: partner.carrier.id });
    findings.push(...e.findings);
    const accepted = !!leg && !["unassigned", "planned", "dispatched", "declined", "cancelled"].includes(leg.state);
    if (!accepted) findings.push({ level: "red", code: "carrier_not_accepted", message: `waiting for ${partner.carrier.name} to accept with a driver and unit`, overridable: false });
    else if (!partner.tender?.driverName) findings.push({ level: "red", code: "no_driver", message: `${partner.carrier.name} has not named the crossing driver (ask them, or accept the tender on their behalf)`, overridable: true });
    else if (!partner.tender.unitNumber) findings.push({ level: "yellow", code: "no_unit", message: `${partner.carrier.name} gave no unit number for ${partner.tender.driverName}`, overridable: true });
    const sum = summarize(findings);
    return { ok: sum.ok, hardBlocked: sum.hardBlocked, findings, at: new Date().toISOString() };
  }
  if (!leg?.truckId) findings.push({ level: "red", code: "no_truck", message: "no crossing truck assigned", overridable: false });
  else {
    const [truck] = await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1);
    if (truck) findings.push(...checkTruck(truck, zone));
  }
  if (!leg?.driverId) findings.push({ level: "red", code: "no_driver", message: "no crossing driver assigned", overridable: false });
  else {
    const [d] = await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1);
    if (d) findings.push(...checkDriver(d, zone));
    if (leg.coDriverId) {
      const [co] = await db.select().from(s.drivers).where(eq(s.drivers.id, leg.coDriverId)).limit(1);
      if (co) findings.push(...checkDriver(co, zone));
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
  // what the system works out is the system's doing, not the person who happened to open the page
  const sys: Ctx = { tenantId: ctx.tenantId, userId: null, role: "system" };
  // the crossing leg moved on the board (driver app, dispatcher): the crossing follows it
  const [xleg] = await db.select({ state: s.legs.state, completedAt: s.legs.completedAt, updatedAt: s.legs.updatedAt }).from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  if (xleg && !["cleared", "cancelled"].includes(c.state)) {
    // (a truck turned back at the border keeps its leg rolling: after a return the border steps start again from the packet)
    const follow: CrossingState | null = xleg.state === "completed" ? "cleared" : xleg.state === "cancelled" ? "cancelled" : ["en_route", "at_delivery"].includes(xleg.state) && beforePacket(c.state) && !c.returnedReason ? "departed_yard" : null;
    if (follow && follow !== c.state) {
      await setState(db, sys, c, follow, { source: "system", note: `the crossing leg is ${xleg.state.replace(/_/g, " ")}`, at: xleg.completedAt ?? xleg.updatedAt ?? undefined }, follow === "cleared" ? { departedYardAt: c.departedYardAt ?? xleg.completedAt ?? new Date() } : follow === "departed_yard" ? { departedYardAt: c.departedYardAt ?? new Date() } : {});
      c = await load(ctx, crossingId);
    }
  }
  if (!c.arrivedYardAt) {
    // the dwell clock starts when the trailer is at the border yard: the crossing leg's pickup stop was reached
    const [leg] = await db.select({ fromStopId: s.legs.fromStopId }).from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
    const st = leg?.fromStopId ? (await db.select({ arrivedAt: s.stops.arrivedAt }).from(s.stops).where(eq(s.stops.id, leg.fromStopId)).limit(1))[0] : null;
    if (st?.arrivedAt) {
      await db.update(s.crossings).set({ arrivedYardAt: st.arrivedAt }).where(eq(s.crossings.id, crossingId));
      await event(db, sys, crossingId, { kind: "note", note: "trailer at the border yard — dwell clock started", source: "system", at: st.arrivedAt });
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
    // the leg that brings the trailer to the border
    const [mine] = await db.select({ fromStopId: s.legs.fromStopId }).from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
    const [before] = mine?.fromStopId ? await db.select({ state: s.legs.state }).from(s.legs).where(and(eq(s.legs.orderId, c.orderId), eq(s.legs.toStopId, mine.fromStopId))).limit(1) : [];
    to = before && ["loaded", "en_route", "at_delivery", "completed"].includes(before.state) ? "awaiting_mx_arrival" : "created";
  }
  if (to !== c.state) await setState(db, sys, c, to, { source: "system" });
  return load(ctx, crossingId);
}

export async function overrideEligibility(ctx: Ctx, crossingId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.override");
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

/** The driver-facing step labels for this crossing's direction. */
export function stepLabel(state: CrossingState, c?: { fromCountry: string; toCountry: string } | null) {
  if (!c || (c.fromCountry === "MX" && c.toCountry === "US")) return STEP_LABEL[state];
  const f = word(c.fromCountry), t = word(c.toCountry);
  if (state === "at_mx_customs") return { en: `At ${f.adj} customs (leaving)`, es: `En aduana ${f.es} (salida)` };
  if (state === "in_us_customs") return { en: `At ${t.adj} customs`, es: `En aduana ${t.es}` };
  if (state === "cleared") return { en: `Cleared — on the ${t.en} side`, es: `Liberado — lado ${t.es}` };
  return STEP_LABEL[state];
}

/**
 * One physical step forward (driver tap, GPS, or dispatcher). Backwards needs the owner. The crossing leg moves
 * with it (B3): the border steps need the caja picked up at the yard (the leg Loaded); Departed the yard puts the
 * leg en route; Cleared delivers the leg at the yard on the other side, which wakes up the next leg.
 */
export async function step(ctx: Ctx, crossingId: string, to: CrossingState, e: { source?: string; verified?: boolean; note?: string | null; at?: Date; seal?: string | null } = {}) {
  assertCtx(ctx);
  const c = await load(ctx, crossingId);
  if (to === "held" || to === "returned" || to === "cancelled") throw new ValidationError("use hold / markReturned / cancel");
  const expected = FORWARD[c.state];
  const machine = ["gps", "system"].includes(e.source ?? "");
  if (expected !== to) {
    const forwardIdx = CROSSING_ORDER.indexOf(to);
    const curIdx = CROSSING_ORDER.indexOf(c.state);
    if (forwardIdx < curIdx && ctx.role !== "owner" && ctx.role !== "system") throw new TransitionError("leg", c.state, to, "moving a crossing backwards needs the owner");
    if (forwardIdx > curIdx + 1 && !machine) throw new TransitionError("leg", c.state, to, "one step at a time");
    if (curIdx < CROSSING_ORDER.indexOf("packet_sent") && !machine) throw new TransitionError("leg", c.state, to, c.state === "ready_to_cross" ? "send the packet first" : "the packet is not ready");
  }
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  const pickedUp = !!leg && ["loaded", "en_route", "at_delivery", "completed"].includes(leg.state);
  if (PHYSICAL.includes(to) && to !== "packet_sent" && !pickedUp && !machine) {
    // the driver's border steps come only after the caja is picked up; the office can say it left, once the caja was at the yard
    const office = !["driver_app", "carrier"].includes(e.source ?? "dispatcher");
    const atYard = !!c.arrivedYardAt || leg?.state === "at_pickup";
    if (!office || !leg || !["dispatched", "accepted", "en_route_to_pickup", "at_pickup"].includes(leg.state) || !atYard)
      throw new TransitionError("leg", c.state, to, !leg || ["unassigned", "planned", "declined"].includes(leg.state) ? "the crossing leg has not been sent" : office && !atYard ? "the caja is not at the yard yet" : "pick up the caja at the yard first (Loaded)");
  }
  const extra: Partial<typeof s.crossings.$inferInsert> = {};
  if (to === "departed_yard") {
    extra.departedYardAt = e.at ?? new Date();
    if (!c.arrivedYardAt) extra.arrivedYardAt = extra.departedYardAt; // it left, so it was there; nobody pressed the yard button
  }
  if (to === "cleared") extra.clearedAt = e.at ?? new Date();
  if (to !== "cleared" && CROSSING_ORDER.indexOf(to) < CROSSING_ORDER.indexOf("packet_sent") && !c.packetSentAt && ["gps"].includes(e.source ?? "")) {
    // spec 3.5: truck crossing without the packet sent
    await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: c.orderId, legId: c.legId, code: "crossed_without_packet", level: "red", title: "Truck moving at the border without the packet sent", detail: `GPS put it at ${to} while the crossing was ${CROSSING_LABEL[c.state]}`, owner: "owner" });
  }
  const after = await setState(db, ctx, c, to, e, extra);
  if (leg) await legFollowsCrossing(ctx, leg, to, e);
  return after;
}

/** The crossing leg follows its border step: en route once it left the yard, delivered at the far yard once cleared. */
async function legFollowsCrossing(ctx: Ctx, leg: typeof s.legs.$inferSelect, to: CrossingState, e: { source?: string; verified?: boolean; at?: Date; seal?: string | null }) {
  const { advanceLeg } = await import("./orders");
  const src = (["driver_app", "gps", "carrier", "dispatcher", "system"].includes(e.source ?? "") ? e.source : "system") as "driver_app" | "gps" | "carrier" | "dispatcher" | "system";
  const ev = { source: src, verified: e.verified ?? false, at: e.at, note: `border: ${CROSSING_LABEL[to].toLowerCase()}` };
  const border = PHYSICAL.includes(to) && to !== "packet_sent";
  const walk: LegState[] = !border ? [] : ["accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", ...(to === "cleared" ? (["at_delivery", "completed"] as LegState[]) : [])];
  let state = leg.state;
  for (const target of walk) {
    const order: LegState[] = ["dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"];
    if (order.indexOf(state) < 0 || order.indexOf(state) >= order.indexOf(target)) continue;
    // the seal the driver reads at the far yard is recorded where the leg arrives (and checked against the one applied)
    const moved = await advanceLeg(systemCtx(ctx.tenantId), leg.id, target, target === "at_delivery" ? { ...ev, seal: e.seal ?? null } : ev, { syncCrossing: false });
    state = moved.state;
  }
  if (to === "cleared" && state === "completed") {
    // the next leg can go: the freight is at the yard on the other side
    const [next] = await db.select().from(s.legs).where(and(eq(s.legs.orderId, leg.orderId), eq(s.legs.fromStopId, leg.toStopId ?? ""))).limit(1);
    const [yard] = leg.toStopId ? await db.select({ name: s.stops.name }).from(s.stops).where(eq(s.stops.id, leg.toStopId)).limit(1) : [];
    if (next && next.state !== "cancelled") await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: next.id, orderId: next.orderId, kind: "note", source: "system", note: `Freight cleared customs and is at ${yard?.name ?? "the yard"}: ready for this leg`, data: { freightReady: true } });
  }
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
  await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: c.orderId, legId: c.legId, code: "crossing_returned", level: "red", title: `Returned to the ${c.fromCountry} side: ${reason.trim()}`, detail: `was ${CROSSING_LABEL[c.state]}`, owner: "dispatch" });
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
  if (directionRule("carta_retiro", c) === "skip") throw new ValidationError("a carta de retiro is for a caja leaving a Mexican yard northbound; this crossing does not need one");
  let caja = c.trailerNumber;
  if (!caja && leg?.trailerId) {
    // the trailer on the leg is the caja
    const [tr] = await db.select({ unitNumber: s.trailers.unitNumber }).from(s.trailers).where(eq(s.trailers.id, leg.trailerId)).limit(1);
    if (tr) {
      caja = tr.unitNumber;
      await db.update(s.crossings).set({ trailerNumber: caja, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
    }
  }
  if (!caja) throw new ValidationError("enter the trailer (caja) number first", "trailerNumber");
  const partner = await partnerOnLeg(leg);
  const { tenantZone } = await import("./company");
  const { stopZone } = await import("@/lib/time");
  const yardZone = fromStop ? stopZone(fromStop, await tenantZone(ctx.tenantId)) : null;
  const yardPlace = fromStop?.address?.city ? `${fromStop.address.city}${fromStop.address.state ? `, ${MX_STATE_NAME[fromStop.address.state.toUpperCase()] ?? fromStop.address.state}` : ""}` : null;
  let data: Parameters<typeof buildSolicitudRetiro>[0];
  if (partner) {
    // a partner transfer carrier picks up the caja: the letter names the carrier, its driver, unit and plates
    if (!partner.tender?.driverName) throw new ValidationError(`${partner.carrier.name} has not named the driver yet`);
    const plates = partner.tender.unitPlate ?? "";
    data = { companyName: tenant.name, legalName: tenant.name, date: new Date(), yardName: input.yardName || fromStop?.name || "patio", trailerNumber: caja, transfer: partner.carrier.name, drivers: [partner.tender.driverName], unitNumber: partner.tender.unitNumber ?? "", usPlate: plates, mxPlate: "", orderNumber: order.orderNumber, authorizedBy: input.authorizedBy || "", place: yardPlace, zone: yardZone };
  } else {
    if (!truck) throw new ValidationError("assign the crossing truck first");
    if (!drivers.length) throw new ValidationError("assign the crossing driver first");
    const entity = truck.entityId ? (await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, truck.entityId)).limit(1))[0] : null;
    data = {
      companyName: entity?.dba || entity?.legalName || tenant.name,
      legalName: entity?.legalName || tenant.name,
      date: new Date(),
      yardName: input.yardName || fromStop?.name || "patio",
      trailerNumber: caja,
      transfer: entity?.dba || tenant.name,
      drivers: drivers.map((d) => d.name),
      unitNumber: truck.unitNumber,
      usPlate: truck.usPlate ?? "",
      mxPlate: truck.mxPlate ?? "",
      orderNumber: order.orderNumber,
      authorizedBy: input.authorizedBy || "",
      place: yardPlace,
      zone: yardZone,
    };
  }
  const bytes = await buildSolicitudRetiro(data);
  const doc = await uploadDocument(ctx, crossingId, { code: "carta_retiro", fileName: `Solicitud de retiro ${caja}.pdf`, mimeType: "application/pdf", bytes: Buffer.from(bytes), source: "generated", fields: { trailer: caja, unit: data.unitNumber, usPlate: data.usPlate, mxPlate: data.mxPlate, driver: data.drivers.join(" / ") } });
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
  const { tenantZone } = await import("./company");
  const { fmtWhen } = await import("@/lib/time");
  const pdf = await buildPacketPdf({ title: `Crossing packet ${order.orderNumber}${c.trailerNumber ? ` · caja ${c.trailerNumber}` : ""}`, parts, builtAt: fmtWhen(new Date(), await tenantZone(ctx.tenantId), { year: true }) });
  const sha = createHash("sha256").update(pdf).digest("hex");
  const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
  await db.update(s.crossings).set({ packetStorageKey: `blob:${blob.id}`, packetBuiltAt: new Date(), packetToken: c.packetToken ?? newToken(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.crossings.id, crossingId));
  await event(db, ctx, crossingId, { kind: "packet", note: `packet built: ${parts.length} documents, ${(pdf.length / 1024).toFixed(0)} KB` });
  return recompute(ctx, crossingId);
}

export class LegNotSentError extends ValidationError {
  constructor(message: string) {
    super(message, "dispatchLeg");
    this.name = "ValidationError";
  }
}

/**
 * Send the packet to whoever drives the crossing. The crossing leg has to be out (B3): a leg that is only planned is
 * sent together with the packet when the dispatcher says so (`dispatchLeg`), never silently; a partner carrier's leg
 * needs the carrier's yes, and the packet goes to the driver it named.
 */
export async function sendPacket(ctx: Ctx, crossingId: string, opts: { dispatchLeg?: boolean } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const c = await recompute(ctx, crossingId);
  if (c.state !== "ready_to_cross") throw new TransitionError("leg", c.state, "packet_sent", c.packetBuiltAt ? "not ready to cross" : "build the packet first");
  let [leg] = await db.select().from(s.legs).where(eq(s.legs.id, c.legId)).limit(1);
  if (!leg || !leg.assigneeKind) throw new ValidationError("put a truck or a carrier on the crossing leg first");
  const partner = await partnerOnLeg(leg);
  if (["unassigned", "declined", "cancelled", "completed"].includes(leg.state)) throw new ValidationError(`the crossing leg is ${leg.state}; put someone on it first`);
  if (partner && ["planned", "dispatched"].includes(leg.state)) throw new ValidationError(`${partner.carrier.name} has not accepted the crossing leg yet`);
  if (!partner && !leg.driverId) throw new ValidationError("assign the crossing driver first");
  const [driver] = !partner && leg.driverId ? await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1) : [];
  if (leg.state === "planned") {
    if (!opts.dispatchLeg) throw new LegNotSentError(`The crossing leg is not sent to ${driver?.name ?? "the driver"} yet. Send the leg with the packet?`);
    const { dispatchLeg } = await import("./orders");
    leg = await dispatchLeg(ctx, leg.id);
  }
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, c.orderId)).limit(1);
  const link = publicUrl(`/p/${c.packetToken}`);
  const name = partner ? (partner.tender?.driverName ?? partner.carrier.name) : driver.name;
  const to = partner ? partner.tender?.driverPhone || partner.carrier.whatsapp || partner.carrier.dispatchEmail || "carrier" : driver.whatsapp || driver.phone || "driver";
  const body = `${name}: packet for ${order.orderNumber}${c.trailerNumber ? ` (caja ${c.trailerNumber})` : ""} is ready. Open it here: ${link}`;
  await enqueue(ctx, { channel: "whatsapp", to, body, subjectKind: "crossing", subjectId: crossingId, meta: { kind: "packet", template: { name: "", params: [name, `${order.orderNumber}${c.trailerNumber ? ` (caja ${c.trailerNumber})` : ""}`, link] } } });
  await deliverQueued().catch(() => null);
  const after = await setState(db, ctx, c, "packet_sent", { note: `packet sent to ${name}${partner ? ` (${partner.carrier.name})` : ""}` }, { packetSentAt: new Date() });
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

export async function crossingBoard(ctx: Ctx, synced = false): Promise<Awaited<ReturnType<typeof boardRows>>> {
  const rows = await boardRows(ctx);
  // a crossing whose leg has moved on (crossed, or cancelled) is brought up to date before it is shown
  const stale = rows.filter((r) => !["cleared", "cancelled"].includes(r.c.state) && (r.legState === "completed" || r.legState === "cancelled" || (["en_route", "at_delivery"].includes(r.legState) && beforePacket(r.c.state) && !r.c.returnedReason)));
  if (!stale.length || synced) return rows;
  for (const r of stale) await recompute(ctx, r.c.id);
  return crossingBoard(ctx, true);
}

async function boardRows(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const rows = await db
    .select({ c: s.crossings, orderNumber: s.orders.orderNumber, customerId: s.orders.customerId, brokerId: s.orders.brokerId, legState: s.legs.state, truckId: s.legs.truckId, driverId: s.legs.driverId, carrierId: s.legs.carrierId })
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
  const [checks, events, own, fromLoad, port] = await Promise.all([
    db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, crossingId)),
    db.select().from(s.crossingEvents).where(eq(s.crossingEvents.crossingId, crossingId)).orderBy(desc(s.crossingEvents.at)).limit(200),
    db.select().from(s.documents).where(and(eq(s.documents.subjectKind, "crossing"), eq(s.documents.subjectId, crossingId))).orderBy(desc(s.documents.createdAt)),
    // the load's own paper that this checklist asks for (a BOL uploaded on the load, a POD from the driver)
    crossingDocs(ctx.tenantId, c).then((ds) => ds.filter((d) => d.crossingId !== c.id && c.requirements.some((r) => r.code.toUpperCase() === d.key)).map((d) => ({ ...d, code: d.key.toLowerCase(), fromLoad: true as const }))),
    c.portId ? db.select().from(s.ports).where(eq(s.ports.id, c.portId)).limit(1).then((r) => r[0] ?? null) : Promise.resolve(null),
  ]);
  const docs = [...own.map((d) => ({ ...d, fromLoad: false })), ...fromLoad.map(({ key: _k, orderId: _o, legId: _l, crossingId: _x, on: _on, ...d }) => d)];
  const truck = leg?.truckId ? (await db.select().from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1))[0] : null;
  const driver = leg?.driverId ? (await db.select().from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1))[0] : null;
  const coDriver = leg?.coDriverId ? (await db.select().from(s.drivers).where(eq(s.drivers.id, leg.coDriverId)).limit(1))[0] : null;
  const customer = order?.customerId ? (await db.select().from(s.customers).where(eq(s.customers.id, order.customerId)).limit(1))[0] : null;
  const broker = customer?.mxBrokerId ? (await db.select().from(s.customsBrokers).where(eq(s.customsBrokers.id, customer.mxBrokerId)).limit(1))[0] : null;
  const waitingOn = c.requirements.find((r) => r.status === "missing") ?? null;
  // the border yard's clock (Nuevo Laredo keeps US daylight time; a Canadian crossing starts in Detroit)
  const yard = leg?.fromStopId ? (await db.select().from(s.stops).where(eq(s.stops.id, leg.fromStopId)).limit(1))[0] : null;
  const { tenantZone } = await import("./company");
  const { stopZone } = await import("@/lib/time");
  const companyZone = await tenantZone(ctx.tenantId);
  const yardZone = yard ? stopZone(yard, companyZone) : companyZone;
  const partner = await partnerOnLeg(leg);
  return { crossing: c, leg, order, checks, events, docs, port, truck, driver, coDriver, customer, broker, waitingOn, yardZone, partner: partner ? { carrier: partner.carrier.name, driverName: partner.tender?.driverName ?? null, driverPhone: partner.tender?.driverPhone ?? null, unitNumber: partner.tender?.unitNumber ?? null, unitPlate: partner.tender?.unitPlate ?? null } : null };
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
