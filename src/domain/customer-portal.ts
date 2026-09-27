import { and, eq, inArray, or, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, systemCtx, type Ctx } from "@/lib/context";
import { issueToken, publicUrl, revokeTokensFor } from "@/lib/tokens";
import { newId } from "@/lib/ids";
import { writeAudit } from "@/lib/audit";
import { createOrder, NotFoundError, ValidationError, type StopInput } from "./orders";
import { LEG_LABEL } from "./states";

/**
 * Customer portal (spec Phase 3 "customer portal entry"): one persistent link per customer or broker —
 * the loads they pay for with live tracking, delivered loads with the POD, their invoices and balance,
 * and a form to request a load that lands on Dispatch as a draft with a flag. No login; the token is the
 * authorization and the customer record is the boundary. Nothing about rates paid to carriers or drivers,
 * driver phones, or other customers ever leaves here.
 */

/** What the customer reads for each order state. */
export const CUSTOMER_STATE: Record<s.OrderState, string> = {
  draft: "Requested",
  booked: "Booked",
  dispatched: "Driver assigned",
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
  const loads = orders.map((o) => {
    const ls = legs.filter((l) => l.orderId === o.id && l.state !== "cancelled");
    const current = ls.find((l) => l.state !== "completed") ?? ls[ls.length - 1] ?? null;
    const inv = invoices.find((i) => i.orderIds.includes(o.id)) ?? null;
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      state: o.state,
      stateLabel: CUSTOMER_STATE[o.state],
      step: current ? LEG_LABEL[current.state] : null,
      equipment: o.equipment,
      refs: { po: o.refs.po ?? null, shipment: o.refs.shipment ?? null, reference: o.refs.reference ?? null, rate_con: o.refs.rate_con ?? null },
      cargoNote: o.cargoNote,
      stops: stops.filter((x) => x.orderId === o.id).map(place),
      deliveredAt: o.deliveredAt,
      createdAt: o.createdAt,
      source: o.source,
      trackingUrl: trackingByOrder.has(o.id) ? publicUrl(`/track/${trackingByOrder.get(o.id)}`) : null,
      docs: docs.filter((d) => d.subjectId === o.id && d.code && CUSTOMER_DOC_CODES.includes(d.code)).map((d) => ({ id: d.id, code: d.code!, fileName: d.fileName, createdAt: d.createdAt })),
      invoice: inv ? { id: inv.id, number: inv.number, state: inv.state, totalCents: inv.totalCents, url: inv.token && inv.pdfStorageKey ? publicUrl(`/i/${inv.token}`) : null } : null,
    };
  });
  const invoiceRows = invoices.map((i) => {
    const open = i.state === "void" ? 0 : Math.max(0, i.totalCents - i.paidCents - i.creditedCents);
    const pastDue = open > 0 && !!i.dueAt && i.dueAt.getTime() < now.getTime() ? Math.round((now.getTime() - i.dueAt.getTime()) / 86400_000) : 0;
    return { id: i.id, number: i.number, state: i.state, issuedAt: i.issuedAt, dueAt: i.dueAt, totalCents: i.totalCents, openCents: open, pastDueDays: pastDue, currency: i.currency, orders: orders.filter((o) => i.orderIds.includes(o.id)).map((o) => o.orderNumber), url: i.token && i.pdfStorageKey ? publicUrl(`/i/${i.token}`) : null };
  });
  const openCents = invoiceRows.reduce((a, r) => a + r.openCents, 0);
  const pastDueCents = invoiceRows.filter((r) => r.pastDueDays > 0).reduce((a, r) => a + r.openCents, 0);
  return {
    company: tenant?.name ?? "",
    customer: { id: customer.id, name: customer.name, kind: customer.kind, termsDays: customer.termsDays, country: customer.country },
    active: loads.filter((l) => ["booked", "dispatched", "in_transit", "exception"].includes(l.state)),
    requested: loads.filter((l) => l.state === "draft"),
    delivered: loads.filter((l) => ["delivered", "ready_to_bill", "invoiced", "paid"].includes(l.state)),
    cancelled: loads.filter((l) => l.state === "cancelled"),
    invoices: invoiceRows,
    balance: { openCents, pastDueCents, currency: invoiceRows[0]?.currency ?? "USD" },
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

/** The customer asks for a load: a draft order from them, flagged so Dispatch sees it in Pending. */
export async function portalRequestLoad(tenantId: string, customerId: string, input: LoadRequest) {
  const ctx = systemCtx(tenantId);
  const customer = await loadCustomer(tenantId, customerId);
  if (!input.pickup?.name?.trim()) throw new ValidationError("where do we pick up?", "pickup");
  if (!input.delivery?.name?.trim()) throw new ValidationError("where does it go?", "delivery");
  const stop = (type: s.StopType, p: LoadRequest["pickup"]): StopInput => ({
    type,
    name: p.name.trim(),
    country: p.country === "MX" ? "MX" : "US",
    address: p.city || p.state ? { city: p.city?.trim() || undefined, state: p.state?.trim().toUpperCase() || undefined, country: p.country === "MX" ? "MX" : "US" } : null,
    windowStart: p.windowStart ?? null,
    windowEnd: p.windowEnd ?? null,
    notes: p.notes?.trim() || null,
    contact: input.contact?.trim() || null,
  });
  const stops = [stop("pickup", input.pickup), stop("delivery", input.delivery)];
  if (stops[0].country !== stops[1].country) {
    // a border move: the yards come from dispatch, who know which port; the request carries the two ends
    stops.splice(1, 0, ...(stops[0].country === "MX" ? [{ type: "border_yard" as const, name: "Border yard (MX)", country: "MX" }, { type: "yard" as const, name: "Laredo yard", country: "US" }] : [{ type: "yard" as const, name: "Laredo yard", country: "US" }, { type: "border_yard" as const, name: "Border yard (MX)", country: "MX" }]));
  }
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
  await db.insert(s.flags).values({ id: newId(), tenantId, orderId: r.order.id, code: "portal_request", level: "yellow", title: `Load request from ${customer.name}`, detail: `${stops[0].name} → ${stops[stops.length - 1].name}${input.contact ? ` · ${input.contact}` : ""}. Price it, confirm with them, then book.`, owner: "dispatch" });
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
