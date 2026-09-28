import { and, eq, inArray, lt, desc, sql } from "drizzle-orm";
import { fmtIn } from "@/lib/time";
import { tenantZone } from "./company";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { TenderChannel } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { newToken, publicUrl } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { planLeg, dispatchLeg, acceptLeg, declineLeg, NotFoundError, ValidationError, normCurrency } from "./orders";
import { money as fxMoney } from "./fx-rules";
import { TransitionError } from "./states";

/**
 * Tendering (spec §4): a leg is offered to one carrier at a time, with a rate, a deadline and a
 * link. Accept moves the leg to accepted; decline or expiry sends it back to Pending with a flag.
 */

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
};

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", ca: "Canada", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };

export async function sendTender(ctx: Ctx, legId: string, input: SendTenderInput) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.dispatch");
  const expiresIn = input.expiresInMinutes ?? 60;
  if (expiresIn < 5 || expiresIn > 7 * 24 * 60) throw new ValidationError("expiry must be between 5 minutes and 7 days", "expiresInMinutes");

  // 1. the leg is planned on this carrier (re-plan if it was on someone else)
  const [legBefore] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!legBefore) throw new NotFoundError("leg", legId);
  // the carrier is paid in its own currency (a Mexican carrier in pesos): the tender, the leg and the bill carry it
  const currency = normCurrency(input.currency ?? legBefore.carrierRateCurrency);
  if (legBefore.state !== "planned" || legBefore.carrierId !== input.carrierId)
    await planLeg(ctx, legId, { kind: "carrier", carrierId: input.carrierId, carrierRateCents: input.rateCents ?? null, carrierRateCurrency: currency }, { override: input.override, reason: input.reason });
  else if (input.rateCents != null && (input.rateCents !== legBefore.carrierRateCents || currency !== (legBefore.carrierRateCurrency ?? "USD")))
    await db.update(s.legs).set({ carrierRateCents: input.rateCents, carrierRateCurrency: currency, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.legs.id, legId));

  const [carrier] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, input.carrierId))).limit(1);
  if (!carrier) throw new NotFoundError("carrier", input.carrierId);
  const channel: TenderChannel = input.channel ?? ((carrier.tenderChannel as TenderChannel) || "email");
  const to = input.to ?? (channel === "whatsapp" ? carrier.whatsapp : carrier.dispatchEmail) ?? null;
  if (channel === "email" && !to) throw new ValidationError(`${carrier.name} has no dispatch email; add one or tender by another channel`, "to");
  if (channel === "whatsapp" && !to) throw new ValidationError(`${carrier.name} has no WhatsApp number; add one on the carrier record or tender by another channel`, "to");

  // 2. one open tender per leg
  await db
    .update(s.tenders)
    .set({ state: "withdrawn", respondedAt: new Date(), respondedBy: "dispatcher", responseNote: "replaced by a new tender", updatedAt: new Date(), updatedBy: ctx.userId })
    .where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "sent")));

  // 3. the leg goes to "sent"
  const leg = await dispatchLeg(ctx, legId);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, leg.orderId)).orderBy(s.stops.seq);
  const from = stops.find((x) => x.id === leg.fromStopId);
  const toStop = stops.find((x) => x.id === leg.toStopId);

  const token = newToken();
  const expiresAt = new Date(Date.now() + expiresIn * 60_000);
  const link = publicUrl(`/t/${token}`);
  const rate = (input.rateCents ?? leg.carrierRateCents) != null ? fxMoney((input.rateCents ?? leg.carrierRateCents) as number, currency, { code: true }) : "rate to be confirmed";
  const zone = await tenantZone(ctx.tenantId);
  const fmt = (d: Date | null | undefined) => fmtIn(d, zone);
  const place = (st?: typeof from) => (st ? `${st.name}${st.address?.city ? `, ${st.address.city}` : ""}${st.address?.state ? ` ${st.address.state}` : ""}` : "");
  const subject = `Load offer ${order.orderNumber}: ${place(from)} → ${place(toStop)} · ${rate}`;
  const body = [
    `${carrier.name},`,
    ``,
    `We have a ${LEG_TYPE_LABEL[leg.type] ?? leg.type} leg for you.`,
    ``,
    `Pickup:   ${place(from)}  (${fmt(from?.windowStart) ?? "ASAP"})`,
    `Delivery: ${place(toStop)}${toStop?.windowEnd ? `  (by ${fmt(toStop.windowEnd)})` : ""}`,
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
    if (to && channel === "email") await enqueue(ctx, { channel: "email", to, subject, body, subjectKind: "tender", subjectId: row.id }, tx);
    // WhatsApp: the template (when the company has one approved) takes carrier, lane, rate, link; otherwise the same text
    if (to && channel === "whatsapp") await enqueue(ctx, { channel: "whatsapp", to, subject, body, subjectKind: "tender", subjectId: row.id, meta: { kind: "tender", template: { name: "", params: [carrier.name, `${place(from)} → ${place(toStop)}`, rate, link] } } }, tx);
    return row;
  });
  await deliverQueued().catch(() => null);
  return { tender, leg, link, subject, body, to };
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

export type TenderResponse = { accept: boolean; name: string; note?: string | null; driverName?: string | null; driverPhone?: string | null; unitNumber?: string | null; trailerNumber?: string | null };

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
      trailerNumber: r.trailerNumber?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(s.tenders.id, tender.id));
  await writeAudit(db, ctx, "tender", tender.id, "transition", { state: { from: "sent", to: r.accept ? "accepted" : "declined" } }, `${r.name.trim()} via portal${r.note ? `: ${r.note}` : ""}`);

  if (r.accept) {
    const leg = await acceptLeg(ctx, tender.legId, "carrier");
    await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: leg.id, orderId: leg.orderId, kind: "note", source: "carrier", note: `Carrier accepted. Driver ${r.driverName}${r.driverPhone ? ` ${r.driverPhone}` : ""}${r.unitNumber ? `, unit ${r.unitNumber}` : ""}${r.trailerNumber ? `, trailer ${r.trailerNumber}` : ""}` });
    return { state: "accepted" as const, leg };
  }
  const leg = await declineLeg(ctx, tender.legId, `${found.carrier?.name ?? "carrier"} declined: ${r.note?.trim()}`, "carrier");
  return { state: "declined" as const, leg };
}

/** Dispatcher heard back by phone: close the open tender to match the leg. */
export async function closeOpenTenderForLeg(ctx: Ctx, legId: string, state: "accepted" | "declined" | "withdrawn", note?: string) {
  assertCtx(ctx);
  await db
    .update(s.tenders)
    .set({ state, respondedAt: new Date(), respondedBy: "dispatcher", responseNote: note ?? null, updatedAt: new Date(), updatedBy: ctx.userId })
    .where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "sent")));
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

/** Job: every tender past its deadline expires and its leg returns to Pending with a flag. */
export async function expireTenders(now = new Date()) {
  const due = await db.select().from(s.tenders).where(and(eq(s.tenders.state, "sent"), lt(s.tenders.expiresAt, now)));
  let expired = 0;
  for (const t of due) {
    const ctx = systemCtx(t.tenantId);
    await db.update(s.tenders).set({ state: "expired", respondedAt: now, respondedBy: "system", updatedAt: now }).where(and(eq(s.tenders.id, t.id), eq(s.tenders.state, "sent")));
    await writeAudit(db, ctx, "tender", t.id, "transition", { state: { from: "sent", to: "expired" } }, "no answer before the deadline");
    const [leg] = await db.select().from(s.legs).where(eq(s.legs.id, t.legId)).limit(1);
    if (leg && leg.state === "dispatched") {
      const [carrier] = await db.select({ name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.id, t.carrierId)).limit(1);
      await declineLeg(ctx, leg.id, `${carrier?.name ?? "carrier"} did not answer the tender in time`, "system").catch(() => null);
      await db.update(s.flags).set({ code: "tender_expired", title: `Tender to ${carrier?.name ?? "carrier"} expired` }).where(and(eq(s.flags.legId, leg.id), eq(s.flags.code, "declined"), sql`${s.flags.clearedAt} is null`));
    }
    expired++;
  }
  return { expired };
}
