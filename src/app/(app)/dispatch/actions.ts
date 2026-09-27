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

export async function candidatesAction(legId: string) {
  return act((ctx) => O.candidatesForLeg(ctx, legId));
}

export async function carrierEligibilityAction(legId: string, carrierId: string) {
  return act(async (ctx) => {
    const leg = await O.getLeg(ctx, legId);
    return O.eligibilityFor(ctx, leg.type, { kind: "carrier", carrierId });
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

export async function advanceAction(legId: string, to: LegState | "next", ev: { source?: EventSource; note?: string } = {}) {
  const r = await act((ctx) => O.advanceLeg(ctx, legId, to, { source: ev.source ?? "dispatcher", verified: false, note: ev.note }));
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

export async function splitAction(legId: string, stop: { type: StopType; name: string; country: string }) {
  const r = await act((ctx) => O.splitLeg(ctx, legId, stop));
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

/** The +New popup: four fields and the order exists, booked, in Pending (spec §2.1 quick-add). */
export async function quickOrderAction(input: { customerId: string; pickup: string; pickupCountry: string; delivery: string; deliveryCountry: string; rate: string; template?: string; refs?: Record<string, string> }) {
  const r = await act(async (ctx) => {
    const rateCents = input.rate.trim() ? Math.round(Number(input.rate.replace(/[$,\s]/g, "")) * 100) : null;
    if (input.rate.trim() && !Number.isFinite(rateCents)) throw Object.assign(new Error("Rate must be a number"), { name: "ValidationError", field: "rate" });
    const template = input.template || O.LEG_TEMPLATES.find((t) => t.key === "mx_crossing_us")!.key;
    const t = O.LEG_TEMPLATES.find((x) => x.key === template)!;
    // Build stops from the template: user names the ends, yards are placeholders they can rename on the order.
    const stops = t.stops.map((type, i) => {
      if (i === 0) return { type, name: input.pickup, country: input.pickupCountry };
      if (i === t.stops.length - 1) return { type, name: input.delivery, country: input.deliveryCountry };
      return { type, name: type === "border_yard" ? "Border yard (MX)" : type === "yard" ? "Laredo yard" : type, country: type === "border_yard" ? "MX" : "US" };
    });
    return O.createOrder(ctx, { customerId: input.customerId, rateCents, rateTbd: rateCents == null, stops, template, refs: input.refs, book: true });
  });
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
