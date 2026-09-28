import { and, eq, inArray, or } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import { docKey, supersedeScope } from "./load-docs-rules";

/**
 * Every document of a load, wherever it was uploaded (owner #8): on the load, on one of its legs, or on one of
 * its crossings. Each row says which load it belongs to and where it came in, and carries its key (the code,
 * upper-case), so a BOL uploaded on the crossing is the load's BOL for billing, the portal and the packet.
 */
export type LoadDoc = typeof s.documents.$inferSelect & { key: string; orderId: string; legId: string | null; crossingId: string | null; on: "load" | "leg" | "crossing" };

export const LIVE_STATUSES = ["present", "verified"];

export async function loadDocuments(tenantId: string, orderIds: string[], opts: { statuses?: string[] | "all"; tx?: Tx | typeof db } = {}): Promise<LoadDoc[]> {
  const q = opts.tx ?? db;
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return [];
  const [legRows, xRows] = await Promise.all([
    q.select({ id: s.legs.id, orderId: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, tenantId), inArray(s.legs.orderId, ids))),
    q.select({ id: s.crossings.id, orderId: s.crossings.orderId, legId: s.crossings.legId }).from(s.crossings).where(and(eq(s.crossings.tenantId, tenantId), inArray(s.crossings.orderId, ids))),
  ]);
  const subjects = [and(eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, ids))];
  if (legRows.length) subjects.push(and(eq(s.documents.subjectKind, "leg"), inArray(s.documents.subjectId, legRows.map((l) => l.id))));
  if (xRows.length) subjects.push(and(eq(s.documents.subjectKind, "crossing"), inArray(s.documents.subjectId, xRows.map((x) => x.id))));
  const statuses = opts.statuses === "all" ? null : (opts.statuses ?? LIVE_STATUSES);
  const rows = await q
    .select()
    .from(s.documents)
    .where(and(eq(s.documents.tenantId, tenantId), or(...subjects), statuses ? inArray(s.documents.status, statuses) : undefined));
  const legOf = new Map(legRows.map((l) => [l.id, l]));
  const xOf = new Map(xRows.map((x) => [x.id, x]));
  const out: LoadDoc[] = [];
  for (const d of rows) {
    if (d.subjectKind === "order") out.push({ ...d, key: docKey(d.code), orderId: d.subjectId, legId: null, crossingId: null, on: "load" });
    else if (d.subjectKind === "leg") {
      const l = legOf.get(d.subjectId);
      if (l) out.push({ ...d, key: docKey(d.code), orderId: l.orderId, legId: l.id, crossingId: null, on: "leg" });
    } else if (d.subjectKind === "crossing") {
      const x = xOf.get(d.subjectId);
      if (x) out.push({ ...d, key: docKey(d.code), orderId: x.orderId, legId: x.legId, crossingId: x.id, on: "crossing" });
    }
  }
  return out.sort((p, q2) => q2.createdAt.getTime() - p.createdAt.getTime());
}

/** Does this load have a live document with this key (from any screen)? */
export const hasDocFor = (docs: LoadDoc[], orderId: string, code: string) => docs.some((d) => d.orderId === orderId && d.key === docKey(code) && LIVE_STATUSES.includes(d.status));

/**
 * A new upload replaces the live one it stands for: on the same crossing (a DODA), the same leg (a carrier's
 * invoice), or anywhere on the load (a BOL uploaded on the crossing replaces the one uploaded on the load).
 * Returns the version the new upload gets.
 */
export async function supersedePrior(tx: Tx | typeof db, tenantId: string, where: { orderId: string; legId?: string | null; crossingId?: string | null }, code: string, userId: string | null) {
  const key = docKey(code);
  const scope = supersedeScope(key);
  const all = (await loadDocuments(tenantId, [where.orderId], { tx })).filter((d) => d.key === key);
  const prior = all.filter((d) => (scope === "crossing" ? d.crossingId === (where.crossingId ?? null) && !!where.crossingId : scope === "leg" ? d.legId === (where.legId ?? null) && d.on === "leg" : true));
  for (const p of prior) await tx.update(s.documents).set({ status: "superseded", updatedAt: new Date(), updatedBy: userId }).where(eq(s.documents.id, p.id));
  return (Math.max(0, ...prior.map((p) => p.version)) || 0) + 1;
}

/** The load a document belongs to (for the portal's access check and the crossing's recompute). */
export async function orderOfDocument(doc: Pick<typeof s.documents.$inferSelect, "tenantId" | "subjectKind" | "subjectId">): Promise<string | null> {
  if (doc.subjectKind === "order") return doc.subjectId;
  if (doc.subjectKind === "leg") return (await db.select({ o: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, doc.tenantId), eq(s.legs.id, doc.subjectId))).limit(1))[0]?.o ?? null;
  if (doc.subjectKind === "crossing") return (await db.select({ o: s.crossings.orderId }).from(s.crossings).where(and(eq(s.crossings.tenantId, doc.tenantId), eq(s.crossings.id, doc.subjectId))).limit(1))[0]?.o ?? null;
  return null;
}
