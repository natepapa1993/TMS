import { requireCtx } from "@/lib/auth";
import { board, type BoardRow } from "@/domain/orders";
import { list } from "@/data/records";
import { DispatchBoard, type BoardData, type Row } from "./board";
import { openTendersForOrders } from "@/domain/tenders";
import { publicUrl } from "@/lib/tokens";
import { ediInbox } from "@/domain/edi";
import { openPortalRequests } from "@/domain/customer-portal";
import { inbox as messageInbox } from "@/domain/messaging";
import { boardEtas } from "@/domain/tracking";
import { mailInbox } from "@/domain/mail";

export const metadata = { title: "Dispatch" };
export const dynamic = "force-dynamic";

export default async function DispatchPage({ searchParams }: PageProps<"/dispatch">) {
  const sp = await searchParams;
  const initialOrder = typeof sp.order === "string" ? sp.order : undefined;
  const ctx = await requireCtx();
  const [rows, customers, carriers, drivers, trucks] = await Promise.all([
    board(ctx),
    list(ctx, "customer", { limit: 2000 }),
    list(ctx, "carrier", { limit: 2000 }),
    list(ctx, "driver", { limit: 2000 }),
    list(ctx, "truck", { limit: 2000 }),
  ]);
  const custName = new Map(customers.map((c) => [c.id, String(c.name)]));
  const [tenderRows, inbox, msgs, requests, etas, mail] = await Promise.all([openTendersForOrders(ctx, rows.map((r) => r.order.id)), ediInbox(ctx), messageInbox(ctx, { limit: 50 }), openPortalRequests(ctx), boardEtas(ctx), mailInbox(ctx, { limit: 50 })]);
  const carrierName = new Map(carriers.map((c) => [c.id, String(c.name)]));
  const data: BoardData = {
    rows: rows.map((r) => ({
      ...slim(r),
      customerName: r.order.customerId ? (custName.get(r.order.customerId) ?? null) : r.order.brokerId ? (custName.get(r.order.brokerId) ?? null) : null,
      tenders: tenderRows
        .filter((t) => t.orderId === r.order.id)
        .map((t) => ({ id: t.id, legId: t.legId, carrierId: t.carrierId, carrierName: carrierName.get(t.carrierId) ?? "carrier", state: t.state === "sent" && t.expiresAt.getTime() < Date.now() ? "expired" : t.state, channel: t.channel, sentTo: t.sentTo, expiresAt: t.expiresAt.toISOString(), respondedAt: t.respondedAt?.toISOString() ?? null, respondedBy: t.respondedBy, responseNote: t.responseNote, driverName: t.driverName, driverPhone: t.driverPhone, unitNumber: t.unitNumber, rateCents: t.rateCents, link: publicUrl(`/t/${t.token}`), delivery: t.delivery })),
    })),
    customers: customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind), note: (c.knowledgeMd as string | null) ?? null })).sort((p, q) => p.name.localeCompare(q.name)),
    carriers: carriers.map((c) => ({ id: c.id, name: String(c.name), country: String(c.country), doNotUse: !!c.doNotUse })).sort((p, q) => p.name.localeCompare(q.name)),
    drivers: drivers.map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType), currentTruckId: (d.currentTruckId as string | null) ?? null })).sort((p, q) => p.name.localeCompare(q.name)),
    trucks: trucks.map((t) => ({ id: t.id, unitNumber: String(t.unitNumber), status: String(t.status) })).sort((p, q) => p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true })),
    role: ctx.role,
    ediInbox: inbox.length,
    messages: msgs.filter((m) => !m.m.handledAt).length + mail.length,
    requests,
    etas,
  };
  return <DispatchBoard data={data} initialOrder={initialOrder} />;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** Only what the board draws. The full rows are ~4 KB each; a busy week is a thousand of them, and the board is a client component. */
function slim(r: BoardRow): Omit<Row, "customerName" | "tenders"> {
  const o = r.order;
  return {
    order: { id: o.id, orderNumber: o.orderNumber, state: o.state, kind: o.kind, rateCents: o.rateCents, rateTbd: o.rateTbd, currency: o.currency, equipment: o.equipment, refs: o.refs ?? {}, holdReason: o.holdReason, legTemplate: o.legTemplate, customerId: o.customerId, brokerId: o.brokerId },
    stops: r.stops.map((st) => ({ id: st.id, seq: st.seq, type: st.type, name: st.name, country: st.country, windowStart: iso(st.windowStart), windowEnd: iso(st.windowEnd), arrivedAt: iso(st.arrivedAt), departedAt: iso(st.departedAt), address: st.address ? { city: st.address.city, state: st.address.state } : null })),
    legs: r.legs.map((l) => ({ id: l.id, seq: l.seq, type: l.type, state: l.state, assigneeKind: l.assigneeKind, truckId: l.truckId, driverId: l.driverId, coDriverId: l.coDriverId, carrierId: l.carrierId, carrierRateCents: l.carrierRateCents, plannedMiles: l.plannedMiles, fromStopId: l.fromStopId, toStopId: l.toStopId, truckUnit: l.truckUnit, driverName: l.driverName, carrierName: l.carrierName, declineReason: l.declineReason, dispatchedAt: iso(l.dispatchedAt), completedAt: iso(l.completedAt) })),
    openFlags: r.openFlags.map((f) => ({ id: f.id, code: f.code, level: f.level, title: f.title, detail: f.detail, legId: f.legId })),
    stage: r.stage,
    shipments: r.shipments,
  };
}
