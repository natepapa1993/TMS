import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { getOrder, orderTimeline } from "@/domain/orders";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { LEG_LABEL } from "@/domain/states";
import { formatCents } from "@/data/fields";
import { OrderEditor, StopEditor, OrderActions } from "./editor";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const LEG_TYPE_LABEL: Record<string, string> = { mx: "MX", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment" };
const STATE_LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const data = await getOrder(ctx, id).catch(() => null);
  if (!data) notFound();
  const { order, stops, legs } = data;
  const [tl, customers, entities, trucks, drivers, carriers, people] = await Promise.all([
    orderTimeline(ctx, id),
    list(ctx, "customer", { limit: 2000 }),
    list(ctx, "billingEntity", { limit: 100 }),
    list(ctx, "truck", { limit: 2000, archived: "all" }),
    list(ctx, "driver", { limit: 2000, archived: "all" }),
    list(ctx, "carrier", { limit: 2000, archived: "all" }),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId)),
  ]);
  const name = (rows: { id: string; [k: string]: unknown }[], key: string) => new Map(rows.map((r) => [r.id, String(r[key])]));
  const cName = name(customers, "name");
  const tName = name(trucks, "unitNumber");
  const dName = name(drivers, "name");
  const carName = name(carriers, "name");
  const who = new Map(people.map((p) => [p.id, p.name]));
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const readOnly = ["paid", "cancelled"].includes(order.state);

  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/orders" className="hover:text-teal">
            Orders
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <span className="mono">{order.orderNumber}</span>
            <Pill tone={order.state === "exception" ? "amber" : order.state === "cancelled" ? "slate" : order.state === "delivered" ? "green" : "teal"}>{STATE_LABEL[order.state]}</Pill>
          </span>
        }
        actions={<OrderActions order={JSON.parse(JSON.stringify(order))} />}
      >
        {cName.get(order.customerId ?? "") ?? cName.get(order.brokerId ?? "") ?? "No customer"} · {order.rateTbd || order.rateCents == null ? "rate TBD" : formatCents(order.rateCents, order.currency)}
        {order.holdReason ? ` · on hold: ${order.holdReason}` : ""}
        {order.cancelReason ? ` · cancelled: ${order.cancelReason}` : ""}
      </PageHeader>
      <div className="px-7 pb-10 grid grid-cols-[1fr_360px] gap-5 items-start">
        <div className="space-y-4">
          <div className="card p-5">
            <div className="h2 mb-3">Order</div>
            <OrderEditor order={JSON.parse(JSON.stringify(order))} customers={customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) }))} entities={entities.map((e) => ({ id: e.id, name: String(e.legalName) }))} readOnly={readOnly} />
          </div>
          <div className="card p-5">
            <div className="h2 mb-3">Stops</div>
            <div className="space-y-2">
              {stops.map((s, i) => (
                <StopEditor key={s.id} orderId={order.id} index={i} stop={JSON.parse(JSON.stringify(s))} readOnly={readOnly} />
              ))}
            </div>
          </div>
          <div className="card p-5">
            <div className="h2 mb-3">Legs</div>
            <table className="table -mx-5 w-[calc(100%+40px)]">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Type</th>
                  <th>From → To</th>
                  <th>Who</th>
                  <th>State</th>
                  <th>Sent</th>
                  <th>Done</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.seq}</td>
                    <td className="font-bold">{LEG_TYPE_LABEL[l.type]}</td>
                    <td>
                      {stopById.get(l.fromStopId ?? "")?.name} → {stopById.get(l.toStopId ?? "")?.name}
                    </td>
                    <td>
                      {l.assigneeKind === "truck" ? `Unit ${tName.get(l.truckId ?? "")}${l.driverId ? ` · ${dName.get(l.driverId)}` : ""}${l.coDriverId ? ` / ${dName.get(l.coDriverId)}` : ""}` : l.assigneeKind === "carrier" ? `${carName.get(l.carrierId ?? "")}${l.carrierRateCents != null ? ` · ${formatCents(l.carrierRateCents)}` : ""}` : <span className="text-faint">—</span>}
                    </td>
                    <td>
                      <Pill tone={l.state === "completed" ? "green" : l.state === "declined" ? "red" : l.state === "unassigned" ? "slate" : "teal"}>{LEG_LABEL[l.state]}</Pill>
                    </td>
                    <td className="text-muted text-[12.5px]">{l.dispatchedAt ? new Date(l.dispatchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                    <td className="text-muted text-[12.5px]">{l.completedAt ? new Date(l.completedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="help mt-2">
              Assign, send and advance legs from{" "}
              <Link href="/dispatch" className="text-teal font-semibold">
                Dispatch
              </Link>
              .
            </div>
          </div>
        </div>
        <aside className="space-y-4">
          {tl.flags.length > 0 && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Flags</div>
              <ul className="space-y-2">
                {tl.flags.map((f) => (
                  <li key={f.id} className="text-[12.5px]">
                    <span className={`pill ${f.clearedAt ? "pill-slate" : f.level === "red" ? "pill-red" : "pill-amber"}`}>{f.code}</span> <span className="font-semibold">{f.title}</span>
                    {f.detail && <div className="text-muted">{f.detail}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card p-4">
            <div className="eyebrow mb-2">Timeline</div>
            {tl.events.length === 0 ? (
              <div className="text-muted text-[13px]">Nothing has moved yet.</div>
            ) : (
              <ul className="space-y-2">
                {tl.events.map((e) => {
                  const leg = legs.find((l) => l.id === e.legId);
                  return (
                    <li key={e.id} className="text-[12.5px] flex gap-2">
                      <span className={`timeline-dot mt-1.5 ${e.verified ? "done" : ""}`} title={e.verified ? "Verified (GPS/app)" : "Reported"} />
                      <div>
                        <div>
                          <span className="font-bold">{leg ? `${LEG_TYPE_LABEL[leg.type]} leg` : "Leg"}</span> → {e.toState ? LEG_LABEL[e.toState as keyof typeof LEG_LABEL] : e.kind}
                          <span className="text-faint"> · {e.source.replace("_", " ")}</span>
                        </div>
                        <div className="text-muted">
                          {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {e.userId ? ` · ${who.get(e.userId) ?? ""}` : ""}
                          {e.note ? ` · ${e.note}` : ""}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="card p-4">
            <div className="eyebrow mb-2">History</div>
            <ul className="space-y-2">
              {tl.audits.map((h) => (
                <li key={h.id} className="text-[12.5px]">
                  <div className="flex justify-between gap-2">
                    <span className="font-bold capitalize">{h.action}</span>
                    <span className="text-faint whitespace-nowrap">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  <div className="text-muted">
                    {h.userId ? (who.get(h.userId) ?? "someone") : "system"}
                    {h.changes ? ` · ${Object.entries(h.changes).slice(0, 4).map(([k, c]) => `${k}: ${fmt(c.from)} → ${fmt(c.to)}`).join(" · ")}` : ""}
                    {h.note ? ` · ${h.note}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function fmt(v: unknown) {
  if (v == null || v === "") return "—";
  if (typeof v === "number" && v > 1000) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
