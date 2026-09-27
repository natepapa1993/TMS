import Link from "next/link";
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
import { trailerBoard } from "@/domain/fleet";
import { Trailers } from "./trailers";

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
  const [cajas, trailerRefs] = await Promise.all([trailerBoard(ctx), loadRefs(ctx, "trailer")]);
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
            <span className="inline-flex rounded-lg border border-line bg-white p-0.5">
              <span className="px-3.5 h-8 grid place-items-center rounded-md text-[13px] font-semibold bg-navy text-white">Units</span>
              <Link href="/fleet/map" className="px-3.5 h-8 grid place-items-center rounded-md text-[13px] font-semibold text-muted hover:text-ink">
                Map
              </Link>
            </span>
            <QuickAdd kind="driver" fields={FIELDS.driver} refs={driverRefs.options} label="Add driver" buttonClass="btn" />
            <QuickAdd kind="truck" fields={FIELDS.truck} refs={truckRefs.options} label="Add truck" />
          </>
        }
      >
        {units.length} units · {units.filter((u) => u.status === "oos").length} out of service · {drivers.length} drivers · {trailers.length} trailers
      </PageHeader>
      <div className="px-7 pb-10">
        <FleetBoard units={units} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name), driverType: String(d.driverType), currentTruckId: (d.currentTruckId as string | null) ?? null }))} />
        <div className="flex items-end justify-between mt-10 mb-3">
          <div>
            <div className="eyebrow">Trailers · cajas</div>
            <div className="h2">Trailers</div>
            <div className="text-muted text-[13px]">On a load now, or where it was last dropped and for how long. Dispatch names the caja on the crossing; a leg can name it too.</div>
          </div>
          <QuickAdd kind="trailer" fields={FIELDS.trailer} refs={trailerRefs.options} label="Add trailer" buttonClass="btn" />
        </div>
        <Trailers rows={JSON.parse(JSON.stringify(cajas))} />
      </div>
    </div>
  );
}
