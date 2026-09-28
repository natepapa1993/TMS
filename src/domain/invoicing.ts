import { and, eq, inArray, desc, sql, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { InvoiceDelivery } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { publicUrl } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { ValidationError } from "./orders";
import { TransitionError } from "./states";
import { billingQueue, createInvoice, issueInvoice, invoiceById, type QueueRow } from "./billing";
import { buildPacketPdf, type PacketPart } from "./crossing-pdf";
import { buildFactorSchedulePdf } from "./billing-pdf";

/**
 * Batch and summary invoicing, and getting the invoice to whoever pays it: by email with the POD and
 * BOL attached, through the factoring company (with a schedule of accounts), by EDI 210, or uploaded to
 * the customer's portal / mailed and recorded.
 */

export const DELIVERY_METHODS = ["email", "factor", "edi", "portal", "mail"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export const DELIVERY_LABEL: Record<DeliveryMethod, string> = { email: "Email", factor: "Factoring company", edi: "EDI 210", portal: "Customer portal", mail: "Mail" };

type Cust = Pick<typeof s.customers.$inferSelect, "invoiceDelivery" | "billingEmail">;
type Ent = Pick<typeof s.billingEntities.$inferSelect, "factorAll" | "factorEmail" | "factorName"> | null | undefined;

/** Pure: how a customer's invoice leaves. "auto" = the factor when the entity factors everything, EDI when the partner takes 210s, else email. */
export function resolveDelivery(cust: Cust | null | undefined, entity: Ent, edi210: boolean): DeliveryMethod {
  const m = cust?.invoiceDelivery ?? "auto";
  if ((DELIVERY_METHODS as readonly string[]).includes(m)) return m as DeliveryMethod;
  if (entity?.factorAll && entity.factorName) return "factor";
  if (edi210) return "edi";
  return "email";
}

async function edi210For(tenantId: string, customerId: string) {
  const { partnerForCustomer } = await import("./edi");
  const p = await partnerForCustomer(tenantId, customerId);
  return !!p?.send210;
}

/** The method for an invoice's customer and entity (issue uses it to decide whether the invoice is factored). */
export async function deliveryForInvoice(ctx: Ctx, customerId: string, entityId: string) {
  const [[cust], [entity]] = await Promise.all([db.select().from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), eq(s.customers.id, customerId))).limit(1), db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), eq(s.billingEntities.id, entityId))).limit(1)]);
  return { method: resolveDelivery(cust, entity, await edi210For(ctx.tenantId, customerId)), customer: cust ?? null, entity: entity ?? null };
}

// ---------- batch ----------

export type PlannedInvoice = { key: string; customerId: string; customerName: string; entityId: string | null; currency: string; orderIds: string[]; orderNumbers: string[]; totalCents: number; mode: "per_load" | "summary"; method: DeliveryMethod; sendTo: string | null };
export type BatchPlan = { invoices: PlannedInvoice[]; skipped: { orderId: string; orderNumber: string; reason: string }[]; /** the company's latest rate per foreign currency, to start the exchange-rate boxes with */ rates: Record<string, string> };

function whyNot(q: QueueRow) {
  if (q.invoiceId) return "already on a draft invoice";
  if (q.mismatch) return "charges differ from the rate con";
  if (!q.docsComplete) return `missing ${[...q.requiredDocs.filter((d) => !d.present).map((d) => d.code), ...q.requiredRefs.filter((r) => !r.present).map((r) => `${r.key.toUpperCase()} reference`)].join(", ")}`;
  if (!(q.order.customerId ?? q.order.brokerId)) return "no customer";
  if (q.chargesCents === 0 && q.pending.count) return "only extras waiting for the customer's approval";
  return null;
}

/** What a billing run would make from these delivered loads: grouped by customer (summary customers get one invoice), entity and currency. */
export async function planBatch(ctx: Ctx, orderIds: string[]): Promise<BatchPlan> {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const queue = (await billingQueue(ctx)).filter((q) => orderIds.includes(q.order.id));
  const skipped: BatchPlan["skipped"] = [];
  for (const id of orderIds) if (!queue.some((q) => q.order.id === id)) skipped.push({ orderId: id, orderNumber: "", reason: "not ready to bill" });
  const good = queue.filter((q) => {
    const why = whyNot(q);
    if (why) skipped.push({ orderId: q.order.id, orderNumber: q.order.orderNumber, reason: why });
    return !why;
  });
  const custIds = [...new Set(good.map((q) => (q.order.customerId ?? q.order.brokerId)!))];
  const [custs, entities] = await Promise.all([custIds.length ? db.select().from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), inArray(s.customers.id, custIds))) : [], db.select().from(s.billingEntities).where(and(eq(s.billingEntities.tenantId, ctx.tenantId), isNull(s.billingEntities.archivedAt)))]);
  const edi = new Map<string, boolean>();
  for (const c of custIds) edi.set(c, await edi210For(ctx.tenantId, c));
  const groups = new Map<string, PlannedInvoice>();
  for (const q of good) {
    const cid = (q.order.customerId ?? q.order.brokerId)!;
    const cust = custs.find((c) => c.id === cid);
    const entity = entities.find((e) => e.id === (q.order.billingEntityId ?? cust?.billingEntityId)) ?? entities.find((e) => e.isDefault) ?? entities[0];
    const mode = cust?.invoiceMode === "summary" ? "summary" : "per_load";
    // late charges on invoiced loads go on their own supplemental invoice
    const key = q.supplemental ? `sup|${q.order.id}` : mode === "summary" ? `${cid}|${entity?.id}|${q.order.currency}` : q.order.id;
    const method = resolveDelivery(cust, entity, edi.get(cid) ?? false);
    const g = groups.get(key) ?? { key, customerId: cid, customerName: cust?.name ?? q.customerName ?? "?", entityId: entity?.id ?? null, currency: q.order.currency, orderIds: [], orderNumbers: [], totalCents: 0, mode, method, sendTo: method === "email" ? (cust?.billingEmail ?? null) : method === "factor" ? (entity?.factorEmail ?? null) : method === "portal" ? (cust?.portalUrl ?? null) : null };
    g.orderIds.push(q.order.id);
    g.orderNumbers.push(q.order.orderNumber);
    g.totalCents += q.chargesCents;
    groups.set(key, g);
  }
  const { getCompany } = await import("./company");
  const fx = (await getCompany(ctx)).settings.fx;
  const rates = Object.fromEntries(Object.entries(fx).map(([c, r]) => [c, ((r?.rateE4 ?? 0) / 10000).toFixed(4)]));
  return { invoices: [...groups.values()].sort((p, q) => p.customerName.localeCompare(q.customerName)), skipped, rates };
}

export type BatchResult = { batchId: string; number: number; results: { customerName: string; orderNumbers: string[]; invoiceId: string | null; number: string | null; state: string; method: DeliveryMethod; ok: boolean; note: string | null }[]; skipped: BatchPlan["skipped"]; schedule: { id: string; number: number; count: number } | null };

async function nextBatchNumber(tenantId: string, kind: string) {
  const [r] = await db.select({ n: sql<number>`coalesce(max(${s.invoiceBatches.number}), 0)` }).from(s.invoiceBatches).where(and(eq(s.invoiceBatches.tenantId, tenantId), eq(s.invoiceBatches.kind, kind)));
  return Number(r?.n ?? 0) + 1;
}

/**
 * A billing run: make the invoices the plan shows; issue them (MXN ones need the exchange rate); send them
 * each by its customer's method — factored invoices go to the factor together on one schedule of accounts.
 * One invoice failing never stops the others.
 */
export async function runBatch(ctx: Ctx, orderIds: string[], opts: { issue?: boolean; send?: boolean; /** MXN per USD (older callers) */ exchangeRate?: number | string | null; /** per currency, units per 1 USD: { MXN: 18.45, CAD: 1.37 } */ exchangeRates?: Record<string, number | string | null | undefined> } = {}): Promise<BatchResult> {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const plan = await planBatch(ctx, orderIds);
  if (!plan.invoices.length) throw new ValidationError(plan.skipped.length ? `nothing to bill: ${plan.skipped.map((x) => `${x.orderNumber || "an order"} — ${x.reason}`).join("; ")}` : "pick the loads to bill");
  const number = await nextBatchNumber(ctx.tenantId, "billing");
  const batchId = newId();
  await db.insert(s.invoiceBatches).values({ id: batchId, tenantId: ctx.tenantId, kind: "billing", number, createdBy: ctx.userId, updatedBy: ctx.userId });
  const results: BatchResult["results"] = [];
  const toFactor: string[] = [];
  for (const g of plan.invoices) {
    const r: BatchResult["results"][number] = { customerName: g.customerName, orderNumbers: g.orderNumbers, invoiceId: null, number: null, state: "draft", method: g.method, ok: true, note: null };
    results.push(r);
    try {
      const inv = await createInvoice(ctx, g.orderIds, { entityId: g.entityId, consolidate: g.orderIds.length > 1, withoutPending: true });
      r.invoiceId = inv.id;
      await db.update(s.invoices).set({ batchId }).where(eq(s.invoices.id, inv.id));
      if (!opts.issue) continue;
      // a MXN or CAD invoice is issued at the rate typed for its currency
      const rate = g.currency === "USD" ? null : (opts.exchangeRates?.[g.currency] ?? (g.currency === "MXN" ? opts.exchangeRate : null));
      if (g.currency !== "USD" && (rate == null || rate === "")) {
        r.note = `left as a draft: a ${g.currency} invoice needs the exchange rate (${g.currency} per USD)`;
        continue;
      }
      const issued = await issueInvoice(ctx, inv.id, { exchangeRate: rate });
      r.number = issued.number;
      r.state = issued.state;
      if (!opts.send) continue;
      if (g.method === "factor") {
        toFactor.push(inv.id);
        continue;
      }
      if (g.method === "portal" || g.method === "mail") {
        r.note = g.method === "portal" ? "upload it to their portal, then record it on the invoice" : "print and mail it, then record it on the invoice";
        continue;
      }
      const sent = await deliverInvoice(ctx, inv.id, { method: g.method, batchId });
      r.state = sent.state;
    } catch (e) {
      r.ok = false;
      r.note = (e as Error).message;
    }
  }
  let schedule: BatchResult["schedule"] = null;
  if (toFactor.length) {
    try {
      const sch = await sendFactorSchedule(ctx, toFactor);
      schedule = { id: sch.id, number: sch.number, count: toFactor.length };
      for (const r of results) if (r.invoiceId && toFactor.includes(r.invoiceId)) r.state = "sent";
    } catch (e) {
      for (const r of results) if (r.invoiceId && toFactor.includes(r.invoiceId)) Object.assign(r, { ok: false, note: `to the factor: ${(e as Error).message}` });
    }
  }
  const ids = results.map((r) => r.invoiceId).filter((x): x is string => !!x);
  const invs = ids.length ? await db.select({ totalCents: s.invoices.totalCents, currency: s.invoices.currency }).from(s.invoices).where(inArray(s.invoices.id, ids)) : [];
  await db.update(s.invoiceBatches).set({ invoiceIds: ids, totalCents: invs.reduce((a, i) => a + i.totalCents, 0), currency: invs[0]?.currency ?? "USD", note: `${ids.length} invoice(s) for ${new Set(results.map((r) => r.customerName)).size} customer(s)`, updatedAt: new Date() }).where(eq(s.invoiceBatches.id, batchId));
  await writeAudit(db, ctx, "invoice_batch", batchId, "create", undefined, `billing run #${number}: ${ids.length} invoice(s)`);
  return { batchId, number, results, skipped: plan.skipped, schedule };
}

// ---------- the packet ----------

/** The documents that go with the invoice: the customer's list, else the ones required before invoicing (TONU: no POD/BOL). */
export async function packetParts(ctx: Ctx, invoiceId: string): Promise<{ parts: PacketPart[]; missing: string[] }> {
  const { invoice: inv, customer, orders } = await invoiceById(ctx, invoiceId);
  if (!inv.pdfStorageKey) throw new ValidationError("issue the invoice first");
  const { readBlob } = await import("./crossing");
  const invPdf = await readBlob(ctx, inv.pdfStorageKey);
  const parts: PacketPart[] = [{ name: `Invoice ${inv.number}`, mimeType: "application/pdf", bytes: new Uint8Array(invPdf.bytes) }];
  const want = (customer?.invoiceDocs ?? customer?.requiredDocs ?? ["POD", "BOL", "RATE_CON"]).map((c) => c.toUpperCase());
  const missing: string[] = [];
  if (!want.length || !orders.length) return { parts, missing };
  const docs = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, orders.map((o) => o.id)), inArray(s.documents.status, ["present", "verified"]))).orderBy(desc(s.documents.createdAt));
  for (const o of [...orders].sort((p, q) => p.orderNumber.localeCompare(q.orderNumber))) {
    for (const code of want) {
      if (o.tonu && ["POD", "BOL", "SEAL"].includes(code)) continue;
      const d = docs.find((x) => x.subjectId === o.id && x.code?.toUpperCase() === code);
      if (!d) {
        missing.push(`${o.orderNumber} ${code}`);
        continue;
      }
      const b = await readBlob(ctx, d.storageKey);
      parts.push({ name: `${o.orderNumber} ${code}`, mimeType: d.mimeType, bytes: new Uint8Array(b.bytes) });
    }
  }
  return { parts, missing };
}

async function storePdf(ctx: Ctx, pdf: Uint8Array) {
  const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: createHash("sha256").update(pdf).digest("hex"), mimeType: "application/pdf", sizeBytes: pdf.length, bytes: Buffer.from(pdf) }).returning({ id: s.documentBlobs.id });
  return `blob:${blob.id}`;
}

/** The invoice with its documents, one PDF. */
export async function invoicePacket(ctx: Ctx, invoiceId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const { invoice } = await invoiceById(ctx, invoiceId);
  const { parts, missing } = await packetParts(ctx, invoiceId);
  // one document: skip the cover page, the invoice is the packet
  const pdf = parts.length === 1 ? parts[0].bytes : await buildPacketPdf({ title: `Invoice ${invoice.number}`, parts });
  return { pdf, fileName: `Invoice ${invoice.number}.pdf`, missing, count: parts.length };
}

// ---------- delivery ----------

const fmt = (c: number, cur: string) => (c / 100).toLocaleString("en-US", { style: "currency", currency: cur });

async function recordDelivery(ctx: Ctx, invoiceId: string, d: Omit<InvoiceDelivery, "at" | "by">) {
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
  const deliveries = [...(inv.deliveries ?? []), { ...d, at: new Date().toISOString(), by: ctx.userId }];
  const [after] = await db.update(s.invoices).set({ state: inv.state === "issued" ? "sent" : inv.state, sentAt: new Date(), sentTo: d.to ?? d.method, deliveries, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.invoices.id, inv.id)).returning();
  await writeAudit(db, ctx, "invoice", inv.id, "transition", inv.state !== after.state ? { state: { from: inv.state, to: after.state } } : undefined, `${DELIVERY_LABEL[d.method as DeliveryMethod] ?? d.method}${d.to ? ` to ${d.to}` : ""}${d.reference ? ` · ${d.reference}` : ""}`);
  return after;
}

/**
 * Send (or record) the invoice. Email and factor attach the packet; EDI sends the 210; portal and mail
 * record where it went. The method defaults to the customer's.
 */
export async function deliverInvoice(ctx: Ctx, invoiceId: string, opts: { method?: DeliveryMethod; to?: string | null; reference?: string | null; batchId?: string | null } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  const { invoice: inv } = await invoiceById(ctx, invoiceId);
  if (!["issued", "sent", "partially_paid", "disputed"].includes(inv.state)) throw new TransitionError("order", inv.state, "sent", "issue the invoice first");
  const { method: auto, customer, entity } = await deliveryForInvoice(ctx, inv.customerId, inv.entityId);
  const method = opts.method ?? auto;
  if (!(DELIVERY_METHODS as readonly string[]).includes(method)) throw new ValidationError("unknown delivery method", "method");
  if (method === "edi") {
    const { emit210 } = await import("./edi");
    const r = await emit210(ctx, invoiceId);
    if (!r) throw new ValidationError(`${customer?.name ?? "this customer"} has no EDI partner that takes 210 invoices`, "method");
    return recordDelivery(ctx, invoiceId, { method, to: "EDI 210", reference: null, batchId: opts.batchId ?? null });
  }
  if (method === "portal" || method === "mail") return recordDelivery(ctx, invoiceId, { method, to: opts.to?.trim() || (method === "portal" ? customer?.portalUrl ?? null : null), reference: opts.reference?.trim() || null, batchId: opts.batchId ?? null });
  if (method === "factor") {
    const sch = await sendFactorSchedule(ctx, [invoiceId]);
    return (await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1))[0] ?? sch;
  }
  // email
  const to = opts.to?.trim() || customer?.billingEmail || null;
  if (!to) throw new ValidationError(`${customer?.name ?? "customer"} has no billing email`, "to");
  const cc = opts.to ? [] : (customer?.invoiceCc ?? "").split(/[,;\s]+/).filter((x) => x.includes("@"));
  const packet = await invoicePacket(ctx, invoiceId);
  const storageKey = await storePdf(ctx, packet.pdf);
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const body = [
    `${customer?.name},`,
    ``,
    `Attached is invoice ${inv.number} from ${entity?.legalName} for ${fmt(open, inv.currency)}, due ${inv.dueAt?.toISOString().slice(0, 10)}${packet.count > 1 ? `, with ${packet.count - 1} supporting document${packet.count > 2 ? "s" : ""}` : ""}.`,
    inv.orderIds.length > 1 ? `It covers ${inv.orderIds.length} loads.` : ``,
    ``,
    `Download the PDF: ${publicUrl(`/i/${inv.token}`)}`,
    ``,
    `Reference: ${inv.number}`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
  await enqueue(ctx, { channel: "email", to, subject: `Invoice ${inv.number} · ${entity?.dba || entity?.legalName}`, body, subjectKind: "invoice", subjectId: inv.id, meta: { kind: "invoice", attachments: [{ fileName: packet.fileName, storageKey }], cc } });
  await deliverQueued().catch(() => null);
  return recordDelivery(ctx, invoiceId, { method: "email", to: [to, ...cc].join(", "), reference: packet.missing.length ? `sent without ${packet.missing.join(", ")}` : null, batchId: opts.batchId ?? null });
}

/**
 * A schedule of accounts to the factor: a cover listing every invoice with its customer and amount, then
 * each invoice with its documents, in one PDF emailed to the factor. The invoices must be factored,
 * issued, from one entity and in one currency.
 */
export async function sendFactorSchedule(ctx: Ctx, invoiceIds: string[]) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.issue");
  if (!invoiceIds.length) throw new ValidationError("pick the invoices to send to the factor");
  const invs = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), inArray(s.invoices.id, invoiceIds)));
  if (invs.length !== invoiceIds.length) throw new ValidationError("an invoice was not found");
  const notIssued = invs.filter((i) => !i.number || ["draft", "void"].includes(i.state));
  if (notIssued.length) throw new ValidationError("issue every invoice before scheduling it");
  if (new Set(invs.map((i) => i.entityId)).size > 1) throw new ValidationError("one schedule is for one billing entity");
  if (new Set(invs.map((i) => i.currency)).size > 1) throw new ValidationError("one schedule is for one currency");
  const [entity] = await db.select().from(s.billingEntities).where(eq(s.billingEntities.id, invs[0].entityId)).limit(1);
  if (!entity?.factorName) throw new ValidationError(`${entity?.legalName ?? "the entity"} has no factoring company — set it under Settings → Billing entities`);
  if (!entity.factorEmail) throw new ValidationError(`add the email ${entity.factorName} takes invoices at (Settings → Billing entities)`);
  const custs = await db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(inArray(s.customers.id, [...new Set(invs.map((i) => i.customerId))]));
  const number = await nextBatchNumber(ctx.tenantId, "factor_schedule");
  const rows = [...invs].sort((p, q) => (p.number ?? "").localeCompare(q.number ?? "")).map((i) => ({ number: i.number!, customer: custs.find((c) => c.id === i.customerId)?.name ?? "?", issuedAt: i.issuedAt!.toISOString().slice(0, 10), loads: i.orderIds.length, amountCents: i.totalCents - i.creditedCents }));
  const total = rows.reduce((a, r) => a + r.amountCents, 0);
  const cover = await buildFactorSchedulePdf({ entity: entity.legalName, factor: entity.factorName, number, date: new Date(), currency: invs[0].currency, rows });
  const parts: PacketPart[] = [{ name: `Schedule of accounts #${number}`, mimeType: "application/pdf", bytes: cover }];
  for (const i of [...invs].sort((p, q) => (p.number ?? "").localeCompare(q.number ?? ""))) parts.push(...(await packetParts(ctx, i.id)).parts);
  const pdf = await buildPacketPdf({ title: `${entity.legalName} · schedule #${number} to ${entity.factorName}`, parts });
  const storageKey = await storePdf(ctx, pdf);
  const id = newId();
  await db.insert(s.invoiceBatches).values({ id, tenantId: ctx.tenantId, kind: "factor_schedule", number, invoiceIds, totalCents: total, currency: invs[0].currency, sentTo: entity.factorEmail, storageKey, note: `${rows.length} invoice(s) to ${entity.factorName}`, createdBy: ctx.userId, updatedBy: ctx.userId });
  const body = [`${entity.factorName},`, ``, `Schedule of accounts #${number} from ${entity.legalName}: ${rows.length} invoice${rows.length === 1 ? "" : "s"} totalling ${fmt(total, invs[0].currency)}.`, ``, ...rows.map((r) => `${r.number}  ${r.customer}  ${fmt(r.amountCents, invs[0].currency)}`), ``, `The schedule, the invoices and their documents are attached.`].join("\n");
  await enqueue(ctx, { channel: "email", to: entity.factorEmail, subject: `Schedule #${number} · ${entity.legalName} · ${fmt(total, invs[0].currency)}`, body, subjectKind: "invoice_batch", subjectId: id, meta: { kind: "invoice", attachments: [{ fileName: `Schedule ${number} - ${entity.legalName}.pdf`, storageKey }] } });
  await deliverQueued().catch(() => null);
  for (const i of invs) {
    if (!i.factored) await db.update(s.invoices).set({ factored: true }).where(eq(s.invoices.id, i.id));
    await recordDelivery(ctx, i.id, { method: "factor", to: entity.factorEmail, reference: `schedule #${number}`, batchId: id });
  }
  await writeAudit(db, ctx, "invoice_batch", id, "create", undefined, `schedule #${number} to ${entity.factorName}: ${rows.length} invoice(s)`);
  return { id, number, totalCents: total };
}

/** Billing runs and factor schedules, newest first. */
export async function listBatches(ctx: Ctx, limit = 30) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  return db.select().from(s.invoiceBatches).where(eq(s.invoiceBatches.tenantId, ctx.tenantId)).orderBy(desc(s.invoiceBatches.createdAt)).limit(limit);
}

/** Factored invoices issued but not yet on a schedule. */
export async function awaitingFactor(ctx: Ctx) {
  assertCtx(ctx);
  requirePermission(ctx, "billing.view");
  const invs = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, ctx.tenantId), eq(s.invoices.factored, true), inArray(s.invoices.state, ["issued"]))).orderBy(s.invoices.number);
  return invs;
}
