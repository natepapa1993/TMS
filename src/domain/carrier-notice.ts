import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { NotFoundError, ValidationError, unplanLeg } from "./orders";

/**
 * Telling a partner carrier we took the load back (M9, owner #19). Pulling a leg back from a carrier
 * who already said yes, or a TONU on a load they were going to run, sends them a plain cancellation
 * through the outbox — email to their dispatch address, WhatsApp when that is how they were tendered —
 * and says so on the load's timeline. Nothing is sent to a carrier who never accepted.
 */

const LEG_LABEL: Record<string, string> = { mx: "Mexico", ca: "Canada", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };

/** Whether pulling this leg back needs a "yes, cancel it with the carrier" first: a carrier leg they accepted (or confirmed by phone). */
export function needsCarrierNotice(leg: { assigneeKind: string | null; carrierId: string | null; state: string }) {
  return leg.assigneeKind === "carrier" && !!leg.carrierId && leg.state === "accepted";
}

export async function notifyCarrierCancelled(ctx: Ctx, legId: string, why: { kind: "pulled_back" | "tonu"; reason: string }) {
  assertCtx(ctx);
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  if (!leg.carrierId) return null;
  const [carrier] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, leg.carrierId))).limit(1);
  if (!carrier) return null;
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, leg.orderId)).limit(1);
  const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, leg.orderId)).orderBy(s.stops.seq);
  const from = stops.find((x) => x.id === leg.fromStopId);
  const to = stops.find((x) => x.id === leg.toStopId);
  const [tender] = await db.select({ channel: s.tenders.channel, sentTo: s.tenders.sentTo }).from(s.tenders).where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.legId, leg.id), inArray(s.tenders.state, ["accepted", "sent"]))).limit(1);
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const place = (st?: typeof from) => (st ? `${st.name}${st.address?.city ? `, ${st.address.city}` : ""}` : "");
  const es = carrier.country === "MX";
  const what = why.kind === "tonu" ? (es ? "El cliente canceló la carga (TONU)." : "The customer cancelled the load (TONU).") : es ? "Ya no necesitamos su unidad para este tramo." : "We no longer need your truck for this leg.";
  const subject = es ? `Cancelada: carga ${order.orderNumber} · ${place(from)} → ${place(to)}` : `Cancelled: load ${order.orderNumber} · ${place(from)} → ${place(to)}`;
  const body = [
    `${carrier.name},`,
    ``,
    `${es ? "Carga" : "Load"} ${order.orderNumber} — ${LEG_LABEL[leg.type] ?? leg.type} ${es ? "tramo" : "leg"}: ${place(from)} → ${place(to)}.`,
    what,
    why.reason ? `${es ? "Motivo" : "Reason"}: ${why.reason}` : "",
    ``,
    es ? "Por favor no envíe unidad. Si ya iba en camino, llámenos para acordar el TONU." : "Please do not send a truck. If yours is already on the way, call us to agree a TONU.",
    ``,
    tenant?.name ?? "",
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n");
  const channel = tender?.channel === "whatsapp" && carrier.whatsapp ? "whatsapp" : carrier.dispatchEmail ? "email" : carrier.whatsapp ? "whatsapp" : null;
  const toAddr = channel === "whatsapp" ? carrier.whatsapp : channel === "email" ? carrier.dispatchEmail : null;
  let row: { id: string } | null = null;
  if (channel && toAddr) {
    row = await enqueue(ctx, { channel, to: toAddr, subject, body, subjectKind: "carrier_cancel", subjectId: leg.id, meta: { kind: "general", template: null, orderId: leg.orderId } });
    await deliverQueued(5).catch(() => null);
  }
  const note = row ? `Cancellation sent to ${carrier.name} (${toAddr})` : `${carrier.name} has no dispatch email or WhatsApp on file — call them to cancel`;
  await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: leg.id, orderId: leg.orderId, kind: "message", source: "dispatcher", userId: ctx.userId, note });
  await writeAudit(db, ctx, "leg", leg.id, "update", undefined, `${note}${why.reason ? ` — ${why.reason}` : ""}`);
  return { sent: !!row, to: toAddr, note };
}

/**
 * Take a leg back from whoever has it. When a partner carrier already accepted it, the dispatcher has
 * to confirm (the UI asks) and the carrier is told it's cancelled.
 */
export async function pullBackLeg(ctx: Ctx, legId: string, opts: { reason?: string | null; confirmCarrier?: boolean } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "dispatch.plan");
  const [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.id, legId))).limit(1);
  if (!leg) throw new NotFoundError("leg", legId);
  const tell = needsCarrierNotice(leg);
  if (tell && !opts.confirmCarrier) throw new ValidationError("the carrier already accepted this leg — confirm to cancel it with them", "confirmCarrier");
  if (tell && !opts.reason?.trim()) throw new ValidationError("say why you're taking it back (the carrier sees it)", "reason");
  const { closeOpenTenderForLeg } = await import("./tenders");
  await closeOpenTenderForLeg(ctx, legId, "withdrawn", opts.reason ?? "pulled back by dispatch");
  const notice = tell ? await notifyCarrierCancelled(ctx, legId, { kind: "pulled_back", reason: opts.reason?.trim() ?? "" }) : null;
  const after = await unplanLeg(ctx, legId, opts.reason ?? undefined);
  return { leg: after, notice };
}
