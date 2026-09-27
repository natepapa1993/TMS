import { requireCtx } from "@/lib/auth";
import { list } from "@/data/records";
import { db } from "@/db/client";
import { legs, orders } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { FleetBoard } from "./board";
import { FIELDS } from "@/data/fields";
import { loadRefs } from "@/data/refs";
import { QuickAdd } from "../settings/[kind]/quick-add";

export const metadata = { title: "Fleet" };
export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const ctx = await requireCtx();
  const [trucks, drivers, trailers, active, truckRefs, driverRefs] = await Promise.all([
    list(ctx, "truck", { limit: 2000 }),
    list(ctx, "driver", { limit: 2000 }),
    list(ctx, "trailer", { limit: 2000 }),
    db
      .select({ truckId: legs.truckId, state: legs.state, orderNumber: orders.orderNumber, orderId: orders.id, type: legs.type })
      .from(legs)
      .innerJoin(orders, eq(orders.id, legs.orderId))
      .where(and(eq(legs.tenantId, ctx.tenantId), inArray(legs.state, ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"]))),
    loadRefs(ctx, "truck"),
    loadRefs(ctx, "driver"),
  ]);
  const byTruck = new Map<string, typeof active>();
  for (const a of active) if (a.truckId) byTruck.set(a.truckId, [...(byTruck.get(a.truckId) ?? []), a]);
  const units = trucks
    .map((t) => ({
      id: t.id,
      unitNumber: String(t.unitNumber),
      equipmentType: String(t.equipmentType),
      usPlate: (t.usPlate as string | null) ?? null,
      mxPlate: (t.mxPlate as string | null) ?? null,
      mxPlateClass: (t.mxPlateClass as string | null) ?? null,
      status: String(t.status),
      oosReason: (t.oosReason as string | null) ?? null,
      oosUntil: t.oosUntil ? String(t.oosUntil) : null,
      dotInspectionExpires: t.dotInspectionExpires ? String(t.dotInspectionExpires) : null,
      usPlateExpires: t.usPlateExpires ? String(t.usPlateExpires) : null,
      mxPlateExpires: t.mxPlateExpires ? String(t.mxPlateExpires) : null,
      drivers: drivers.filter((d) => d.currentTruckId === t.id).map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType) })),
      loads: (byTruck.get(t.id) ?? []).map((a) => ({ orderId: a.orderId, orderNumber: a.orderNumber, state: a.state, type: a.type })),
    }))
    .sort((p, q) => p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true }));
  return (
    <div>
      <PageHeader
        eyebrow="Fleet"
        title="Units"
        actions={
          <>
            <QuickAdd kind="driver" fields={FIELDS.driver} refs={driverRefs.options} label="Add driver" buttonClass="btn" />
            <QuickAdd kind="truck" fields={FIELDS.truck} refs={truckRefs.options} label="Add truck" />
          </>
        }
      >
        {units.length} units · {units.filter((u) => u.status === "oos").length} out of service · {drivers.length} drivers · {trailers.length} trailers
      </PageHeader>
      <div className="px-7 pb-10">
        <FleetBoard units={units} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType), currentTruckId: (d.currentTruckId as string | null) ?? null }))} />
      </div>
    </div>
  );
}
