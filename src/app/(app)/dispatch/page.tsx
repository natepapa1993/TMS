import { requireCtx } from "@/lib/auth";
import { canSeeMoney } from "@/domain/money-visibility";
import { board, type BoardRow } from "@/domain/orders";
import { list } from "@/data/records";
import { DispatchBoard, type BoardData, type Row } from "./board";
import { openTendersForOrders } from "@/domain/tenders";
import { publicUrl } from "@/lib/tokens";
import { ediInbox } from "@/domain/edi";
import { openPortalRequests } from "@/domain/customer-portal";
import { inbox as messageInbox } from "@/domain/messaging";
import { boardEtas, lastPings } from "@/domain/tracking";
import { mergeCallEtas, type BucketKey, type AlertKey, BUCKETS, ALERTS } from "@/domain/board-buckets";
import { lastCheckCalls } from "@/domain/check-calls";
import { db } from "@/db/client";
import { tenants, documents } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { mailInbox } from "@/domain/mail";

export const metadata = { title: "Dispatch" };
export const dynamic = "force-dynamic";

export default async function DispatchPage({ searchParams }: PageProps<"/dispatch">) {
  const sp = await searchParams;
  const initialOrder = typeof sp.order === "string" ? sp.order : undefined;
  // links from the owner's Today page land on a filtered board: ?bucket=needs, ?chip=late
  const initialBucket = typeof sp.bucket === "string" && BUCKETS.some((b) => b.key === sp.bucket) ? (sp.bucket as BucketKey) : undefined;
  const initialChip = typeof sp.chip === "string" && ALERTS.some((a) => a.key === sp.chip) ? (sp.chip as AlertKey) : undefined;
  const ctx = await requireCtx();
  const showMoney = await canSeeMoney(ctx); // the owner can hide the customer's rate from dispatchers
  const [rows, customers, carriers, drivers, trucks, trailers, [tenant], locations] = await Promise.all([
    board(ctx),
    list(ctx, "customer", { limit: 2000 }),
    list(ctx, "carrier", { limit: 2000 }),
    list(ctx, "driver", { limit: 2000 }),
    list(ctx, "truck", { limit: 2000 }),
    list(ctx, "trailer", { limit: 2000 }),
    db.select({ zone: tenants.timeZone }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1),
    list(ctx, "location", { limit: 2000 }),
  ]);
  const custName = new Map(customers.map((c) => [c.id, String(c.name)]));
  const [tenderRows, inbox, msgs, requests, etas, mail, pings, calls] = await Promise.all([openTendersForOrders(ctx, rows.map((r) => r.order.id)), ediInbox(ctx), messageInbox(ctx, { limit: 50 }), openPortalRequests(ctx), boardEtas(ctx), mailInbox(ctx, { limit: 50 }), lastPings(ctx), lastCheckCalls(ctx, rows.map((r) => r.order.id))]);
  const carrierName = new Map(carriers.map((c) => [c.id, String(c.name)]));
  const slimRows = rows.map((r) => slim(r, showMoney));
  // the dispatcher's ETA from a check call stands until a newer GPS position (M6)
  const callEtas = Object.fromEntries([...calls].map(([k, c]) => [k, { at: c.at.toISOString(), etaAt: c.etaAt?.toISOString() ?? null, legId: c.legId }]));
  const mergedEtas = mergeCallEtas(slimRows, Object.fromEntries(Object.entries(etas).map(([k, e]) => [k, { ...e, source: "gps" as const }])), callEtas);
  // delivered loads with no POD yet: the board says so and offers "bill without POD" (M14)
  const deliveredIds = rows.filter((r) => r.order.state === "delivered" && !r.order.tonu).map((r) => r.order.id);
  const pods = deliveredIds.length ? await db.select({ subjectId: documents.subjectId }).from(documents).where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.subjectKind, "order"), eq(documents.code, "POD"), inArray(documents.subjectId, deliveredIds), inArray(documents.status, ["present", "verified"]))) : [];
  const withPod = new Set(pods.map((p) => p.subjectId));
  const data: BoardData = {
    rows: rows.map((r, i) => ({
      ...slimRows[i],
      podMissing: r.order.state === "delivered" && !r.order.tonu && r.order.kind !== "trip" && !withPod.has(r.order.id) && !(r.order.custom as { podWaived?: unknown } | null)?.podWaived,
      customerName: r.order.customerId ? (custName.get(r.order.customerId) ?? null) : r.order.brokerId ? (custName.get(r.order.brokerId) ?? null) : null,
      tenders: tenderRows
        .filter((t) => t.orderId === r.order.id)
        .map((t) => ({ id: t.id, legId: t.legId, carrierId: t.carrierId, carrierName: carrierName.get(t.carrierId) ?? "carrier", state: t.state === "sent" && t.expiresAt.getTime() < Date.now() ? "expired" : t.state, channel: t.channel, sentTo: t.sentTo, expiresAt: t.expiresAt.toISOString(), respondedAt: t.respondedAt?.toISOString() ?? null, respondedBy: t.respondedBy, responseNote: t.responseNote, driverName: t.driverName, driverPhone: t.driverPhone, unitNumber: t.unitNumber, rateCents: t.rateCents, link: publicUrl(`/t/${t.token}`), delivery: t.delivery })),
    })),
    customers: customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind), note: (c.knowledgeMd as string | null) ?? null })).sort((p, q) => p.name.localeCompare(q.name)),
    carriers: carriers.map((c) => ({ id: c.id, name: String(c.name), country: String(c.country), kind: (c.kind as string | null) ?? null, whatsapp: (c.whatsapp as string | null) ?? null, dispatchEmail: (c.dispatchEmail as string | null) ?? null, doNotUse: !!c.doNotUse })).sort((p, q) => p.name.localeCompare(q.name)),
    drivers: drivers.map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType), currentTruckId: (d.currentTruckId as string | null) ?? null })).sort((p, q) => p.name.localeCompare(q.name)),
    trucks: trucks.map((t) => ({ id: t.id, unitNumber: String(t.unitNumber), status: String(t.status) })).sort((p, q) => p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true })),
    role: ctx.role,
    ediInbox: inbox.length,
    messages: msgs.filter((m) => !m.m.handledAt).length + mail.length,
    requests,
    etas: mergedEtas,
    zone: tenant?.zone ?? "America/Chicago",
    pings,
    lastCalls: Object.fromEntries([...calls].map(([k, c]) => [k, { at: c.at.toISOString(), status: c.status, location: c.location, note: c.note, etaAt: c.etaAt?.toISOString() ?? null, legId: c.legId }])),
    locations: locations.map((l) => ({ id: l.id, name: String(l.name), kind: String(l.kind), country: String(l.country), city: ((l.address as { city?: string } | null)?.city ?? null) as string | null })).sort((p, q) => p.name.localeCompare(q.name)),
    trailers: trailers.map((t) => ({ id: t.id, unitNumber: String(t.unitNumber), status: String(t.status ?? "active") })).sort((p, q) => p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true })),
    fx: await (async () => {
      const [{ getCompany }, { pickRate }] = await Promise.all([import("@/domain/company"), import("@/domain/fx-rules")]);
      const fx = (await getCompany(ctx)).settings.fx;
      return { MXN: pickRate("MXN", null, fx).rateE4, CAD: pickRate("CAD", null, fx).rateE4 };
    })(),
  };
  return <DispatchBoard data={data} initialOrder={initialOrder} initialBucket={initialBucket} initialChip={initialChip} />;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** Only what the board draws. The full rows are ~4 KB each; a busy week is a thousand of them, and the board is a client component. */
function slim(r: BoardRow, showMoney = true): Omit<Row, "customerName" | "tenders" | "podMissing"> {
  const o = r.order;
  return {
    order: { id: o.id, orderNumber: o.orderNumber, state: o.state, kind: o.kind, rateCents: showMoney ? o.rateCents : null, rateTbd: o.rateTbd, currency: o.currency, equipment: o.equipment, refs: o.refs ?? {}, holdReason: o.holdReason, legTemplate: o.legTemplate, customerId: o.customerId, brokerId: o.brokerId },
    stops: r.stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, country: st.country, windowStart: iso(st.windowStart), windowEnd: iso(st.windowEnd), arrivedAt: iso(st.arrivedAt), departedAt: iso(st.departedAt), address: st.address ? { city: st.address.city, state: st.address.state } : null })),
    legs: r.legs.map((l) => ({ id: l.id, seq: l.seq, type: l.type, state: l.state, assigneeKind: l.assigneeKind, truckId: l.truckId, trailerId: l.trailerId, trailerUnit: l.trailerUnit, driverId: l.driverId, coDriverId: l.coDriverId, carrierId: l.carrierId, carrierRateCents: l.carrierRateCents, plannedMiles: l.plannedMiles, carrierRateCurrency: l.carrierRateCurrency ?? "USD", estMiles: l.estMiles, fromStopId: l.fromStopId, toStopId: l.toStopId, truckUnit: l.truckUnit, driverName: l.driverName, carrierName: l.carrierName, declineReason: l.declineReason, dispatchedAt: iso(l.dispatchedAt), completedAt: iso(l.completedAt) })),
    openFlags: r.openFlags.map((f) => ({ id: f.id, code: f.code, level: f.level, title: f.title, detail: f.detail, legId: f.legId })),
    stage: r.stage,
    shipments: r.shipments,
  };
}
