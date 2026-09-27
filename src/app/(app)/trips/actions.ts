"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as T from "@/domain/tailgate";
import type { StopType } from "@/db/schema";

const touch = (id?: string) => {
  revalidatePath("/trips");
  revalidatePath("/dispatch");
  revalidatePath("/orders");
  if (id) revalidatePath(`/trips/${id}`);
};

const cents = (v: string | undefined, field: string) => {
  if (!v?.trim()) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) throw Object.assign(new Error(`${field} must be a number`), { name: "ValidationError", field });
  return Math.round(n * 100);
};
const num = (v: string | undefined, field: string) => {
  if (!v?.trim()) return null;
  const n = Number(v.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`${field} must be a number`), { name: "ValidationError", field });
  return Math.round(n);
};

export async function createTripAction(input: { equipment: string; stops: { type: StopType; name: string; country: string; city?: string; state?: string }[] }) {
  const r = await act((ctx) => T.createTrip(ctx, { equipment: input.equipment, stops: input.stops.map((st) => ({ type: st.type, name: st.name, country: st.country, address: st.city || st.state ? { city: st.city || undefined, state: st.state || undefined, country: st.country } : undefined })) }));
  if (r.ok) touch(r.data.order.id);
  return r;
}

export async function addShipmentAction(tripId: string, v: { customerId: string; rate: string; rateTbd: boolean; refs: Record<string, string>; pickupStopId: string; deliveryStopId: string; pieces: string; weightLbs: string; linearFt: string; cubeFt: string; stackable: boolean; hazmat: boolean; cargoNote: string }) {
  const r = await act((ctx) => {
    const refs: Record<string, string> = {};
    for (const [k, x] of Object.entries(v.refs)) if (x?.trim()) refs[k] = x.trim();
    return T.addShipment(ctx, tripId, { customerId: v.customerId, rateCents: cents(v.rate, "rate"), rateTbd: v.rateTbd, refs, pickupStopId: v.pickupStopId, deliveryStopId: v.deliveryStopId, pieces: num(v.pieces, "pieces"), weightLbs: num(v.weightLbs, "weight"), linearFt: num(v.linearFt, "linear feet"), cubeFt: num(v.cubeFt, "cube"), stackable: v.stackable, hazmat: v.hazmat, cargoNote: v.cargoNote || null });
  });
  if (r.ok) touch(tripId);
  return r;
}

export async function removeShipmentAction(tripId: string, shipmentId: string, reason: string) {
  const r = await act((ctx) => T.removeShipment(ctx, shipmentId, reason));
  if (r.ok) touch(tripId);
  return r;
}

export async function bookTripAction(tripId: string) {
  const r = await act((ctx) => T.bookTrip(ctx, tripId));
  if (r.ok) touch(tripId);
  return r;
}

export async function holdShipmentAction(tripId: string, shipmentId: string, reason: string) {
  const r = await act((ctx) => T.holdShipment(ctx, shipmentId, reason));
  if (r.ok) touch(tripId);
  return r;
}

export async function releaseShipmentAction(tripId: string, shipmentId: string) {
  const r = await act((ctx) => T.releaseShipment(ctx, shipmentId));
  if (r.ok) touch(tripId);
  return r;
}

export async function previewFitAction(tripId: string, v: { pickupStopId: string; deliveryStopId: string; weightLbs: string; linearFt: string; cubeFt: string }) {
  return act((ctx) => T.capacity(ctx, tripId, { pickupStopId: v.pickupStopId, deliveryStopId: v.deliveryStopId, weightLbs: num(v.weightLbs, "weight") ?? 0, linearFt: num(v.linearFt, "linear feet") ?? 0, cubeFt: num(v.cubeFt, "cube") ?? 0 }));
}
