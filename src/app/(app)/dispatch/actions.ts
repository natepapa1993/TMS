"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as O from "@/domain/orders";
import { sendTender, closeOpenTenderForLeg, type SendTenderInput } from "@/domain/tenders";
import { issueToken, publicUrl } from "@/lib/tokens";
import { latestTruckPositions } from "@/domain/tracking";
import type { LegState, EventSource, StopType } from "@/db/schema";

const touch = () => {
  revalidatePath("/dispatch");
  revalidatePath("/orders");
  revalidatePath("/fleet");
};

/** Trucks ranked for a leg, with when and where each comes free, the deadhead to the pickup, and whether it can make the appointment. */
export async function candidatesAction(legId: string) {
  return act(async (ctx) => {
    const { rankForLeg } = await import("@/domain/planner");
    return rankForLeg(ctx, legId);
  });
}

export async function carrierEligibilityAction(legId: string, carrierId: string) {
  return act(async (ctx) => {
    const leg = await O.getLeg(ctx, legId);
    return O.eligibilityFor(ctx, await O.zoneForLeg((await import("@/db/client")).db, leg), { kind: "carrier", carrierId });
  });
}

export async function laneRateAction(legId: string, carrierId: string) {
  return act((ctx) => O.suggestCarrierRate(ctx, legId, carrierId));
}

/** The carrier's last-90-days scorecard and compliance, shown the moment one is picked. */
export async function carrierPickAction(carrierId: string) {
  return act(async (ctx) => {
    const { carrierPick } = await import("@/domain/carrier-portal");
    return carrierPick(ctx, carrierId);
  });
}

export type PlanOpts = { override?: boolean; reason?: string; plannedMiles?: number | null };

export async function planAction(legId: string, a: O.Assignment, opts: PlanOpts = {}) {
  const r = await act((ctx) => O.planLeg(ctx, legId, a, opts));
  if (r.ok) touch();
  return r;
}

export async function unplanAction(legId: string, reason?: string) {
  const r = await act(async (ctx) => {
    await closeOpenTenderForLeg(ctx, legId, "withdrawn", reason);
    return O.unplanLeg(ctx, legId, reason);
  });
  if (r.ok) touch();
  return r;
}

export async function dispatchAction(legId: string) {
  const r = await act((ctx) => O.dispatchLeg(ctx, legId));
  if (r.ok) touch();
  return r;
}

export async function planAndDispatchAction(legId: string, a: O.Assignment, opts: PlanOpts = {}) {
  const r = await act(async (ctx) => {
    await O.planLeg(ctx, legId, a, opts);
    return O.dispatchLeg(ctx, legId);
  });
  if (r.ok) touch();
  return r;
}

export async function advanceAction(legId: string, to: LegState | "next", ev: { source?: EventSource; note?: string; at?: string } = {}) {
  const r = await act((ctx) => {
    const at = ev.at ? new Date(ev.at) : undefined;
    if (at && (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000)) throw Object.assign(new Error("That time is in the future"), { name: "ValidationError", field: "at" });
    return O.advanceLeg(ctx, legId, to, { source: ev.source ?? "dispatcher", verified: false, note: ev.note, at });
  });
  if (r.ok) touch();
  return r;
}

export async function acceptAction(legId: string) {
  const r = await act(async (ctx) => {
    const leg = await O.acceptLeg(ctx, legId, "dispatcher");
    await closeOpenTenderForLeg(ctx, legId, "accepted", "confirmed by phone");
    return leg;
  });
  if (r.ok) touch();
  return r;
}

export async function declineAction(legId: string, reason: string) {
  const r = await act(async (ctx) => {
    const leg = await O.declineLeg(ctx, legId, reason, "dispatcher");
    await closeOpenTenderForLeg(ctx, legId, "declined", reason);
    return leg;
  });
  if (r.ok) touch();
  return r;
}

export async function splitAction(legId: string, stop: { type: StopType; name: string; country: string; locationId?: string | null }) {
  const r = await act((ctx) => O.splitLeg(ctx, legId, { type: stop.type, name: stop.name, country: stop.country, locationId: stop.locationId ?? null }));
  if (r.ok) touch();
  return r;
}

export async function holdAction(orderId: string, reason: string) {
  const r = await act((ctx) => O.holdOrder(ctx, orderId, reason));
  if (r.ok) touch();
  return r;
}

export async function releaseAction(orderId: string) {
  const r = await act((ctx) => O.releaseOrder(ctx, orderId));
  if (r.ok) touch();
  return r;
}

export async function cancelAction(orderId: string, reason: string) {
  const r = await act((ctx) => O.cancelOrder(ctx, orderId, reason));
  if (r.ok) touch();
  return r;
}

export async function copyOrderAction(orderId: string, dates: { pickupAt?: string | null; deliveryAt?: string | null } = {}) {
  const r = await act(async (ctx) => {
    const c = await O.copyOrder(ctx, orderId, { pickupAt: dates.pickupAt ? new Date(dates.pickupAt) : null, deliveryAt: dates.deliveryAt ? new Date(dates.deliveryAt) : null });
    return { id: c.order.id, orderNumber: c.order.orderNumber };
  });
  if (r.ok) touch();
  return r;
}

export async function bookAction(orderId: string) {
  const r = await act((ctx) => O.bookOrder(ctx, orderId));
  if (r.ok) touch();
  return r;
}

export async function setDriversAction(legId: string, drivers: { driverId?: string | null; coDriverId?: string | null }, opts: { override?: boolean; reason?: string } = {}) {
  const r = await act((ctx) => O.setLegDrivers(ctx, legId, drivers, opts));
  if (r.ok) touch();
  return r;
}

export async function oosAction(truckId: string, reason: string) {
  const r = await act((ctx) => O.setTruckOos(ctx, truckId, reason));
  if (r.ok) touch();
  return r;
}

/** Offer a leg to a partner carrier: plans it, marks it sent, emails the accept/decline link. */
export async function tenderAction(legId: string, input: SendTenderInput) {
  const r = await act((ctx) => sendTender(ctx, legId, input));
  if (r.ok) touch();
  return r;
}

export async function withdrawTenderAction(legId: string, reason?: string) {
  const r = await act(async (ctx) => {
    await closeOpenTenderForLeg(ctx, legId, "withdrawn", reason ?? "withdrawn by dispatch");
    return O.unplanLeg(ctx, legId, reason ?? "tender withdrawn");
  });
  if (r.ok) touch();
  return r;
}

/** The customer tracking link for an order (one per order, reused). */
export async function trackingLinkAction(orderId: string) {
  return act(async (ctx) => {
    await O.getOrder(ctx, orderId); // tenant check
    const tok = await issueToken(ctx, "tracking_link", orderId, { label: "customer" });
    return { url: publicUrl(`/track/${tok.token}`) };
  });
}

/** The driver's app link (one per driver, reused; revoke from the driver record). */
export async function driverLinkAction(driverId: string) {
  return act(async (ctx) => {
    const { get } = await import("@/data/records");
    const d = await get(ctx, "driver", driverId);
    const tok = await issueToken(ctx, "driver_app", driverId, { label: String(d.name) });
    return { url: publicUrl(`/d/${tok.token}`), name: String(d.name), phone: (d.phone as string | null) ?? null, whatsapp: (d.whatsapp as string | null) ?? null };
  });
}

export async function positionsAction() {
  return act((ctx) => latestTruckPositions(ctx));
}

export async function setLegMilesAction(legId: string, miles: string) {
  const r = await act((ctx) => O.setLegMiles(ctx, legId, miles.trim() ? Number(miles.replace(/[,\s]/g, "")) : null));
  if (r.ok) touch();
  return r;
}

/** The partner carrier's driver's link for one leg (their phone is our tracking on a carrier leg). */
export async function carrierDriverLinkAction(legId: string) {
  return act(async (ctx) => {
    const { carrierDriverLink } = await import("@/domain/carrier-portal");
    const { db } = await import("@/db/client");
    const { legs } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const [l] = await db.select({ id: legs.id }).from(legs).where(and(eq(legs.tenantId, ctx.tenantId), eq(legs.id, legId))).limit(1);
    if (!l) throw Object.assign(new Error("leg not found"), { name: "NotFoundError" });
    return carrierDriverLink(ctx.tenantId, legId);
  });
}

/** Send a driver their app link, a partner carrier's driver their leg link, or a customer contact the tracking link, on WhatsApp through the outbox (template "tracking": name, order, link). */
export async function sendLinkWhatsAppAction(input: { kind: "driver" | "tracking" | "carrier_driver"; orderId: string; driverId?: string; legId?: string; to?: string }) {
  return act(async (ctx) => {
    const { enqueue, deliverQueued } = await import("@/lib/outbox");
    const { db } = await import("@/db/client");
    const { outbox } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const o = await O.getOrder(ctx, input.orderId);
    let to: string | null = null;
    let name = "";
    let url = "";
    if (input.kind === "driver") {
      if (!input.driverId) throw Object.assign(new Error("pick a driver"), { name: "ValidationError" });
      const { get } = await import("@/data/records");
      const d = await get(ctx, "driver", input.driverId);
      to = ((d.whatsapp as string | null) || (d.phone as string | null)) ?? null;
      name = String(d.name);
      url = publicUrl(`/d/${(await issueToken(ctx, "driver_app", input.driverId, { label: name })).token}`);
      if (!to) throw Object.assign(new Error(`${name} has no phone or WhatsApp on the driver record`), { name: "ValidationError" });
    } else if (input.kind === "carrier_driver") {
      if (!input.legId) throw Object.assign(new Error("pick a leg"), { name: "ValidationError" });
      const { carrierDriverLink } = await import("@/domain/carrier-portal");
      const cl = await carrierDriverLink(ctx.tenantId, input.legId);
      to = input.to?.trim() || cl.driverPhone || null;
      name = cl.driverName ?? "Driver";
      url = cl.url;
      if (!to) throw Object.assign(new Error("the carrier has not given a phone for their driver; enter one"), { name: "ValidationError", field: "to" });
    } else {
      to = input.to?.trim() || null;
      if (!to) throw Object.assign(new Error("enter the customer contact's WhatsApp number"), { name: "ValidationError", field: "to" });
      name = "Tracking";
      url = publicUrl(`/track/${(await issueToken(ctx, "tracking_link", input.orderId, { label: "customer" })).token}`);
    }
    const body = input.kind === "driver" ? `${name}, your loads: ${url}` : input.kind === "carrier_driver" ? `${name}, load ${o.order.orderNumber} — one button per step, keep it open while driving: ${url}` : `Tracking for ${o.order.orderNumber}: ${url}`;
    const row = await enqueue(ctx, { channel: "whatsapp", to, body, subjectKind: input.kind === "driver" ? "driver_link" : input.kind === "carrier_driver" ? "carrier_driver_link" : "tracking_link", subjectId: input.kind === "driver" ? input.driverId! : input.kind === "carrier_driver" ? input.legId! : input.orderId, meta: { kind: "tracking", template: { name: "", params: [name, o.order.orderNumber, url] } } });
    await deliverQueued().catch(() => null);
    const [after] = await db.select({ state: outbox.state, error: outbox.error }).from(outbox).where(eq(outbox.id, row.id)).limit(1);
    return { state: after?.state ?? "queued", error: after?.error ?? null, to };
  });
}

export async function checkCallAction(orderId: string, v: { legId?: string | null; status: string; location: string; eta: string; tempF: string; note: string; send: boolean }) {
  const { addCheckCall } = await import("@/domain/check-calls");
  const r = await act((ctx) => {
    const tempF = v.tempF.trim() ? Number(v.tempF) : null;
    return addCheckCall(ctx, orderId, { legId: v.legId ?? null, status: v.status, location: v.location, etaAt: v.eta ? new Date(v.eta) : null, tempF, note: v.note, sendToCustomer: v.send });
  });
  if (r.ok) touch();
  return r;
}

export async function checkCallsAction(orderId: string) {
  const { listCheckCalls } = await import("@/domain/check-calls");
  return act((ctx) => listCheckCalls(ctx, orderId));
}

/** Take a leg back. A partner carrier who already accepted it must be confirmed and is sent a cancellation. */
export async function pullBackAction(legId: string, v: { reason?: string; confirmCarrier?: boolean } = {}) {
  const r = await act(async (ctx) => {
    const { pullBackLeg } = await import("@/domain/carrier-notice");
    const out = await pullBackLeg(ctx, legId, { reason: v.reason ?? null, confirmCarrier: !!v.confirmCarrier });
    return { note: out.notice?.note ?? null };
  });
  if (r.ok) touch();
  return r;
}

/** Someone dealt with a flag (a breakdown fixed, a decline re-covered): it leaves the board. */
export async function clearFlagAction(flagId: string, note?: string) {
  const r = await act((ctx) => O.clearFlag(ctx, flagId, note ?? null));
  if (r.ok) {
    touch();
    revalidatePath("/dispatch/planner");
  }
  return r;
}

/** A delivered load goes to billing without a POD, with the reason on the record. */
export async function waivePodAction(orderId: string, reason: string) {
  const r = await act((ctx) => O.waivePod(ctx, orderId, reason));
  if (r.ok) {
    touch();
    revalidatePath("/billing");
  }
  return r;
}
