import { and, eq, inArray, desc, sql, or } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { LEG_LABEL } from "./states";

const OPEN: s.LegState[] = ["planned", "dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"];
const TYPE: Record<string, string> = { mx: "Mexico", ca: "Canada", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };

/**
 * Where every trailer (caja) is: on which load right now, or where it was last dropped and for how long.
 * A trailer is on a leg when the leg names it, or when the crossing names its unit number (dispatch types
 * the caja on the crossing workbench). Idle days are what cost money at the yard.
 */
export async function trailerBoard(ctx: Ctx, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "records.view");
  const trailers = await db.select().from(s.trailers).where(and(eq(s.trailers.tenantId, ctx.tenantId), sql`${s.trailers.archivedAt} is null`));
  if (!trailers.length) return [];
  const numbers = trailers.map((t) => t.unitNumber);
  const [legRows, crossingRows] = await Promise.all([
    db
      .select({ leg: s.legs, orderNumber: s.orders.orderNumber })
      .from(s.legs)
      .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
      .where(and(eq(s.legs.tenantId, ctx.tenantId), or(inArray(s.legs.trailerId, trailers.map((t) => t.id)), sql`false`)))
      .orderBy(desc(s.legs.updatedAt))
      .limit(2000),
    db
      .select({ crossing: s.crossings, leg: s.legs, orderNumber: s.orders.orderNumber })
      .from(s.crossings)
      .innerJoin(s.legs, eq(s.legs.id, s.crossings.legId))
      .innerJoin(s.orders, eq(s.orders.id, s.crossings.orderId))
      .where(and(eq(s.crossings.tenantId, ctx.tenantId), inArray(s.crossings.trailerNumber, numbers)))
      .orderBy(desc(s.crossings.updatedAt))
      .limit(2000),
  ]);
  const stopIds = [...new Set([...legRows, ...crossingRows].flatMap((r) => [r.leg.fromStopId, r.leg.toStopId]).filter((x): x is string => !!x))];
  const stops = stopIds.length ? await db.select({ id: s.stops.id, name: s.stops.name, arrivedAt: s.stops.arrivedAt, departedAt: s.stops.departedAt }).from(s.stops).where(inArray(s.stops.id, stopIds)) : [];
  const stopById = new Map(stops.map((x) => [x.id, x]));
  return trailers
    .map((t) => {
      // a caja named on a live crossing is on that load even before the crossing leg is assigned: it is sitting at the yard for it
      const mine = [
        ...legRows.filter((r) => r.leg.trailerId === t.id).map((r) => ({ leg: r.leg, orderNumber: r.orderNumber, live: OPEN.includes(r.leg.state) })),
        ...crossingRows.filter((r) => r.crossing.trailerNumber === t.unitNumber).map((r) => ({ leg: r.leg, orderNumber: r.orderNumber, live: !["completed", "cancelled"].includes(r.leg.state) && !["cleared", "cancelled"].includes(r.crossing.state) })),
      ];
      const seen = new Set<string>();
      const uniq = mine.filter((r) => (seen.has(r.leg.id) ? false : (seen.add(r.leg.id), true)));
      const current = uniq.find((r) => r.live) ?? null;
      const last = uniq.filter((r) => r.leg.state === "completed").sort((p, q) => (q.leg.completedAt?.getTime() ?? 0) - (p.leg.completedAt?.getTime() ?? 0))[0] ?? null;
      const lastStop = last ? stopById.get(last.leg.toStopId ?? "") : undefined;
      const lastAt = last?.leg.completedAt ?? null;
      const idleDays = !current && lastAt ? Math.floor((now.getTime() - lastAt.getTime()) / 86400_000) : null;
      const from = current ? stopById.get(current.leg.fromStopId ?? "") : undefined;
      const to = current ? stopById.get(current.leg.toStopId ?? "") : undefined;
      return {
        id: t.id,
        unitNumber: t.unitNumber,
        kind: t.kind,
        lengthFt: t.lengthFt,
        usPlate: t.usPlate,
        status: t.status,
        inspectionExpires: t.inspectionExpires,
        now: current ? { orderId: current.leg.orderId, orderNumber: current.orderNumber, legType: TYPE[current.leg.type] ?? current.leg.type, state: LEG_LABEL[current.leg.state], route: `${from?.name ?? "?"} → ${to?.name ?? "?"}` } : null,
        last: last ? { orderNumber: last.orderNumber, where: lastStop?.name ?? null, at: lastAt } : null,
        idleDays,
        loads: uniq.length,
      };
    })
    .sort((p, q) => (p.now ? 0 : 1) - (q.now ? 0 : 1) || (q.idleDays ?? -1) - (p.idleDays ?? -1) || p.unitNumber.localeCompare(q.unitNumber, undefined, { numeric: true }));
}
