import { normCountry } from "./zones";
import { and, eq, gte, desc, inArray, sql, or } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { wrap, parse, transactionSets, envelopeOf, build997, EdiError, type Segment } from "@/integrations/edi/x12";
import { build214, build210, build990, parse204, DEFAULT_214_MAP, type Party, type Tender204 } from "@/integrations/edi/messages";
import { createOrder, cancelOrder, ValidationError, NotFoundError, type StopInput } from "./orders";
import { zoneFor, localToInstant } from "@/lib/time";

/**
 * EDI with customers (spec §4.2 EDI 214 to RXO/AOD, §7.4 EDI 210, inbound 204 tenders):
 * every message is a row first; outbound is generated from our own events and invoices,
 * inbound 204s become draft orders (or wait in the inbox), and every interchange gets a 997.
 */

type Partner = typeof s.ediPartners.$inferSelect;

async function loadPartner(tenantId: string, partnerId: string) {
  const [p] = await db.select().from(s.ediPartners).where(and(eq(s.ediPartners.tenantId, tenantId), eq(s.ediPartners.id, partnerId))).limit(1);
  if (!p) throw new NotFoundError("EDI partner", partnerId);
  return p;
}

export async function partnerForCustomer(tenantId: string, customerId: string | null) {
  if (!customerId) return null;
  const [p] = await db
    .select()
    .from(s.ediPartners)
    .where(and(eq(s.ediPartners.tenantId, tenantId), eq(s.ediPartners.customerId, customerId), eq(s.ediPartners.enabled, true), sql`${s.ediPartners.archivedAt} is null`))
    .limit(1);
  return p ?? null;
}

/** Interchange control numbers never repeat per partner: serialized on the partner row. */
async function nextControl(partnerId: string) {
  return db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`select next_control as n from edi_partners where id = ${partnerId} for update`)) as unknown as { n: number }[];
    await tx.update(s.ediPartners).set({ nextControl: row.n + 1, lastOutboundAt: new Date() }).where(eq(s.ediPartners.id, partnerId));
    return row.n;
  });
}

const FUNCTIONAL: Record<string, string> = { "214": "QM", "210": "IM", "990": "GF", "997": "FA", "204": "SM" };

/** Generate, store and hand off one outbound transaction set. Idempotent on subjectKey. */
async function queueOutbound(ctx: Ctx, partner: Partner, m: { type: "214" | "210" | "990" | "997"; body: Segment[]; subjectKey: string; summary: string; orderId?: string | null; legId?: string | null; invoiceId?: string | null; at?: Date }) {
  const [dup] = await db.select({ id: s.ediMessages.id }).from(s.ediMessages).where(and(eq(s.ediMessages.tenantId, ctx.tenantId), eq(s.ediMessages.subjectKey, m.subjectKey))).limit(1);
  if (dup) return null;
  const control = await nextControl(partner.id);
  const at = m.at ?? new Date();
  const text = wrap(m.body, { senderQualifier: partner.ourQualifier, senderId: partner.ourId, receiverQualifier: partner.theirQualifier, receiverId: partner.theirId, usage: partner.usage === "P" ? "P" : "T", controlNumber: control, functionalId: FUNCTIONAL[m.type], transactionSet: m.type, at });
  const id = newId();
  let outboxId: string | null = null;
  let state: (typeof s.EDI_MESSAGE_STATES)[number] = "logged";
  if (partner.delivery === "email" && partner.deliveryEmail) {
    const ob = await enqueue(ctx, { channel: "email", to: partner.deliveryEmail, subject: `EDI ${m.type} ${partner.ourId} → ${partner.theirId} #${control}`, body: text, subjectKind: "edi", subjectId: id });
    outboxId = ob.id;
    state = "queued";
  }
  await db.insert(s.ediMessages).values({ id, tenantId: ctx.tenantId, partnerId: partner.id, direction: "out", type: m.type, controlNumber: String(control), functionalId: FUNCTIONAL[m.type], orderId: m.orderId ?? null, legId: m.legId ?? null, invoiceId: m.invoiceId ?? null, subjectKey: m.subjectKey, summary: m.summary, content: text, state, outboxId, createdBy: ctx.userId });
  if (outboxId) {
    await deliverQueued();
    const [ob] = await db.select({ state: s.outbox.state }).from(s.outbox).where(eq(s.outbox.id, outboxId)).limit(1);
    if (ob?.state === "sent" || ob?.state === "logged") await db.update(s.ediMessages).set({ state: ob.state }).where(eq(s.ediMessages.id, id));
  }
  return id;
}

// ---------- 214 from leg events ----------

const stopParty = (st: typeof s.stops.$inferSelect | undefined): Party | null => (st ? { name: st.name, line1: st.address?.line1 ?? null, city: st.address?.city ?? null, state: st.address?.state ?? null, postalCode: st.address?.postalCode ?? null, country: st.address?.country ?? st.country } : null);

/** One 214 per (leg, milestone) for every partner that wants them. Runs from the ticker; safe to repeat. */
export async function emit214(now = new Date()) {
  const partners = await db.select().from(s.ediPartners).where(and(eq(s.ediPartners.enabled, true), eq(s.ediPartners.send214, true), sql`${s.ediPartners.archivedAt} is null`));
  let sent = 0;
  for (const p of partners) {
    const ctx = systemCtx(p.tenantId);
    const map = { ...Object.fromEntries(Object.entries(DEFAULT_214_MAP).map(([k, v]) => [k, v.code])), ...(p.statusMap ?? {}) };
    const since = new Date(now.getTime() - 7 * 86400_000);
    const orders = await db
      .select()
      .from(s.orders)
      .where(and(eq(s.orders.tenantId, p.tenantId), or(eq(s.orders.customerId, p.customerId), eq(s.orders.brokerId, p.customerId)), gte(s.orders.updatedAt, since)));
    if (!orders.length) continue;
    const orderIds = orders.map((o) => o.id);
    const [legs, stops, events, trucks] = await Promise.all([
      db.select().from(s.legs).where(inArray(s.legs.orderId, orderIds)),
      db.select().from(s.stops).where(inArray(s.stops.orderId, orderIds)),
      db.select().from(s.legEvents).where(and(inArray(s.legEvents.orderId, orderIds), eq(s.legEvents.kind, "transition"), gte(s.legEvents.at, since))).orderBy(s.legEvents.at),
      db.select({ id: s.trucks.id, unitNumber: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.tenantId, p.tenantId)),
    ]);
    const stopById = new Map(stops.map((x) => [x.id, x]));
    for (const ev of events) {
      const code = ev.toState ? map[ev.toState] : null;
      if (!code) continue;
      const leg = legs.find((l) => l.id === ev.legId);
      const order = orders.find((o) => o.id === ev.orderId);
      if (!leg || !order) continue;
      const ordered = stops.filter((x) => x.orderId === order.id).sort((a, b) => a.seq - b.seq);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const where = ["at_pickup", "loaded"].includes(ev.toState!) ? stopById.get(leg.fromStopId ?? "") : ["at_delivery", "completed"].includes(ev.toState!) ? stopById.get(leg.toStopId ?? "") : ev.lat ? undefined : stopById.get(leg.fromStopId ?? "");
      const body = build214({
        ourRef: order.orderNumber,
        theirRef: order.refs.rate_con ?? order.refs.shipment ?? order.refs.po ?? order.sourceRef ?? null,
        scac: p.scac,
        refs: [
          { qualifier: "PO", value: order.refs.po ?? "" },
          { qualifier: "BM", value: order.refs.bol ?? "" },
          { qualifier: "CR", value: order.refs.reference ?? "" },
        ],
        shipper: stopParty(first),
        consignee: stopParty(last),
        status: { code, at: ev.at, city: where?.address?.city ?? null, state: where?.address?.state ?? null, country: where?.address?.country ?? where?.country ?? null },
        equipment: leg.truckId ? { number: trucks.find((t) => t.id === leg.truckId)?.unitNumber ?? null } : null,
      });
      const id = await queueOutbound(ctx, p, { type: "214", body, subjectKey: `214:${leg.id}:${ev.toState}`, summary: `${order.orderNumber} · ${code} ${DEFAULT_214_MAP[ev.toState!]?.label ?? ev.toState}`, orderId: order.id, legId: leg.id, at: now });
      if (id) sent++;
    }
    for (const o of orders) {
      if (o.state !== "cancelled" || !map.cancelled) continue;
      const body = build214({ ourRef: o.orderNumber, theirRef: o.refs.rate_con ?? o.sourceRef ?? null, scac: p.scac, refs: [], status: { code: map.cancelled, at: o.updatedAt } });
      const id = await queueOutbound(ctx, p, { type: "214", body, subjectKey: `214:${o.id}:cancelled`, summary: `${o.orderNumber} · ${map.cancelled} cancelled`, orderId: o.id, at: now });
      if (id) sent++;
    }
  }
  return { sent };
}

// ---------- 210 at issue ----------

/** Called by issueInvoice after the snapshot is locked. No partner or 210 off → nothing. */
export async function emit210(ctx: Ctx, invoiceId: string) {
  const [inv] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.id, invoiceId))).limit(1);
  if (!inv || !inv.snapshot || !inv.number || !inv.issuedAt) return null;
  const partner = await partnerForCustomer(ctx.tenantId, inv.customerId);
  if (!partner || !partner.send210) return null;
  const snap = inv.snapshot;
  const first = snap.stops[0];
  const last = snap.stops[snap.stops.length - 1];
  const party = (st: typeof first | undefined): Party | null => (st ? { name: st.name, city: st.city, state: st.state, country: st.country } : null);
  const body = build210({
    invoiceNumber: inv.number,
    theirRef: snap.refs.rate_con ?? snap.refs.shipment ?? snap.refs.po ?? null,
    scac: partner.scac,
    currency: snap.currency,
    issuedAt: inv.issuedAt,
    deliveredAt: last?.arrivedAt ? new Date(last.arrivedAt) : null,
    totalCents: inv.totalCents,
    refs: [
      { qualifier: "PO", value: snap.refs.po ?? "" },
      { qualifier: "BM", value: snap.refs.bol ?? "" },
      { qualifier: "CR", value: snap.refs.reference ?? "" },
      { qualifier: "CO", value: snap.lines[0]?.orderNumber ?? "" },
    ],
    billTo: { name: snap.billTo.name },
    shipper: party(first),
    consignee: party(last),
    lines: snap.lines.map((l) => ({ description: l.description, kind: l.kind, qty: l.qty, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents })),
    chargeCodes: partner.chargeCodes ?? undefined,
  });
  return queueOutbound(ctx, partner, { type: "210", body, subjectKey: `210:${inv.id}`, summary: `${inv.number} · ${(inv.totalCents / 100).toFixed(2)} ${snap.currency}`, invoiceId: inv.id, orderId: inv.orderIds[0] ?? null });
}

// ---------- inbound ----------

export type InboundResult = { messageId: string; sets: { type: string; control: string; ok: boolean; note: string; orderId?: string | null; messageId?: string | null }[]; ackId: string | null };

/** An interchange arrived (HTTP endpoint with the partner token, or pasted by a person). */
export async function receiveInterchange(partnerId: string, text: string, opts: { via: "http" | "paste" | "sftp"; userId?: string | null } = { via: "http" }): Promise<InboundResult> {
  const [p] = await db.select().from(s.ediPartners).where(eq(s.ediPartners.id, partnerId)).limit(1);
  if (!p || !p.enabled || p.archivedAt) throw new NotFoundError("EDI partner", partnerId);
  const ctx: Ctx = { tenantId: p.tenantId, userId: opts.userId ?? null, role: "system" };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(text);
  } catch (e) {
    const id = newId();
    await db.insert(s.ediMessages).values({ id, tenantId: p.tenantId, partnerId: p.id, direction: "in", type: "?", summary: `unreadable interchange: ${(e as Error).message}`, content: text.slice(0, 200_000), state: "error", error: (e as Error).message, createdBy: opts.userId ?? null });
    throw new ValidationError(`could not read the interchange: ${(e as Error).message}`);
  }
  const env = envelopeOf(parsed.segments);
  if (env.senderId !== p.theirId.trim()) throw new ValidationError(`interchange is from ${env.senderId}, but this partner is ${p.theirId}`);
  const key = `in:${p.id}:${env.isaControl}`;
  const [dup] = await db.select({ id: s.ediMessages.id }).from(s.ediMessages).where(and(eq(s.ediMessages.tenantId, p.tenantId), eq(s.ediMessages.subjectKey, key))).limit(1);
  if (dup) throw new ValidationError(`interchange ${env.isaControl} was already received`);
  const sets = transactionSets(parsed.segments);
  const messageId = newId();
  await db.insert(s.ediMessages).values({ id: messageId, tenantId: p.tenantId, partnerId: p.id, direction: "in", type: "interchange", controlNumber: env.isaControl, functionalId: env.functionalId, subjectKey: key, summary: `${sets.map((x) => x.type).join(" + ") || "empty"} from ${env.senderId} via ${opts.via}`, content: text, state: "received", createdBy: opts.userId ?? null });
  await db.update(s.ediPartners).set({ lastInboundAt: new Date() }).where(eq(s.ediPartners.id, p.id));

  const results: InboundResult["sets"] = [];
  for (const set of sets) {
    if (set.type === "204") {
      results.push({ ...(await handle204(ctx, p, set, messageId)), type: "204", control: set.control });
    } else if (set.type === "997") {
      // their acknowledgment of ours: mark the acknowledged control numbers
      const ak1 = set.segments.find((x) => x[0] === "AK1");
      if (ak1?.[2]) await db.update(s.ediMessages).set({ ackedAt: new Date() }).where(and(eq(s.ediMessages.partnerId, p.id), eq(s.ediMessages.direction, "out"), eq(s.ediMessages.controlNumber, ak1[2])));
      results.push({ type: "997", control: set.control, ok: true, note: `acknowledged group ${ak1?.[2] ?? "?"}` });
    } else {
      results.push({ type: set.type, control: set.control, ok: false, note: `we do not process ${set.type}` });
    }
  }
  // 997 back for everything except a 997
  const ackable = sets.filter((x) => x.type !== "997");
  let ackId: string | null = null;
  if (ackable.length) {
    const body = build997({ ackFunctionalId: env.functionalId, ackGroupControl: env.gsControl, sets: ackable.map((x) => ({ type: x.type, control: x.control, ok: results.find((r) => r.control === x.control)?.ok ?? false })) });
    ackId = await queueOutbound(ctx, p, { type: "997", body, subjectKey: `997:${p.id}:${env.isaControl}`, summary: `997 for ${env.isaControl}: ${results.filter((r) => r.ok).length}/${ackable.length} accepted` });
  }
  return { messageId, sets: results, ackId };
}

const eqMap: Record<string, string> = { TV: "53_dry", TF: "53_dry", RT: "53_reefer", FT: "flatbed", SV: "sprinter", TL: "53_dry" };

async function handle204(ctx: Ctx, p: Partner, set: { control: string; segments: Segment[] }, inboundId: string): Promise<{ ok: boolean; note: string; orderId?: string | null; messageId?: string | null }> {
  let t: Tender204;
  try {
    t = parse204(set.segments);
  } catch (e) {
    return { ok: false, note: (e as Error).message };
  }
  const [existing] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, p.tenantId), eq(s.orders.source, "edi204"), eq(s.orders.sourceRef, t.theirRef))).limit(1);
  const summaryBase = `${t.theirRef} · ${t.stops[0]?.party?.name ?? "?"} → ${t.stops[t.stops.length - 1]?.party?.name ?? "?"}`;
  if (t.purpose === "cancel") {
    if (!existing) return { ok: true, note: `cancel for ${t.theirRef}: no order here` };
    try {
      await cancelOrder(ctx, existing.id, `EDI 204 cancellation from ${p.theirId}`);
      return { ok: true, note: `cancelled ${existing.orderNumber}`, orderId: existing.id };
    } catch (e) {
      await db.insert(s.flags).values({ id: newId(), tenantId: p.tenantId, orderId: existing.id, code: "edi_cancel_blocked", level: "red", title: `Customer cancelled by EDI but the load is moving`, detail: (e as Error).message, owner: "dispatch" });
      return { ok: true, note: `cancel for ${existing.orderNumber} needs a dispatcher: ${(e as Error).message}`, orderId: existing.id };
    }
  }
  if (t.purpose === "change" || existing) {
    const id = newId();
    await db.insert(s.ediMessages).values({ id, tenantId: p.tenantId, partnerId: p.id, direction: "in", type: "204", controlNumber: set.control, orderId: existing?.id ?? null, summary: `${t.purpose === "change" ? "CHANGE" : "DUPLICATE"} ${summaryBase}`, content: set.segments.map((x) => x.join("*")).join("~\n"), state: "received", subjectKey: `204:${p.id}:${set.control}:${inboundId}`, createdBy: ctx.userId });
    if (existing) await db.insert(s.flags).values({ id: newId(), tenantId: p.tenantId, orderId: existing.id, code: "edi_change", level: "yellow", title: `Customer sent a ${t.purpose === "change" ? "changed" : "repeated"} tender for ${t.theirRef}`, detail: "Open the EDI inbox to compare and accept or decline", owner: "dispatch" });
    return { ok: true, note: `${t.purpose} for ${t.theirRef} waits in the EDI inbox`, orderId: existing?.id ?? null, messageId: id };
  }
  // original tender: store it, then create the draft order if the partner allows it
  const id = newId();
  await db.insert(s.ediMessages).values({ id, tenantId: p.tenantId, partnerId: p.id, direction: "in", type: "204", controlNumber: set.control, summary: `TENDER ${summaryBase}`, content: set.segments.map((x) => x.join("*")).join("~\n"), state: "received", subjectKey: `204:${p.id}:${set.control}:${inboundId}`, createdBy: ctx.userId });
  if (!p.accept204) return { ok: true, note: `tender ${t.theirRef} stored; this partner's tenders are not accepted automatically`, messageId: id };
  if (!p.autoCreateOrders) return { ok: true, note: `tender ${t.theirRef} waits in the EDI inbox`, messageId: id };
  try {
    const order = await orderFromTender(ctx, p, t, id);
    return { ok: true, note: `draft ${order.orderNumber} created`, orderId: order.id, messageId: id };
  } catch (e) {
    await db.update(s.ediMessages).set({ state: "error", error: (e as Error).message }).where(eq(s.ediMessages.id, id));
    return { ok: false, note: `could not create an order: ${(e as Error).message}`, messageId: id };
  }
}

/** The customer's stops as they sent them; the legs are cut from them like any load. */
function stopsFromTender(t: Tender204, companyZone: string): { stops: StopInput[]; template: string | null } {
  const at = (st: Tender204["stops"][number], l: { date: string; time: string; code: string | null } | null, fallback: Date | null) => (l ? localToInstant(l.date, l.time, zoneFor({ code: l.code, state: st.party?.state, city: st.party?.city, country: st.party?.country }, companyZone)) : fallback);
  const ends: StopInput[] = t.stops.map((st) => ({
    type: st.type,
    name: st.party?.name || (st.type === "pickup" ? "Pickup" : "Delivery"),
    address: st.party ? { line1: st.party.line1 ?? undefined, city: st.party.city ?? undefined, state: st.party.state ?? undefined, postalCode: st.party.postalCode ?? undefined, country: st.party.country ?? undefined } : undefined,
    country: normCountry(st.party?.country),
    windowStart: at(st, st.earliestLocal, st.earliest), // wall-clock times land in the stop's own zone
    windowEnd: at(st, st.latestLocal, st.latest),
    appointment: st.appointment,
    refs: st.refs,
    notes: [st.commodity && `${st.commodity}${st.pieces ? ` · ${st.pieces} pcs` : ""}${st.weightLbs ? ` · ${st.weightLbs} lb` : ""}`, ...st.notes].filter(Boolean).join(" · ") || null,
  }));
  if (ends.length < 2) throw new ValidationError("the tender has fewer than two stops");
  return { stops: ends, template: null };
}

/** Draft order from a parsed tender (no booking: a dispatcher reviews it). Links the inbound message. */
async function orderFromTender(ctx: Ctx, p: Partner, t: Tender204, messageId: string) {
  const [tenant] = await db.select({ timeZone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const { stops, template } = stopsFromTender(t, tenant?.timeZone ?? "America/Detroit");
  const o = await createOrder(ctx, {
    customerId: p.customerId,
    equipment: (t.equipment?.code && eqMap[t.equipment.code]) || "53_dry",
    refs: { ...t.refs, ...(t.refs.rate_con ? {} : { rate_con: t.theirRef }) },
    rateCents: t.rateCents,
    rateTbd: t.rateCents == null,
    cargoNote: [t.stops[0]?.commodity, t.totalWeightLbs && `${t.totalWeightLbs} lb`, ...t.notes].filter(Boolean).join(" · ") || null,
    template,
    source: "edi204",
    sourceRef: t.theirRef,
    stops,
    book: false,
  });
  await db.update(s.ediMessages).set({ orderId: o.order.id, state: "accepted" }).where(eq(s.ediMessages.id, messageId));
  return o.order;
}

/** A dispatcher accepts or declines a tender from the inbox → order (if accepting) + 990. */
export async function respondToTender(ctx: Ctx, messageId: string, accept: boolean, note?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, accept ? "orders.create" : "dispatch.plan");
  const [m] = await db.select().from(s.ediMessages).where(and(eq(s.ediMessages.tenantId, ctx.tenantId), eq(s.ediMessages.id, messageId))).limit(1);
  if (!m || m.direction !== "in" || m.type !== "204") throw new NotFoundError("tender", messageId);
  if (m.state !== "received" && m.state !== "error") throw new ValidationError(`this tender is already ${m.state}`);
  const p = await loadPartner(ctx.tenantId, m.partnerId);
  const t = parse204(m.content.split(/~\n?/).filter(Boolean).map((line) => line.split("*")));
  let orderId: string | null = m.orderId;
  if (accept) {
    if (t.purpose === "change") throw new ValidationError("apply the change on the existing order, then acknowledge it as declined-changed or accepted from here");
    const o = await orderFromTender(ctx, p, t, m.id);
    orderId = o.id;
  } else {
    if (!note?.trim()) throw new ValidationError("say why you are declining — it goes to the customer", "note");
    await db.update(s.ediMessages).set({ state: "rejected", error: note.trim() }).where(eq(s.ediMessages.id, m.id));
  }
  const body = build990({ scac: p.scac, theirRef: t.theirRef, accept, at: new Date(), refs: [{ qualifier: "PO", value: t.refs.po ?? "" }], note: accept ? null : note });
  const ackId = await queueOutbound(ctx, p, { type: "990", body, subjectKey: `990:${m.id}`, summary: `${accept ? "ACCEPT" : "DECLINE"} ${t.theirRef}`, orderId });
  await writeAudit(db, ctx, "edi_message", m.id, "transition", { state: { from: m.state, to: accept ? "accepted" : "rejected" }, note: { from: null, to: note ?? null }, orderId: { from: m.orderId, to: orderId } });
  return { orderId, ackId };
}

/** Auto-accept 990 for tenders that became orders without a person (sent right after creation). */
export async function send990ForAutoAccepted(now = new Date()) {
  const rows = await db.select().from(s.ediMessages).where(and(eq(s.ediMessages.direction, "in"), eq(s.ediMessages.type, "204"), eq(s.ediMessages.state, "accepted")));
  let sent = 0;
  for (const m of rows) {
    const [done] = await db.select({ id: s.ediMessages.id }).from(s.ediMessages).where(and(eq(s.ediMessages.tenantId, m.tenantId), eq(s.ediMessages.subjectKey, `990:${m.id}`))).limit(1);
    if (done) continue;
    const [p] = await db.select().from(s.ediPartners).where(eq(s.ediPartners.id, m.partnerId)).limit(1);
    if (!p) continue;
    const t = parse204(m.content.split(/~\n?/).filter(Boolean).map((line) => line.split("*")));
    const id = await queueOutbound(systemCtx(m.tenantId), p, { type: "990", body: build990({ scac: p.scac, theirRef: t.theirRef, accept: true, at: now, refs: [{ qualifier: "PO", value: t.refs.po ?? "" }] }), subjectKey: `990:${m.id}`, summary: `ACCEPT ${t.theirRef}`, orderId: m.orderId });
    if (id) sent++;
  }
  return { sent };
}

// ---------- reads ----------

export async function ediLog(ctx: Ctx, opts: { limit?: number; direction?: "in" | "out"; partnerId?: string } = {}) {
  assertCtx(ctx);
  const conds = [eq(s.ediMessages.tenantId, ctx.tenantId)];
  if (opts.direction) conds.push(eq(s.ediMessages.direction, opts.direction));
  if (opts.partnerId) conds.push(eq(s.ediMessages.partnerId, opts.partnerId));
  const rows = await db
    .select({ m: s.ediMessages, theirId: s.ediPartners.theirId, customerId: s.ediPartners.customerId, orderNumber: s.orders.orderNumber })
    .from(s.ediMessages)
    .innerJoin(s.ediPartners, eq(s.ediPartners.id, s.ediMessages.partnerId))
    .leftJoin(s.orders, eq(s.orders.id, s.ediMessages.orderId))
    .where(and(...conds))
    .orderBy(desc(s.ediMessages.createdAt))
    .limit(opts.limit ?? 200);
  return rows;
}

/** Tenders waiting for a person. */
export async function ediInbox(ctx: Ctx) {
  assertCtx(ctx);
  return db
    .select({ m: s.ediMessages, theirId: s.ediPartners.theirId, customerId: s.ediPartners.customerId, orderNumber: s.orders.orderNumber })
    .from(s.ediMessages)
    .innerJoin(s.ediPartners, eq(s.ediPartners.id, s.ediMessages.partnerId))
    .leftJoin(s.orders, eq(s.orders.id, s.ediMessages.orderId))
    .where(and(eq(s.ediMessages.tenantId, ctx.tenantId), eq(s.ediMessages.direction, "in"), eq(s.ediMessages.type, "204"), inArray(s.ediMessages.state, ["received", "error"])))
    .orderBy(desc(s.ediMessages.createdAt));
}

export async function ediMessage(ctx: Ctx, id: string) {
  assertCtx(ctx);
  const [m] = await db.select().from(s.ediMessages).where(and(eq(s.ediMessages.tenantId, ctx.tenantId), eq(s.ediMessages.id, id))).limit(1);
  if (!m) throw new NotFoundError("EDI message", id);
  return m;
}

/** A parsed view of a stored 204 for the inbox card. */
export function tenderView(m: { content: string }) {
  try {
    return parse204(m.content.split(/~\n?/).filter(Boolean).map((line) => line.split("*")));
  } catch (e) {
    if (e instanceof EdiError) return null;
    throw e;
  }
}

export async function partnerByToken(token: string) {
  const [p] = await db.select().from(s.ediPartners).where(eq(s.ediPartners.inboundToken, token)).limit(1);
  return p && p.enabled && !p.archivedAt ? p : null;
}
