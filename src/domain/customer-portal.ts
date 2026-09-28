import { normCountry, HANDOFF } from "./zones";
import { and, eq, inArray, or, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, systemCtx, type Ctx } from "@/lib/context";
import { issueToken, publicUrl, revokeTokensFor } from "@/lib/tokens";
import { newId } from "@/lib/ids";
import { writeAudit } from "@/lib/audit";
import { createOrder, NotFoundError, ValidationError, type StopInput } from "./orders";
import { LEG_LABEL, LEG_LABEL_ES } from "./states";

/**
 * Customer portal (spec Phase 3 "customer portal entry"): one persistent link per customer or broker —
 * the loads they pay for with live tracking, delivered loads with the POD, their invoices and balance,
 * and a form to request a load that lands on Dispatch as a draft with a flag. No login; the token is the
 * authorization and the customer record is the boundary. Nothing about rates paid to carriers or drivers,
 * driver phones, or other customers ever leaves here.
 */

/** Lo mismo, en español. */
export const CUSTOMER_STATE_ES: Record<s.OrderState, string> = {
  draft: "Solicitado",
  booked: "Reservado",
  dispatched: "Asignado",
  in_transit: "En tránsito",
  exception: "Detenido",
  delivered: "Entregado",
  ready_to_bill: "Entregado",
  invoiced: "Entregado",
  paid: "Entregado",
  cancelled: "Cancelado",
};

/** What the customer reads for each order state. */
export const CUSTOMER_STATE: Record<s.OrderState, string> = {
  draft: "Requested",
  booked: "Booked",
  dispatched: "Assigned", // a truck or a carrier is on it — not "driver assigned" when only a carrier has the tender
  in_transit: "In transit",
  exception: "On hold",
  delivered: "Delivered",
  ready_to_bill: "Delivered",
  invoiced: "Delivered",
  paid: "Delivered",
  cancelled: "Cancelled",
};

export async function customerPortalLink(ctx: Ctx, customerId: string) {
  assertCtx(ctx);
  const [c] = await db.select().from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), eq(s.customers.id, customerId))).limit(1);
  if (!c) throw new NotFoundError("customer", customerId);
  const tok = await issueToken(ctx, "customer_portal", customerId, { label: c.name });
  return { url: publicUrl(`/cp/${tok.token}`), name: c.name, email: c.billingEmail, contacts: c.contacts };
}

export async function revokeCustomerPortal(ctx: Ctx, customerId: string) {
  assertCtx(ctx);
  await revokeTokensFor(ctx, "customer_portal", customerId);
}

async function loadCustomer(tenantId: string, customerId: string) {
  const [c] = await db.select().from(s.customers).where(and(eq(s.customers.tenantId, tenantId), eq(s.customers.id, customerId))).limit(1);
  if (!c || c.archivedAt) throw new NotFoundError("customer", customerId);
  return c;
}

const place = (st: typeof s.stops.$inferSelect) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, city: st.address?.city ?? null, state: st.address?.state ?? null, country: st.country, windowStart: st.windowStart, windowEnd: st.windowEnd, arrivedAt: st.arrivedAt, departedAt: st.departedAt });

/** Documents a customer may download: what they would get by email anyway. */
const CUSTOMER_DOC_CODES = ["POD", "BOL", "RATE_CON", "carta_porte", "invoice", "packing_list"];

/** Everything the customer's page shows. */
export async function customerPortalView(tenantId: string, customerId: string, now = new Date()) {
  const ctx = systemCtx(tenantId);
  const customer = await loadCustomer(tenantId, customerId);
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  const since = new Date(now.getTime() - 90 * 86400_000);
  const mine = or(eq(s.orders.customerId, customerId), eq(s.orders.brokerId, customerId));
  const orders = await db
    .select()
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, tenantId), mine, sql`${s.orders.kind} <> 'trip'`, or(inArray(s.orders.state, ["draft", "booked", "dispatched", "in_transit", "exception"]), gte(s.orders.updatedAt, since))))
    .orderBy(desc(s.orders.updatedAt))
    .limit(300);
  const orderIds = orders.map((o) => o.id);
  const [stops, legs, docs, tokens, invoices] = orderIds.length
    ? await Promise.all([
        db.select().from(s.stops).where(inArray(s.stops.orderId, orderIds)).orderBy(s.stops.seq),
        db.select().from(s.legs).where(inArray(s.legs.orderId, orderIds)).orderBy(s.legs.seq),
        db.select().from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, orderIds), inArray(s.documents.status, ["present", "verified"]))),
        db.select().from(s.accessTokens).where(and(eq(s.accessTokens.tenantId, tenantId), eq(s.accessTokens.kind, "tracking_link"), inArray(s.accessTokens.subjectId, orderIds), sql`${s.accessTokens.revokedAt} is null`)),
        db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, tenantId), eq(s.invoices.customerId, customerId), sql`${s.invoices.state} <> 'draft'`)).orderBy(desc(s.invoices.issuedAt)),
      ])
    : [[], [], [], [], await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, tenantId), eq(s.invoices.customerId, customerId), sql`${s.invoices.state} <> 'draft'`)).orderBy(desc(s.invoices.issuedAt))];
  // one tracking link per live load, issued here if dispatch never sent one
  const trackingByOrder = new Map(tokens.map((t) => [t.subjectId, t.token]));
  for (const o of orders) {
    if (trackingByOrder.has(o.id) || !["booked", "dispatched", "in_transit", "exception", "delivered"].includes(o.state)) continue;
    const tok = await issueToken(ctx, "tracking_link", o.id, { label: "customer portal" });
    trackingByOrder.set(o.id, tok.token);
  }
  const { mergedOrderEtas } = await import("./tracking");
  const etaByOrder = new Map<string, { at: Date; stopName: string; late: boolean }>();
  for (const o of orders) {
    if (!["dispatched", "in_transit", "exception"].includes(o.state)) continue;
    const e = Object.values(await mergedOrderEtas(tenantId, o.id, now))[0];
    if (e) etaByOrder.set(o.id, { at: e.at, stopName: e.stopName, late: e.late });
  }
  const loads = orders.map((o) => {
    const ls = legs.filter((l) => l.orderId === o.id && l.state !== "cancelled");
    const current = ls.find((l) => l.state !== "completed") ?? ls[ls.length - 1] ?? null;
    const inv = invoices.find((i) => i.orderIds.includes(o.id)) ?? null;
    return {
      eta: etaByOrder.get(o.id) ?? null,
      id: o.id,
      orderNumber: o.orderNumber,
      state: o.state,
      stateLabel: CUSTOMER_STATE[o.state],
      stateLabelEs: CUSTOMER_STATE_ES[o.state],
      step: current ? LEG_LABEL[current.state] : null,
      stepEs: current ? LEG_LABEL_ES[current.state] : null,
      equipment: o.equipment,
      refs: { po: o.refs.po ?? null, shipment: o.refs.shipment ?? null, reference: o.refs.reference ?? null, rate_con: o.refs.rate_con ?? null },
      cargoNote: o.cargoNote,
      stops: stops.filter((x) => x.orderId === o.id).map(place),
      deliveredAt: o.deliveredAt,
      createdAt: o.createdAt,
      source: o.source,
      trackingUrl: trackingByOrder.has(o.id) ? publicUrl(`/track/${trackingByOrder.get(o.id)}`) : null,
      docs: docs.filter((d) => d.subjectId === o.id && d.code && CUSTOMER_DOC_CODES.includes(d.code)).map((d) => ({ id: d.id, code: d.code!, fileName: d.fileName, createdAt: d.createdAt })),
      invoice: inv ? { id: inv.id, number: inv.number, state: inv.state, totalCents: inv.totalCents, currency: inv.currency, url: inv.token && inv.pdfStorageKey ? publicUrl(`/i/${inv.token}`) : null } : null,
    };
  });
  const invoiceRows = invoices.map((i) => {
    const open = i.state === "void" ? 0 : Math.max(0, i.totalCents - i.paidCents - i.creditedCents);
    const pastDue = open > 0 && !!i.dueAt && i.dueAt.getTime() < now.getTime() ? Math.round((now.getTime() - i.dueAt.getTime()) / 86400_000) : 0;
    return { id: i.id, number: i.number, state: i.state, issuedAt: i.issuedAt, dueAt: i.dueAt, totalCents: i.totalCents, openCents: open, pastDueDays: pastDue, currency: i.currency, orders: orders.filter((o) => i.orderIds.includes(o.id)).map((o) => o.orderNumber), url: i.token && i.pdfStorageKey ? publicUrl(`/i/${i.token}`) : null };
  });
  // what they owe, per currency: pesos are never added to dollars (USD first, then MXN, then CAD)
  const order = ["USD", "MXN", "CAD"];
  const balances = [...new Set(invoiceRows.map((r) => r.currency))]
    .sort((p, q) => (order.indexOf(p) + 99) % 99 - (order.indexOf(q) + 99) % 99)
    .map((currency) => {
      const rows = invoiceRows.filter((r) => r.currency === currency);
      return { currency, openCents: rows.reduce((a, r) => a + r.openCents, 0), pastDueCents: rows.filter((r) => r.pastDueDays > 0).reduce((a, r) => a + r.openCents, 0) };
    })
    .filter((b) => b.openCents > 0);
  const home = balances.find((b) => b.currency === "USD") ?? balances[0] ?? { currency: invoiceRows[0]?.currency ?? "USD", openCents: 0, pastDueCents: 0 };
  return {
    company: tenant?.name ?? "",
    customer: { id: customer.id, name: customer.name, kind: customer.kind, termsDays: customer.termsDays, country: customer.country },
    active: loads.filter((l) => ["booked", "dispatched", "in_transit", "exception"].includes(l.state)),
    requested: loads.filter((l) => l.state === "draft"),
    delivered: loads.filter((l) => ["delivered", "ready_to_bill", "invoiced", "paid"].includes(l.state)),
    cancelled: loads.filter((l) => l.state === "cancelled"),
    invoices: invoiceRows,
    /** one currency's balance (USD first) — kept for older readers; the page shows `balances` */
    balance: { openCents: home.openCents, pastDueCents: home.pastDueCents, currency: home.currency },
    balances,
  };
}

export type LoadRequest = {
  pickup: { name: string; city?: string | null; state?: string | null; country: string; windowStart?: Date | null; windowEnd?: Date | null; notes?: string | null };
  delivery: { name: string; city?: string | null; state?: string | null; country: string; windowStart?: Date | null; windowEnd?: Date | null; notes?: string | null };
  equipment?: string | null;
  po?: string | null;
  reference?: string | null;
  cargoNote?: string | null;
  contact?: string | null;
};

/**
 * The hand-off stops a customer's loads usually make between two countries: the border yard and the
 * yard on the other side their recent loads on the same crossing went through, most common first.
 * Nothing when the lane stays in one country or they have no history on it.
 */
export async function usualHandoffs(tenantId: string, customerId: string, fromCountry: string, toCountry: string): Promise<StopInput[]> {
  if (fromCountry === toCountry) return [];
  const since = new Date(Date.now() - 180 * 86400_000);
  const recent = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.customerId, customerId), eq(s.orders.kind, "order"), sql`${s.orders.state} not in ('cancelled', 'draft')`, gte(s.orders.createdAt, since)))
    .orderBy(sql`${s.orders.createdAt} desc`)
    .limit(40);
  if (!recent.length) return [];
  const all = await db.select().from(s.stops).where(and(eq(s.stops.tenantId, tenantId), inArray(s.stops.orderId, recent.map((o) => o.id)))).orderBy(s.stops.seq);
  const counts = new Map<string, { n: number; stops: typeof all }>();
  for (const o of recent) {
    const st = all.filter((x) => x.orderId === o.id);
    if (st.length < 3 || st[0].country !== fromCountry || st[st.length - 1].country !== toCountry) continue;
    const mid = st.slice(1, -1).filter((x) => HANDOFF.includes(x.type));
    if (!mid.length) continue;
    const key = mid.map((x) => `${x.type}|${x.locationId ?? x.name.toLowerCase()}`).join(">");
    const c = counts.get(key) ?? { n: 0, stops: mid };
    c.n++;
    counts.set(key, c);
  }
  const best = [...counts.values()].sort((p, q) => q.n - p.n)[0];
  if (!best) return [];
  return best.stops.map((x) => ({ type: x.type, name: x.name, locationId: x.locationId, address: x.address, country: x.country }));
}

/** The customer asks for a load: a draft order from them, flagged so Dispatch sees it in Pending. */
export async function portalRequestLoad(tenantId: string, customerId: string, input: LoadRequest) {
  const ctx = systemCtx(tenantId);
  const customer = await loadCustomer(tenantId, customerId);
  if (!input.pickup?.name?.trim()) throw new ValidationError("where do we pick up?", "pickup");
  if (!input.delivery?.name?.trim()) throw new ValidationError("where does it go?", "delivery");
  const stop = (type: s.StopType, p: LoadRequest["pickup"]): StopInput => ({
    type,
    name: p.name.trim(),
    country: normCountry(p.country),
    address: p.city || p.state ? { city: p.city?.trim() || undefined, state: p.state?.trim().toUpperCase() || undefined, country: normCountry(p.country) } : null,
    windowStart: p.windowStart ?? null,
    windowEnd: p.windowEnd ?? null,
    notes: p.notes?.trim() || null,
    contact: input.contact?.trim() || null,
  });
  // the two ends as the customer gave them, with the hand-offs their loads on this lane usually make
  // (MX → border yard → Laredo yard → US): the request arrives already legged (M10)
  const ends = [stop("pickup", input.pickup), stop("delivery", input.delivery)];
  const via = await usualHandoffs(tenantId, customer.id, ends[0].country ?? "US", ends[1].country ?? "US");
  const stops = [ends[0], ...via, ends[1]];
  const refs: Record<string, string> = {};
  if (input.po?.trim()) refs.po = input.po.trim();
  if (input.reference?.trim()) refs.reference = input.reference.trim();
  const r = await createOrder(ctx, {
    customerId: customer.id, // whoever holds the link is who we bill; a broker is still the bill-to
    equipment: input.equipment || "53_dry",
    refs,
    rateTbd: true,
    cargoNote: input.cargoNote?.trim() || null,
    source: "portal",
    stops,
    book: false,
  });
  await db.insert(s.flags).values({ id: newId(), tenantId, orderId: r.order.id, code: "portal_request", level: "yellow", title: `Load request from ${customer.name}`, detail: `${stops[0].name} → ${stops[stops.length - 1].name}${input.contact ? ` · ${input.contact}` : ""}.${via.length ? ` Legged like their usual lane, via ${via.map((v) => v.name).join(" → ")}.` : ""} Price it, confirm with them, then book.`, owner: "dispatch" });
  await writeAudit(db, ctx, "order", r.order.id, "create", undefined, `requested by ${customer.name} through the customer portal`);
  return r;
}

/** A document off one of the customer's own loads. */
export async function portalDocument(tenantId: string, customerId: string, documentId: string) {
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.id, documentId), eq(s.documents.subjectKind, "order"))).limit(1);
  if (!doc || !doc.code || !CUSTOMER_DOC_CODES.includes(doc.code)) throw new NotFoundError("document", documentId);
  const [o] = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), eq(s.orders.id, doc.subjectId), or(eq(s.orders.customerId, customerId), eq(s.orders.brokerId, customerId)))).limit(1);
  if (!o) throw new NotFoundError("document", documentId);
  const id = doc.storageKey.replace(/^blob:/, "");
  const [blob] = await db.select().from(s.documentBlobs).where(and(eq(s.documentBlobs.tenantId, tenantId), eq(s.documentBlobs.id, id))).limit(1);
  if (!blob) throw new NotFoundError("file", id);
  return { doc, blob };
}

/** Pending requests for the dispatch board badge. */
export async function openPortalRequests(ctx: Ctx) {
  assertCtx(ctx);
  const rows = await db.select({ n: sql<number>`count(*)` }).from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), eq(s.flags.code, "portal_request"), sql`${s.flags.clearedAt} is null`));
  return Number(rows[0]?.n ?? 0);
}
