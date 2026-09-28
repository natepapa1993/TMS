import { and, eq, desc, inArray, or } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { CHECK_CALL_STATUSES, type CheckCallStatus } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { fmtIn, zoneFor } from "@/lib/time";
import { NotFoundError, ValidationError } from "./orders";

/**
 * Check calls: the dispatcher's running log of where a load is and how it's going — one line each
 * (location, status, ETA, reefer temp, note), on the load's timeline, and emailed to the customer's
 * tracking contact when asked. The location defaults to the truck's last GPS position.
 */

export const CHECK_CALL_LABEL: Record<CheckCallStatus, string> = {
  on_time: "On time",
  running_late: "Running late",
  at_shipper: "At shipper",
  loading: "Loading",
  at_receiver: "At receiver",
  unloading: "Unloading",
  at_border: "At the border",
  breakdown: "Breakdown",
  weather: "Weather delay",
  traffic: "Traffic delay",
  fuel_stop: "Fuel stop",
  rest: "On a break (HOS)",
  other: "Other",
};

/** Where the load was last seen: the latest position of the leg (or its truck) in the last 12 hours. */
export async function lastSeen(ctx: Ctx, leg: { id: string; truckId: string | null }) {
  const since = new Date(Date.now() - 12 * 3600_000);
  const [p] = await db
    .select()
    .from(s.positions)
    .where(and(eq(s.positions.tenantId, ctx.tenantId), leg.truckId ? or(eq(s.positions.legId, leg.id), eq(s.positions.truckId, leg.truckId)) : eq(s.positions.legId, leg.id)))
    .orderBy(desc(s.positions.at))
    .limit(1);
  if (!p || p.at < since) return null;
  return { at: p.at, ageMin: Math.max(0, Math.round((Date.now() - p.at.getTime()) / 60000)), lat: p.lat, lng: p.lng, place: p.place ?? `${Number(p.lat).toFixed(3)}, ${Number(p.lng).toFixed(3)}` };
}

export type CheckCallInput = { legId?: string | null; status: string; location?: string | null; etaAt?: Date | null; tempF?: number | null; note?: string | null; at?: Date | null; sendToCustomer?: boolean; source?: string };

export async function addCheckCall(ctx: Ctx, orderId: string, input: CheckCallInput) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const [order] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!order) throw new NotFoundError("order", orderId);
  if (!(CHECK_CALL_STATUSES as readonly string[]).includes(input.status)) throw new ValidationError("pick a status", "status");
  if (input.tempF != null && (!Number.isFinite(input.tempF) || input.tempF < -40 || input.tempF > 120)) throw new ValidationError("reefer temperature in °F (−40 to 120)", "tempF");
  if (input.etaAt && Number.isNaN(input.etaAt.getTime())) throw new ValidationError("the ETA", "etaAt");
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId))).orderBy(s.legs.seq);
  const leg = input.legId ? legs.find((l) => l.id === input.legId) : (legs.find((l) => !["completed", "cancelled", "unassigned"].includes(l.state)) ?? legs[0]);
  if (input.legId && !leg) throw new NotFoundError("leg", input.legId);
  let location = input.location?.trim() || null;
  let lat: string | null = null;
  let lng: string | null = null;
  if (!location && leg) {
    const seen = await lastSeen(ctx, leg);
    if (seen) ({ place: location, lat, lng } = { place: seen.place, lat: seen.lat, lng: seen.lng });
  }
  if (!location && !input.note?.trim()) throw new ValidationError("where is it? (no GPS position in the last 12 hours)", "location");
  const status = input.status as CheckCallStatus;
  const id = newId();
  const row = { id, tenantId: ctx.tenantId, orderId, legId: leg?.id ?? null, at: input.at ?? new Date(), location, lat, lng, status, etaAt: input.etaAt ?? null, tempF: input.tempF ?? null, note: input.note?.trim() || null, source: input.source ?? "dispatcher", sentTo: null as string | null, createdBy: ctx.userId };

  if (input.sendToCustomer) {
    const [cust] = order.customerId || order.brokerId ? await db.select().from(s.customers).where(eq(s.customers.id, (order.customerId ?? order.brokerId)!)).limit(1) : [];
    const to = cust?.contacts?.find((c) => c.email)?.email ?? cust?.billingEmail ?? null;
    if (!to) throw new ValidationError(`${cust?.name ?? "the customer"} has no contact email — add one on the customer`, "sendToCustomer");
    const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, orderId)).orderBy(s.stops.seq);
    const [tenant] = await db.select({ zone: s.tenants.timeZone, name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
    const dest = stops[stops.length - 1];
    const zone = dest ? zoneFor({ state: dest.address?.state, country: dest.country }, tenant?.zone ?? "America/Chicago") : (tenant?.zone ?? "America/Chicago");
    const refs = Object.entries(order.refs ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.toUpperCase()} ${v}`)
      .join(" · ");
    const body = [
      `Load ${order.orderNumber}${refs ? ` (${refs})` : ""}: ${CHECK_CALL_LABEL[status].toLowerCase()}${location ? ` — ${location}` : ""}.`,
      row.etaAt ? `ETA ${dest?.name ? `at ${dest.name} ` : ""}${fmtIn(row.etaAt, zone)}.` : "",
      row.tempF != null ? `Reefer ${row.tempF}°F.` : "",
      row.note ?? "",
      "",
      tenant?.name ?? "",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n");
    await enqueue(ctx, { channel: "email", to, subject: `Load ${order.orderNumber} update · ${CHECK_CALL_LABEL[status]}`, body, subjectKind: "order", subjectId: orderId, meta: { kind: "tracking", orderId } });
    await deliverQueued().catch(() => null);
    row.sentTo = to;
  }
  await db.insert(s.checkCalls).values(row);
  // a breakdown is a problem to work, not just a line in the log: the load is flagged and the truck is out of
  // the planner (not rankable, "Unavailable — breakdown") until someone clears the flag
  if (status === "breakdown") {
    const truckId = leg?.assigneeKind === "truck" ? leg.truckId : null;
    const [unit] = truckId ? await db.select({ unit: s.trucks.unitNumber }).from(s.trucks).where(eq(s.trucks.id, truckId)).limit(1) : [];
    await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId, legId: leg?.id ?? null, code: "breakdown", level: "red", title: `Breakdown${unit ? ` · unit ${unit.unit}` : ""}${location ? ` near ${location}` : ""}`, detail: row.note ?? "Repower, recover or reschedule; tell the customer. Clear this flag once the truck runs again.", owner: "dispatch", data: { truckId, driverId: leg?.driverId ?? null, checkCallId: id } });
  }
  await writeAudit(db, ctx, "order", orderId, "update", undefined, `check call: ${CHECK_CALL_LABEL[status]}${location ? ` · ${location}` : ""}${row.note ? ` · ${row.note}` : ""}${row.sentTo ? ` · sent to ${row.sentTo}` : ""}`);
  return row;
}

export async function listCheckCalls(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  return db.select().from(s.checkCalls).where(and(eq(s.checkCalls.tenantId, ctx.tenantId), eq(s.checkCalls.orderId, orderId))).orderBy(desc(s.checkCalls.at));
}

/** The latest check call of each order (for the board). */
export async function lastCheckCalls(ctx: Ctx, orderIds: string[]) {
  assertCtx(ctx);
  if (!orderIds.length) return new Map<string, typeof s.checkCalls.$inferSelect>();
  const rows = await db
    .selectDistinctOn([s.checkCalls.orderId])
    .from(s.checkCalls)
    .where(and(eq(s.checkCalls.tenantId, ctx.tenantId), inArray(s.checkCalls.orderId, orderIds)))
    .orderBy(s.checkCalls.orderId, desc(s.checkCalls.at));
  return new Map(rows.map((r) => [r.orderId, r]));
}
