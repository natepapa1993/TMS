import { and, eq, or, sql, desc, isNull, inArray, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, can, requirePermission, type Ctx } from "@/lib/context";
import { ACCENTED, PLAIN, fold } from "@/lib/fold";

export type SearchHit = { kind: "load" | "truck" | "trailer" | "driver" | "customer" | "carrier" | "invoice" | "credit" | "bill" | "payment" | "crossing"; id: string; title: string; sub: string; href: string };

/** A column (or SQL text) with accents and case taken off, to compare with a folded term: "Óscar" = "oscar". */
export const folded = (x: AnyColumn | SQL) => sql`lower(translate(${x}::text, ${ACCENTED}, ${PLAIN}))`;
/** `x` contains the (already folded) pattern. */
const has = (x: AnyColumn | SQL, like: string) => sql`${folded(x)} like ${like}`;

/**
 * One search box for the whole company (⌘K), accent- and case-blind: load number, any reference on a
 * load (PO, BOL, customer load #, rate con), the city of a stop, a caja / trailer, a seal, a pedimento or
 * any number read off a load document, a partner carrier's driver or unit, a unit, a driver, a customer,
 * a carrier — and for billing: invoice #, credit memo #, carrier invoice #, payment reference.
 * People and companies come first, then loads, then money.
 */
export async function searchAll(ctx: Ctx, q: string): Promise<SearchHit[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const term = fold(q).trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const money = can(ctx, "billing.view");
  const T = ctx.tenantId;
  const loadCols = { id: s.orders.id, num: s.orders.orderNumber, state: s.orders.state, refs: s.orders.refs, kind: s.orders.kind, createdAt: s.orders.createdAt };
  const [orders, byStop, byCrossing, byTender, byDoc, trucks, trailers, drivers, customers, carriers] = await Promise.all([
    db
      .select({ ...loadCols, cust: s.customers.name })
      .from(s.orders)
      .leftJoin(s.customers, eq(s.customers.id, s.orders.customerId))
      .where(and(eq(s.orders.tenantId, T), or(has(s.orders.orderNumber, like), has(sql`${s.orders.refs}`, like), has(s.customers.name, like))))
      .orderBy(desc(s.orders.createdAt))
      .limit(12),
    db
      .selectDistinct({ ...loadCols, stop: s.stops.name })
      .from(s.stops)
      .innerJoin(s.orders, eq(s.orders.id, s.stops.orderId))
      .where(and(eq(s.stops.tenantId, T), or(has(s.stops.name, like), has(sql`${s.stops.address}->>'city'`, like), has(sql`${s.stops.refs}`, like), has(s.stops.sealIn, like), has(s.stops.sealOut, like))))
      .orderBy(desc(s.orders.createdAt))
      .limit(8),
    // the caja and seal on a crossing
    db
      .select({ ...loadCols, caja: s.crossings.trailerNumber, seal: s.crossings.sealNumber })
      .from(s.crossings)
      .innerJoin(s.orders, eq(s.orders.id, s.crossings.orderId))
      .where(and(eq(s.crossings.tenantId, T), or(has(s.crossings.trailerNumber, like), has(s.crossings.sealNumber, like))))
      .orderBy(desc(s.orders.createdAt))
      .limit(6),
    // a partner carrier's driver, unit or caja, as they gave it when they accepted
    db
      .select({ ...loadCols, driverName: s.tenders.driverName, unit: s.tenders.unitNumber, caja: s.tenders.trailerNumber })
      .from(s.tenders)
      .innerJoin(s.orders, eq(s.orders.id, s.tenders.orderId))
      .where(and(eq(s.tenders.tenantId, T), or(has(s.tenders.driverName, like), has(s.tenders.unitNumber, like), has(s.tenders.trailerNumber, like), has(s.tenders.driverPhone, like))))
      .orderBy(desc(s.orders.createdAt))
      .limit(6),
    // a number on a load's or crossing's document: pedimento, BOL, DODA folio, carta porte UUID
    db
      .select({ id: s.documents.id, subjectKind: s.documents.subjectKind, subjectId: s.documents.subjectId, code: s.documents.code, number: s.documents.number })
      .from(s.documents)
      .where(and(eq(s.documents.tenantId, T), inArray(s.documents.subjectKind, ["order", "crossing", "leg"]), or(has(s.documents.number, like), has(sql`${s.documents.extracted}`, like))))
      .limit(6),
    db.select({ id: s.trucks.id, unit: s.trucks.unitNumber, status: s.trucks.status }).from(s.trucks).where(and(eq(s.trucks.tenantId, T), isNull(s.trucks.archivedAt), or(has(s.trucks.unitNumber, like), has(s.trucks.usPlate, like), has(s.trucks.mxPlate, like), has(s.trucks.vin, like)))).limit(5),
    db.select({ id: s.trailers.id, unit: s.trailers.unitNumber }).from(s.trailers).where(and(eq(s.trailers.tenantId, T), isNull(s.trailers.archivedAt), or(has(s.trailers.unitNumber, like), has(s.trailers.usPlate, like)))).limit(5),
    db.select({ id: s.drivers.id, name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(and(eq(s.drivers.tenantId, T), isNull(s.drivers.archivedAt), or(has(s.drivers.name, like), has(s.drivers.phone, like)))).limit(5),
    db.select({ id: s.customers.id, name: s.customers.name, kind: s.customers.kind }).from(s.customers).where(and(eq(s.customers.tenantId, T), isNull(s.customers.archivedAt), has(s.customers.name, like))).limit(5),
    db.select({ id: s.carriers.id, name: s.carriers.name, mc: s.carriers.mcNumber }).from(s.carriers).where(and(eq(s.carriers.tenantId, T), isNull(s.carriers.archivedAt), or(has(s.carriers.name, like), has(s.carriers.mcNumber, like), has(s.carriers.dotNumber, like)))).limit(5),
  ]);
  const [invoices, credits, bills, pays, receiptRows] = money
    ? await Promise.all([
        db.select({ id: s.invoices.id, number: s.invoices.number, state: s.invoices.state, totalCents: s.invoices.totalCents, currency: s.invoices.currency, cust: s.customers.name }).from(s.invoices).leftJoin(s.customers, eq(s.customers.id, s.invoices.customerId)).where(and(eq(s.invoices.tenantId, T), has(s.invoices.number, like))).orderBy(desc(s.invoices.createdAt)).limit(6),
        db.select({ id: s.creditMemos.id, number: s.creditMemos.number, invoiceId: s.creditMemos.invoiceId, amountCents: s.creditMemos.amountCents, reason: s.creditMemos.reason }).from(s.creditMemos).where(and(eq(s.creditMemos.tenantId, T), has(s.creditMemos.number, like))).limit(5),
        db.select({ id: s.carrierBills.id, number: s.carrierBills.carrierInvoiceNumber, orderId: s.carrierBills.orderId, state: s.carrierBills.state, carrier: s.carriers.name, num: s.orders.orderNumber }).from(s.carrierBills).innerJoin(s.carriers, eq(s.carriers.id, s.carrierBills.carrierId)).innerJoin(s.orders, eq(s.orders.id, s.carrierBills.orderId)).where(and(eq(s.carrierBills.tenantId, T), or(has(s.carrierBills.carrierInvoiceNumber, like), has(s.carrierBills.reference, like)))).limit(5),
        db.select({ id: s.payments.id, reference: s.payments.reference, customerId: s.payments.customerId, amountCents: s.payments.amountCents, currency: s.payments.currency, cust: s.customers.name }).from(s.payments).leftJoin(s.customers, eq(s.customers.id, s.payments.customerId)).where(and(eq(s.payments.tenantId, T), or(has(s.payments.reference, like), has(s.payments.remittance, like)))).orderBy(desc(s.payments.receivedAt)).limit(5),
        db.select({ id: s.receipts.id, reference: s.receipts.reference, invoiceId: s.receipts.invoiceId, amountCents: s.receipts.amountCents, number: s.invoices.number, currency: s.invoices.currency }).from(s.receipts).innerJoin(s.invoices, eq(s.invoices.id, s.receipts.invoiceId)).where(and(eq(s.receipts.tenantId, T), isNull(s.receipts.paymentId), has(s.receipts.reference, like))).limit(5),
      ])
    : [[], [], [], [], []];

  const refText = (refs: Record<string, string> | null) =>
    Object.entries(refs ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.replace(/_/g, " ").toUpperCase()} ${v}`)
      .join(" · ");
  const loadHref = (id: string, kind: string) => (kind === "trip" ? `/trips/${id}` : `/orders/${id}`);
  const cents = (c: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(c / 100);
  const seen = new Set<string>();
  const loads: SearchHit[] = [];
  const addLoad = (o: { id: string; num: string; state: string; refs: Record<string, string> | null; kind: string }, why: string | null) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    loads.push({ kind: "load", id: o.id, title: o.num, sub: [why, o.state.replace(/_/g, " "), refText(o.refs)].filter(Boolean).join(" · "), href: loadHref(o.id, o.kind) });
  };
  for (const o of orders) addLoad(o, o.cust);
  for (const o of byCrossing) addLoad(o, [o.caja && fold(o.caja).includes(term) ? `caja ${o.caja}` : null, o.seal && fold(o.seal).includes(term) ? `seal ${o.seal}` : null].filter(Boolean).join(" · ") || `caja ${o.caja ?? "—"}`);
  for (const o of byTender) addLoad(o, [o.driverName ? `carrier driver ${o.driverName}` : null, o.unit ? `unit ${o.unit}` : null, o.caja ? `caja ${o.caja}` : null].filter(Boolean).join(" · "));
  for (const o of byStop) addLoad(o, `stop ${o.stop}`);
  // documents point at a load or a crossing
  if (byDoc.length) {
    const crossingIds = byDoc.filter((d) => d.subjectKind === "crossing").map((d) => d.subjectId);
    const legIds = byDoc.filter((d) => d.subjectKind === "leg").map((d) => d.subjectId);
    const [xs, lgs] = await Promise.all([
      crossingIds.length ? db.select({ id: s.crossings.id, orderId: s.crossings.orderId }).from(s.crossings).where(and(eq(s.crossings.tenantId, T), inArray(s.crossings.id, crossingIds))) : [],
      legIds.length ? db.select({ id: s.legs.id, orderId: s.legs.orderId }).from(s.legs).where(and(eq(s.legs.tenantId, T), inArray(s.legs.id, legIds))) : [],
    ]);
    const orderOf = (d: (typeof byDoc)[number]) => (d.subjectKind === "order" ? d.subjectId : d.subjectKind === "crossing" ? xs.find((x) => x.id === d.subjectId)?.orderId : lgs.find((x) => x.id === d.subjectId)?.orderId);
    const ids = [...new Set(byDoc.map(orderOf).filter((x): x is string => !!x))];
    const os = ids.length ? await db.select(loadCols).from(s.orders).where(and(eq(s.orders.tenantId, T), inArray(s.orders.id, ids))) : [];
    for (const d of byDoc) {
      const o = os.find((x) => x.id === orderOf(d));
      if (!o) continue;
      const what = `${(d.code ?? "document").replace(/_/g, " ").toUpperCase()}${d.number ? ` ${d.number}` : ""}`;
      if (d.subjectKind === "crossing" && !seen.has(o.id)) {
        seen.add(o.id);
        loads.push({ kind: "crossing", id: d.subjectId, title: o.num, sub: `${what} · crossing`, href: `/crossing/${d.subjectId}` });
      } else addLoad(o, what);
    }
  }
  const hits: SearchHit[] = [];
  hits.push(...customers.map((c) => ({ kind: "customer" as const, id: c.id, title: c.name, sub: c.kind === "broker" ? "broker" : "customer", href: `/settings/customers/${c.id}` })));
  hits.push(...carriers.map((c) => ({ kind: "carrier" as const, id: c.id, title: c.name, sub: c.mc ? `MC ${c.mc}` : "carrier", href: `/settings/carriers/${c.id}` })));
  hits.push(...drivers.map((d) => ({ kind: "driver" as const, id: d.id, title: d.name, sub: d.phone ?? "driver", href: `/settings/drivers/${d.id}` })));
  hits.push(...trucks.map((t) => ({ kind: "truck" as const, id: t.id, title: `Unit ${t.unit}`, sub: t.status === "oos" ? "out of service" : "truck", href: `/settings/trucks/${t.id}` })));
  hits.push(...trailers.map((t) => ({ kind: "trailer" as const, id: t.id, title: `Trailer ${t.unit}`, sub: "trailer", href: `/settings/trailers/${t.id}` })));
  hits.push(...loads);
  hits.push(...invoices.map((i) => ({ kind: "invoice" as const, id: i.id, title: i.number ?? "draft", sub: [i.cust, i.state, cents(i.totalCents, i.currency)].filter(Boolean).join(" · "), href: `/billing/invoices/${i.id}` })));
  hits.push(...credits.map((c) => ({ kind: "credit" as const, id: c.id, title: c.number, sub: `credit memo · ${cents(c.amountCents)} · ${c.reason}`, href: `/billing/invoices/${c.invoiceId}` })));
  hits.push(...bills.map((b) => ({ kind: "bill" as const, id: b.id, title: b.number ?? b.num, sub: `${b.carrier} bill · ${b.num} · ${b.state}`, href: `/orders/${b.orderId}?tab=money` })));
  hits.push(...pays.map((p) => ({ kind: "payment" as const, id: p.id, title: p.reference ?? "payment", sub: [p.cust, cents(p.amountCents, p.currency)].filter(Boolean).join(" · "), href: `/billing/payments?customer=${p.customerId}` })));
  hits.push(...receiptRows.map((r) => ({ kind: "payment" as const, id: r.id, title: r.reference ?? "receipt", sub: `paid on ${r.number ?? "invoice"} · ${cents(r.amountCents, r.currency)}`, href: `/billing/invoices/${r.invoiceId}` })));
  return hits;
}
