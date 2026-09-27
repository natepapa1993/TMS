"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { act } from "@/lib/action";
import * as O from "@/domain/orders";
import type { StopType } from "@/db/schema";
import { parseDate, parseAddress } from "@/data/fields";
import type { StopPayload } from "@/components/stop-fields";

const touch = (id?: string) => {
  revalidatePath("/dispatch");
  revalidatePath("/orders");
  if (id) revalidatePath(`/orders/${id}`);
};

export type StopForm = { type: StopType; name: string; address: string; country: string; windowStart: string; windowEnd: string; appointment: boolean; contact: string; notes: string; sealIn?: string; sealOut?: string };


/** A stop from the builder: a saved location or typed in; "save as a location" creates the location first. */
async function stopFromPayload(ctx: Parameters<Parameters<typeof act>[0]>[0], st: StopPayload): Promise<O.StopInput> {
  const address = st.line1 || st.city || st.state || st.postalCode ? { line1: st.line1 || undefined, city: st.city || undefined, state: st.state ? st.state.toUpperCase() : undefined, postalCode: st.postalCode || undefined, country: st.country } : null;
  let locationId = st.locationId || null;
  if (!locationId && st.saveLocation && st.name) {
    if (!address?.line1 && !address?.city) throw Object.assign(new Error(`add an address to save "${st.name}" as a location`), { name: "ValidationError", field: "stops" });
    const { create } = await import("@/data/records");
    const kind = ({ pickup: "shipper", delivery: "consignee" } as Record<string, string>)[st.type] ?? st.type;
    const loc = await create(ctx, "location", { name: st.name, kind, country: st.country, address });
    locationId = loc.id;
  }
  return {
    type: st.type as StopType,
    name: st.name,
    locationId,
    address,
    country: st.country || "US",
    windowStart: st.windowStart ? new Date(st.windowStart) : null,
    windowEnd: st.windowEnd ? new Date(st.windowEnd) : null,
    appointment: !!st.appointment,
    contact: st.contact || null,
    refs: st.ref ? { reference: st.ref } : {},
    notes: st.notes || null,
  };
}

export type LoadInput = { customerId: string; brokerId: string; billingEntityId: string; equipment: string; rate: string; rateTbd: boolean; currency: string; refs: Record<string, string>; cargoNote: string; freight: { commodity: string; pieces: string; packaging: string; weightLb: string; hazmat: boolean }[]; stops: StopPayload[]; book: boolean };

/** The load builder: any number of stops; the legs are cut from them. */
export async function createLoadAction(input: LoadInput) {
  const r = await act(async (ctx) => {
    const rateCents = input.rate.trim() ? Math.round(Number(input.rate.replace(/[$,\s]/g, "")) * 100) : null;
    if (input.rate.trim() && !Number.isFinite(rateCents)) throw Object.assign(new Error("Rate must be a number"), { name: "ValidationError", field: "rate" });
    if (input.stops.length < 2) throw Object.assign(new Error("a load needs at least a pickup and a delivery"), { name: "ValidationError", field: "stops" });
    if (!input.stops.some((s) => s.type === "pickup")) throw Object.assign(new Error("add the pickup"), { name: "ValidationError", field: "stops" });
    if (!input.stops.some((s) => s.type === "delivery")) throw Object.assign(new Error("add the delivery"), { name: "ValidationError", field: "stops" });
    const refs: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.refs)) if (v?.trim()) refs[k] = v.trim();
    const freight = input.freight
      .filter((l) => l.commodity.trim() || l.pieces.trim() || l.weightLb.trim())
      .map((l) => ({ commodity: l.commodity.trim() || "freight", pieces: l.pieces.trim() ? Number(l.pieces) : undefined, packaging: l.packaging.trim() || undefined, weightLb: l.weightLb.trim() ? Number(l.weightLb.replace(/[,\s]/g, "")) : undefined, hazmat: l.hazmat || undefined }));
    for (const l of freight) if ((l.pieces != null && !Number.isFinite(l.pieces)) || (l.weightLb != null && !Number.isFinite(l.weightLb))) throw Object.assign(new Error("pieces and weight are numbers"), { name: "ValidationError", field: "freight" });
    const stops = [];
    for (const st of input.stops) stops.push(await stopFromPayload(ctx, st));
    return O.createOrder(ctx, {
      customerId: input.customerId || null,
      brokerId: input.brokerId || null,
      billingEntityId: input.billingEntityId || null,
      equipment: input.equipment || "53_dry",
      rateCents,
      rateTbd: input.rateTbd || rateCents == null,
      currency: input.currency || "USD",
      refs,
      freight,
      cargoNote: input.cargoNote || null,
      stops,
      book: input.book,
    });
  });
  if (r.ok) {
    touch();
    redirect(`/dispatch?order=${r.data.order.id}`);
  }
  return r;
}

export async function addStopAction(orderId: string, position: number, stop: StopPayload) {
  const r = await act(async (ctx) => {
    if (!stop.name) throw Object.assign(new Error("the stop needs a location name"), { name: "ValidationError", field: "name" });
    const input = await stopFromPayload(ctx, stop);
    await O.addStop(ctx, orderId, position, input);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function removeStopAction(orderId: string, stopId: string) {
  const r = await act(async (ctx) => {
    await O.removeStop(ctx, orderId, stopId);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function moveStopAction(orderId: string, stopId: string, dir: -1 | 1) {
  const r = await act(async (ctx) => {
    await O.moveStop(ctx, orderId, stopId, dir);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function updateOrderAction(orderId: string, values: { customerId?: string; brokerId?: string; billingEntityId?: string; equipment?: string; rate?: string; rateTbd?: boolean; currency?: string; refs?: Record<string, string>; cargoNote?: string; fuelRule?: string; fuelPct?: string; tollsFees?: string }, expectedUpdatedAt?: string) {
  const r = await act(async (ctx) => {
    const patch: Record<string, unknown> = {};
    if (values.customerId !== undefined) patch.customerId = values.customerId || null;
    if (values.brokerId !== undefined) patch.brokerId = values.brokerId || null;
    if (values.billingEntityId !== undefined) patch.billingEntityId = values.billingEntityId || null;
    if (values.equipment !== undefined) patch.equipment = values.equipment;
    if (values.currency !== undefined) patch.currency = values.currency;
    if (values.cargoNote !== undefined) patch.cargoNote = values.cargoNote || null;
    if (values.fuelRule !== undefined) patch.fuelRule = values.fuelRule === "pct" ? "pct" : "included";
    if (values.fuelPct !== undefined) {
      const n = values.fuelPct.trim() ? Number(values.fuelPct.replace("%", "")) : null;
      if (n != null && (!Number.isFinite(n) || n < 0 || n > 100)) throw Object.assign(new Error("Fuel % must be 0–100"), { name: "ValidationError", field: "fuelPct" });
      patch.fuelPct = n == null ? null : Math.round(n);
      if (patch.fuelRule === "pct" && patch.fuelPct == null) throw Object.assign(new Error("Enter the fuel surcharge percent"), { name: "ValidationError", field: "fuelPct" });
    }
    if (values.tollsFees !== undefined) {
      const c = values.tollsFees.trim() ? Math.round(Number(values.tollsFees.replace(/[$,\s]/g, "")) * 100) : null;
      if (values.tollsFees.trim() && !Number.isFinite(c)) throw Object.assign(new Error("Tolls & fees must be an amount"), { name: "ValidationError", field: "tollsFees" });
      patch.tollsFeesCents = c;
    }
    if (values.rate !== undefined) {
      const c = values.rate.trim() ? Math.round(Number(values.rate.replace(/[$,\s]/g, "")) * 100) : null;
      if (values.rate.trim() && !Number.isFinite(c)) throw Object.assign(new Error("Rate must be a number"), { name: "ValidationError", field: "rate" });
      patch.rateCents = c;
      patch.rateTbd = c == null ? true : !!values.rateTbd;
    }
    if (values.refs) {
      const refs: Record<string, string> = {};
      for (const [k, v] of Object.entries(values.refs)) if (v?.trim()) refs[k.trim()] = v.trim();
      patch.refs = refs;
    }
    return O.updateOrder(ctx, orderId, patch, expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined);
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function updateStopAction(orderId: string, stopId: string, st: Partial<StopForm>) {
  const r = await act(async (ctx) => {
    const patch: Record<string, unknown> = {};
    if (st.name !== undefined) patch.name = st.name;
    if (st.type !== undefined) patch.type = st.type;
    if (st.country !== undefined) patch.country = st.country;
    if (st.address !== undefined) patch.address = st.address.trim() ? parseAddress(st.address) : null;
    if (st.windowStart !== undefined) patch.windowStart = st.windowStart ? (parseDate(st.windowStart) ?? new Date(st.windowStart)) : null;
    if (st.windowEnd !== undefined) patch.windowEnd = st.windowEnd ? (parseDate(st.windowEnd) ?? new Date(st.windowEnd)) : null;
    if (st.appointment !== undefined) patch.appointment = st.appointment;
    if (st.contact !== undefined) patch.contact = st.contact || null;
    if (st.notes !== undefined) patch.notes = st.notes || null;
    if (st.sealIn !== undefined) patch.sealIn = st.sealIn || null;
    if (st.sealOut !== undefined) patch.sealOut = st.sealOut || null;
    return O.updateStop(ctx, stopId, patch);
  });
  if (r.ok) touch(orderId);
  return r;
}
