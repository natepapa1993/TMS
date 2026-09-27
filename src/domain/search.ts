import { and, eq, ilike, or, sql, desc, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";

export type SearchHit = { kind: "load" | "truck" | "trailer" | "driver" | "customer" | "carrier"; id: string; title: string; sub: string; href: string };

/**
 * One search box for the whole company: load number, any reference on a load (PO, BOL, customer load #,
 * rate con, caja), the city of a stop, a unit, a trailer, a driver, a customer, a carrier.
 */
export async function searchAll(ctx: Ctx, q: string): Promise<SearchHit[]> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const [orders, byStop, trucks, trailers, drivers, customers, carriers] = await Promise.all([
    db
      .select({ id: s.orders.id, num: s.orders.orderNumber, state: s.orders.state, refs: s.orders.refs, kind: s.orders.kind, cust: s.customers.name })
      .from(s.orders)
      .leftJoin(s.customers, eq(s.customers.id, s.orders.customerId))
      .where(and(eq(s.orders.tenantId, ctx.tenantId), or(ilike(s.orders.orderNumber, like), sql`${s.orders.refs}::text ilike ${like}`, ilike(s.customers.name, like))))
      .orderBy(desc(s.orders.createdAt))
      .limit(12),
    db
      .selectDistinct({ id: s.orders.id, num: s.orders.orderNumber, state: s.orders.state, refs: s.orders.refs, kind: s.orders.kind, stop: s.stops.name, createdAt: s.orders.createdAt })
      .from(s.stops)
      .innerJoin(s.orders, eq(s.orders.id, s.stops.orderId))
      .where(and(eq(s.stops.tenantId, ctx.tenantId), or(ilike(s.stops.name, like), sql`${s.stops.address}->>'city' ilike ${like}`, sql`${s.stops.refs}::text ilike ${like}`)))
      .orderBy(desc(s.orders.createdAt))
      .limit(8),
    db.select({ id: s.trucks.id, unit: s.trucks.unitNumber, status: s.trucks.status }).from(s.trucks).where(and(eq(s.trucks.tenantId, ctx.tenantId), isNull(s.trucks.archivedAt), or(ilike(s.trucks.unitNumber, like), ilike(s.trucks.usPlate, like), ilike(s.trucks.vin, like)))).limit(5),
    db.select({ id: s.trailers.id, unit: s.trailers.unitNumber }).from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), isNull(s.trailers.archivedAt), or(ilike(s.trailers.unitNumber, like), ilike(s.trailers.usPlate, like)))).limit(5),
    db.select({ id: s.drivers.id, name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt), or(ilike(s.drivers.name, like), ilike(s.drivers.phone, like)))).limit(5),
    db.select({ id: s.customers.id, name: s.customers.name, kind: s.customers.kind }).from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), isNull(s.customers.archivedAt), ilike(s.customers.name, like))).limit(5),
    db.select({ id: s.carriers.id, name: s.carriers.name, mc: s.carriers.mcNumber }).from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), isNull(s.carriers.archivedAt), or(ilike(s.carriers.name, like), ilike(s.carriers.mcNumber, like), ilike(s.carriers.dotNumber, like)))).limit(5),
  ]);
  const refText = (refs: Record<string, string> | null) =>
    Object.entries(refs ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.replace(/_/g, " ").toUpperCase()} ${v}`)
      .join(" · ");
  const loadHref = (id: string, kind: string) => (kind === "trip" ? `/trips/${id}` : `/orders/${id}`);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const o of orders) {
    seen.add(o.id);
    hits.push({ kind: "load", id: o.id, title: o.num, sub: [o.cust, o.state.replace(/_/g, " "), refText(o.refs)].filter(Boolean).join(" · "), href: loadHref(o.id, o.kind) });
  }
  for (const o of byStop) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    hits.push({ kind: "load", id: o.id, title: o.num, sub: [`stop ${o.stop}`, o.state.replace(/_/g, " "), refText(o.refs)].filter(Boolean).join(" · "), href: loadHref(o.id, o.kind) });
  }
  hits.push(...trucks.map((t) => ({ kind: "truck" as const, id: t.id, title: `Unit ${t.unit}`, sub: t.status === "oos" ? "out of service" : "truck", href: `/settings/trucks/${t.id}` })));
  hits.push(...trailers.map((t) => ({ kind: "trailer" as const, id: t.id, title: `Trailer ${t.unit}`, sub: "trailer", href: `/settings/trailers/${t.id}` })));
  hits.push(...drivers.map((d) => ({ kind: "driver" as const, id: d.id, title: d.name, sub: d.phone ?? "driver", href: `/settings/drivers/${d.id}` })));
  hits.push(...customers.map((c) => ({ kind: "customer" as const, id: c.id, title: c.name, sub: c.kind === "broker" ? "broker" : "customer", href: `/settings/customers/${c.id}` })));
  hits.push(...carriers.map((c) => ({ kind: "carrier" as const, id: c.id, title: c.name, sub: c.mc ? `MC ${c.mc}` : "carrier", href: `/settings/carriers/${c.id}` })));
  return hits;
}
