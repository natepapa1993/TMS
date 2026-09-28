import { and, eq, inArray, lt, desc, sql } from "drizzle-orm";
import { fmtWhen, fmtWindow, stopZone } from "@/lib/time";
import { tenantZone } from "./company";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { TenderChannel } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { newToken, publicUrl } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { planLeg, dispatchLeg, acceptLeg, declineLeg, unplanLeg, refreshOrderState, NotFoundError, ValidationError, normCurrency } from "./orders";
import { TransitionError } from "./states";

/**
 * Tendering (spec §4): a leg is offered to one carrier at a time, with a rate, a deadline and a
 * link. Accept moves the leg to accepted; decline or expiry sends it back to Pending (Needs truck)
 * with a red flag. Every step — sent, accepted, declined, expired, withdrawn — is on the load's timeline.
 */

export type TenderEventState = "sent" | "accepted" | "declined" | "expired" | "withdrawn" | "countered" | "counter accepted" | "counter declined";

/** A tender step on the load's timeline (leg events, kind "tender"). */
async function tenderEvent(tx: Tx | typeof db, ctx: Ctx, t: { id: string; legId: string; orderId: string; carrierId: string }, state: TenderEventState, note: string, at = new Date()) {
  await tx.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: t.legId, orderId: t.orderId, at, kind: "tender", source: state === "accepted" || state === "declined" ? "carrier" : ctx.userId ? "dispatcher" : "system", userId: ctx.userId, note, data: { tenderId: t.id, state, carrierId: t.carrierId } });
}

export type SendTenderInput = {
  carrierId: string;
  rateCents?: number | null;
  currency?: string;
  channel?: TenderChannel;
  to?: string | null; // override the carrier's dispatch email
  expiresInMinutes?: number;
  message?: string | null;
  override?: boolean;
  reason?: string;
  saveContact?: boolean; // the number / email typed in the dialog goes onto the carrier's record
};

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", ca: "Canada", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };

/** Where a tender goes by each channel; "manual" is a link dispatch shares or reads out on the phone. */
export function tenderRecipient(channel: TenderChannel, carrier: { name: string; whatsapp?: string | null; dispatchEmail?: string | null }, to?: string | null) {
  const v = (to ?? (channel === "whatsapp" ? carrier.whatsapp : channel === "email" ? carrier.dispatchEmail : null) ?? "").trim() || null;
  if (channel === "email" && !v) throw new ValidationError(`${carrier.name} has no dispatch email. Add it here or tender by WhatsApp or a link.`, "dispatchEmail");
  if (channel === "whatsapp" && !v) throw new ValidationError(`${carrier.name} has no WhatsApp number. Add it here or tender by email or a link.`, "whatsapp");
  if (channel === "whatsapp" && v && v.replace(/\D/g, "").length < 10) throw new ValidationError(`"${v}" is not a WhatsApp number — use the full number with the country code (+52 …, +1 …)`, "whatsapp");
  if (channel === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new ValidationError(`"${v}" is not an email address`, "dispatchEmail");
  return v;
}

/**
 * Offer a leg to a carrier. This is the only way a partner carrier's leg is Sent (dispatch N1): the tender carries
 * the link, the deadline and the expiry back to Needs truck. The carrier's email / WhatsApp is checked before the
 * leg is touched, and anything that fails on the way (a message the provider refuses) puts the leg back as it was.
 */
export async function sendTender(ctx: Ctx, legId: string, input: SendTenderInput) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const expiresIn = input.expiresInMinutes ?? 60;
  if (expiresIn < 5 || expiresIn > 7 * 24 * 60) throw new ValidationError("expiry must be between 5 minutes and 7 days", "expiresInMinutes");

  const [legBefore] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!legBefore) throw new NotFoundError("leg", legId);
  const [carrier] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, input.carrierId))).limit(1);
  if (!carrier) throw new NotFoundError("carrier", input.carrierId);
  const channel: TenderChannel = input.channel ?? ((carrier.tenderChannel as TenderChannel) || "email");
  // 0. who it goes to, before anything changes: a tender that can't go out leaves the leg as it was
  const to = tenderRecipient(channel, carrier, input.to);
  if (input.saveContact && to && (channel === "whatsapp" || channel === "email")) {
    const field = channel === "whatsapp" ? "whatsapp" : "dispatchEmail";
    if ((carrier[field] ?? null) !== to) {
      await db.update(s.carriers).set({ [field]: to, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carriers.id, carrier.id));
      await writeAudit(db, ctx, "carrier", carrier.id, "update", { [field]: { from: carrier[field] ?? null, to } }, "added while tendering");
      carrier[field] = to;
    }
  }
  try {
    return await sendTenderTo(ctx, legId, input, { legBefore, carrier, channel, to, expiresIn });
  } catch (e) {
    await putLegBack(ctx, legBefore, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** A tender that failed on the way: the leg goes back to what it was (Needs truck, or Planned on who it had). */
async function putLegBack(ctx: Ctx, before: typeof s.legs.$inferSelect, why: string) {
  const [now] = await db.select().from(s.legs).where(eq(s.legs.id, before.id)).limit(1);
  if (!now) return;
  const same = now.state === before.state && now.carrierId === before.carrierId && now.carrierRateCents === before.carrierRateCents && now.truckId === before.truckId;
  if (same) return;
  const note = `Tender not sent (${why.slice(0, 160)}) — the leg is back as it was`;
  if (!before.assigneeKind || ["unassigned", "declined"].includes(before.state)) {
    await unplanLeg(ctx, before.id, note).catch(() => null);
    return;
  }
  const { id: _id, tenantId: _t, createdAt: _c, createdBy: _cb, ...cols } = before;
  void _id; void _t; void _c; void _cb;
  await db.update(s.legs).set({ ...cols, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.legs.id, before.id));
  await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: before.id, orderId: before.orderId, kind: "note", source: "system", userId: ctx.userId, note });
  await refreshOrderState(ctx, before.orderId).catch(() => null);
}

async function sendTenderTo(ctx: Ctx, legId: string, input: SendTenderInput, p: { legBefore: typeof s.legs.$inferSelect; carrier: typeof s.carriers.$inferSelect; channel: TenderChannel; to: string | null; expiresIn: number }) {
  const { legBefore, carrier, channel, to, expiresIn } = p;
  // 1. the leg is planned on this carrier (re-plan if it was on someone else)
  // the carrier is paid in its own currency (a Mexican carrier in pesos): the tender, the leg and the bill carry it
  const currency = normCurrency(input.currency ?? legBefore.carrierRateCurrency);
  if (legBefore.state !== "planned" || legBefore.carrierId !== input.carrierId)
    await planLeg(ctx, legId, { kind: "carrier", carrierId: input.carrierId, carrierRateCents: input.rateCents ?? null, carrierRateCurrency: currency }, { override: input.override, reason: input.reason, inPlace: false });
  else if (input.rateCents != null && (input.rateCents !== legBefore.carrierRateCents || currency !== (legBefore.carrierRateCurrency ?? "USD")))
    await db.update(s.legs).set({ carrierRateCents: input.rateCents, carrierRateCurrency: currency, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.legs.id, legId));

  // 2. one open tender per leg
  const replaced = await db
    .update(s.tenders)
    .set({ state: "withdrawn", respondedAt: new Date(), respondedBy: "dispatcher", responseNote: "replaced by a new tender", updatedAt: new Date(), updatedBy: ctx.userId })
    .where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "sent")))
    .returning();
  for (const r of replaced) await tenderEvent(db, ctx, r, "withdrawn", "Tender withdrawn: replaced by a new tender");
  // a new tender answers the old "tender expired" / "declined" flag on this leg
  await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.legId, legId), inArray(s.flags.code, ["tender_expired", "declined"]), sql`${s.flags.clearedAt} is null`));

  // 3. the leg goes to "sent"
  const leg = await dispatchLeg(ctx, legId);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, leg.orderId)).orderBy(s.stops.seq);
  const from = stops.find((x) => x.id === leg.fromStopId);
  const toStop = stops.find((x) => x.id === leg.toStopId);

  const token = newToken();
  const expiresAt = new Date(Date.now() + expiresIn * 60_000);
  const link = publicUrl(`/t/${token}`);
  // the code first ("MXN 9,500.00"): a bare "$" means pesos to a Mexican carrier and dollars to a US one
  const rate = (input.rateCents ?? leg.carrierRateCents) != null ? `${currency} ${(((input.rateCents ?? leg.carrierRateCents) as number) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "rate to be confirmed";
  const zone = await tenantZone(ctx.tenantId);
  // each stop's time on that stop's clock; the deadline on the company's
  const fmt = (d: Date | null | undefined) => fmtWhen(d, zone);
  const atStop = (st: typeof from) => (st ? fmtWindow(st.windowStart, st.windowEnd, stopZone(st, zone)) : null);
  const place = (st?: typeof from) => (st ? `${st.name}${st.address?.city ? `, ${st.address.city}` : ""}${st.address?.state ? ` ${st.address.state}` : ""}` : "");
  const subject = `Load offer ${order.orderNumber}: ${place(from)} → ${place(toStop)} · ${rate}`;
  const body = [
    `${carrier.name},`,
    ``,
    `We have a ${LEG_TYPE_LABEL[leg.type] ?? leg.type} leg for you.`,
    ``,
    `Pickup:   ${place(from)}  (${atStop(from) ?? "ASAP"})`,
    `Delivery: ${place(toStop)}${atStop(toStop) ? `  (${atStop(toStop)})` : ""}`,
    `Equipment: ${order.equipment.replace("_", " ")}`,
    order.cargoNote ? `Cargo: ${order.cargoNote}` : null,
    `Rate: ${rate}`,
    input.message ? `` : null,
    input.message ?? null,
    ``,
    `Accept or decline here (link works until ${fmt(expiresAt)}):`,
    link,
    ``,
    `Reference: ${order.orderNumber} leg ${leg.seq}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const tender = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.tenders)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        legId,
        orderId: leg.orderId,
        carrierId: carrier.id,
        rateCents: input.rateCents ?? leg.carrierRateCents ?? null,
        currency,
        channel,
        token,
        sentTo: to,
        expiresAt,
        message: input.message ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, "tender", row.id, "create", { carrierId: { from: null, to: carrier.id }, rateCents: { from: null, to: row.rateCents } }, `leg ${leg.seq} of ${order.orderNumber} tendered to ${carrier.name} by ${channel}`);
    await tenderEvent(tx, ctx, row, "sent", channel === "manual" ? `Tender link for ${carrier.name} (dispatch shares it or calls them) · ${rate} · answer by ${fmt(expiresAt)}` : `Tender sent to ${carrier.name} by ${channel}${to ? ` (${to})` : ""} · ${rate} · answer by ${fmt(expiresAt)}`);
    if (to && channel === "email") await enqueue(ctx, { channel: "email", to, subject, body, subjectKind: "tender", subjectId: row.id }, tx);
    // WhatsApp: the template (when the company has one approved) takes carrier, lane, rate, link; otherwise the same text
    if (to && channel === "whatsapp") await enqueue(ctx, { channel: "whatsapp", to, subject, body, subjectKind: "tender", subjectId: row.id, meta: { kind: "tender", template: { name: "", params: [carrier.name, `${place(from)} → ${place(toStop)}`, rate, link] } } }, tx);
    return row;
  });
  await deliverQueued().catch(() => null);
  // the provider refused it on the first try (a bad number, a template not approved): the tender stands — it has its
  // link and deadline and expires back to Needs truck — but dispatch hears it now, not from the pill later
  const [m] = channel === "email" || channel === "whatsapp" ? await db.select({ state: s.outbox.state, error: s.outbox.error }).from(s.outbox).where(and(eq(s.outbox.tenantId, ctx.tenantId), eq(s.outbox.subjectKind, "tender"), eq(s.outbox.subjectId, tender.id))).limit(1) : [];
  const deliveryError = m && m.error && m.state !== "sent" && m.state !== "logged" ? m.error : null;
  return { tender, leg, link, subject, body, to, deliveryError };
}

export async function tenderByToken(token: string) {
  const [t] = await db.select().from(s.tenders).where(eq(s.tenders.token, token)).limit(1);
  if (!t) return null;
  const ctx = systemCtx(t.tenantId);
  const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, t.legId)).limit(1);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, t.orderId)).limit(1);
  const [carrier] = await db.select().from(s.carriers).where(eq(s.carriers.id, t.carrierId)).limit(1);
  const [tenant] = await db.select().from(s.tenants).where(eq(s.tenants.id, t.tenantId)).limit(1);
  const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, t.orderId)).orderBy(s.stops.seq);
  const from = stops.find((x) => x.id === leg?.fromStopId) ?? null;
  const to = stops.find((x) => x.id === leg?.toStopId) ?? null;
  const effective = t.state === "sent" && t.expiresAt.getTime() < Date.now() ? "expired" : t.state;
  return { ctx, tender: { ...t, state: effective }, leg, order, carrier, tenant, from, to };
}

export type TenderResponse = { accept: boolean; name: string; note?: string | null; driverName?: string | null; driverPhone?: string | null; unitNumber?: string | null; unitPlate?: string | null; trailerNumber?: string | null };

/** The carrier's answer from the public page. No login: the token is the authorization. */
export async function respondToTender(token: string, r: TenderResponse) {
  const found = await tenderByToken(token);
  if (!found) throw new NotFoundError("tender", token.slice(0, 8));
  const { ctx, tender } = found;
  if (!r.name?.trim()) throw new ValidationError("please type your name", "name");
  if (tender.state !== "sent") throw new TransitionError("leg", tender.state, r.accept ? "accepted" : "declined", tender.state === "expired" ? "this offer has expired" : `this offer was already ${tender.state}`);
  if (r.accept && !r.driverName?.trim()) throw new ValidationError("driver name is required to accept", "driverName");
  if (!r.accept && !r.note?.trim()) throw new ValidationError("tell us why, in a few words", "note");

  await db
    .update(s.tenders)
    .set({
      state: r.accept ? "accepted" : "declined",
      respondedAt: new Date(),
      respondedBy: r.name.trim(),
      responseNote: r.note?.trim() || null,
      driverName: r.driverName?.trim() || null,
      driverPhone: r.driverPhone?.trim() || null,
      unitNumber: r.unitNumber?.trim() || null,
      unitPlate: r.unitPlate?.trim().toUpperCase() || null,
      trailerNumber: r.trailerNumber?.trim().toUpperCase() || null,
      updatedAt: new Date(),
    })
    .where(eq(s.tenders.id, tender.id));
  await writeAudit(db, ctx, "tender", tender.id, "transition", { state: { from: "sent", to: r.accept ? "accepted" : "declined" } }, `${r.name.trim()} via portal${r.note ? `: ${r.note}` : ""}`);

  if (r.accept) {
    const leg = await acceptLeg(ctx, tender.legId, "carrier");
    await tenderEvent(db, ctx, tender, "accepted", `Tender accepted by ${r.name.trim()} (${found.carrier?.name ?? "carrier"}). Driver ${r.driverName}${r.driverPhone ? ` ${r.driverPhone}` : ""}${r.unitNumber ? `, unit ${r.unitNumber}` : ""}${r.unitPlate ? ` (plates ${r.unitPlate.trim().toUpperCase()})` : ""}${r.trailerNumber ? `, trailer ${r.trailerNumber.trim().toUpperCase()}` : ""}`);
    // the caja the carrier named goes onto the crossing papers
    if (r.trailerNumber?.trim()) {
      const { cajaFromCarrier } = await import("./crossing");
      await cajaFromCarrier(ctx, leg.orderId, leg.id, r.trailerNumber.trim().toUpperCase(), `${found.carrier?.name ?? "carrier"} at acceptance`).catch(() => null);
    }
    return { state: "accepted" as const, leg };
  }
  await tenderEvent(db, ctx, tender, "declined", `Tender declined by ${r.name.trim()} (${found.carrier?.name ?? "carrier"}): ${r.note?.trim()}`);
  const leg = await declineLeg(ctx, tender.legId, `${found.carrier?.name ?? "carrier"} declined: ${r.note?.trim()}`, "carrier");
  return { state: "declined" as const, leg };
}

const fmtRate = (cents: number, cur: string) => `${cur} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/**
 * The carrier answers "not at that rate — at this one" from the offer page (M1): the counter goes to dispatch as a
 * flag on the board with Accept / Decline, instead of a decline and a new tender. The offer stays open (a little
 * longer, so dispatch can answer); the carrier can still accept the original rate meanwhile.
 */
export async function counterTender(token: string, r: { name: string; rateCents: number; note?: string | null }) {
  const found = await tenderByToken(token);
  if (!found) throw new NotFoundError("tender", token.slice(0, 8));
  const { ctx, tender, carrier } = found;
  if (!r.name?.trim()) throw new ValidationError("please type your name", "name");
  if (tender.state !== "sent") throw new TransitionError("leg", tender.state, "countered", tender.state === "expired" ? "this offer has expired" : `this offer was already ${tender.state}`);
  if (!Number.isFinite(r.rateCents) || r.rateCents <= 0) throw new ValidationError("type the rate you can do it for", "rate");
  if (tender.rateCents != null && r.rateCents === tender.rateCents) throw new ValidationError("that is the rate offered — accept it instead", "rate");
  const now = new Date();
  const expiresAt = new Date(Math.max(tender.expiresAt.getTime(), now.getTime() + 30 * 60_000));
  await db.update(s.tenders).set({ counterCents: r.rateCents, counterNote: r.note?.trim() || null, counterBy: r.name.trim(), counterAt: now, expiresAt, updatedAt: now }).where(eq(s.tenders.id, tender.id));
  await writeAudit(db, ctx, "tender", tender.id, "update", { counterCents: { from: tender.counterCents ?? null, to: r.rateCents } }, `${r.name.trim()} via the offer page`);
  const was = tender.rateCents != null ? ` (offered ${fmtRate(tender.rateCents, tender.currency)})` : "";
  await tenderEvent(db, ctx, tender, "countered", `Counter-offer from ${r.name.trim()} (${carrier?.name ?? "carrier"}): ${fmtRate(r.rateCents, tender.currency)}${was}${r.note?.trim() ? ` — ${r.note.trim()}` : ""}`);
  await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.legId, tender.legId), eq(s.flags.code, "tender_counter"), sql`${s.flags.clearedAt} is null`));
  await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: tender.orderId, legId: tender.legId, code: "tender_counter", level: "yellow", title: `Counter-offer: ${carrier?.name ?? "the carrier"} asks ${fmtRate(r.rateCents, tender.currency)}${was}`, detail: r.note?.trim() || "Accept or decline it on the leg", owner: "dispatch", data: { tenderId: tender.id, counterCents: r.rateCents } });
  return { expiresAt };
}

/**
 * Dispatch answers a counter-offer. Accept: the tender and the leg take the carrier's rate and the carrier confirms
 * on the same link with its driver (the offer stays open at least an hour). Decline: the offer stands at our rate.
 */
export async function answerCounter(ctx: Ctx, legId: string, accept: boolean) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const [t] = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "sent"))).limit(1);
  if (!t || t.counterCents == null) throw new ValidationError("there is no counter-offer on this leg");
  if (t.expiresAt.getTime() < Date.now()) throw new TransitionError("leg", "expired", "answer", "the offer expired");
  const now = new Date();
  const counter = fmtRate(t.counterCents, t.currency);
  if (accept) {
    await db.update(s.tenders).set({ rateCents: t.counterCents, counterCents: null, counterNote: null, counterBy: null, counterAt: null, expiresAt: new Date(Math.max(t.expiresAt.getTime(), now.getTime() + 60 * 60_000)), responseNote: `counter ${counter} accepted by dispatch`, updatedAt: now, updatedBy: ctx.userId }).where(eq(s.tenders.id, t.id));
    await db.update(s.legs).set({ carrierRateCents: t.counterCents, carrierRateCurrency: t.currency, updatedAt: now, updatedBy: ctx.userId }).where(eq(s.legs.id, legId));
    await writeAudit(db, ctx, "leg", legId, "update", { carrierRateCents: { from: t.rateCents, to: t.counterCents } }, `counter-offer from ${t.counterBy ?? "the carrier"} accepted`);
  } else {
    await db.update(s.tenders).set({ counterCents: null, counterNote: null, counterBy: null, counterAt: null, responseNote: `counter ${counter} declined by dispatch`, updatedAt: now, updatedBy: ctx.userId }).where(eq(s.tenders.id, t.id));
  }
  await tenderEvent(db, ctx, t, accept ? "counter accepted" : "counter declined", `Counter-offer ${counter} ${accept ? "accepted — the carrier confirms with its driver on the same link" : "declined — the offer stands"} (dispatch)`);
  await db.update(s.flags).set({ clearedAt: now, clearedBy: ctx.userId ?? "system" }).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.legId, legId), eq(s.flags.code, "tender_counter"), sql`${s.flags.clearedAt} is null`));
  // the carrier hears it where they got the offer
  const [carrier] = await db.select().from(s.carriers).where(eq(s.carriers.id, t.carrierId)).limit(1);
  if (t.sentTo && (t.channel === "email" || t.channel === "whatsapp")) {
    const es = (carrier?.country ?? "").toUpperCase() === "MX";
    const link = publicUrl(`/t/${t.token}`);
    const body = accept ? (es ? `Aceptamos su contraoferta de ${counter}. Confirme con su operador aquí: ${link}` : `We accept your counter-offer of ${counter}. Confirm with your driver here: ${link}`) : es ? `No podemos pagar ${counter}. La oferta sigue en ${t.rateCents != null ? fmtRate(t.rateCents, t.currency) : "la tarifa original"}: ${link}` : `We can't do ${counter}. The offer stands at ${t.rateCents != null ? fmtRate(t.rateCents, t.currency) : "the original rate"}: ${link}`;
    await enqueue(ctx, { channel: t.channel, to: t.sentTo, subject: `Counter-offer ${accept ? "accepted" : "declined"}`, body, subjectKind: "tender", subjectId: t.id });
    await deliverQueued().catch(() => null);
  }
  return { accepted: accept };
}

/** Dispatcher heard back by phone: close the open tender to match the leg. */
export async function closeOpenTenderForLeg(ctx: Ctx, legId: string, state: "accepted" | "declined" | "withdrawn", note?: string) {
  assertCtx(ctx);
  const closed = await db
    .update(s.tenders)
    .set({ state, respondedAt: new Date(), respondedBy: "dispatcher", responseNote: note ?? null, updatedAt: new Date(), updatedBy: ctx.userId })
    .where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "sent")))
    .returning();
  for (const t of closed) await tenderEvent(db, ctx, t, state, `Tender ${state} by dispatch${note ? `: ${note}` : ""}`);
}

export async function openTendersForOrders(ctx: Ctx, orderIds: string[]) {
  assertCtx(ctx);
  if (!orderIds.length) return [];
  const rows = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, ctx.tenantId), inArray(s.tenders.orderId, orderIds))).orderBy(desc(s.tenders.createdAt));
  if (!rows.length) return [];
  // delivery state of the message that carried it (email / WhatsApp), so the board can say "sent", "read" or "failed"
  const msgs = await db.select({ subjectId: s.outbox.subjectId, state: s.outbox.state, error: s.outbox.error }).from(s.outbox).where(and(eq(s.outbox.tenantId, ctx.tenantId), eq(s.outbox.subjectKind, "tender"), inArray(s.outbox.subjectId, rows.map((r) => r.id))));
  return rows.map((r) => {
    const m = msgs.find((x) => x.subjectId === r.id);
    return { ...r, delivery: m ? { state: m.state, error: m.error } : null };
  });
}

/**
 * Every tender past its deadline expires: the leg goes back to Needs truck (Pending, nobody on it) with a red
 * "Tender expired" flag that puts the load at the top of the board, and the expiry is on the load's timeline.
 * Runs from the job ticker and on read (the board, the planner, the Loads grid and the load page call it for
 * their company first), so the board is right between ticks. Idempotent: a tender expires once.
 */
export async function expireTenders(now = new Date(), opts: { tenantId?: string } = {}) {
  const due = await db
    .select()
    .from(s.tenders)
    .where(and(eq(s.tenders.state, "sent"), lt(s.tenders.expiresAt, now), opts.tenantId ? eq(s.tenders.tenantId, opts.tenantId) : sql`true`));
  let expired = 0;
  for (const t of due) {
    const ctx = systemCtx(t.tenantId);
    const [won] = await db.update(s.tenders).set({ state: "expired", respondedAt: now, respondedBy: "system", updatedAt: now }).where(and(eq(s.tenders.id, t.id), eq(s.tenders.state, "sent"))).returning({ id: s.tenders.id });
    if (!won) continue; // another reader got it first
    const [carrier] = await db.select({ name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.id, t.carrierId)).limit(1);
    const who = carrier?.name ?? "carrier";
    await writeAudit(db, ctx, "tender", t.id, "transition", { state: { from: "sent", to: "expired" } }, "no answer before the deadline");
    const zone = await tenantZone(t.tenantId);
    await tenderEvent(db, ctx, t, "expired", `Tender to ${who} expired: no answer by ${fmtWhen(t.expiresAt, zone)}`, now);
    const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, t.legId)).limit(1);
    if (leg && (leg.state === "dispatched" || leg.state === "planned") && leg.carrierId === t.carrierId) {
      // nobody is on it any more: back to Needs truck
      await unplanLeg(ctx, leg.id, `${who} did not answer the tender in time`).catch(() => null);
      await db.insert(s.flags).values({ id: newId(), tenantId: t.tenantId, orderId: t.orderId, legId: leg.id, code: "tender_expired", level: "red", title: `Tender expired — ${who} did not answer`, detail: `Leg ${leg.seq} needs a truck again. Tender it to the next carrier or put a truck on it.`, owner: "dispatch", data: { tenderId: t.id, carrierId: t.carrierId } });
    }
    expired++;
  }
  // a "tender expired" flag whose leg has been covered since (a truck, a carrier by any route) is stale: it goes (N9)
  const stale = await db
    .select({ id: s.flags.id })
    .from(s.flags)
    .innerJoin(s.legs, eq(s.legs.id, s.flags.legId))
    .where(and(eq(s.flags.code, "tender_expired"), sql`${s.flags.clearedAt} is null`, sql`${s.legs.state} not in ('unassigned', 'declined')`, opts.tenantId ? eq(s.flags.tenantId, opts.tenantId) : sql`true`));
  // a counter-offer flag whose tender is no longer open with a counter (accepted, declined, expired, replaced) goes too
  const counters = await db
    .select({ id: s.flags.id })
    .from(s.flags)
    .where(and(eq(s.flags.code, "tender_counter"), sql`${s.flags.clearedAt} is null`, sql`not exists (select 1 from tenders t where t.leg_id = ${s.flags.legId} and t.state = 'sent' and t.counter_cents is not null)`, opts.tenantId ? eq(s.flags.tenantId, opts.tenantId) : sql`true`));
  const gone = [...stale, ...counters].map((x) => x.id);
  if (gone.length) await db.update(s.flags).set({ clearedAt: now, clearedBy: "system" }).where(inArray(s.flags.id, gone));
  return { expired, cleared: gone.length };
}
