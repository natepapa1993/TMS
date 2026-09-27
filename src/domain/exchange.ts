import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { LegState } from "@/db/schema";
import { newId } from "@/lib/ids";
import { newToken } from "@/lib/tokens";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError, createOrder, bookOrder, cancelOrder, advanceLeg } from "./orders";
import { LEG_FORWARD } from "./states";

/**
 * Carrier-to-carrier exchange (spec Module 8, Phase 3): a tender to a partner carrier that is also on
 * Crossline appears on their dispatch board as a load; their acceptance, their driver and unit, every
 * milestone, their positions, the POD and their invoice flow back to the tendering company's leg
 * without anyone re-typing. The link is one code per company, entered once on the carrier record;
 * the tendering company appears in the partner's tenant as a customer.
 */

const CODE_LEN = 8;

/** The company's exchange code: minted once, shown under Settings → Company, given to partners. */
export async function exchangeCode(ctx: Ctx) {
  assertCtx(ctx);
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const cur = (t?.settings as Record<string, unknown> | undefined)?.exchangeCode;
  if (typeof cur === "string" && cur) return cur;
  const code = newToken().replace(/[^A-Z0-9]/gi, "").slice(0, CODE_LEN).toUpperCase();
  await db.update(s.tenants).set({ settings: { ...(t?.settings ?? {}), exchangeCode: code } }).where(eq(s.tenants.id, ctx.tenantId));
  return code;
}

async function tenantByCode(code: string) {
  const [t] = await db.select({ id: s.tenants.id, name: s.tenants.name }).from(s.tenants).where(sql`upper(${s.tenants.settings}->>'exchangeCode') = ${code.trim().toUpperCase()}`).limit(1);
  return t ?? null;
}

/** On the carrier record: "they are on Crossline too" — the partner's code links the two companies. */
export async function linkCarrier(ctx: Ctx, carrierId: string, code: string) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  const [c] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, carrierId))).limit(1);
  if (!c) throw new NotFoundError("carrier", carrierId);
  const partner = await tenantByCode(code);
  if (!partner) throw new ValidationError("no company on Crossline has that exchange code — ask them for theirs under Settings → Company", "code");
  if (partner.id === ctx.tenantId) throw new ValidationError("that is your own code", "code");
  await db.update(s.carriers).set({ exchangeTenantId: partner.id, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carriers.id, c.id));
  await writeAudit(db, ctx, "carrier", c.id, "update", { exchange: { from: c.exchangeTenantId, to: partner.id } }, `linked to ${partner.name} on Crossline`);
  return { partnerName: partner.name };
}

export async function unlinkCarrier(ctx: Ctx, carrierId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  const [c] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, carrierId))).limit(1);
  if (!c) throw new NotFoundError("carrier", carrierId);
  await db.update(s.carriers).set({ exchangeTenantId: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carriers.id, c.id));
  await writeAudit(db, ctx, "carrier", c.id, "update", { exchange: { from: c.exchangeTenantId, to: null } }, "exchange link removed");
}

export async function partnerName(tenantId: string) {
  const [t] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  return t?.name ?? "partner";
}

/** In the partner's tenant, the tendering company is a customer (created on the first tender). */
async function customerFor(partnerTenantId: string, fromTenantId: string) {
  const [existing] = await db.select().from(s.customers).where(and(eq(s.customers.tenantId, partnerTenantId), eq(s.customers.exchangeTenantId, fromTenantId))).limit(1);
  if (existing) return existing;
  const name = await partnerName(fromTenantId);
  const [from] = await db.select({ country: s.tenants.country }).from(s.tenants).where(eq(s.tenants.id, fromTenantId)).limit(1);
  const ctx = systemCtx(partnerTenantId);
  const [row] = await db
    .insert(s.customers)
    .values({ id: newId(), tenantId: partnerTenantId, name, kind: "customer", country: from?.country ?? "US", termsDays: 30, requiredDocs: [], trackingRequirement: "none", exchangeTenantId: fromTenantId, knowledgeMd: "On Crossline: their tenders land on your board; your milestones, POD and invoice go straight back to them.", createdBy: null, updatedBy: null })
    .returning();
  await writeAudit(db, ctx, "customer", row.id, "create", { name: { from: null, to: name }, exchange: { from: null, to: fromTenantId } }, "created by the carrier exchange");
  return row;
}

const REF = (tenantId: string, tenderId: string) => `exchange:${tenantId}:${tenderId}`;
const parseRef = (ref: string | null | undefined) => {
  const m = ref?.match(/^exchange:([^:]+):([^:]+)$/);
  return m ? { tenantId: m[1], tenderId: m[2] } : null;
};

/**
 * Called by sendTender: the load appears on the partner's board as a draft with an offer flag. The
 * tender's own link still works — accepting there or on the board is the same acceptance.
 */
export async function mirrorTender(ctx: Ctx, tender: typeof s.tenders.$inferSelect, leg: typeof s.legs.$inferSelect, order: typeof s.orders.$inferSelect, from: typeof s.stops.$inferSelect | undefined, to: typeof s.stops.$inferSelect | undefined, partnerTenantId: string) {
  assertCtx(ctx);
  const pctx = systemCtx(partnerTenantId);
  const customer = await customerFor(partnerTenantId, ctx.tenantId);
  const ours = await partnerName(ctx.tenantId);
  const mirrored = await createOrder(pctx, {
    customerId: customer.id,
    rateCents: tender.rateCents,
    rateTbd: tender.rateCents == null,
    currency: tender.currency,
    equipment: order.equipment,
    cargoNote: order.cargoNote,
    refs: { reference: `${order.orderNumber} leg ${leg.seq}`, ...(order.refs.po ? { po: order.refs.po } : {}) },
    source: "exchange",
    sourceRef: REF(ctx.tenantId, tender.id),
    legPlan: [{ type: leg.type, from: 0, to: 1 }],
    stops: [from, to].map((st, i) => ({ type: (st?.type ?? (i === 0 ? "pickup" : "delivery")) as s.StopType, name: st?.name ?? (i === 0 ? "Pickup" : "Delivery"), country: st?.country ?? "US", address: st?.address ?? undefined, windowStart: st?.windowStart ?? undefined, windowEnd: st?.windowEnd ?? undefined, contact: st?.contact ?? undefined, notes: st?.notes ?? undefined, locationId: null })),
    book: false,
  });
  await db.insert(s.flags).values({ id: newId(), tenantId: partnerTenantId, orderId: mirrored.order.id, code: "exchange_offer", level: "yellow", title: `Load offer from ${ours}${tender.rateCents != null ? ` · ${tender.currency} ${(tender.rateCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : ""}`, detail: `${tender.message ? `${tender.message} · ` : ""}answer by ${tender.expiresAt.toISOString()}; accept to book it, decline to send it back`, owner: "dispatch", data: { tenderId: tender.id, fromTenantId: ctx.tenantId, expiresAt: tender.expiresAt.toISOString(), link: tender.token } });
  return mirrored.order;
}

/** The partner's open offers: exchange drafts with the offer flag still open. */
export async function exchangeOffers(ctx: Ctx) {
  assertCtx(ctx);
  const rows = await db
    .select({ order: s.orders, flag: s.flags })
    .from(s.flags)
    .innerJoin(s.orders, eq(s.orders.id, s.flags.orderId))
    .where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.code, "exchange_offer"), sql`${s.flags.clearedAt} is null`, eq(s.orders.state, "draft")))
    .orderBy(desc(s.flags.openedAt));
  return rows.map((r) => ({ orderId: r.order.id, orderNumber: r.order.orderNumber, title: r.flag.title, detail: r.flag.detail, expiresAt: (r.flag.data as { expiresAt?: string } | null)?.expiresAt ?? null, rateCents: r.order.rateCents, currency: r.order.currency }));
}

/** The partner answers on their board: accept books the load and accepts our tender; decline sends it back. */
export async function answerOffer(ctx: Ctx, orderId: string, accept: boolean, note?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!o || o.source !== "exchange") throw new NotFoundError("offer", orderId);
  const ref = parseRef(o.sourceRef);
  if (!ref) throw new ValidationError("this load did not come through the exchange");
  const [tender] = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId))).limit(1);
  if (!tender) throw new NotFoundError("tender", ref.tenderId);
  if (tender.state !== "sent") throw new ValidationError(tender.state === "expired" ? "this offer has expired" : `this offer was already ${tender.state}`);
  const { respondToTender } = await import("./tenders");
  const [user] = ctx.userId ? await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, ctx.userId)).limit(1) : [];
  const who = user?.name ?? (await partnerName(ctx.tenantId));
  if (accept) {
    await respondToTender(tender.token, { accept: true, name: who, driverName: "assigned on Crossline", note: note ?? null }, { viaExchange: true });
    await bookOrder(ctx, orderId);
    await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.orderId, orderId), eq(s.flags.code, "exchange_offer")));
    return { state: "accepted" as const };
  }
  if (!note?.trim()) throw new ValidationError("tell them why, in a few words", "note");
  await respondToTender(tender.token, { accept: false, name: who, note: note.trim() }, { viaExchange: true });
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.orderId, orderId), eq(s.flags.code, "exchange_offer")));
  await cancelOrder(ctx, orderId, `declined: ${note.trim()}`);
  return { state: "declined" as const };
}

/** The tender was answered somewhere else (its link, or by phone at the tendering desk): the mirror follows. */
export async function syncMirrorAfterAnswer(fromTenantId: string, tenderId: string, accepted: boolean, note: string | null) {
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.sourceRef, REF(fromTenantId, tenderId)), eq(s.orders.state, "draft"))).limit(1);
  if (!o) return;
  const ctx = systemCtx(o.tenantId);
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: "system" }).where(and(eq(s.flags.orderId, o.id), eq(s.flags.code, "exchange_offer")));
  if (accepted) await bookOrder(ctx, o.id).catch(() => null);
  else await cancelOrder(ctx, o.id, note ? `declined: ${note}` : "the offer was closed").catch(() => null);
}

/** Our tender was withdrawn or expired before they answered: the mirrored draft goes away. */
export async function withdrawMirror(fromTenantId: string, tenderId: string, why: string) {
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.sourceRef, REF(fromTenantId, tenderId)), eq(s.orders.state, "draft"))).limit(1);
  if (!o) return;
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: "system" }).where(and(eq(s.flags.orderId, o.id), eq(s.flags.code, "exchange_offer")));
  await cancelOrder(systemCtx(o.tenantId), o.id, why).catch(() => null);
}

// ---------- what flows back ----------

/** Our leg's state, as the partner's legs imply it: their first leg is our pickup, their last our delivery. */
export function impliedState(theirLegs: { seq: number; state: LegState }[], theirOrderState: string): LegState | null {
  const live = theirLegs.filter((l) => l.state !== "cancelled").sort((p, q) => p.seq - q.seq);
  if (!live.length) return null;
  if (theirOrderState === "delivered" || live.every((l) => l.state === "completed")) return "completed";
  const first = live[0];
  const last = live[live.length - 1];
  const idx = (st: LegState) => LEG_FORWARD.indexOf(st);
  if (idx(last.state) >= idx("at_delivery")) return "at_delivery";
  if (idx(last.state) >= idx("en_route") || live.slice(1).some((l) => idx(l.state) >= idx("en_route_to_pickup"))) return "en_route";
  if (first.state === "completed" || idx(first.state) >= idx("loaded")) return live.length === 1 && first.state === "loaded" ? "loaded" : "en_route";
  if (first.state === "at_pickup") return "at_pickup";
  if (first.state === "en_route_to_pickup") return "en_route_to_pickup";
  return null;
}

/** After any change to the partner's legs: our leg follows, forward only, one milestone at a time so every clock is stamped. */
export async function pushProgress(theirTenantId: string, theirOrderId: string) {
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, theirTenantId), eq(s.orders.id, theirOrderId))).limit(1);
  const ref = parseRef(o?.sourceRef);
  if (!o || !ref) return null;
  const theirLegs = await db.select({ seq: s.legs.seq, state: s.legs.state }).from(s.legs).where(eq(s.legs.orderId, o.id));
  const target = impliedState(theirLegs, o.state);
  if (!target) return null;
  const [tender] = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId))).limit(1);
  if (!tender || tender.state !== "accepted") return null;
  const ctx = systemCtx(ref.tenantId);
  let [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ref.tenantId), eq(s.legs.id, tender.legId))).limit(1);
  if (!leg) return null;
  const forward = LEG_FORWARD as readonly string[];
  let steps = 0;
  while (leg && forward.indexOf(leg.state) >= 0 && forward.indexOf(leg.state) < forward.indexOf(target) && steps < 8) {
    const next = forward[forward.indexOf(leg.state) + 1] as LegState;
    leg = await advanceLeg(ctx, leg.id, next, { source: "carrier", verified: false, note: `from ${await partnerName(theirTenantId)}'s board (${o.orderNumber})` });
    steps++;
  }
  return { steps, state: leg?.state };
}

/** The partner assigned a truck and driver: their names land on our accepted tender, as a portal answer would. */
export async function pushAssignment(theirTenantId: string, theirLegId: string) {
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, theirTenantId), eq(s.legs.id, theirLegId))).limit(1);
  if (!leg) return;
  const [o] = await db.select().from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const ref = parseRef(o?.sourceRef);
  if (!o || !ref || leg.seq !== 1) return; // the first leg's driver is who picks up
  const [driver] = leg.driverId ? await db.select({ name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(eq(s.drivers.id, leg.driverId)).limit(1) : [];
  const [truck] = leg.truckId ? await db.select({ unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.id, leg.truckId)).limit(1) : [];
  const [carrier] = leg.carrierId ? await db.select({ name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.id, leg.carrierId)).limit(1) : [];
  const driverName = driver?.name ?? (carrier ? `${carrier.name} (their partner)` : null);
  if (!driverName) return;
  await db.update(s.tenders).set({ driverName, driverPhone: driver?.phone ?? null, unitNumber: truck?.unitNumber ?? null, updatedAt: new Date() }).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId), eq(s.tenders.state, "accepted")));
  const [tender] = await db.select({ legId: s.tenders.legId, orderId: s.tenders.orderId }).from(s.tenders).where(eq(s.tenders.id, ref.tenderId)).limit(1);
  if (tender) await db.insert(s.legEvents).values({ id: newId(), tenantId: ref.tenantId, legId: tender.legId, orderId: tender.orderId, kind: "note", source: "carrier", verified: false, note: `${await partnerName(theirTenantId)} assigned ${driverName}${truck ? ` · unit ${truck.unitNumber}` : ""}` });
}

/** Their driver's positions are ours to show the customer. */
export async function pushPosition(theirTenantId: string, theirLegId: string, p: { at: Date; lat: string; lng: string; speedMph: number | null; heading: number | null; place: string | null }) {
  const [leg] = await db.select({ orderId: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, theirTenantId), eq(s.legs.id, theirLegId))).limit(1);
  if (!leg) return;
  const [o] = await db.select({ sourceRef: s.orders.sourceRef }).from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const ref = parseRef(o?.sourceRef);
  if (!ref) return;
  const [tender] = await db.select({ legId: s.tenders.legId, orderId: s.tenders.orderId, state: s.tenders.state }).from(s.tenders).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId))).limit(1);
  if (!tender || tender.state !== "accepted") return;
  await db.insert(s.positions).values({ id: newId(), tenantId: ref.tenantId, source: "carrier", at: p.at, lat: p.lat, lng: p.lng, speedMph: p.speedMph, heading: p.heading, place: p.place, legId: tender.legId, orderId: tender.orderId, truckId: null, driverId: null });
}

/** Their POD (or BOL) is our POD. */
export async function pushDocument(theirTenantId: string, theirOrderId: string, doc: { code: string; fileName: string; mimeType: string; bytes: Buffer }) {
  if (!["POD", "BOL", "SEAL_PHOTO"].includes(doc.code)) return;
  const [o] = await db.select({ sourceRef: s.orders.sourceRef }).from(s.orders).where(and(eq(s.orders.tenantId, theirTenantId), eq(s.orders.id, theirOrderId))).limit(1);
  const ref = parseRef(o?.sourceRef);
  if (!ref) return;
  const [tender] = await db.select({ orderId: s.tenders.orderId, state: s.tenders.state }).from(s.tenders).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId))).limit(1);
  if (!tender || tender.state !== "accepted") return;
  const { uploadOrderDocument } = await import("./billing");
  await uploadOrderDocument(systemCtx(ref.tenantId), tender.orderId, { code: doc.code, fileName: doc.fileName, mimeType: doc.mimeType, bytes: doc.bytes, source: "exchange" });
}

/** They issued their invoice to us: it is our carrier bill, received, ready for the three-way check. */
export async function pushInvoice(theirTenantId: string, invoiceId: string) {
  const [inv] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, theirTenantId), eq(s.invoices.id, invoiceId))).limit(1);
  if (!inv || !inv.number) return;
  const orders = await db.select({ id: s.orders.id, sourceRef: s.orders.sourceRef, rateCents: s.orders.rateCents }).from(s.orders).where(inArray(s.orders.id, inv.orderIds));
  const refs = orders.map((o) => parseRef(o.sourceRef)).filter((x): x is { tenantId: string; tenderId: string } => !!x);
  if (refs.length !== orders.length || !refs.length) return; // only when the whole invoice is exchange loads for one partner
  const B = await import("./billing");
  for (const ref of refs) {
    const [tender] = await db.select({ legId: s.tenders.legId, state: s.tenders.state }).from(s.tenders).where(and(eq(s.tenders.tenantId, ref.tenantId), eq(s.tenders.id, ref.tenderId))).limit(1);
    if (!tender || tender.state !== "accepted") continue;
    const ctx = systemCtx(ref.tenantId);
    await B.syncCarrierBills(ctx).catch(() => null);
    const [bill] = await db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ref.tenantId), eq(s.carrierBills.legId, tender.legId))).limit(1);
    if (!bill || ["approved", "scheduled", "paid"].includes(bill.state)) continue;
    const share = refs.length === 1 ? inv.totalCents : Math.round(inv.totalCents / refs.length);
    await B.receiveCarrierBill(ctx, bill.id, { invoicedCents: share, carrierInvoiceNumber: inv.number, docId: null }).catch(() => null);
  }
}

/** Where a mirrored load is on the partner's side, for our leg card: their order number and state. */
export async function partnerSide(ctx: Ctx, tenderId: string) {
  assertCtx(ctx);
  const [o] = await db.select({ orderNumber: s.orders.orderNumber, state: s.orders.state, tenantId: s.orders.tenantId }).from(s.orders).where(eq(s.orders.sourceRef, REF(ctx.tenantId, tenderId))).limit(1);
  if (!o) return null;
  return { orderNumber: o.orderNumber, state: o.state, partner: await partnerName(o.tenantId) };
}
