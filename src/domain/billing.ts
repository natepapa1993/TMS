import { and, eq, inArray, desc, sql, isNull, lt, gte, lte, arrayOverlaps, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { ChargeKind, InvoiceSnapshot, InvoiceLine, SettlementLine } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit, diff } from "@/lib/audit";
import { newToken, publicUrl } from "@/lib/tokens";
import { enqueue } from "@/lib/outbox";
import { NotFoundError, ValidationError } from "./orders";
import { assertOrderTransition, TransitionError } from "./states";
import { getCompany, setFxRate } from "./company";
import { zonedDate, stopZone } from "@/lib/time";
import { buildInvoicePdf, buildStatementPdf, buildCreditMemoPdf } from "./billing-pdf";
import { money, parseRate, pickRate, toHome, HOME_CURRENCY, type FxRates } from "./fx-rules";

/**
 * Billing & settlements (spec §7). Our own ledger: charges on orders → invoices with locked
 * snapshots and entity-prefixed numbers → receipts; carrier bills with a three-way check;
 * driver settlements from pay rules; order P&L; a month-end close that locks the past.
 */

type Order = typeof s.orders.$inferSelect;

// ---------- charges (7.3) ----------

export const CHARGE_LABEL: Record<ChargeKind, string> = { linehaul: "Line haul", fuel: "Fuel surcharge", detention: "Detention", layover: "Layover", tonu: "TONU", lumper: "Lumper", border_fee: "Border fee", crossing_fee: "Crossing fee", storage: "Storage", extra_stop: "Extra stop", accessorial: "Accessorial", tax: "Tax", other: "Other" };

async function loadOrder(ctx: Ctx, orderId: string): Promise<Order> {
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!o) throw new NotFoundError("order", orderId);
  return o;
}

/** The line haul and fuel charges the order's rate con gives (source rate_con), in the order's currency. */
async function rateConRows(ctx: Ctx, order: Order): Promise<(typeof s.charges.$inferInsert)[]> {
  if (order.rateCents == null) return [];
  const orderId = order.id;
  const rows: (typeof s.charges.$inferInsert)[] = [{ id: newId(), tenantId: ctx.tenantId, orderId, kind: "linehaul", description: "Line haul", qty: 1, unit: "flat", rateCents: order.rateCents, amountCents: order.rateCents, currency: order.currency, source: "rate_con", createdBy: ctx.userId, updatedBy: ctx.userId }];
  if (order.fuelRule === "pct" && order.fuelPct) {
    const pct = order.fuelPct;
    rows.push({ id: newId(), tenantId: ctx.tenantId, orderId, kind: "fuel", description: `Fuel surcharge ${pct}%`, qty: pct * 100, unit: "pct", rateCents: order.rateCents, amountCents: Math.round((order.rateCents * pct) / 100), currency: order.currency, source: "rate_con", createdBy: ctx.userId, updatedBy: ctx.userId });
  } else if (order.fuelRule === "per_mile" && order.fuelCentsPerMile) {
    // cents per mile on the rated miles: the per-mile quantity when the load is priced per mile, else the legs' planned miles
    let miles = order.rateType === "per_mile" && order.rateQty ? order.rateQty : 0;
    if (!miles) {
      const legs = await db.select({ miles: s.legs.plannedMiles, state: s.legs.state }).from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.orderId, orderId)));
      miles = legs.filter((l) => l.state !== "cancelled").reduce((a, l) => a + (l.miles ?? 0), 0);
    }
    if (miles > 0) rows.push({ id: newId(), tenantId: ctx.tenantId, orderId, kind: "fuel", description: `Fuel surcharge ${order.fuelCentsPerMile}¢/mi × ${miles} mi`, qty: miles, unit: "mi", rateCents: order.fuelCentsPerMile, amountCents: order.fuelCentsPerMile * miles, currency: order.currency, source: "rate_con", createdBy: ctx.userId, updatedBy: ctx.userId });
  }
  return rows;
}

/** Make sure the order has its line haul (and fuel) charge from the rate confirmation. Idempotent. */
export async function ensureCharges(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  const order = await loadOrder(ctx, orderId);
  const existing = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId)));
  // a TONU is billed its fee instead of the line haul
  if (existing.some((c) => c.kind === "linehaul" || c.kind === "tonu")) return existing;
  const rows = await rateConRows(ctx, order);
  if (!rows.length) return existing;
  await db.insert(s.charges).values(rows);
  return db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId)));
}

/**
 * The rate, currency or fuel rule on the load changed: the rate-con charges (line haul and fuel, source
 * rate_con) are rebuilt from the load, in its currency. Charges already on an invoice are never touched
 * (a change after invoicing is a credit or a supplemental). With `reset`, a typed line haul or fuel
 * (source manual) is replaced too — "Reset charges to the rate con". A mismatch accepted earlier no longer
 * stands once the rate con itself changed.
 */
export async function syncRateConCharges(ctx: Ctx, orderId: string, opts: { reset?: boolean } = {}) {
  assertCtx(ctx);
  const order = await loadOrder(ctx, orderId);
  if (order.tonu || order.kind === "trip") return { changed: false as const, reason: order.tonu ? "a TONU bills its fee" : "a trip doesn't bill" };
  const existing = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId)));
  const base = existing.filter((c) => c.kind === "linehaul" || c.kind === "fuel");
  if (base.some((c) => c.invoiceId)) return { changed: false as const, reason: "the line haul is already on an invoice: credit it or bill a supplemental" };
  const drop = base.filter((c) => c.source === "rate_con" || opts.reset);
  // nothing built yet and not a reset: ensureCharges builds them from the load when billing needs them
  if (!drop.length && !opts.reset && !existing.length) return { changed: false as const, reason: null };
  const rows = await rateConRows(ctx, order);
  const custom = { ...((order.custom ?? {}) as Record<string, unknown>) };
  const hadAccepted = "rateConMismatchAccepted" in custom;
  delete custom.rateConMismatchAccepted;
  await db.transaction(async (tx) => {
    if (drop.length) await tx.delete(s.charges).where(inArray(s.charges.id, drop.map((c) => c.id)));
    if (rows.length) await tx.insert(s.charges).values(rows);
    if (hadAccepted) await tx.update(s.orders).set({ custom, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, orderId));
    const was = drop.map((c) => `${c.description} ${money(c.amountCents, c.currency)}`).join(", ") || "none";
    const now = rows.map((c) => `${c.description} ${money(c.amountCents!, c.currency!)}`).join(", ") || "none";
    if (was !== now) await writeAudit(tx, ctx, "order", orderId, "update", { rateConCharges: { from: was, to: now } }, opts.reset ? "charges reset to the rate con" : "rate con changed: line haul and fuel follow it");
  });
  return { changed: true as const, reason: null };
}

export type ChargeInput = { kind: ChargeKind; description?: string; qty?: number; unit?: string; rateCents: number; currency?: string; billable?: boolean; legId?: string | null; data?: Record<string, unknown>; approvalState?: "none" | "pending" | "approved"; /** the exact amount when qty × rate would round (detention by the minute) */ amountCents?: number };

/** Extras beyond the rate con that the customer has to OK before they bill (when the customer asks for approvals, the default). */
export const NEEDS_APPROVAL: ChargeKind[] = ["detention", "layover", "lumper", "storage", "extra_stop", "accessorial", "other", "border_fee", "crossing_fee"];

/** The customer OK'd an extra charge: who, and how (email, portal, phone). It bills; if a draft invoice is open for the load it joins it. */
export async function approveCharge(ctx: Ctx, chargeId: string, a: { by: string; ref?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!a.by?.trim()) throw new ValidationError("who approved it at the customer?", "by");
  const [c] = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.id, chargeId))).limit(1);
  if (!c) throw new NotFoundError("charge", chargeId);
  if (c.invoiceId) throw new ValidationError("this charge is already on an invoice");
  const [draft] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.state, "draft"), sql`${c.orderId} = any(${s.invoices.orderIds})`)).limit(1);
  await db.transaction(async (tx) => {
    await tx.update(s.charges).set({ approvalState: "approved", approvedBy: a.by.trim(), approvalRef: a.ref?.trim() || null, approvedAt: new Date(), rejectedReason: null, billable: true, invoiceId: draft && draft.currency === c.currency ? draft.id : null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.charges.id, c.id));
    if (draft && draft.currency === c.currency) await tx.update(s.invoices).set({ subtotalCents: draft.subtotalCents + c.amountCents, totalCents: draft.totalCents + c.amountCents, updatedAt: new Date() }).where(eq(s.invoices.id, draft.id));
    await writeAudit(tx, ctx, "order", c.orderId, "update", { [c.description]: { from: c.approvalState, to: "approved" } }, `approved by ${a.by.trim()}${a.ref?.trim() ? ` (${a.ref.trim()})` : ""}`);
  });
  return { joinedDraft: draft?.id ?? null };
}

/** The customer said no: the charge stays on the load for the record, not billable. */
export async function rejectCharge(ctx: Ctx, chargeId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!reason?.trim()) throw new ValidationError("what did the customer say?", "reason");
  const [c] = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.id, chargeId))).limit(1);
  if (!c) throw new NotFoundError("charge", chargeId);
  if (c.invoiceId) throw new ValidationError("this charge is already on an invoice: credit it instead");
  await db.update(s.charges).set({ approvalState: "rejected", rejectedReason: reason.trim(), billable: false, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.charges.id, c.id));
  await writeAudit(db, ctx, "order", c.orderId, "update", { [c.description]: { from: c.approvalState, to: "rejected" } }, reason.trim());
}

export async function addCharge(ctx: Ctx, orderId: string, input: ChargeInput) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const order = await loadOrder(ctx, orderId);
  // after invoicing, a late charge (detention approved later, a lumper receipt) goes on a supplemental invoice
  if (order.state === "cancelled" && !order.tonu) throw new ValidationError("order is cancelled");
  if (!Number.isFinite(input.rateCents)) throw new ValidationError("rate must be a number", "rateCents");
  const custId = order.customerId ?? order.brokerId;
  const [cust] = custId ? await db.select({ approval: s.customers.accessorialApproval }).from(s.customers).where(eq(s.customers.id, custId)).limit(1) : [];
  const approvalState = input.approvalState ?? (NEEDS_APPROVAL.includes(input.kind) && (cust?.approval ?? true) ? "pending" : "none");
  const qty = input.qty ?? 1;
  const unit = input.unit ?? "flat";
  // qty is in hundredths for hours (150 = 1.50 h) and hundredths of a percent for pct (2000 = 20.00 % of the rate)
  const amount = input.amountCents != null && Number.isInteger(input.amountCents) ? input.amountCents : unit === "h" ? Math.round((input.rateCents * qty) / 100) : unit === "pct" ? Math.round((input.rateCents * qty) / 10000) : Math.round(input.rateCents * qty);
  const [row] = await db
    .insert(s.charges)
    .values({ id: newId(), tenantId: ctx.tenantId, orderId, legId: input.legId ?? null, kind: input.kind, description: input.description?.trim() || CHARGE_LABEL[input.kind], qty, unit, rateCents: input.rateCents, amountCents: amount, currency: input.currency ?? order.currency, billable: input.billable ?? true, source: input.data ? "computed" : "manual", data: input.data, approvalState, createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning();
  await writeAudit(db, ctx, "order", orderId, "update", { charge: { from: null, to: `${row.description} ${amount}` } }, approvalState === "pending" ? "waiting for the customer's approval" : undefined);
  return row;
}

export async function removeCharge(ctx: Ctx, chargeId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const [c] = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.id, chargeId))).limit(1);
  if (!c) throw new NotFoundError("charge", chargeId);
  if (c.invoiceId) throw new ValidationError("this charge is on an invoice; void or credit that first");
  await db.delete(s.charges).where(eq(s.charges.id, chargeId));
  await writeAudit(db, ctx, "order", c.orderId, "update", { charge: { from: `${c.description} ${c.amountCents}`, to: null } });
}

/** Detention from the stop clocks: free time and rate come from the customer (spec 7.3, 11.6 split clocks per side). */
export async function computeDetention(ctx: Ctx, orderId: string, opts: { freeMinutes?: number; rateCentsPerHour?: number } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const order = await loadOrder(ctx, orderId);
  const customer = order.customerId ? (await db.select().from(s.customers).where(eq(s.customers.id, order.customerId)).limit(1))[0] : null;
  const free = opts.freeMinutes ?? customer?.detentionFreeMinutes ?? 120;
  const rate = opts.rateCentsPerHour ?? customer?.detentionRateCents ?? 7500;
  const stops = await db.select().from(s.stops).where(and(eq(s.stops.orderId, orderId), sql`${s.stops.arrivedAt} is not null`, sql`${s.stops.departedAt} is not null`));
  const out = [];
  for (const st of stops) {
    if (st.type !== "pickup" && st.type !== "delivery") continue;
    const minutes = Math.round((st.departedAt!.getTime() - st.arrivedAt!.getTime()) / 60000);
    const billableMin = minutes - free;
    if (billableMin <= 0) continue;
    const hours100 = Math.round((billableMin / 60) * 100);
    // billed by the minute: 2 h 28 min at $75/h is $185.00 (not 2.47 h × $75 = $185.25)
    const exact = Math.round((rate * billableMin) / 60);
    const [dupe] = await db.select({ id: s.charges.id }).from(s.charges).where(and(eq(s.charges.orderId, orderId), eq(s.charges.kind, "detention"), sql`${s.charges.data}->>'stopId' = ${st.id}`)).limit(1);
    if (dupe) continue;
    out.push(await addCharge(ctx, orderId, { kind: "detention", description: `Detention at ${st.name} (${st.country}) — ${Math.floor(billableMin / 60)}h ${billableMin % 60}m over ${free} min free`, qty: hours100, unit: "h", rateCents: rate, amountCents: exact, data: { stopId: st.id, arrivedAt: st.arrivedAt, departedAt: st.departedAt, freeMinutes: free, rateCents: rate, billableMinutes: billableMin, rule: "customer · by the minute" } }));
  }
  return out;
}

export async function chargesFor(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  return db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId))).orderBy(s.charges.createdAt);
}

// ---------- billing queue (7.2) ----------

export type QueueRow = { order: Order; customerName: string | null; entityName: string | null; chargesCents: number; rateConCents: number | null; mismatch: boolean; mismatchReason: string | null; bigDifference: boolean; requiredDocs: { code: string; present: boolean }[]; requiredRefs: { key: string; present: boolean }[]; docsComplete: boolean; ageDays: number; invoiceId: string | null; paperSays: string | null; pending: { count: number; cents: number; charges: { id: string; description: string; amountCents: number }[] }; supplemental: boolean };

/** The reference keys a customer may require on the order before it invoices, as the customer record spells them. */
export const REF_KEYS: Record<string, string> = { PO: "po", ASN: "asn", SHIPMENT: "shipment", REFERENCE: "reference", RATE_CON: "rate_con" };

export function requiredRefsFor(cust: { requiredRefs?: string[] | null } | undefined, refs: Record<string, string | null | undefined>) {
  return (cust?.requiredRefs ?? []).map((code) => {
    const key = REF_KEYS[code.toUpperCase()] ?? code.toLowerCase();
    return { key, present: !!refs[key]?.toString().trim() };
  });
}

/** A charge that bills now: billable, not on an invoice, agreed or approved (not waiting, not refused). */
const billsNow = (c: typeof s.charges.$inferSelect) => c.billable && !c.invoiceId && (c.approvalState === "none" || c.approvalState === "approved");

/**
 * Why the charges differ from the rate con, or null when they don't: the agreed line haul (or TONU) isn't
 * what the rate con says, someone typed their own line haul or fuel, or a charge is in another currency
 * than the load. Approved extras don't count: their approval is on the charge.
 */
export function mismatchReason(o: Pick<Order, "rateCents" | "custom" | "currency">, cs: (typeof s.charges.$inferSelect)[]): string | null {
  if (o.rateCents == null) return null;
  const live = cs.filter((c) => c.billable && c.approvalState !== "rejected");
  const other = live.filter((c) => !c.invoiceId && c.currency !== o.currency);
  // a charge in another currency is never accepted as is: it would bill dollars as pesos
  if (other.length) return `${other.length} charge${other.length === 1 ? " is" : "s are"} in ${[...new Set(other.map((c) => c.currency))].join(", ")} but the load is in ${o.currency}`;
  if ((o.custom as Record<string, unknown> | null)?.rateConMismatchAccepted) return null;
  const base = live.filter((c) => c.kind === "linehaul" || c.kind === "tonu").reduce((a, c) => a + c.amountCents, 0);
  if (base !== o.rateCents) return `line haul ${money(base, o.currency)} vs ${money(o.rateCents, o.currency)} on the rate con`;
  if (live.some((c) => (c.kind === "linehaul" || c.kind === "fuel") && c.source !== "rate_con")) return "a typed line haul or fuel charge";
  return null;
}

export function rateConMismatch(o: Pick<Order, "rateCents" | "custom" | "currency">, cs: (typeof s.charges.$inferSelect)[]) {
  return mismatchReason(o, cs) != null;
}

/** A difference this big is not something to wave through: more than 10% of the rate con, or another currency. */
export function bigDifference(rateConCents: number | null, chargesCents: number, reason: string | null) {
  if (!reason) return false;
  if (/currency|but the load is in/.test(reason)) return true;
  if (!rateConCents) return true;
  return Math.abs(chargesCents - rateConCents) > rateConCents * 0.1;
}

export async function billingQueue(ctx: Ctx): Promise<QueueRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  // a tailgate trip never bills: its shipments do. Invoiced / paid loads come back when a late charge is waiting for a supplemental invoice.
  const late = await db.selectDistinct({ orderId: s.charges.orderId }).from(s.charges).innerJoin(s.orders, eq(s.orders.id, s.charges.orderId)).where(and(eq(s.charges.tenantId, ctx.tenantId), isNull(s.charges.invoiceId), eq(s.charges.billable, true), sql`${s.charges.approvalState} <> 'rejected'`, inArray(s.orders.state, ["invoiced", "paid"])));
  const ords = await db
    .select()
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, ctx.tenantId), sql`${s.orders.kind} <> 'trip'`, late.length ? or(inArray(s.orders.state, ["delivered", "ready_to_bill"]), inArray(s.orders.id, late.map((l) => l.orderId))) : inArray(s.orders.state, ["delivered", "ready_to_bill"])))
    .orderBy(s.orders.deliveredAt);
  if (!ords.length) return [];
  const ids = ords.map((o) => o.id);
  const [chargeRows, docs, customers, entities, drafts] = await Promise.all([
    db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), inArray(s.charges.orderId, ids))),
    db.select({ subjectId: s.documents.subjectId, code: s.documents.code }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, ids), inArray(s.documents.status, ["present", "verified"]))),
    db.select().from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId)),
    db.select().from(s.billingEntities).where(eq(s.billingEntities.tenantId, ctx.tenantId)),
    db.select({ id: s.invoices.id, orderIds: s.invoices.orderIds }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.state, ["draft"]))),
  ]);
  const paperFlags = await db.select({ orderId: s.flags.orderId, title: s.flags.title }).from(s.flags).where(and(eq(s.flags.tenantId, ctx.tenantId), inArray(s.flags.orderId, ids), eq(s.flags.code, "rate_con_differs"), sql`${s.flags.clearedAt} is null`));
  const out: QueueRow[] = [];
  for (const o of ords) {
    const supplemental = o.state === "invoiced" || o.state === "paid";
    let cs = chargeRows.filter((c) => c.orderId === o.id);
    if (!supplemental && !cs.some((c) => c.kind === "linehaul" || c.kind === "tonu") && o.rateCents != null) cs = await ensureCharges(ctx, o.id);
    const cust = customers.find((c) => c.id === (o.customerId ?? o.brokerId));
    const entity = entities.find((e) => e.id === (o.billingEntityId ?? cust?.billingEntityId)) ?? entities.find((e) => e.isDefault) ?? entities[0];
    // a TONU never picked up: no POD or BOL to wait for
    const required = (cust?.requiredDocs ?? ["POD", "BOL", "RATE_CON"]).filter((code) => !(o.tonu && ["POD", "BOL", "SEAL"].includes(code))).map((code) => ({ code, present: docs.some((d) => d.subjectId === o.id && d.code === code) }));
    const requiredRefs = requiredRefsFor(cust, o.refs ?? {});
    const pendingRows = cs.filter((c) => c.billable && !c.invoiceId && c.approvalState === "pending");
    const chargesCents = cs.filter(billsNow).reduce((a, c) => a + c.amountCents, 0);
    out.push({
      order: o,
      customerName: cust?.name ?? null,
      entityName: entity?.legalName ?? null,
      chargesCents,
      rateConCents: o.rateCents,
      mismatch: !supplemental && rateConMismatch(o, cs),
      mismatchReason: supplemental ? null : mismatchReason(o, cs),
      bigDifference: !supplemental && bigDifference(o.rateCents, chargesCents, mismatchReason(o, cs)),
      requiredDocs: required,
      requiredRefs,
      docsComplete: required.every((r) => r.present) && requiredRefs.every((r) => r.present),
      ageDays: o.deliveredAt ? Math.floor((Date.now() - o.deliveredAt.getTime()) / 86400_000) : 0,
      invoiceId: drafts.find((d) => d.orderIds.includes(o.id))?.id ?? null,
      paperSays: paperFlags.find((x) => x.orderId === o.id)?.title ?? null,
      pending: { count: pendingRows.length, cents: pendingRows.reduce((a, c) => a + c.amountCents, 0), charges: pendingRows.map((c) => ({ id: c.id, description: c.description, amountCents: c.amountCents })) },
      supplemental,
    });
  }
  // a supplemental row with nothing ready to bill (only waiting approvals) still shows, so the approval can be chased
  return out;
}

export async function acceptRateConMismatch(ctx: Ctx, orderId: string, note: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!note?.trim()) throw new ValidationError("say why the charges differ from the rate con (e.g. accessorial approved by email)", "note");
  const o = await loadOrder(ctx, orderId);
  const cs = await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId)));
  const wrong = cs.filter((c) => c.billable && c.approvalState !== "rejected" && !c.invoiceId && c.currency !== o.currency);
  if (wrong.length) throw new ValidationError(`${wrong.map((c) => c.description).join(", ")} ${wrong.length === 1 ? "is" : "are"} in ${wrong[0].currency} but the load is in ${o.currency} — reset the charges to the rate con, or remove and re-add ${wrong.length === 1 ? "it" : "them"} in ${o.currency}`);
  await db.update(s.orders).set({ custom: { ...(o.custom ?? {}), rateConMismatchAccepted: note.trim() }, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, orderId));
  // accepting our charges with a note also approves any extras still waiting, on the strength of that note
  await db.update(s.charges).set({ approvalState: "approved", approvedBy: "accepted with a note", approvalRef: note.trim(), approvedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.charges.tenantId, ctx.tenantId), eq(s.charges.orderId, orderId), eq(s.charges.approvalState, "pending"), isNull(s.charges.invoiceId)));
  await writeAudit(db, ctx, "order", orderId, "override", { rateCon: { from: "mismatch", to: "accepted" } }, note.trim());
}

/** "Reset charges to the rate con": the line haul and fuel go back to what the load's rate con says (a typed one is removed). */
export async function resetChargesToRateCon(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const r = await syncRateConCharges(ctx, orderId, { reset: true });
  if (!r.changed && r.reason) throw new ValidationError(r.reason);
  return r;
}

/** Upload a POD / BOL / rate con on the order (billing docs). */
export async function uploadOrderDocument(ctx: Ctx, orderId: string, input: { code: string; fileName: string; mimeType: string; bytes: Buffer; source?: string }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  if (!input.bytes?.length) throw new ValidationError("empty file", "file");
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(input.mimeType)) throw new ValidationError("PDF, JPG or PNG only", "file");
  await loadOrder(ctx, orderId);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const row = await db.transaction(async (tx) => {
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: input.mimeType, sizeBytes: input.bytes.length, bytes: input.bytes }).returning({ id: s.documentBlobs.id });
    const prior = await tx.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "order"), eq(s.documents.subjectId, orderId), eq(s.documents.code, input.code), inArray(s.documents.status, ["present", "verified"])));
    for (const p of prior) await tx.update(s.documents).set({ status: "superseded" }).where(eq(s.documents.id, p.id));
    const [row] = await tx.insert(s.documents).values({ id: newId(), tenantId: ctx.tenantId, code: input.code, subjectKind: "order", subjectId: orderId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: input.source ?? "upload", version: (Math.max(0, ...prior.map((p) => p.version)) || 0) + 1, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
    await writeAudit(tx, ctx, "order", orderId, "update", { [input.code]: { from: prior[0]?.fileName ?? null, to: input.fileName } });
    return row;
  });
  if (input.code === "RATE_CON") await readRateCon(ctx, row.id, input).catch(() => null); // never blocks the upload
  return row;
}

/**
 * The customer's rate confirmation, read by the AI extractor when one is connected: the rate on their
 * paper against the rate on our order. A difference is a yellow flag for billing before anything invoices;
 * a match is noted on the document. A person still confirms; the AI never edits the order.
 */
export async function readRateCon(ctx: Ctx, documentId: string, input: { fileName: string; mimeType: string; bytes: Buffer }, fetchImpl?: typeof fetch) {
  const [integ] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, ctx.tenantId), eq(s.integrations.provider, "extractor"))).limit(1);
  if (!integ?.enabled || !integ.config.apiKey) return { ran: false as const, reason: "AI extractor not connected" };
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.id, documentId))).limit(1);
  if (!doc) throw new NotFoundError("document", documentId);
  const order = await loadOrder(ctx, doc.subjectId);
  const { extractWithModel } = await import("@/integrations/extractor");
  const fields = [
    { key: "rate", label: "Total rate / amount the carrier is paid, as a number", kind: "number" as const },
    { key: "currency", label: "Currency of the rate (USD or MXN)" },
    { key: "rateConNumber", label: "Rate confirmation / load / order number" },
    { key: "po", label: "PO or customer reference number" },
    { key: "pickupDate", label: "Pickup date", kind: "datetime" as const },
    { key: "deliveryDate", label: "Delivery date", kind: "datetime" as const },
  ];
  try {
    const r = await extractWithModel({ apiKey: integ.config.apiKey, model: integ.config.model || undefined }, { code: "RATE_CON", label: "Rate confirmation", mimeType: input.mimeType, bytes: input.bytes }, fields, fetchImpl);
    const rateRead = r.fields.rate?.value != null && r.fields.rate.value !== "" ? Math.round(Number(r.fields.rate.value) * 100) : null;
    const extracted = Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v.value != null && v.value !== ""));
    let note = `${r.model} · read`;
    if (rateRead != null && Number.isFinite(rateRead) && order.rateCents != null) {
      if (Math.abs(rateRead - order.rateCents) >= 100) {
        note = `${r.model} · rate con says ${(rateRead / 100).toFixed(2)}, order says ${(order.rateCents / 100).toFixed(2)}`;
        const [open] = await db.select({ id: s.flags.id }).from(s.flags).where(and(eq(s.flags.orderId, order.id), eq(s.flags.code, "rate_con_differs"), sql`${s.flags.clearedAt} is null`)).limit(1);
        if (!open) await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId: order.id, code: "rate_con_differs", level: "yellow", title: `Rate con says $${(rateRead / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}; the order says $${(order.rateCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, detail: `Read from ${input.fileName} by the AI extractor. Fix the order or the customer before invoicing.`, owner: "billing", data: { documentId, rateReadCents: rateRead } });
      } else {
        note = `${r.model} · rate matches the order`;
        await db.update(s.flags).set({ clearedAt: new Date(), clearedBy: "system" }).where(and(eq(s.flags.orderId, order.id), eq(s.flags.code, "rate_con_differs"), sql`${s.flags.clearedAt} is null`));
      }
    }
    await db.update(s.documents).set({ extracted, extractionAt: new Date(), extractionNote: note }).where(eq(s.documents.id, documentId));
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: null, lastResult: note }).where(eq(s.integrations.id, integ.id));
    return { ran: true as const, rateReadCents: rateRead, note };
  } catch (e) {
    await db.update(s.documents).set({ extractionNote: `failed: ${(e as Error).message}` }).where(eq(s.documents.id, documentId));
    await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: (e as Error).message }).where(eq(s.integrations.id, integ.id));
    return { ran: false as const, reason: (e as Error).message };
  }
}

// ---------- invoices (7.1, 7.4) ----------

async function closedThrough(ctx: Ctx) {
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const v = (t?.settings as Record<string, unknown>)?.closedThrough;
  return v ? new Date(String(v)) : null;
}

/** Month-end close (persona: head of billing). Nothing dated on or before this can be issued, voided or credited. */
export async function closePeriod(ctx: Ctx, through: Date) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.void");
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const prev = await closedThrough(ctx);
  if (prev && through.getTime() < prev.getTime()) throw new ValidationError("a period cannot be re-opened from here");
  await db.update(s.tenants).set({ settings: { ...(t.settings ?? {}), closedThrough: through.toISOString() } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { closedThrough: { from: prev?.toISOString() ?? null, to: through.toISOString() } }, "period closed");
}

/** Nothing dated on or before the close can be recorded: receipts, payments, factor entries, bill and settlement payments. */
export async function assertOpenPeriod(ctx: Ctx, date: Date) {
  const c = await closedThrough(ctx);
  if (c && date.getTime() <= c.getTime()) throw new ValidationError(`the books are closed through ${c.toISOString().slice(0, 10)}: date it after that (the owner closes periods; they can't be reopened)`);
}

export async function createInvoice(ctx: Ctx, orderIds: string[], opts: { entityId?: string | null; consolidate?: boolean; withoutPending?: boolean; rebillOf?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!orderIds.length) throw new ValidationError("pick at least one order", "orderIds");
  const queue = (await billingQueue(ctx)).filter((q) => orderIds.includes(q.order.id));
  if (queue.length !== orderIds.length) throw new ValidationError("an order is not ready to bill (not delivered, cancelled, or already invoiced)");
  const supplemental = queue.some((q) => q.supplemental);
  if (supplemental && queue.some((q) => !q.supplemental)) throw new ValidationError("late charges on invoiced loads go on their own supplemental invoice");
  const custIds = new Set(queue.map((q) => q.order.customerId ?? q.order.brokerId));
  if (custIds.size > 1) throw new ValidationError("one invoice is for one customer");
  const customerId = [...custIds][0];
  if (!customerId) throw new ValidationError("the order has no customer");
  const bad = queue.filter((q) => !q.docsComplete || q.mismatch);
  if (bad.length) throw new ValidationError(bad.map((q) => `${q.order.orderNumber}: ${!q.docsComplete ? `missing ${[...q.requiredDocs.filter((d) => !d.present).map((d) => d.code), ...q.requiredRefs.filter((r) => !r.present).map((r) => `${r.key.toUpperCase()} reference`)].join(", ")}` : "charges differ from the rate con"}`).join("; "));
  const waiting = queue.filter((q) => q.pending.count > 0);
  if (waiting.length && !opts.withoutPending) throw new ValidationError(waiting.map((q) => `${q.order.orderNumber}: ${q.pending.count} extra charge${q.pending.count === 1 ? "" : "s"} waiting for the customer's approval (${q.pending.charges.map((c) => c.description).join(", ")}) — approve, reject, or bill without ${q.pending.count === 1 ? "it" : "them"}`).join("; "), "pending");
  if (queue.some((q) => q.invoiceId)) throw new ValidationError("one of these orders already has a draft invoice: open it");
  const [cust] = await db.select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1);
  const entities = await db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), isNull(s.billingEntities.archivedAt)));
  const entity = entities.find((e) => e.id === (opts.entityId ?? queue[0].order.billingEntityId ?? cust.billingEntityId)) ?? entities.find((e) => e.isDefault) ?? entities[0];
  if (!entity) throw new ValidationError("add a billing entity first (Settings → Billing entities)");
  if (!supplemental) {
    const already = await db.select({ id: s.invoices.id }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), arrayOverlaps(s.invoices.orderIds, orderIds), sql`${s.invoices.state} <> 'void'`, eq(s.invoices.kind, "standard"))).limit(1);
    if (already.length) throw new ValidationError("one of these orders is already on an invoice");
  }
  const chargeRows = (await db.select().from(s.charges).where(and(eq(s.charges.tenantId, ctx.tenantId), inArray(s.charges.orderId, orderIds)))).filter(billsNow);
  if (!chargeRows.length) throw new ValidationError("nothing to bill yet: every charge is waiting for approval");
  const currency = queue[0].order.currency;
  if (queue.some((q) => q.order.currency !== currency)) throw new ValidationError("one invoice is in one currency: these loads are in " + [...new Set(queue.map((q) => q.order.currency))].join(" and "));
  const wrongCur = chargeRows.filter((c) => c.currency !== currency);
  if (wrongCur.length) throw new ValidationError(`${wrongCur.map((c) => `${queue.find((q) => q.order.id === c.orderId)?.order.orderNumber ?? ""} ${c.description} (${c.currency})`).join(", ")}: the invoice is in ${currency} — fix the charge on the load first`);
  const subtotal = chargeRows.reduce((a, c) => a + c.amountCents, 0);
  const kind = opts.rebillOf ? "rebill" : supplemental ? "supplemental" : "standard";
  // a supplemental invoice adds to the load's invoice: it says which one, so the customer's AP doesn't reject it as a duplicate
  const [orig] = supplemental ? await db.select({ id: s.invoices.id }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.kind, "standard"), arrayOverlaps(s.invoices.orderIds, orderIds), sql`${s.invoices.state} not in ('void','draft')`)).orderBy(desc(s.invoices.issuedAt)).limit(1) : [];
  return db.transaction(async (tx) => {
    const [inv] = await tx.insert(s.invoices).values({ id: newId(), tenantId: ctx.tenantId, entityId: entity.id, customerId, orderIds, currency, termsDays: cust.termsDays, subtotalCents: subtotal, totalCents: subtotal, payWhenPaid: cust.payWhenPaid, token: newToken(), kind, rebillOf: opts.rebillOf ?? null, supplementOf: orig?.id ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
    await tx.update(s.charges).set({ invoiceId: inv.id }).where(inArray(s.charges.id, chargeRows.map((c) => c.id)));
    for (const o of queue) if (o.order.state === "delivered") await tx.update(s.orders).set({ state: "ready_to_bill", previousState: "delivered", updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, o.order.id));
    await writeAudit(tx, ctx, "invoice", inv.id, "create", undefined, `${kind === "standard" ? "draft" : `${kind} draft`} for ${queue.map((q) => q.order.orderNumber).join(", ")}${waiting.length ? " (extras waiting for approval left off)" : ""}`);
    return inv;
  });
}

/**
 * Rebill: the customer wants the invoice again with a change (their PO, a corrected charge, another bill-to).
 * No payments on it yet: it voids with the reason and a new draft for the same loads opens, linked to it,
 * for the change before it issues. With payments on it, credit the difference or bill a supplemental instead.
 */
export async function rebillInvoice(ctx: Ctx, invoiceId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!reason?.trim()) throw new ValidationError("why is it rebilled? (the customer's words)", "reason");
  const { invoice: inv, receipts: rcpts } = await invoiceById(ctx, invoiceId);
  if (rcpts.length) throw new ValidationError("this invoice has payments on it: credit the difference, or bill the extra on a supplemental invoice");
  if (inv.creditedCents) throw new ValidationError("this invoice has a credit memo: rebill isn't clean — credit the rest instead");
  if (!["issued", "sent", "disputed"].includes(inv.state)) throw new TransitionError("order", inv.state, "void", "only an issued, sent or disputed invoice can be rebilled");
  if (inv.issuedAt) await assertOpenPeriod(ctx, inv.issuedAt);
  await db.transaction(async (tx) => {
    await tx.update(s.charges).set({ invoiceId: null }).where(eq(s.charges.invoiceId, invoiceId));
    await tx.update(s.invoices).set({ state: "void", voidedAt: new Date(), voidReason: `Rebilled: ${reason.trim()}`, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId));
    // a standard invoice's loads go back to "ready to bill"; a supplemental's stay invoiced
    if (inv.kind !== "supplemental") for (const oid of inv.orderIds) await tx.update(s.orders).set({ state: "ready_to_bill", previousState: "invoiced", updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.orders.id, oid), eq(s.orders.state, "invoiced")));
    await writeAudit(tx, ctx, "invoice", invoiceId, "transition", { state: { from: inv.state, to: "void" } }, `rebilled: ${reason.trim()}`);
  });
  return createInvoice(ctx, inv.orderIds, { entityId: inv.entityId, withoutPending: true, rebillOf: inv.id });
}

export async function invoiceById(ctx: Ctx, invoiceId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [inv] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.id, invoiceId))).limit(1);
  if (!inv) throw new NotFoundError("invoice", invoiceId);
  const [lines, rcpts, memos, entity, customer, orders] = await Promise.all([
    db.select().from(s.charges).where(eq(s.charges.invoiceId, invoiceId)).orderBy(s.charges.createdAt),
    db.select().from(s.receipts).where(eq(s.receipts.invoiceId, invoiceId)).orderBy(desc(s.receipts.receivedAt)),
    db.select().from(s.creditMemos).where(eq(s.creditMemos.invoiceId, invoiceId)).orderBy(desc(s.creditMemos.issuedAt)),
    db.select().from(s.billingEntities).where(eq(s.billingEntities.id, inv.entityId)).limit(1).then((r) => r[0] ?? null),
    db.select().from(s.customers).where(eq(s.customers.id, inv.customerId)).limit(1).then((r) => r[0] ?? null),
    inv.orderIds.length ? db.select().from(s.orders).where(inArray(s.orders.id, inv.orderIds)) : Promise.resolve([]),
  ]);
  return { invoice: inv, lines, receipts: rcpts, creditMemos: memos, entity, customer, orders };
}

const hasAddress = (a: Record<string, string | undefined> | null | undefined) => !!(a && a.line1?.trim() && a.city?.trim());

/** Reference keys as a customer reads them on the invoice: "PO #", "Rate con #", not "po:". */
export const REF_LABEL: Record<string, string> = { po: "PO #", rate_con: "Rate con #", asn: "ASN #", shipment: "Shipment #", reference: "Ref #", bol: "BOL #", pro: "PRO #", pickup: "Pickup #", delivery: "Delivery #", sylectus_load: "Load #" };
export const refLabel = (k: string) => REF_LABEL[k] ?? `${k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} #`;

export async function issueInvoice(ctx: Ctx, invoiceId: string, opts: { issuedAt?: Date; exchangeRate?: number | string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const { invoice: inv, lines, entity, customer, orders } = await invoiceById(ctx, invoiceId);
  if (inv.state !== "draft") throw new TransitionError("order", inv.state, "issued", "only a draft can be issued");
  if (!lines.length) throw new ValidationError("the invoice has no lines");
  if (!entity || !customer) throw new ValidationError("entity or customer missing");
  const issuedAt = opts.issuedAt ?? new Date();
  await assertOpenPeriod(ctx, issuedAt);
  // rate-con hard stop and required docs re-checked at issue (persona: head of billing)
  const queue = (await billingQueue(ctx)).filter((q) => inv.orderIds.includes(q.order.id));
  const bad = queue.filter((q) => !q.docsComplete || q.mismatch);
  if (bad.length) throw new ValidationError(bad.map((q) => `${q.order.orderNumber}: ${!q.docsComplete ? `missing ${[...q.requiredDocs.filter((d) => !d.present).map((d) => d.code), ...q.requiredRefs.filter((r) => !r.present).map((r) => `${r.key.toUpperCase()} reference`)].join(", ")}` : `charges differ from the rate con (${q.mismatchReason})`}`).join("; "));
  if (lines.some((l) => l.currency !== inv.currency)) throw new ValidationError(`every line must be in ${inv.currency}: fix the charges on the load`);
  // a MXN or CAD invoice carries the rate it was issued at: reports and QuickBooks convert with it
  let rateE4: number | null = null;
  if (inv.currency !== HOME_CURRENCY) {
    if (opts.exchangeRate == null || opts.exchangeRate === "") throw new ValidationError(`an exchange rate is required for a ${inv.currency} invoice (${inv.currency} per 1 USD)`, "exchangeRate");
    try {
      rateE4 = parseRate(opts.exchangeRate, inv.currency);
    } catch (e) {
      throw new ValidationError((e as Error).message, "exchangeRate");
    }
  }
  const company = await getCompany(ctx);
  const tz = company.timeZone;
  const allStops = orders.length ? await db.select().from(s.stops).where(inArray(s.stops.orderId, orders.map((o) => o.id))).orderBy(s.stops.seq) : [];
  const stops = inv.orderIds.length === 1 ? allStops.filter((x) => x.orderId === inv.orderIds[0]) : [];
  // dates the customer reads are the stop's own calendar day (a 9 PM pickup in Laredo is that day, not tomorrow in UTC)
  const localDay = (d: Date | null | undefined, st?: { country: string; address: { state?: string } | null }) => (d ? zonedDate(d, st ? stopZone(st, tz) : tz) : null);
  const refs: Record<string, string> = {};
  if (orders.length === 1) for (const [k, v] of Object.entries(orders[0].refs)) if (v) refs[k] = v;
  // a summary invoice: one row per load with its references, lane and dates
  let loads: InvoiceSnapshot["loads"];
  if (orders.length > 1) {
    const place = (st?: typeof allStops[number]) => (st ? [st.address?.city || st.name, st.address?.state].filter(Boolean).join(", ") : "");
    loads = [...orders]
      .sort((p, q) => p.orderNumber.localeCompare(q.orderNumber))
      .map((o) => {
        const st = allStops.filter((x) => x.orderId === o.id);
        const first = st.find((x) => x.type === "pickup") ?? st[0];
        const last = [...st].reverse().find((x) => x.type === "delivery") ?? st[st.length - 1];
        return { orderNumber: o.orderNumber, refs: Object.values(o.refs).filter(Boolean).join(" / "), from: place(first), to: place(last), pickedUp: localDay(first?.departedAt, first), delivered: localDay(last?.arrivedAt ?? o.deliveredAt, last), amountCents: lines.filter((l) => l.orderId === o.id).reduce((a, l) => a + l.amountCents, 0) };
      });
  }
  // factored: the factor's remit-to and the notice of assignment go on the invoice — never our address under the factor's name
  const { deliveryForInvoice } = await import("./invoicing");
  const factored = entity.factorName ? (await deliveryForInvoice(ctx, inv.customerId, entity.id)).method === "factor" : false;
  if (factored && !hasAddress(entity.factorRemitTo as Record<string, string | undefined> | null)) throw new ValidationError(`${customer.name}'s invoices go to ${entity.factorName}, but ${entity.legalName} has no remit-to address for the factor. Add the factor's payment address under Settings → Billing entities → Factor's remit-to, then issue.`, "factorRemitTo");
  const remitTo = (entity.remitTo as Record<string, string | undefined>) ?? null;
  // what this invoice points back to: the invoice a supplemental adds to, the voided one a rebill replaces
  const refIds = [inv.supplementOf, inv.rebillOf].filter((x): x is string => !!x);
  const refInvs = refIds.length ? await db.select({ id: s.invoices.id, number: s.invoices.number }).from(s.invoices).where(inArray(s.invoices.id, refIds)) : [];
  const snapshot: InvoiceSnapshot = {
    entity: { legalName: entity.legalName, dba: entity.dba, taxId: entity.taxId, remitTo, mc: entity.mcNumber, dot: entity.dotNumber },
    billTo: { name: customer.name, email: customer.billingEmail, kind: customer.kind, address: customer.billingAddress ?? null },
    loadNumbers: orders.map((o) => o.orderNumber).sort(),
    refs,
    stops: stops.map((st) => ({ seq: st.seq, type: st.type, name: st.name, city: st.address?.city ?? null, state: st.address?.state ?? null, country: st.country, departedAt: st.departedAt?.toISOString() ?? null, arrivedAt: st.arrivedAt?.toISOString() ?? null, departedDate: localDay(st.departedAt, st), arrivedDate: localDay(st.arrivedAt, st) })),
    lines: lines.map<InvoiceLine>((l) => ({ chargeId: l.id, orderId: l.orderId, orderNumber: orders.find((o) => o.id === l.orderId)?.orderNumber ?? "", kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents })),
    terms: `Net ${inv.termsDays}`,
    currency: inv.currency,
    exchangeRate: rateE4 ? rateE4 / 10000 : null,
    ...(loads ? { loads } : {}),
    factor: factored ? { name: entity.factorName!, remitTo: (entity.factorRemitTo as Record<string, string | undefined>) ?? null, notice: entity.factorNotice?.trim() || `This invoice has been assigned to and must be paid only to ${entity.factorName}. Payment to anyone else does not discharge the debt.` } : null,
    supplementOf: inv.supplementOf ? (refInvs.find((r) => r.id === inv.supplementOf)?.number ?? null) : null,
    replaces: inv.rebillOf ? (refInvs.find((r) => r.id === inv.rebillOf)?.number ?? null) : null,
    timeZone: tz,
  };
  const subtotal = lines.reduce((a, l) => a + l.amountCents, 0);
  const dueAt = new Date(issuedAt.getTime() + inv.termsDays * 86400_000);
  const issued = await db.transaction(async (tx) => {
    // number from the entity's sequence, serialized on the entity row, never reused
    const [ent] = await tx.execute(sql`select next_invoice_number as n, invoice_prefix as p from billing_entities where id = ${entity.id} for update`) as unknown as { n: number; p: string }[];
    const number = `${ent.p}-${String(ent.n).padStart(6, "0")}`;
    await tx.update(s.billingEntities).set({ nextInvoiceNumber: ent.n + 1 }).where(eq(s.billingEntities.id, entity.id));
    const pdf = await buildInvoicePdf({ number, issuedAt, dueAt, snapshot, subtotalCents: subtotal, totalCents: subtotal });
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: createHash("sha256").update(pdf).digest("hex"), mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
    const [after] = await tx.update(s.invoices).set({ state: "issued", number, issuedAt, dueAt, subtotalCents: subtotal, totalCents: subtotal, snapshot, factored, exchangeRate: rateE4, pdfStorageKey: `blob:${blob.id}`, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, inv.id)).returning();
    for (const oid of inv.orderIds) {
      const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, oid)).limit(1);
      // a supplemental invoice leaves an invoiced or paid load where it is
      if (o && (o.state === "delivered" || o.state === "ready_to_bill")) {
        assertOrderTransition(o.state === "delivered" ? "ready_to_bill" : o.state, "invoiced");
        await tx.update(s.orders).set({ state: "invoiced", previousState: o.state, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, oid));
      }
    }
    await writeAudit(tx, ctx, "invoice", inv.id, "transition", { state: { from: "draft", to: "issued" }, number: { from: null, to: number } }, rateE4 ? `at ${(rateE4 / 10000).toFixed(4)} ${inv.currency} per USD` : undefined);
    return after;
  });
  // the rate on the newest invoice is the company's latest rate for loads not invoiced yet
  if (rateE4) await setFxRate(ctx, inv.currency, rateE4, { silent: true });
  // EDI 210 for partners that take invoices electronically (after the commit; a failure here never un-issues)
  try {
    const { emit210 } = await import("./edi");
    await emit210(ctx, invoiceId);
  } catch (e) {
    console.error(`[edi] 210 for ${invoiceId} failed: ${String(e)}`);
  }
  return issued;
}

/** Re-draw an issued invoice's PDF from its locked snapshot (after a credit memo, or a corrected remit-to). */
async function redrawInvoicePdf(ctx: Ctx, inv: typeof s.invoices.$inferSelect, snapshot: InvoiceSnapshot, creditedCents: number) {
  if (!inv.number || !inv.issuedAt || !inv.dueAt) return inv.pdfStorageKey;
  const pdf = await buildInvoicePdf({ number: inv.number, issuedAt: inv.issuedAt, dueAt: inv.dueAt, snapshot, subtotalCents: inv.subtotalCents, totalCents: inv.totalCents, creditedCents });
  const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: createHash("sha256").update(pdf).digest("hex"), mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
  return `blob:${blob.id}`;
}

/**
 * After a chargeback the customer owes us again, but the invoice they hold says "pay the factor". This
 * re-draws it with our own remit-to (the notice of assignment dropped, the snapshot remembers it was
 * there) and emails it to the customer's billing address.
 */
export async function sendCorrectedInvoice(ctx: Ctx, invoiceId: string, to?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const { invoice: inv } = await invoiceById(ctx, invoiceId);
  if (!inv.snapshot?.factor) throw new ValidationError("this invoice already tells the customer to pay you");
  if (inv.factored || inv.factorFundedAt) throw new ValidationError("the factor still owns this invoice: record the chargeback first (Billing → Factoring)");
  if (!["issued", "sent", "partially_paid", "disputed"].includes(inv.state)) throw new ValidationError(`the invoice is ${inv.state}`);
  const snapshot: InvoiceSnapshot = { ...inv.snapshot, factor: null, correctedFromFactor: inv.snapshot.factor.name };
  const key = await redrawInvoicePdf(ctx, inv, snapshot, inv.creditedCents);
  await db.update(s.invoices).set({ snapshot, pdfStorageKey: key, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId));
  await writeAudit(db, ctx, "invoice", invoiceId, "update", { remitTo: { from: inv.snapshot.factor.name, to: inv.snapshot.entity.legalName } }, "corrected invoice after the chargeback: remit to us");
  const { deliverInvoice } = await import("./invoicing");
  return deliverInvoice(ctx, invoiceId, { method: "email", to: to ?? null, reference: "corrected: remit to us" });
}

/** Email the invoice with its documents (the customer's billing email, or `to`). Other routes: invoicing.deliverInvoice. */
export async function sendInvoice(ctx: Ctx, invoiceId: string, to?: string | null) {
  const { deliverInvoice } = await import("./invoicing");
  return deliverInvoice(ctx, invoiceId, { method: "email", to: to ?? null });
}

export async function invoiceByToken(token: string) {
  if (!token || token.length < 16) return null;
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.token, token)).limit(1);
  if (!inv || !inv.pdfStorageKey) return null;
  const id = inv.pdfStorageKey.replace(/^blob:/, "");
  const [b] = await db.select().from(s.documentBlobs).where(eq(s.documentBlobs.id, id)).limit(1);
  return b ? { invoice: inv, blob: b } : null;
}

export async function recordReceipt(ctx: Ctx, invoiceId: string, r: { amountCents: number; receivedAt?: Date; method?: string; reference?: string | null; note?: string | null; paymentId?: string | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!Number.isFinite(r.amountCents) || r.amountCents <= 0) throw new ValidationError("amount must be positive", "amountCents");
  const { invoice: inv } = await invoiceById(ctx, invoiceId);
  if (!["issued", "sent", "partially_paid", "disputed"].includes(inv.state)) throw new TransitionError("order", inv.state, "paid", "no receipts on a draft, void or paid invoice");
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  if (r.amountCents > open) throw new ValidationError(`over-payment: ${(r.amountCents / 100).toFixed(2)} is more than the ${(open / 100).toFixed(2)} open. Record the remainder as unapplied credit on another invoice.`, "amountCents");
  await assertOpenPeriod(ctx, r.receivedAt ?? new Date());
  return db.transaction(async (tx) => {
    await tx.insert(s.receipts).values({ id: newId(), tenantId: ctx.tenantId, invoiceId, amountCents: r.amountCents, receivedAt: r.receivedAt ?? new Date(), method: r.method ?? "ach", reference: r.reference ?? null, note: r.note ?? null, paymentId: r.paymentId ?? null, createdBy: ctx.userId });
    const paid = inv.paidCents + r.amountCents;
    const full = paid >= inv.totalCents - inv.creditedCents;
    const [after] = await tx.update(s.invoices).set({ paidCents: paid, state: full ? "paid" : "partially_paid", paidAt: full ? (r.receivedAt ?? new Date()) : null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId)).returning();
    if (full) for (const oid of inv.orderIds) await tx.update(s.orders).set({ state: "paid", previousState: "invoiced", updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.orders.id, oid), eq(s.orders.state, "invoiced")));
    await writeAudit(tx, ctx, "invoice", invoiceId, "update", { paidCents: { from: inv.paidCents, to: paid } }, `${r.method ?? "ach"} ${r.reference ?? ""}`.trim());
    return after;
  });
}

export async function voidInvoice(ctx: Ctx, invoiceId: string, reason: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.void");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const { invoice: inv, receipts: rcpts } = await invoiceById(ctx, invoiceId);
  if (rcpts.length) throw new ValidationError("this invoice has receipts: issue a credit memo instead");
  if (!["issued", "sent", "draft", "disputed"].includes(inv.state)) throw new TransitionError("order", inv.state, "void", "only issued or sent invoices void");
  if (inv.issuedAt) await assertOpenPeriod(ctx, inv.issuedAt);
  return db.transaction(async (tx) => {
    await tx.update(s.charges).set({ invoiceId: null }).where(eq(s.charges.invoiceId, invoiceId));
    const [after] = await tx.update(s.invoices).set({ state: "void", voidedAt: new Date(), voidReason: reason.trim(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId)).returning();
    // voiding a supplemental leaves its loads invoiced: only its late charges come back to the queue
    if (inv.kind !== "supplemental") for (const oid of inv.orderIds) await tx.update(s.orders).set({ state: "ready_to_bill", previousState: "invoiced", updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.orders.id, oid), inArray(s.orders.state, ["invoiced", "ready_to_bill"])));
    await writeAudit(tx, ctx, "invoice", invoiceId, "transition", { state: { from: inv.state, to: "void" } }, reason.trim());
    return after;
  });
}

/**
 * A credit memo: reduces what the customer owes on an invoice. It has its own number (PREFIX-CM-000001, a
 * sequence apart from invoices, so invoice numbers have no gaps), its own PDF, and it can be emailed like
 * an invoice. The invoice's PDF is re-drawn with the credit so "Send again" shows what is really due.
 */
export async function creditMemo(ctx: Ctx, invoiceId: string, m: { amountCents: number; reason: string; lines?: { description: string; amountCents: number }[] }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.void");
  if (!m.reason?.trim()) throw new ValidationError("a reason is required", "reason");
  if (!Number.isFinite(m.amountCents) || m.amountCents <= 0) throw new ValidationError("amount must be positive", "amountCents");
  const { invoice: inv, entity, customer } = await invoiceById(ctx, invoiceId);
  if (inv.state === "draft" || inv.state === "void") throw new TransitionError("order", inv.state, "credit", "issue the invoice first");
  // a credit can only reduce what is still owed: money already received is refunded, not credited
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  if (m.amountCents > open) throw new ValidationError(`the credit can't be more than the ${money(open, inv.currency)} still open`, "amountCents");
  const issuedAt = new Date();
  await assertOpenPeriod(ctx, issuedAt);
  const lines = m.lines ?? [{ description: m.reason.trim(), amountCents: m.amountCents }];
  const memo = await db.transaction(async (tx) => {
    const [ent] = await tx.execute(sql`select next_credit_number as n, invoice_prefix as p from billing_entities where id = ${entity!.id} for update`) as unknown as { n: number; p: string }[];
    const number = `${ent.p}-CM-${String(ent.n).padStart(6, "0")}`;
    await tx.update(s.billingEntities).set({ nextCreditNumber: ent.n + 1 }).where(eq(s.billingEntities.id, entity!.id));
    const snap = inv.snapshot;
    const pdf = await buildCreditMemoPdf({ number, issuedAt, invoiceNumber: inv.number ?? "", reason: m.reason.trim(), lines, amountCents: m.amountCents, currency: inv.currency, entity: snap?.entity ?? { legalName: entity!.legalName, dba: entity!.dba, taxId: entity!.taxId, remitTo: (entity!.remitTo as Record<string, string | undefined>) ?? null, mc: entity!.mcNumber, dot: entity!.dotNumber }, billTo: snap?.billTo ?? { name: customer?.name ?? "", email: customer?.billingEmail ?? null, kind: customer?.kind ?? "customer", address: customer?.billingAddress ?? null }, invoiceTotalCents: inv.totalCents, openAfterCents: open - m.amountCents, timeZone: snap?.timeZone });
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: createHash("sha256").update(pdf).digest("hex"), mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
    const [memo] = await tx.insert(s.creditMemos).values({ id: newId(), tenantId: ctx.tenantId, invoiceId, number, amountCents: m.amountCents, reason: m.reason.trim(), lines, issuedAt, pdfStorageKey: `blob:${blob.id}`, createdBy: ctx.userId }).returning();
    const credited = inv.creditedCents + m.amountCents;
    const full = inv.paidCents >= inv.totalCents - credited;
    await tx.update(s.invoices).set({ creditedCents: credited, state: full ? "paid" : inv.state, paidAt: full && !inv.paidAt ? new Date() : inv.paidAt, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId));
    if (full) for (const oid of inv.orderIds) await tx.update(s.orders).set({ state: "paid", previousState: "invoiced", updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.orders.id, oid), eq(s.orders.state, "invoiced")));
    await writeAudit(tx, ctx, "invoice", invoiceId, "update", { creditedCents: { from: inv.creditedCents, to: credited } }, `${number}: ${m.reason.trim()}`);
    return memo;
  });
  // the invoice PDF now shows the credit, so a re-send says what is really due
  if (inv.snapshot) {
    const key = await redrawInvoicePdf(ctx, inv, inv.snapshot, inv.creditedCents + m.amountCents);
    if (key) await db.update(s.invoices).set({ pdfStorageKey: key }).where(eq(s.invoices.id, invoiceId));
  }
  return memo;
}

/** Credit memos, newest first, with their invoice and customer (the invoice list shows them as their own kind). */
export async function listCreditMemos(ctx: Ctx, opts: { customerId?: string; q?: string } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const rows = await db
    .select({ memo: s.creditMemos, invoiceNumber: s.invoices.number, customerId: s.invoices.customerId, currency: s.invoices.currency, customer: s.customers.name })
    .from(s.creditMemos)
    .innerJoin(s.invoices, eq(s.invoices.id, s.creditMemos.invoiceId))
    .innerJoin(s.customers, eq(s.customers.id, s.invoices.customerId))
    .where(and(eq(s.creditMemos.tenantId, ctx.tenantId), ...(opts.customerId ? [eq(s.invoices.customerId, opts.customerId)] : [])))
    .orderBy(desc(s.creditMemos.issuedAt))
    .limit(500);
  const q = opts.q?.trim().toLowerCase();
  return q ? rows.filter((r) => `${r.memo.number} ${r.invoiceNumber ?? ""} ${r.customer} ${r.memo.reason}`.toLowerCase().includes(q)) : rows;
}

/** The credit memo PDF (drawn when it was issued; an older memo without one is drawn now). */
export async function creditMemoPdf(ctx: Ctx, memoId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const [memo] = await db.select().from(s.creditMemos).where(and(eq(s.creditMemos.tenantId, ctx.tenantId), eq(s.creditMemos.id, memoId))).limit(1);
  if (!memo) throw new NotFoundError("credit memo", memoId);
  const { readBlob } = await import("./crossing");
  if (memo.pdfStorageKey) return { memo, bytes: new Uint8Array((await readBlob(ctx, memo.pdfStorageKey)).bytes) };
  const { invoice: inv, entity, customer } = await invoiceById(ctx, memo.invoiceId);
  const bytes = await buildCreditMemoPdf({ number: memo.number, issuedAt: memo.issuedAt, invoiceNumber: inv.number ?? "", reason: memo.reason, lines: memo.lines, amountCents: memo.amountCents, currency: inv.currency, entity: inv.snapshot?.entity ?? { legalName: entity?.legalName ?? "", dba: entity?.dba ?? null, taxId: entity?.taxId ?? null, remitTo: null, mc: null, dot: null }, billTo: inv.snapshot?.billTo ?? { name: customer?.name ?? "", email: customer?.billingEmail ?? null, kind: "customer" }, invoiceTotalCents: inv.totalCents, openAfterCents: null, timeZone: inv.snapshot?.timeZone });
  return { memo, bytes };
}

/** Email the credit memo PDF to the customer's billing email (or `to`), like an invoice. */
export async function sendCreditMemo(ctx: Ctx, memoId: string, to?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const { memo, bytes } = await creditMemoPdf(ctx, memoId);
  const { invoice: inv, customer, entity } = await invoiceById(ctx, memo.invoiceId);
  const dest = to?.trim() || customer?.billingEmail || null;
  if (!dest) throw new ValidationError(`${customer?.name ?? "the customer"} has no billing email: type the address to send it to`, "to");
  let key = memo.pdfStorageKey;
  if (!key) {
    const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/pdf", sizeBytes: bytes.length, bytes: Buffer.from(bytes) }).returning({ id: s.documentBlobs.id });
    key = `blob:${blob.id}`;
  }
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const body = [`${customer?.name},`, ``, `Attached is credit memo ${memo.number} from ${entity?.legalName} for ${money(memo.amountCents, inv.currency, { code: true })}, applied to invoice ${inv.number}.`, `Reason: ${memo.reason}`, ``, open > 0 ? `Invoice ${inv.number} now has ${money(open, inv.currency, { code: true })} open.` : `Invoice ${inv.number} is now settled.`, ``, `Reference: ${memo.number}`].join("\n");
  await enqueue(ctx, { channel: "email", to: dest, subject: `Credit memo ${memo.number} · invoice ${inv.number} · ${entity?.dba || entity?.legalName}`, body, subjectKind: "credit_memo", subjectId: memo.id, meta: { kind: "invoice", attachments: [{ fileName: `Credit memo ${memo.number}.pdf`, storageKey: key }] } });
  const { deliverQueued } = await import("@/lib/outbox");
  await deliverQueued().catch(() => null);
  await db.update(s.creditMemos).set({ sentAt: new Date(), sentTo: dest, pdfStorageKey: key }).where(eq(s.creditMemos.id, memo.id));
  await writeAudit(db, ctx, "invoice", inv.id, "update", undefined, `credit memo ${memo.number} emailed to ${dest}`);
  return { sentTo: dest };
}

export const DISPUTE_OUTCOMES = { customer_pays: "Resolved in our favor — the customer will pay", credited: "Resolved with a credit memo", paid: "The customer paid", other: "Other (see note)" } as const;
export type DisputeOutcome = keyof typeof DISPUTE_OUTCOMES;

/**
 * Resolve a dispute: the outcome and a note are kept on the invoice and in its history, and it goes back
 * to where the money says it is — paid when nothing is open, partly paid when some was received, else sent
 * (or issued if it was never sent). Reminders pick it up again.
 */
export async function resolveDispute(ctx: Ctx, invoiceId: string, r: { outcome: DisputeOutcome; note: string }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!(r.outcome in DISPUTE_OUTCOMES)) throw new ValidationError("pick how it was resolved", "outcome");
  if (!r.note?.trim()) throw new ValidationError("add a note: what was agreed, with whom", "note");
  const { invoice: inv, creditMemos } = await invoiceById(ctx, invoiceId);
  if (inv.state !== "disputed") throw new TransitionError("order", inv.state, "resolved", "only a disputed invoice can be resolved");
  if (r.outcome === "credited" && !creditMemos.length) throw new ValidationError("issue the credit memo first (owner), then resolve the dispute", "outcome");
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const to = open <= 0 ? "paid" : inv.paidCents > 0 ? "partially_paid" : inv.sentAt ? "sent" : "issued";
  const resolution = `${DISPUTE_OUTCOMES[r.outcome]}: ${r.note.trim()}`;
  const [after] = await db.update(s.invoices).set({ state: to, disputeResolution: resolution, disputeExpectedAt: null, paidAt: to === "paid" && !inv.paidAt ? new Date() : inv.paidAt, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId)).returning();
  if (to === "paid") for (const oid of inv.orderIds) await db.update(s.orders).set({ state: "paid", previousState: "invoiced", updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.orders.id, oid), eq(s.orders.state, "invoiced")));
  await writeAudit(db, ctx, "invoice", invoiceId, "transition", { state: { from: "disputed", to } }, `dispute resolved — ${resolution}`);
  return after;
}

export async function disputeInvoice(ctx: Ctx, invoiceId: string, reason: string, expectedAt?: Date | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!reason?.trim()) throw new ValidationError("a reason is required", "reason");
  const { invoice: inv } = await invoiceById(ctx, invoiceId);
  if (!["sent", "issued", "partially_paid"].includes(inv.state)) throw new TransitionError("order", inv.state, "disputed");
  const [after] = await db.update(s.invoices).set({ state: "disputed", disputeReason: reason.trim(), disputeExpectedAt: expectedAt ?? null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, invoiceId)).returning();
  await writeAudit(db, ctx, "invoice", invoiceId, "transition", { state: { from: inv.state, to: "disputed" } }, reason.trim());
  return after;
}

export async function setPromiseToPay(ctx: Ctx, invoiceId: string, at: Date | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  await db.update(s.invoices).set({ promiseToPayAt: at, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.id, invoiceId)));
}

export type InvoiceFilter = { states?: string[]; customerId?: string; q?: string; view?: "open" | "overdue" | "unsent" | "factored" | "credits" | ""; from?: string; to?: string; kind?: string };

/** Invoices with the filters billing actually uses: who, what state, overdue, not sent yet, factored, dates, and a search over invoice #, load #, any load reference and the customer. */
export async function listInvoices(ctx: Ctx, opts: InvoiceFilter = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const conds = [eq(s.invoices.tenantId, ctx.tenantId)];
  if (opts.states?.length) conds.push(inArray(s.invoices.state, opts.states as never));
  if (opts.customerId) conds.push(eq(s.invoices.customerId, opts.customerId));
  if (opts.kind) conds.push(eq(s.invoices.kind, opts.kind as never));
  const open = ["issued", "sent", "partially_paid", "disputed"];
  if (opts.view === "open") conds.push(inArray(s.invoices.state, open as never));
  if (opts.view === "overdue") conds.push(inArray(s.invoices.state, open as never), lt(s.invoices.dueAt, new Date()));
  if (opts.view === "unsent") conds.push(eq(s.invoices.state, "issued"));
  if (opts.view === "factored") conds.push(eq(s.invoices.factored, true));
  if (opts.from) conds.push(gte(s.invoices.issuedAt, new Date(`${opts.from}T00:00:00Z`)));
  if (opts.to) conds.push(lt(s.invoices.issuedAt, new Date(new Date(`${opts.to}T00:00:00Z`).getTime() + 86400_000)));
  let rows = await db.select().from(s.invoices).where(and(...conds)).orderBy(desc(s.invoices.createdAt)).limit(2000);
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    const ids = [...new Set(rows.flatMap((r) => r.orderIds))];
    const [orders, customers] = await Promise.all([ids.length ? db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber, refs: s.orders.refs }).from(s.orders).where(inArray(s.orders.id, ids)) : [], db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId))]);
    const hay = new Map(rows.map((r) => [r.id, [r.number ?? "", customers.find((c) => c.id === r.customerId)?.name ?? "", ...orders.filter((o) => r.orderIds.includes(o.id)).flatMap((o) => [o.orderNumber, ...Object.values(o.refs ?? {}).map((v) => String(v ?? ""))])].join(" ").toLowerCase()]));
    rows = rows.filter((r) => hay.get(r.id)!.includes(q));
  }
  return rows;
}

export function invoicesCsv(rows: (typeof s.invoices.$inferSelect)[], customerName: (id: string) => string) {
  const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : "");
  const c = (n: number) => (n / 100).toFixed(2);
  const lines = [["Number", "Kind", "Customer", "State", "Issued", "Due", "Currency", "Total", "Paid", "Credited", "Open", "Factored", "Loads"]];
  for (const r of rows) lines.push([r.number ?? "draft", r.kind, customerName(r.customerId), r.state, d(r.issuedAt), d(r.dueAt), r.currency, c(r.totalCents), c(r.paidCents), c(r.creditedCents), ["paid", "void", "closed", "draft"].includes(r.state) ? "0.00" : c(r.totalCents - r.creditedCents - r.paidCents), r.factored ? "yes" : "", String(r.orderIds.length)]);
  return lines.map((l) => l.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
}

// ---------- AR (7.5) ----------

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";
export function bucketFor(dueAt: Date | null, now: Date): AgingBucket {
  if (!dueAt) return "current";
  const d = Math.floor((now.getTime() - dueAt.getTime()) / 86400_000);
  return d <= 0 ? "current" : d <= 30 ? "1_30" : d <= 60 ? "31_60" : d <= 90 ? "61_90" : "90_plus";
}

type Buckets = Record<AgingBucket, number> & { total: number };
const zeroBuckets = (): Buckets => ({ current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, total: 0 });

/** The open states: issued, sent, partly paid, disputed. */
export const OPEN_INVOICE_STATES = ["issued", "sent", "partially_paid", "disputed"] as const;

/**
 * Receivables, one definition for the Receivables screen and Reports: invoices issued, sent, partly paid or
 * disputed with money still open, less the ones the factor funded (the customer owes the factor, shown on
 * Factoring). Amounts stay in their own currency — one row per customer per currency, totals per currency —
 * and a USD figure converts each invoice at the rate stored on it when it was issued.
 */
export async function aging(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  return receivables(ctx, now);
}

/** The receivables themselves (no permission check: Reports shows the same total to whoever sees Reports). */
export async function receivables(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  const open = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.state, [...OPEN_INVOICE_STATES])));
  const customers = await db.select({ id: s.customers.id, name: s.customers.name, payWhenPaid: s.customers.payWhenPaid }).from(s.customers).where(eq(s.customers.tenantId, ctx.tenantId));
  const company = await getCompany(ctx);
  const rows = new Map<string, { customerId: string; name: string; currency: string; buckets: Record<AgingBucket, number>; total: number; invoices: (typeof open)[number][] }>();
  const totals: Record<string, Buckets> = {};
  const withFactor: Record<string, number> = {};
  const home = { openCents: 0, overdueCents: 0, rates: [] as { currency: string; rateE4: number; source: ReturnType<typeof pickRate>["source"] }[] };
  for (const inv of open) {
    const openCents = inv.totalCents - inv.creditedCents - inv.paidCents;
    if (openCents <= 0) continue;
    // funded by the factor: the customer owes the factor now (Billing → Factoring), not us
    if (inv.factorFundedAt) {
      withFactor[inv.currency] = (withFactor[inv.currency] ?? 0) + openCents;
      continue;
    }
    const key = `${inv.customerId}|${inv.currency}`;
    const r = rows.get(key) ?? { customerId: inv.customerId, name: customers.find((c) => c.id === inv.customerId)?.name ?? "?", currency: inv.currency, buckets: { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 }, total: 0, invoices: [] };
    const bucket = bucketFor(inv.dueAt, now);
    r.buckets[bucket] += openCents;
    r.total += openCents;
    r.invoices.push(inv);
    rows.set(key, r);
    const tot = (totals[inv.currency] ??= zeroBuckets());
    tot[bucket] += openCents;
    tot.total += openCents;
    const rate = pickRate(inv.currency, inv.exchangeRate, company.settings.fx);
    const usd = toHome(openCents, inv.currency, rate.rateE4);
    home.openCents += usd;
    if (bucket !== "current") home.overdueCents += usd;
    if (inv.currency !== HOME_CURRENCY) home.rates.push({ currency: inv.currency, ...rate });
  }
  // dollars first, then pesos, then Canadian; biggest customer first within each
  const order = ["USD", "MXN", "CAD"];
  const list = [...rows.values()].sort((p, q) => order.indexOf(p.currency) - order.indexOf(q.currency) || q.total - p.total);
  return { rows: list, totals, withFactor, home };
}

export async function statementPdf(ctx: Ctx, customerId: string, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const { rows } = await aging(ctx, now);
  const mine = rows.filter((x) => x.customerId === customerId);
  const invs = mine.flatMap((r) => r.invoices);
  // the entity on the customer's invoices (the default one when they have none open)
  const entityId = invs[0]?.entityId;
  const [entity] = entityId ? await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, entityId)).limit(1) : await db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), eq(s.billingEntities.isDefault, true))).limit(1);
  const [cust] = await db.select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1);
  const company = await getCompany(ctx);
  const pdf = await buildStatementPdf({ entityName: entity?.legalName ?? "", remitTo: (entity?.remitTo as Record<string, string | undefined> | null) ?? null, customerName: cust?.name ?? "", asOf: now, timeZone: company.timeZone, rows: invs.map((i) => ({ number: i.number ?? "", currency: i.currency, issuedAt: i.issuedAt ?? null, dueAt: i.dueAt ?? null, totalCents: i.totalCents, openCents: i.totalCents - i.creditedCents - i.paidCents, daysPastDue: i.dueAt ? Math.floor((now.getTime() - i.dueAt.getTime()) / 86400_000) : 0, disputed: i.state === "disputed" })) });
  return { pdf, fileName: `Statement ${(cust?.name ?? "customer").replace(/[^\w .-]+/g, "")} ${zonedDate(now, company.timeZone)}.pdf` };
}

/** Job: reminder emails at the customer's configured days after due (default +3, +10, +20), once per step. */
export async function sendReminders(now = new Date()) {
  // funded factored invoices are the factor's to collect: no reminders from us
  const open = await db.select().from(s.invoices).where(and(inArray(s.invoices.state, ["sent", "partially_paid"]), lt(s.invoices.dueAt, now), isNull(s.invoices.factorFundedAt)));
  let sent = 0;
  for (const inv of open) {
    const [cust] = await db.select().from(s.customers).where(eq(s.customers.id, inv.customerId)).limit(1);
    if (!cust?.billingEmail) continue;
    const steps = (cust.reminderDays ?? [3, 10, 20]).slice().sort((a, b) => a - b); // [] = the customer opted out
    const days = Math.floor((now.getTime() - inv.dueAt!.getTime()) / 86400_000);
    const due = steps.filter((d) => days >= d);
    if (!due.length) continue;
    const step = due[due.length - 1];
    const already = await db.select({ id: s.outbox.id }).from(s.outbox).where(and(eq(s.outbox.subjectKind, "invoice_reminder"), eq(s.outbox.subjectId, `${inv.id}:${step}`))).limit(1);
    if (already.length) continue;
    const ctx = { tenantId: inv.tenantId, userId: null, role: "system" as const };
    const openCents = inv.totalCents - inv.creditedCents - inv.paidCents;
    await enqueue(ctx, { channel: "email", to: cust.billingEmail, subject: `Reminder: invoice ${inv.number} is ${days} days past due`, body: `${cust.name},\n\nInvoice ${inv.number} for ${(openCents / 100).toLocaleString("en-US", { style: "currency", currency: inv.currency })} was due ${inv.dueAt!.toISOString().slice(0, 10)}.\n\nPDF: ${publicUrl(`/i/${inv.token}`)}\n\nIf payment is on its way, thank you — reply with the date and we will note it.`, subjectKind: "invoice_reminder", subjectId: `${inv.id}:${step}` });
    sent++;
  }
  return { sent };
}

// ---------- carrier bills (7.6) ----------

/** Every completed carrier leg gets an expected bill at the accepted tender rate. Idempotent. */
export async function syncCarrierBills(ctx: Ctx) {
  assertCtx(ctx);
  const legs = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.assigneeKind, "carrier"), eq(s.legs.state, "completed")));
  const existing = await db.select({ legId: s.carrierBills.legId }).from(s.carrierBills).where(eq(s.carrierBills.tenantId, ctx.tenantId));
  const have = new Set(existing.map((e) => e.legId));
  let created = 0;
  for (const l of legs) {
    if (have.has(l.id) || !l.carrierId) continue;
    const [tender] = await db.select().from(s.tenders).where(and(eq(s.tenders.legId, l.id), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1);
    const [carrier] = await db.select({ quickPayPct: s.carriers.quickPayPct }).from(s.carriers).where(eq(s.carriers.id, l.carrierId)).limit(1);
    const qp = carrier?.quickPayPct;
    await db.insert(s.carrierBills).values({ id: newId(), tenantId: ctx.tenantId, carrierId: l.carrierId, orderId: l.orderId, legId: l.id, tenderId: tender?.id ?? null, expectedCents: tender?.rateCents ?? l.carrierRateCents ?? 0, currency: tender?.currency ?? l.carrierRateCurrency ?? "USD", quickPayPct: qp ? Math.round(qp * 100) : null, createdBy: ctx.userId, updatedBy: ctx.userId });
    created++;
  }
  return { created };
}

export async function carrierBillsList(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  await syncCarrierBills(ctx);
  return db
    .select({ bill: s.carrierBills, carrierName: s.carriers.name, orderNumber: s.orders.orderNumber, legSeq: s.legs.seq, legType: s.legs.type })
    .from(s.carrierBills)
    .innerJoin(s.carriers, eq(s.carriers.id, s.carrierBills.carrierId))
    .innerJoin(s.orders, eq(s.orders.id, s.carrierBills.orderId))
    .innerJoin(s.legs, eq(s.legs.id, s.carrierBills.legId))
    .where(eq(s.carrierBills.tenantId, ctx.tenantId))
    .orderBy(desc(s.carrierBills.createdAt))
    .limit(1000);
}

async function loadBill(ctx: Ctx, id: string) {
  const [b] = await db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ctx.tenantId), eq(s.carrierBills.id, id))).limit(1);
  if (!b) throw new NotFoundError("carrier bill", id);
  return b;
}

export async function receiveCarrierBill(ctx: Ctx, id: string, r: { invoicedCents: number; carrierInvoiceNumber?: string | null; docId?: string | null; accessorialCents?: number }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const b = await loadBill(ctx, id);
  if (!["expected", "received", "disputed"].includes(b.state)) throw new TransitionError("order", b.state, "received");
  if (!Number.isFinite(r.invoicedCents) || r.invoicedCents < 0) throw new ValidationError("amount", "invoicedCents");
  const [after] = await db.update(s.carrierBills).set({ state: "received", invoicedCents: r.invoicedCents, carrierInvoiceNumber: r.carrierInvoiceNumber ?? null, carrierInvoiceDocId: r.docId ?? null, accessorialCents: r.accessorialCents ?? b.accessorialCents, receivedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carrierBills.id, id)).returning();
  await writeAudit(db, ctx, "carrier_bill", id, "update", { invoicedCents: { from: b.invoicedCents, to: r.invoicedCents } });
  return after;
}

/** Three-way check: tender rate (+accessorials) = carrier invoice, and a POD is on the order. */
export function threeWayOf(b: Pick<typeof s.carrierBills.$inferSelect, "expectedCents" | "accessorialCents" | "invoicedCents">, podPresent: boolean) {
  const expected = b.expectedCents + b.accessorialCents;
  return { expected, invoiced: b.invoicedCents, podPresent, rateMatch: b.invoicedCents != null && b.invoicedCents === expected, difference: b.invoicedCents != null ? b.invoicedCents - expected : null };
}

export async function threeWay(ctx: Ctx, id: string) {
  const b = await loadBill(ctx, id);
  const [pod] = await db.select({ id: s.documents.id }).from(s.documents).where(and(eq(s.documents.subjectKind, "order"), eq(s.documents.subjectId, b.orderId), eq(s.documents.code, "POD"), inArray(s.documents.status, ["present", "verified"]))).limit(1);
  return threeWayOf(b, !!pod);
}

/** The three-way check for a whole list in two queries instead of two per bill. */
export async function threeWayMany(ctx: Ctx, bills: (typeof s.carrierBills.$inferSelect)[]) {
  assertCtx(ctx);
  const orderIds = [...new Set(bills.map((b) => b.orderId))];
  const pods = orderIds.length ? await db.select({ orderId: s.documents.subjectId }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, orderIds), eq(s.documents.code, "POD"), inArray(s.documents.status, ["present", "verified"]))) : [];
  const has = new Set(pods.map((p) => p.orderId));
  return bills.map((b) => threeWayOf(b, has.has(b.orderId)));
}

export async function approveCarrierBill(ctx: Ctx, id: string, a: { approvedCents?: number; note?: string | null; shortPayNote?: string | null; payDate?: Date | null; allowNoPod?: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const b = await loadBill(ctx, id);
  if (b.state !== "received" && b.state !== "disputed") throw new TransitionError("order", b.state, "approved", "record the carrier's invoice first");
  const chk = await threeWay(ctx, id);
  if (!chk.podPresent && !a.allowNoPod) throw new ValidationError("no POD on the order yet; upload it or approve explicitly without POD");
  const approved = a.approvedCents ?? b.invoicedCents ?? chk.expected;
  if (!chk.rateMatch && approved !== chk.expected && !a.note?.trim()) throw new ValidationError(`carrier billed ${(chk.invoiced! / 100).toFixed(2)} vs ${(chk.expected / 100).toFixed(2)} expected: approve the difference with a reason, or short-pay with a note`, "note");
  if (approved < (b.invoicedCents ?? 0) && !a.shortPayNote?.trim()) throw new ValidationError("a short-pay needs a note that goes to the carrier", "shortPayNote");
  const [after] = await db.update(s.carrierBills).set({ state: a.payDate ? "scheduled" : "approved", approvedCents: approved, approvalNote: a.note ?? null, shortPayNote: a.shortPayNote ?? null, approvedAt: new Date(), payDate: a.payDate ?? null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carrierBills.id, id)).returning();
  await writeAudit(db, ctx, "carrier_bill", id, "transition", { state: { from: b.state, to: after.state }, approvedCents: { from: null, to: approved } }, a.note ?? a.shortPayNote ?? undefined);
  return after;
}

export async function payCarrierBill(ctx: Ctx, id: string, p: { paidCents?: number; method: string; reference?: string | null; paidAt?: Date }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const b = await loadBill(ctx, id);
  if (!["approved", "scheduled"].includes(b.state)) throw new TransitionError("order", b.state, "paid", "approve the bill first");
  // pay-when-paid: hold until the customer paid (persona)
  const [inv] = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), sql`${b.orderId} = any(${s.invoices.orderIds})`, sql`${s.invoices.state} <> 'void'`)).limit(1);
  if (inv?.payWhenPaid && inv.state !== "paid") throw new ValidationError(`pay-when-paid: customer invoice ${inv.number} is not paid yet`);
  let amount = p.paidCents ?? b.approvedCents ?? 0;
  const paidAt = p.paidAt ?? new Date();
  await assertOpenPeriod(ctx, paidAt);
  if (b.quickPayPct && b.approvedAt && paidAt.getTime() - b.approvedAt.getTime() <= 7 * 86400_000 && p.paidCents == null) amount = Math.round(amount * (1 - b.quickPayPct / 10000));
  const [after] = await db.update(s.carrierBills).set({ state: "paid", paidCents: amount, paidAt, method: p.method, reference: p.reference ?? null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.carrierBills.id, id)).returning();
  await writeAudit(db, ctx, "carrier_bill", id, "transition", { state: { from: b.state, to: "paid" }, paidCents: { from: null, to: amount } }, `${p.method} ${p.reference ?? ""}`.trim());
  return after;
}

/** 1099 totals: paid to each carrier per calendar year (persona: 1099 by W-9). */
export async function carrier1099(ctx: Ctx, year: number) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const rows = await db
    .select({ carrierId: s.carrierBills.carrierId, name: s.carriers.name, country: s.carriers.country, currency: s.carrierBills.currency, total: sql<number>`sum(${s.carrierBills.paidCents})::int` })
    .from(s.carrierBills)
    .innerJoin(s.carriers, eq(s.carriers.id, s.carrierBills.carrierId))
    .where(and(eq(s.carrierBills.tenantId, ctx.tenantId), eq(s.carrierBills.state, "paid"), gte(s.carrierBills.paidAt, new Date(Date.UTC(year, 0, 1))), lte(s.carrierBills.paidAt, new Date(Date.UTC(year, 11, 31, 23, 59, 59)))))
    .groupBy(s.carrierBills.carrierId, s.carriers.name, s.carriers.country, s.carrierBills.currency);
  return rows;
}

// ---------- driver settlements (7.7) ----------

/** A statement's gross, deductions and net from its lines. */
function totalsOf(lines: SettlementLine[]) {
  const gross = lines.filter((l) => l.amountCents > 0).reduce((a, l) => a + l.amountCents, 0);
  const ded = -lines.filter((l) => l.amountCents < 0).reduce((a, l) => a + l.amountCents, 0);
  return { grossCents: gross, deductionsCents: ded, netCents: gross - ded };
}

/** A load line that pays $0 because the leg has no miles: it must be fixed before the statement is approved. */
const noMiles = (l: SettlementLine) => l.kind === "leg" && l.amountCents === 0 && (l.source === "missing miles" || l.source === "no miles on the leg");

/**
 * Build (or rebuild, while open) a driver's statement for a week. The rules, in plain words:
 * - it pays the legs the driver completed that week, plus any leg completed in an earlier week whose
 *   statement was already approved or paid (a late leg is never lost; it says it's late);
 * - reimbursements and per diem are pay; deductions come off in a fixed order — carried-over amounts,
 *   one-off deductions, recurring deductions, advance recovery, escrow last — and never take the net below
 *   $0. What doesn't fit carries to the next statement (an advance or limited deduction just stays owed);
 * - a week with no pay at all gets no statement: deductions wait for one with pay;
 * - a pay item already on another statement not yet paid is not taken twice.
 */
export async function buildSettlement(ctx: Ctx, driverId: string, periodStart: Date, periodEnd: Date) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [driver] = await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), eq(s.drivers.id, driverId))).limit(1);
  if (!driver) throw new NotFoundError("driver", driverId);
  const mine = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.driverId, driverId)));
  const existing = mine.find((x) => x.periodStart.getTime() === periodStart.getTime());
  if (existing && existing.state !== "open") throw new ValidationError(`the ${periodStart.toISOString().slice(0, 10)} settlement is ${existing.state}`);
  const others = mine.filter((x) => x.id !== existing?.id);
  const onStatement = new Set(others.flatMap((x) => x.lines.map((l) => l.legId).filter((v): v is string => !!v)));
  // weeks already approved or paid for this driver: a leg completed in one of them after the fact is "late"
  const closed = others.filter((x) => x.state === "approved" || x.state === "paid");
  const lateFrom = closed.length ? new Date(Math.min(...closed.map((x) => x.periodStart.getTime()))) : periodStart;
  const found = await db
    .select({ leg: s.legs, orderNumber: s.orders.orderNumber, rateCents: s.orders.rateCents, currency: s.orders.currency, orderId: s.orders.id })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.state, "completed"), sql`(${s.legs.driverId} = ${driverId} or ${s.legs.coDriverId} = ${driverId})`, gte(s.legs.completedAt, lateFrom < periodStart ? lateFrom : periodStart), lt(s.legs.completedAt, periodEnd)));
  const inClosedWeek = (d: Date) => closed.some((x) => d >= x.periodStart && d < x.periodEnd);
  const legs = found.filter((l) => !onStatement.has(l.leg.id) && (l.leg.completedAt! >= periodStart || inClosedWeek(l.leg.completedAt!)));
  const late = new Set(legs.filter((l) => l.leg.completedAt! < periodStart).map((l) => l.leg.id));
  const company = await getCompany(ctx);
  const lateNote = (legId: string | null | undefined) => (legId && late.has(legId) ? ` (late: completed ${zonedDate(legs.find((l) => l.leg.id === legId)!.leg.completedAt!, company.timeZone)}, after that week's statement)` : "");
  let lines: SettlementLine[] = [];
  const plan = driver.payPlanId ? (await db.select().from(s.payPlans).where(and(eq(s.payPlans.tenantId, ctx.tenantId), eq(s.payPlans.id, driver.payPlanId))).limit(1))[0] : null;
  if (plan && !plan.archivedAt) {
    const { payInputs } = await import("./pay-inputs");
    const { legPayLines, statementExtras } = await import("./pay-plans");
    const inputs = await payInputs(ctx, driverId, legs.map((l) => l.leg));
    for (const inp of inputs) lines.push(...legPayLines(plan, inp));
    const days = new Set(legs.map((l) => zonedDate(l.leg.completedAt!, company.timeZone))).size;
    const earned = lines.reduce((a, l) => a + l.amountCents, 0);
    lines.push(...statementExtras(plan, days, earned));
  } else {
    const rate = driver.payRateCents ?? 0;
    const invs = legs.length ? await db.select({ orderIds: s.invoices.orderIds, state: s.invoices.state, kind: s.invoices.kind, currency: s.invoices.currency, exchangeRate: s.invoices.exchangeRate, issuedAt: s.invoices.issuedAt }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), arrayOverlaps(s.invoices.orderIds, [...new Set(legs.map((l) => l.orderId))]))) : [];
    for (const { leg, orderNumber, rateCents, currency, orderId } of legs) {
      const team = !!leg.coDriverId;
      const share = team ? 0.5 : 1;
      let line: SettlementLine;
      if (driver.payType === "per_mile") {
        const miles = leg.plannedMiles ?? 0;
        line = { id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · ${miles} mi × ${(rate / 100).toFixed(2)}${team ? " (team ½)" : ""}`, qty: miles, unit: "mi", rateCents: rate, amountCents: Math.round(miles * rate * share), source: leg.plannedMiles ? "planned miles" : "no miles on the leg" };
      } else if (driver.payType === "pct") {
        // a percent of the line haul's dollar value: a peso load is converted first
        const usdRate = toHome(rateCents ?? 0, currency, loadRate({ id: orderId, currency }, invs, company.settings.fx).rateE4);
        line = { id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · ${rate / 100}% of ${money(usdRate, "USD")}${currency !== "USD" ? ` (${money(rateCents ?? 0, currency)})` : ""}${team ? " (team ½)" : ""}`, qty: rate, unit: "pct", rateCents: usdRate, amountCents: Math.round(((usdRate * rate) / 10000) * share), source: "order rate" };
      } else {
        line = { id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · flat${team ? " (team ½)" : ""}`, qty: 1, unit: "flat", rateCents: rate, amountCents: Math.round(rate * share), source: "flat per leg" };
      }
      lines.push(line);
      if (leg.type === "crossing" && driver.crossingPayCents) lines.push({ id: newId(), kind: "accessorial", legId: leg.id, orderNumber, description: `${orderNumber} border crossing pay`, qty: 1, unit: "flat", rateCents: driver.crossingPayCents, amountCents: driver.crossingPayCents, source: "driver record" });
    }
  }
  lines = lines.map((l) => ({ ...l, description: `${l.description}${l.kind === "leg" ? lateNote(l.legId) : ""}`, blocker: noMiles(l) ? `${l.orderNumber ?? "a load"}: the leg has no miles, so it pays $0 — enter the miles on the load, then rebuild the statement` : null }));

  // pay items: reimbursements are pay; deductions come off in order and never below $0
  const items = await db.select().from(s.payItems).where(and(eq(s.payItems.tenantId, ctx.tenantId), eq(s.payItems.driverId, driverId), eq(s.payItems.active, true)));
  // what other statements not yet paid already hold of each item: never take the same money twice
  const held = new Map<string, number>();
  for (const x of others.filter((o) => o.state !== "paid")) for (const l of x.lines) if (l.payItemId) held.set(l.payItemId, (held.get(l.payItemId) ?? 0) + Math.abs(l.amountCents));
  const due = items.filter((it) => !(it.endsAt && it.endsAt.getTime() < periodStart.getTime()) && !(it.recurring && it.startsAt.getTime() > periodEnd.getTime() + 7 * 86400_000));
  for (const it of due.filter((x) => x.kind === "reimbursement")) {
    if (!it.recurring && held.has(it.id)) continue;
    lines.push({ id: newId(), kind: "reimbursement", description: it.description, qty: 1, unit: "flat", rateCents: it.amountCents, amountCents: it.amountCents, source: it.recurring ? "recurring" : "one-off", payItemId: it.id });
  }
  const earned = lines.filter((l) => l.amountCents > 0).reduce((a, l) => a + l.amountCents, 0);
  if (earned <= 0) {
    // nothing to pay: no statement. An open one from an earlier build goes away; its deductions wait.
    if (existing) {
      await db.delete(s.settlements).where(eq(s.settlements.id, existing.id));
      await writeAudit(db, ctx, "settlement", existing.id, "archive", undefined, `${driver.name} ${periodStart.toISOString().slice(0, 10)}: no pay this week — deductions wait for a statement with pay`);
    }
    throw new ValidationError(`${driver.name} has no pay for the week of ${zonedDate(periodStart, company.timeZone)}: no statement is made — deductions and advances wait for the next statement with pay`);
  }
  const { applyDeductions, deductionRank } = await import("./pay-plans-pure");
  const wants = due
    .filter((x) => x.kind !== "reimbursement")
    .sort((p, q) => deductionRank(p) - deductionRank(q) || p.createdAt.getTime() - q.createdAt.getTime())
    .flatMap((it) => {
      if (!it.recurring && it.remainingCents == null && held.has(it.id)) return []; // a one-off already on another open statement
      let amt = it.amountCents;
      if (it.remainingCents != null) amt = Math.min(amt, Math.max(0, it.remainingCents - (held.get(it.id) ?? 0)));
      // escrow: collect until the balance reaches the target
      if (it.kind === "escrow" && it.targetCents != null) amt = Math.min(amt, Math.max(0, it.targetCents - (it.balanceCents ?? 0) - (held.get(it.id) ?? 0)));
      return amt > 0 ? [{ it, amt }] : [];
    });
  const applied = applyDeductions(earned, wants.map((w) => ({ key: w.it.id, wantCents: w.amt })));
  for (const [i, w] of wants.entries()) {
    const { takenCents, shortCents } = applied[i];
    const it = w.it;
    if (!takenCents && it.kind === "escrow") continue; // escrow waits for a week with pay left
    const owed = it.remainingCents != null ? it.remainingCents - (held.get(it.id) ?? 0) - takenCents : null;
    const what = shortCents ? (it.kind === "advance" || it.remainingCents != null ? ` — ${money(takenCents)} of ${money(w.amt)} this week, the rest stays owed` : ` — ${money(takenCents)} of ${money(w.amt)} this week, ${money(shortCents)} carries to next week`) : "";
    const left = owed != null && owed > 0 ? ` (${money(owed)} left to recover after this)` : "";
    lines.push({ id: newId(), kind: "deduction", description: `${it.description}${what}${left}`, qty: 1, unit: "flat", rateCents: w.amt, amountCents: -takenCents, source: it.carriedFrom ? "carried from last week" : it.kind === "escrow" ? "escrow" : it.kind === "advance" ? "advance" : it.recurring ? "recurring" : "one-off", payItemId: it.id, shortCents: shortCents || null });
  }
  const row = { lines, ...totalsOf(lines), updatedAt: new Date(), updatedBy: ctx.userId };
  if (existing) {
    const [after] = await db.update(s.settlements).set(row).where(eq(s.settlements.id, existing.id)).returning();
    return after;
  }
  const [after] = await db.insert(s.settlements).values({ id: newId(), tenantId: ctx.tenantId, driverId, periodStart, periodEnd, ...row, createdBy: ctx.userId }).returning();
  await writeAudit(db, ctx, "settlement", after.id, "create", undefined, `${driver.name} ${periodStart.toISOString().slice(0, 10)}`);
  return after;
}

/** Why a statement can't be approved yet, in plain words (empty = it can). */
export function approvalBlockers(st: Pick<typeof s.settlements.$inferSelect, "lines" | "periodEnd" | "netCents" | "grossCents">, now = new Date()): string[] {
  const out: string[] = [];
  if (st.periodEnd.getTime() > now.getTime()) out.push(`the week isn't over yet (it ends ${st.periodEnd.toISOString().slice(0, 10)}): approve it once it has, so late legs make it on`);
  for (const l of st.lines) if (l.blocker) out.push(l.blocker);
  for (const l of st.lines) if (!l.blocker && noMiles(l)) out.push(`${l.orderNumber ?? "a load"}: the leg has no miles, so it pays $0 — enter the miles, then rebuild`);
  if (st.grossCents <= 0) out.push("there is no pay on it");
  if (st.netCents < 0) out.push("the net is below $0: deductions can't be more than the pay");
  return out;
}

/**
 * Move a statement along: open → reviewed → approved → paid. Approving (and paying) waits until the week
 * has ended and every load line has its miles. The one exception is paying a driver early (a final check, a
 * driver going home): the owner approves an unfinished week with a reason, and it is kept in the history.
 */
export async function settlementTransition(ctx: Ctx, id: string, to: "reviewed" | "approved" | "paid" | "open", p: { method?: string; reference?: string; now?: Date; earlyReason?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [st] = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.id, id))).limit(1);
  if (!st) throw new NotFoundError("settlement", id);
  const allowed: Record<string, string[]> = { open: ["reviewed"], reviewed: ["approved", "open"], approved: ["paid", "reviewed"], paid: [] };
  if (!allowed[st.state].includes(to)) throw new TransitionError("order", st.state, to);
  const now = p.now ?? new Date();
  if (to === "approved" || to === "paid") {
    let why = approvalBlockers(st, now);
    const early = st.periodEnd.getTime() > now.getTime();
    // paying early: only the owner, only with a reason, and only the unfinished week can be waived
    if (early && (p.earlyReason?.trim() || (to === "paid" && st.approvedAt))) {
      if (to === "approved" && !can(ctx, "billing.void")) throw new ValidationError("only the owner can approve a week before it ends");
      why = why.filter((w) => !w.startsWith("the week isn't over"));
    }
    if (why.length) throw new ValidationError(`can't ${to === "paid" ? "pay" : "approve"} this statement: ${why.join("; ")}`, early && why.length === 1 && why[0].startsWith("the week isn't over") ? "early" : undefined);
  }
  if (to === "paid" && !p.method) throw new ValidationError("how was it paid?", "method");
  if (to === "paid") await assertOpenPeriod(ctx, now);
  const [after] = await db.update(s.settlements).set({ state: to, reviewedAt: to === "reviewed" ? new Date() : st.reviewedAt, approvedAt: to === "approved" ? new Date() : st.approvedAt, paidAt: to === "paid" ? now : null, method: p.method ?? st.method, reference: p.reference ?? st.reference, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.settlements.id, id)).returning();
  if (to === "paid") {
    // what the statement actually took comes off each pay item; what it couldn't take carries to the next one
    const items = await db.select().from(s.payItems).where(and(eq(s.payItems.tenantId, ctx.tenantId), eq(s.payItems.driverId, st.driverId)));
    const company = await getCompany(ctx);
    for (const it of items) {
      const line = st.lines.find((l) => l.kind === "deduction" && l.payItemId === it.id);
      const credit = st.lines.find((l) => l.kind === "reimbursement" && l.payItemId === it.id);
      // a one-off (not an advance, no total to recover) is done once a paid statement carries it
      if (!it.recurring && it.remainingCents == null && (line || credit)) await db.update(s.payItems).set({ active: false, updatedAt: new Date() }).where(eq(s.payItems.id, it.id));
      if (!line) continue;
      const taken = -line.amountCents;
      if (it.remainingCents != null) await db.update(s.payItems).set({ remainingCents: Math.max(0, it.remainingCents - taken), active: it.remainingCents - taken > 0, updatedAt: new Date() }).where(eq(s.payItems.id, it.id));
      // escrow: what was held this week is now in the driver's escrow balance
      if (it.kind === "escrow" && taken) await db.update(s.payItems).set({ balanceCents: (it.balanceCents ?? 0) + taken, updatedAt: new Date() }).where(eq(s.payItems.id, it.id));
      // a deduction that didn't fit (and has no running total of its own) carries to the next statement
      if (line.shortCents && it.kind === "deduction" && it.remainingCents == null) {
        const base = it.description.replace(/^Carried from week of \d{4}-\d{2}-\d{2}: /, "");
        await db.insert(s.payItems).values({ id: newId(), tenantId: ctx.tenantId, driverId: st.driverId, kind: "deduction", description: `Carried from week of ${zonedDate(st.periodStart, company.timeZone)}: ${base}`, amountCents: line.shortCents, recurring: false, originalCents: line.shortCents, carriedFrom: st.id, createdBy: ctx.userId, updatedBy: ctx.userId });
      }
    }
  }
  await writeAudit(db, ctx, "settlement", id, "transition", { state: { from: st.state, to } }, to === "approved" && p.earlyReason?.trim() ? `approved before the week ended: ${p.earlyReason.trim()}` : p.reference);
  return after;
}

export async function addSettlementLine(ctx: Ctx, id: string, line: { kind: SettlementLine["kind"]; description: string; amountCents: number }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [st] = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), eq(s.settlements.id, id))).limit(1);
  if (!st) throw new NotFoundError("settlement", id);
  if (st.state === "paid" || st.state === "approved") throw new ValidationError("send it back to reviewed to change lines");
  if (!line.description?.trim() || !Number.isFinite(line.amountCents)) throw new ValidationError("description and amount");
  const amount = line.kind === "deduction" ? -Math.abs(line.amountCents) : line.amountCents;
  // net pay never goes below $0: a deduction bigger than what's left goes on next week as a pay item
  if (amount < 0 && st.netCents + amount < 0) throw new ValidationError(`only ${money(Math.max(0, st.netCents))} of pay is left on this statement: add the rest as a deduction pay item and it comes off next week`, "amount");
  const lines = [...st.lines, { id: newId(), kind: line.kind, description: line.description.trim(), qty: 1, unit: "flat", rateCents: Math.abs(amount), amountCents: amount, source: "manual" }];
  const [after] = await db.update(s.settlements).set({ lines, ...totalsOf(lines), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.settlements.id, id)).returning();
  return after;
}

/** Driver sees approved/paid settlements (spec 7.7) plus one in review so a dispute lands before pay day. */
export async function driverSettlements(tenantId: string, driverId: string) {
  return db
    .select()
    .from(s.settlements)
    .where(and(eq(s.settlements.tenantId, tenantId), eq(s.settlements.driverId, driverId), inArray(s.settlements.state, ["reviewed", "approved", "paid"])))
    .orderBy(desc(s.settlements.periodStart))
    .limit(8);
}

/** Driver disputes a line from the app (spec 7.10). */
export async function disputeSettlementLine(tenantId: string, driverId: string, settlementId: string, lineId: string, reason: string) {
  const [st] = await db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, tenantId), eq(s.settlements.id, settlementId), eq(s.settlements.driverId, driverId))).limit(1);
  if (!st) throw new NotFoundError("settlement", settlementId);
  if (!reason?.trim()) throw new ValidationError("say what is wrong", "reason");
  const lines = st.lines.map((l) => (l.id === lineId ? { ...l, disputed: reason.trim() } : l));
  await db.update(s.settlements).set({ lines, state: st.state === "approved" ? "reviewed" : st.state, updatedAt: new Date() }).where(eq(s.settlements.id, settlementId));
}

export async function listSettlements(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  return db.select({ st: s.settlements, driverName: s.drivers.name }).from(s.settlements).innerJoin(s.drivers, eq(s.drivers.id, s.settlements.driverId)).where(eq(s.settlements.tenantId, ctx.tenantId)).orderBy(desc(s.settlements.periodStart)).limit(500);
}

export async function addPayItem(ctx: Ctx, driverId: string, it: { kind: "deduction" | "reimbursement" | "advance" | "escrow"; description: string; amountCents: number; recurring?: boolean; remainingCents?: number | null; targetCents?: number | null; endsAt?: Date | null }) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!it.description?.trim() || !Number.isFinite(it.amountCents) || it.amountCents <= 0) throw new ValidationError("description and a positive amount");
  const [row] = await db.insert(s.payItems).values({ id: newId(), tenantId: ctx.tenantId, driverId, kind: it.kind, description: it.description.trim(), amountCents: it.amountCents, recurring: it.kind === "escrow" ? true : !!it.recurring, remainingCents: it.kind === "advance" ? (it.remainingCents ?? it.amountCents) : (it.remainingCents ?? null), originalCents: it.kind === "advance" ? (it.remainingCents ?? it.amountCents) : (it.remainingCents ?? null), targetCents: it.kind === "escrow" ? (it.targetCents ?? null) : null, balanceCents: it.kind === "escrow" ? 0 : null, endsAt: it.endsAt ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
  return row;
}

export type PayItemLedgerRow = { id: string; driverId: string; driverName: string; kind: string; description: string; recurring: boolean; active: boolean; perStatementCents: number; originalCents: number | null; recoveredCents: number; remainingCents: number | null; heldCents: number | null; targetCents: number | null; carriedFrom: string | null; history: { week: string; state: string; cents: number; shortCents: number }[] };

/**
 * Every pay item with its balance, per driver: what there was to recover, what statements took (paid ones
 * count as recovered), what's left, escrow held — and the week-by-week history, so a second $200 "Fuel
 * advance" line reads as the second installment of $400, not a double deduction.
 */
export async function payItemLedger(ctx: Ctx, opts: { driverId?: string; includeDone?: boolean } = {}): Promise<PayItemLedgerRow[]> {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const where = [eq(s.payItems.tenantId, ctx.tenantId)];
  if (opts.driverId) where.push(eq(s.payItems.driverId, opts.driverId));
  const [items, sts, drivers] = await Promise.all([
    db.select().from(s.payItems).where(and(...where)).orderBy(desc(s.payItems.createdAt)),
    db.select().from(s.settlements).where(and(eq(s.settlements.tenantId, ctx.tenantId), ...(opts.driverId ? [eq(s.settlements.driverId, opts.driverId)] : []))).orderBy(s.settlements.periodStart),
    db.select({ id: s.drivers.id, name: s.drivers.name }).from(s.drivers).where(eq(s.drivers.tenantId, ctx.tenantId)),
  ]);
  return items
    .map((it) => {
      const history = sts.flatMap((st) => st.lines.filter((l) => l.payItemId === it.id).map((l) => ({ week: st.periodStart.toISOString().slice(0, 10), state: st.state, cents: Math.abs(l.amountCents), shortCents: l.shortCents ?? 0 })));
      const recovered = history.filter((h) => h.state === "paid").reduce((a, h) => a + h.cents, 0);
      const original = it.originalCents ?? (it.remainingCents != null ? it.remainingCents + recovered : !it.recurring ? it.amountCents : null);
      return { id: it.id, driverId: it.driverId, driverName: drivers.find((d) => d.id === it.driverId)?.name ?? "?", kind: it.kind, description: it.description, recurring: it.recurring, active: it.active, perStatementCents: it.amountCents, originalCents: original, recoveredCents: recovered, remainingCents: it.remainingCents != null ? it.remainingCents : !it.recurring ? (it.active ? it.amountCents : 0) : null, heldCents: it.kind === "escrow" ? (it.balanceCents ?? 0) : null, targetCents: it.targetCents, carriedFrom: it.carriedFrom, history };
    })
    .filter((r) => opts.includeDone || r.active || (r.heldCents ?? 0) > 0);
}

/** Sunday-to-Saturday week containing `d`, in UTC. */
export function weekOf(d: Date) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
  return { start, end: new Date(start.getTime() + 7 * 86400_000) };
}

// ---------- order P&L (7.8) ----------

/**
 * The rate that converts one load's money to USD: the rate on its (non-void) invoice when there is one,
 * else the company's latest rate for the currency, else the default. Pure given its inputs.
 */
export function loadRate(order: { id: string; currency: string }, invoices: { orderIds: string[]; state: string; kind: string; currency: string; exchangeRate: number | null; issuedAt: Date | null }[], fx: FxRates) {
  const inv = invoices.filter((i) => i.orderIds.includes(order.id) && i.state !== "void" && i.state !== "draft" && i.currency === order.currency && i.exchangeRate).sort((p, q) => (q.issuedAt?.getTime() ?? 0) - (p.issuedAt?.getTime() ?? 0))[0];
  return pickRate(order.currency, inv?.exchangeRate ?? null, fx);
}

/**
 * One load's P&L in USD: revenue (its charges, converted at the load's rate), carrier cost (each bill or
 * leg in its own currency, converted), driver pay (USD), fuel (USD per mile) and tolls. A peso load shows
 * its margin in dollars, never pesos minus dollars.
 */
export async function orderPnl(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const order = await loadOrder(ctx, orderId);
  await ensureCharges(ctx, orderId);
  // a tailgate shipment carries its share of the trip's costs (weight / revenue / cube per the company setting)
  const costOrderId = order.kind === "shipment" && order.tripId ? order.tripId : orderId;
  let share = 1;
  if (order.kind === "shipment" && order.tripId) {
    const { costShares } = await import("./tailgate");
    share = (await costShares(ctx, order.tripId)).get(order.id) ?? 0;
  }
  const [cs, bills, legs, company, costOrder, invs] = await Promise.all([
    db.select().from(s.charges).where(and(eq(s.charges.orderId, orderId), eq(s.charges.billable, true))),
    db.select().from(s.carrierBills).where(eq(s.carrierBills.orderId, costOrderId)),
    db.select().from(s.legs).where(eq(s.legs.orderId, costOrderId)),
    getCompany(ctx),
    costOrderId === orderId ? Promise.resolve(order) : loadOrder(ctx, costOrderId),
    db.select({ orderIds: s.invoices.orderIds, state: s.invoices.state, kind: s.invoices.kind, currency: s.invoices.currency, exchangeRate: s.invoices.exchangeRate, issuedAt: s.invoices.issuedAt }).from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), sql`${orderId} = any(${s.invoices.orderIds})`)),
  ]);
  const fx = company.settings.fx;
  const rate = loadRate(order, invs, fx);
  const usd = (cents: number, cur: string) => toHome(cents, cur, cur === order.currency ? rate.rateE4 : pickRate(cur, null, fx).rateE4);
  const live = cs.filter((c) => c.approvalState !== "rejected" && c.approvalState !== "pending");
  const revenueOriginal = live.filter((c) => c.currency === order.currency).reduce((a, c) => a + c.amountCents, 0);
  const revenue = live.reduce((a, c) => a + usd(c.amountCents, c.currency), 0);
  // carrier cost: the bill when there is one, else what the leg was tendered at — each in its own currency
  const billed = new Set(bills.map((b) => b.legId).filter(Boolean));
  const carrierCost = Math.round((bills.reduce((a, b) => a + usd(b.paidCents ?? b.approvedCents ?? b.invoicedCents ?? b.expectedCents + b.accessorialCents, b.currency), 0) + legs.filter((l) => l.assigneeKind === "carrier" && l.state !== "cancelled" && !billed.has(l.id)).reduce((a, l) => a + usd(l.carrierRateCents ?? 0, l.carrierRateCurrency ?? "USD"), 0)) * share);
  // driver pay: what a statement paid for the leg, else an estimate from the driver's pay rule (plan or pay type)
  const sts = await db.select().from(s.settlements).where(eq(s.settlements.tenantId, ctx.tenantId));
  let driverPay = 0;
  const paidLegs = new Set<string>();
  for (const st of sts)
    for (const l of st.lines)
      if (l.legId && legs.some((g) => g.id === l.legId) && l.amountCents > 0) {
        driverPay += l.amountCents;
        paidLegs.add(l.legId);
      }
  let driverPayEstimated = false;
  const ownLegs = legs.filter((l) => l.assigneeKind === "truck" && l.driverId && l.state !== "cancelled" && !paidLegs.has(l.id));
  if (ownLegs.length) {
    const ids = [...new Set(ownLegs.flatMap((l) => [l.driverId!, l.coDriverId].filter((x): x is string => !!x)))];
    const drivers = await db.select().from(s.drivers).where(inArray(s.drivers.id, ids));
    const costRate = costOrderId === orderId ? rate : loadRate(costOrder, [], fx);
    for (const l of ownLegs) {
      for (const did of [l.driverId, l.coDriverId].filter((x): x is string => !!x)) {
        const d = drivers.find((x) => x.id === did);
        if (!d) continue;
        const team = !!l.coDriverId;
        if (d.payPlanId) {
          const [plan] = await db.select().from(s.payPlans).where(eq(s.payPlans.id, d.payPlanId)).limit(1);
          if (plan) {
            const { payInputs } = await import("./pay-inputs");
            const { legPayLines } = await import("./pay-plans-pure");
            const inputs = await payInputs(ctx, d.id, [l]);
            driverPay += inputs.flatMap((inp) => legPayLines(plan, inp)).reduce((a, x) => a + x.amountCents, 0);
            driverPayEstimated = true;
            continue;
          }
        }
        const pr = d.payRateCents ?? 0;
        const sh = team ? 0.5 : 1;
        // a percent of the line haul is a percent of its dollar value
        const linehaulUsd = toHome(costOrder.rateCents ?? 0, costOrder.currency, costRate.rateE4);
        driverPay += Math.round((d.payType === "per_mile" ? (l.plannedMiles ?? 0) * pr : d.payType === "pct" ? (linehaulUsd * pr) / 10000 : pr) * sh);
        driverPayEstimated = true;
      }
    }
  }
  driverPay = Math.round(driverPay * share);
  const milesAll = legs.filter((l) => l.assigneeKind === "truck").reduce((a, l) => a + (l.plannedMiles ?? 0), 0);
  const miles = Math.round(milesAll * share);
  const fuelCpm = company.settings.fuelCostCentsPerMile;
  const fuel = Math.round(milesAll * fuelCpm * share);
  // tolls and fees are typed on the load in its currency
  const extra = costOrderId === orderId ? usd(order.tollsFeesCents ?? 0, order.currency) : Math.round(toHome(costOrder.tollsFeesCents ?? 0, costOrder.currency, pickRate(costOrder.currency, null, fx).rateE4) * share) + usd(order.tollsFeesCents ?? 0, order.currency); // trip tolls shared, the shipment's own on top
  const cost = carrierCost + driverPay + fuel + extra;
  return { currency: HOME_CURRENCY, orderCurrency: order.currency, fx: order.currency === HOME_CURRENCY ? null : rate, revenueOriginal, revenue, carrierCost, driverPay, driverPayEstimated, fuel, miles, fuelCpm, extra, cost, share, margin: revenue - cost, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0 };
}

export { diff };

/** Pay back escrow to the driver: a one-off reimbursement on the next statement, taken off the balance now. */
export async function releaseEscrow(ctx: Ctx, payItemId: string, amountCents: number, note?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const [it] = await db.select().from(s.payItems).where(and(eq(s.payItems.tenantId, ctx.tenantId), eq(s.payItems.id, payItemId))).limit(1);
  if (!it || it.kind !== "escrow") throw new NotFoundError("escrow", payItemId);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new ValidationError("enter the amount to release", "amount");
  if (amountCents > (it.balanceCents ?? 0)) throw new ValidationError(`only ${(it.balanceCents ?? 0) / 100} is held in this escrow`, "amount");
  await db.update(s.payItems).set({ balanceCents: (it.balanceCents ?? 0) - amountCents, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.payItems.id, it.id));
  const [row] = await db.insert(s.payItems).values({ id: newId(), tenantId: ctx.tenantId, driverId: it.driverId, kind: "reimbursement", description: `Escrow release — ${it.description}${note ? ` (${note})` : ""}`, amountCents, recurring: false, createdBy: ctx.userId, updatedBy: ctx.userId }).returning();
  await writeAudit(db, ctx, "driver", it.driverId, "update", { escrow: { from: it.balanceCents, to: (it.balanceCents ?? 0) - amountCents } }, "escrow released");
  return row;
}
