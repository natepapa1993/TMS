import { requireCtx } from "@/lib/auth";
import { board } from "@/domain/orders";
import { list } from "@/data/records";
import { LEG_TEMPLATES } from "@/domain/templates";
import { DispatchBoard, type BoardData } from "./board";

export const metadata = { title: "Dispatch" };
export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const ctx = await requireCtx();
  const [rows, customers, carriers, drivers, trucks] = await Promise.all([
    board(ctx),
    list(ctx, "customer", { limit: 2000 }),
    list(ctx, "carrier", { limit: 2000 }),
    list(ctx, "driver", { limit: 2000 }),
    list(ctx, "truck", { limit: 2000 }),
  ]);
  const custName = new Map(customers.map((c) => [c.id, String(c.name)]));
  const data: BoardData = {
    rows: rows.map((r) => ({
      ...JSON.parse(JSON.stringify(r)),
      customerName: r.order.customerId ? (custName.get(r.order.customerId) ?? null) : r.order.brokerId ? (custName.get(r.order.brokerId) ?? null) : null,
    })),
    customers: customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) })).sort((p, q) => p.name.localeCompare(q.name)),
    carriers: carriers.map((c) => ({ id: c.id, name: String(c.name), country: String(c.country), doNotUse: !!c.doNotUse })).sort((p, q) => p.name.localeCompare(q.name)),
    drivers: drivers.map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType), currentTruckId: (d.currentTruckId as string | null) ?? null })).sort((p, q) => p.name.localeCompare(q.name)),
    trucks: trucks.map((t) => ({ id: t.id, unitNumber: String(t.unitNumber), status: String(t.status) })).sort((p, q) => p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true })),
    templates: LEG_TEMPLATES.map((t) => ({ key: t.key, label: t.label, description: t.description })),
    role: ctx.role,
  };
  return <DispatchBoard data={data} />;
}
