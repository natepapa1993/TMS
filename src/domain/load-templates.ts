import { and, eq, isNull, desc, asc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { LoadTemplateData, TemplateStop, StopType } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { localToInstant, zoneFor, zonedParts } from "@/lib/time";
import { createOrder, NotFoundError, ValidationError, type StopInput } from "./orders";
import { normCountry } from "./zones";

/**
 * Load templates: a lane run again and again, saved with everything but the dates. Stop times are
 * wall-clock times at each stop (in that stop's time zone) and a day offset from the first stop, so a
 * template made in July still picks up at 08:00 local in November. Build one load from it in the
 * builder, or many at once for a list of dates.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function clean(data: LoadTemplateData): LoadTemplateData {
  if (!data || !Array.isArray(data.stops)) throw new ValidationError("a template needs its stops", "stops");
  if (data.stops.length < 2) throw new ValidationError("a template needs at least a pickup and a delivery", "stops");
  if (!data.stops.some((x) => x.type === "pickup") || !data.stops.some((x) => x.type === "delivery")) throw new ValidationError("a template needs a pickup and a delivery", "stops");
  const stops: TemplateStop[] = data.stops.map((x, i) => {
    if (!x.name?.trim()) throw new ValidationError(`stop ${i + 1} needs a location`, "stops");
    for (const k of ["from", "to"] as const) if (x[k] && !HHMM.test(x[k])) throw new ValidationError(`stop ${i + 1}: time as HH:MM`, "stops");
    const dayOffset = Math.round(Number(x.dayOffset ?? 0));
    if (!Number.isFinite(dayOffset) || dayOffset < 0 || dayOffset > 30) throw new ValidationError(`stop ${i + 1}: day 0 to 30 after the first stop`, "stops");
    return { type: x.type, locationId: x.locationId ?? null, name: x.name.trim(), line1: x.line1?.trim() || undefined, city: x.city?.trim() || undefined, state: x.state?.trim().toUpperCase() || undefined, postalCode: x.postalCode?.trim() || undefined, country: normCountry(x.country), dayOffset, from: x.from || "", to: x.to || "", appointment: !!x.appointment, ref: x.ref?.trim() || undefined, contact: x.contact?.trim() || undefined, notes: x.notes?.trim() || undefined };
  });
  if (data.rateCents != null && (!Number.isFinite(data.rateCents) || data.rateCents < 0)) throw new ValidationError("rate must be a positive amount", "rate");
  return { customerId: data.customerId || null, brokerId: data.brokerId || null, billingEntityId: data.billingEntityId || null, equipment: data.equipment || "53_dry", rateCents: data.rateCents ?? null, currency: ["USD", "MXN", "CAD"].includes(data.currency) ? data.currency : "USD", refs: Object.fromEntries(Object.entries(data.refs ?? {}).filter(([, v]) => v?.trim())), freight: data.freight ?? [], cargoNote: data.cargoNote?.trim() || null, stops };
}

export async function listTemplates(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const rows = await db
    .select({ t: s.loadTemplates, customer: s.customers.name })
    .from(s.loadTemplates)
    .leftJoin(s.customers, eq(s.customers.id, s.loadTemplates.customerId))
    .where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), isNull(s.loadTemplates.archivedAt)))
    .orderBy(desc(s.loadTemplates.lastUsedAt), asc(s.loadTemplates.name));
  return rows.map((r) => ({ ...r.t, customer: r.customer }));
}

export async function saveTemplate(ctx: Ctx, input: { id?: string | null; name: string; data: LoadTemplateData }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const name = input.name?.trim();
  if (!name) throw new ValidationError("name the template", "name");
  if (name.length > 80) throw new ValidationError("keep the name under 80 characters", "name");
  const data = clean(input.data);
  const dup = await db.select({ id: s.loadTemplates.id }).from(s.loadTemplates).where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), isNull(s.loadTemplates.archivedAt), sql`lower(${s.loadTemplates.name}) = ${name.toLowerCase()}`)).limit(1);
  if (dup[0] && dup[0].id !== input.id) throw new ValidationError(`a template called "${name}" already exists`, "name");
  if (input.id) {
    const [cur] = await db.select().from(s.loadTemplates).where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), eq(s.loadTemplates.id, input.id))).limit(1);
    if (!cur || cur.archivedAt) throw new NotFoundError("template", input.id);
    await db.update(s.loadTemplates).set({ name, customerId: data.customerId, data, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.loadTemplates.id, cur.id));
    await writeAudit(db, ctx, "load_template", cur.id, "update", undefined, name);
    return { id: cur.id };
  }
  const id = newId();
  await db.insert(s.loadTemplates).values({ id, tenantId: ctx.tenantId, name, customerId: data.customerId, data, createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, "load_template", id, "create", undefined, name);
  return { id };
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const [t] = await db.select().from(s.loadTemplates).where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), eq(s.loadTemplates.id, id))).limit(1);
  if (!t || t.archivedAt) throw new NotFoundError("template", id);
  await db.update(s.loadTemplates).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.loadTemplates.id, id));
  await writeAudit(db, ctx, "load_template", id, "archive", undefined, t.name);
}

async function tenantZone(tenantId: string) {
  const [t] = await db.select({ zone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  return t?.zone ?? "America/Detroit";
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type StopLike = { type: StopType; locationId: string | null; name: string; address: { line1?: string; city?: string; state?: string; postalCode?: string } | null; country: string; windowStart: Date | null; windowEnd: Date | null; appointment: boolean; ref?: string; contact?: string | null; notes?: string | null };

/** Stops with real instants → template stops: time of day in each stop's zone, days counted from the first dated stop. */
export function toTemplateStops(stops: StopLike[], fallbackZone: string): TemplateStop[] {
  const local = (d: Date | null, st: StopLike) => {
    if (!d) return null;
    const p = zonedParts(d, zoneFor({ state: st.address?.state, city: st.address?.city, name: st.name, country: st.country }, fallbackZone));
    return { date: `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, time: `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}` };
  };
  const firstDate = stops.map((st) => local(st.windowStart, st)?.date).find(Boolean) ?? null;
  const days = (date: string | undefined) => (firstDate && date ? Math.round((new Date(`${date}T12:00:00Z`).getTime() - new Date(`${firstDate}T12:00:00Z`).getTime()) / 86400_000) : 0);
  return stops.map((st) => {
    const a = local(st.windowStart, st);
    const b = local(st.windowEnd, st);
    return { type: st.type, locationId: st.locationId, name: st.name, line1: st.address?.line1, city: st.address?.city, state: st.address?.state, postalCode: st.address?.postalCode, country: st.country, dayOffset: Math.max(0, days(a?.date)), from: a?.time ?? "", to: b?.time ?? "", appointment: st.appointment, ref: st.ref, contact: st.contact ?? undefined, notes: st.notes ?? undefined };
  });
}

/** The builder's form → a template (its instants read back as local times at each stop). */
export async function templateFromDraft(ctx: Ctx, name: string, draft: Omit<LoadTemplateData, "stops"> & { stops: StopLike[] }) {
  assertCtx(ctx);
  const stops = toTemplateStops(draft.stops, await tenantZone(ctx.tenantId));
  return saveTemplate(ctx, { name, data: { ...draft, stops } });
}

/** A saved load → a template: each stop's time of day at its own zone, days counted from the first stop. */
export async function templateFromOrder(ctx: Ctx, orderId: string, name: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!o) throw new NotFoundError("order", orderId);
  if (o.kind !== "order") throw new ValidationError("templates are made from loads, not trips or shipments");
  const stops = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, ctx.tenantId), eq(s.stops.orderId, orderId))).orderBy(asc(s.stops.seq));
  const data: LoadTemplateData = {
    customerId: o.customerId,
    brokerId: o.brokerId,
    billingEntityId: o.billingEntityId,
    equipment: o.equipment,
    rateCents: o.rateTbd ? null : o.rateCents,
    currency: o.currency,
    refs: {},
    freight: o.freight ?? [],
    cargoNote: o.cargoNote,
    stops: toTemplateStops(
      stops.map((st) => ({ type: st.type, locationId: st.locationId, name: st.name, address: st.address, country: st.country, windowStart: st.windowStart, windowEnd: st.windowEnd, appointment: st.appointment, ref: st.refs?.reference, contact: st.contact, notes: st.notes })),
      await tenantZone(ctx.tenantId),
    ),
  };
  return saveTemplate(ctx, { name, data });
}

/** The stops of a template on a given first-stop date, as instants in each stop's zone. */
export async function stopsOn(tenantId: string, data: LoadTemplateData, date: string): Promise<(StopInput & { windowStart: Date | null; windowEnd: Date | null })[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("pick the date as YYYY-MM-DD", "date");
  const fallback = await tenantZone(tenantId);
  return data.stops.map((st) => {
    const zone = zoneFor({ state: st.state, city: st.city, name: st.name, country: st.country }, fallback);
    const day = addDays(date, st.dayOffset);
    const at = (hhmm: string) => (hhmm ? localToInstant(day, hhmm.replace(":", ""), zone) : null);
    const address = st.line1 || st.city || st.state || st.postalCode ? { line1: st.line1, city: st.city, state: st.state, postalCode: st.postalCode, country: st.country } : null;
    return { type: st.type as StopType, name: st.name, locationId: st.locationId, address, country: st.country, windowStart: at(st.from), windowEnd: at(st.to), appointment: st.appointment, contact: st.contact ?? null, refs: (st.ref ? { reference: st.ref } : {}) as Record<string, string>, notes: st.notes ?? null };
  });
}

/** Build loads from a template for each date; one failure does not stop the rest. */
export async function loadsFromTemplate(ctx: Ctx, templateId: string, dates: string[], opts: { book?: boolean } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  const [t] = await db.select().from(s.loadTemplates).where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), eq(s.loadTemplates.id, templateId))).limit(1);
  if (!t || t.archivedAt) throw new NotFoundError("template", templateId);
  const uniq = [...new Set(dates)].sort();
  if (!uniq.length) throw new ValidationError("pick at least one date", "dates");
  if (uniq.length > 60) throw new ValidationError("up to 60 loads at a time", "dates");
  const created: { date: string; orderId: string; orderNumber: string }[] = [];
  const failed: { date: string; error: string }[] = [];
  for (const date of uniq) {
    try {
      const stops = await stopsOn(ctx.tenantId, t.data, date);
      const o = await createOrder(ctx, { customerId: t.data.customerId, brokerId: t.data.brokerId, billingEntityId: t.data.billingEntityId, equipment: t.data.equipment, rateCents: t.data.rateCents, rateTbd: t.data.rateCents == null, currency: t.data.currency, refs: t.data.refs, freight: t.data.freight, cargoNote: t.data.cargoNote, stops, book: !!opts.book });
      created.push({ date, orderId: o.order.id, orderNumber: o.order.orderNumber });
    } catch (e) {
      failed.push({ date, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (created.length) await db.update(s.loadTemplates).set({ lastUsedAt: new Date(), timesUsed: sql`${s.loadTemplates.timesUsed} + ${created.length}` }).where(eq(s.loadTemplates.id, t.id));
  await writeAudit(db, ctx, "load_template", t.id, "update", undefined, `${created.length} load(s) created${failed.length ? `, ${failed.length} failed` : ""}`);
  return { created, failed };
}

/** For the builder: a template on a date, times as instants the browser shows in its own clock. */
export async function templateDraft(ctx: Ctx, templateId: string, date: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const [t] = await db.select().from(s.loadTemplates).where(and(eq(s.loadTemplates.tenantId, ctx.tenantId), eq(s.loadTemplates.id, templateId))).limit(1);
  if (!t || t.archivedAt) throw new NotFoundError("template", templateId);
  const stops = await stopsOn(ctx.tenantId, t.data, date);
  return {
    templateId: t.id,
    name: t.name,
    data: t.data,
    stops: t.data.stops.map((x, i) => ({ ...x, windowStart: stops[i].windowStart?.toISOString() ?? null, windowEnd: stops[i].windowEnd?.toISOString() ?? null })),
  };
}
