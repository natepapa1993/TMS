import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { requireCtx } from "@/lib/auth";
import { getOrder, orderTimeline } from "@/domain/orders";
import { listNotes } from "@/domain/notes";
import { list } from "@/data/records";
import { Pill } from "@/components/ui";
import { LEG_LABEL } from "@/domain/states";
import { formatCents } from "@/data/fields";
import { OrderEditor, StopEditor, OrderActions, LegMiles, AddStop } from "./editor";
import { Charges } from "./charges";
import { LoadTabs, MoneyBox, PeopleCard, NotesPanel, DocumentsPanel, NOTE_LABEL } from "./load-page";
import { CheckCallBox } from "../../dispatch/check-call";
import { fmtWhen, stopZone } from "@/lib/time";
import type { Loc } from "@/components/stop-fields";
import { chargesFor, orderPnl, requiredRefsFor } from "@/domain/billing";
import { pickRate, toHome } from "@/domain/fx-rules";
import { db } from "@/db/client";
import { documents, users } from "@/db/schema";

export const dynamic = "force-dynamic";

const LEG_TYPE_LABEL: Record<string, string> = { mx: "MX", ca: "CA", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment" };
const STATE_LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };
const EQUIPMENT: Record<string, string> = { "53_dry": "53' dry van", "53_reefer": "53' reefer", "48_dry": "48' dry van", flatbed: "Flatbed", sprinter: "Sprinter", straight: "Straight truck", power_only: "Power only" };
/** Server rows → plain JSON for client components (dates become strings). */
const J = (v: unknown) => JSON.parse(JSON.stringify(v));

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const { timeZone: companyZone, settings: companySettings } = await (await import("@/domain/company")).getCompany(ctx);
  await (await import("@/domain/tenders")).expireTenders(new Date(), { tenantId: ctx.tenantId });
  const data = await getOrder(ctx, id).catch(() => null);
  if (!data) notFound();
  const { order, stops, legs } = data;
  // one clock rule: a stop's time on the stop's clock, anything else (sent, history) on the company's, always labelled
  const zoneOf = (st: (typeof stops)[number] | undefined | null) => (st ? stopZone(st, companyZone) : companyZone);
  const when = (d: Date | string | null | undefined, zone = companyZone) => fmtWhen(d, zone, { style: "short" }) ?? "—";
  const atStop = (d: Date | string | null | undefined, st: (typeof stops)[number] | undefined | null) => fmtWhen(d, zoneOf(st)) ?? "—";
  const [tl, customers, entities, trucks, drivers, carriers, people, locations, notes, docRows] = await Promise.all([
    orderTimeline(ctx, id),
    list(ctx, "customer", { limit: 2000 }),
    list(ctx, "billingEntity", { limit: 100 }),
    list(ctx, "truck", { limit: 2000, archived: "all" }),
    list(ctx, "driver", { limit: 2000, archived: "all" }),
    list(ctx, "carrier", { limit: 2000, archived: "all" }),
    db.select({ id: users.id, name: users.name, archivedAt: users.archivedAt }).from(users).where(eq(users.tenantId, ctx.tenantId)),
    list(ctx, "location", { limit: 2000 }),
    listNotes(ctx, id),
    db
      .select({ id: documents.id, code: documents.code, fileName: documents.fileName, status: documents.status, source: documents.source, createdAt: documents.createdAt, author: users.name })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.createdBy))
      .where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.subjectKind, "order"), eq(documents.subjectId, id), inArray(documents.status, ["present", "verified", "pending"]))),
  ]);
  const name = (rows: { id: string; [k: string]: unknown }[], key: string) => new Map(rows.map((r) => [r.id, String(r[key])]));
  const cName = name(customers, "name");
  const tName = name(trucks, "unitNumber");
  const dName = name(drivers, "name");
  const carName = name(carriers, "name");
  const who = new Map(people.map((p) => [p.id, p.name]));
  const billingView = ["owner", "billing", "dispatcher"].includes(ctx.role) && order.state !== "cancelled";
  const [chargeRows, pnl] = billingView ? await Promise.all([chargesFor(ctx, id), ["delivered", "ready_to_bill", "invoiced", "paid"].includes(order.state) ? orderPnl(ctx, id).catch(() => null) : Promise.resolve(null)]) : [[], null];
  const cust = customers.find((c) => c.id === (order.customerId ?? order.brokerId));
  const requiredDocs = ((cust?.requiredDocs as string[] | undefined) ?? ["POD", "BOL", "RATE_CON"]).filter((c) => !(order.tonu && ["POD", "BOL", "SEAL"].includes(c)));
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const closed = ["paid", "cancelled"].includes(order.state);
  const readOnly = closed || !!order.lockedAt;
  const restructure = !["delivered", "ready_to_bill", "invoiced", "paid", "cancelled"].includes(order.state) && order.kind !== "trip" && !order.lockedAt;
  const lastReached = stops.reduce((m, s, i) => (s.arrivedAt ? i : m), -1);

  // the header's numbers
  const pickup = stops.find((s) => s.type === "pickup") ?? stops[0];
  const delivery = [...stops].reverse().find((s) => s.type === "delivery") ?? stops[stops.length - 1];
  const place = (s: (typeof stops)[number] | undefined) => (s ? [s.address?.city, s.address?.state].filter(Boolean).join(", ") || s.name : "—");
  // typed miles, else the estimate from the stops, marked "est."
  const liveLegs = legs.filter((l) => l.state !== "cancelled");
  const milesKnown = liveLegs.some((l) => l.plannedMiles != null || l.estMiles != null);
  const miles = milesKnown ? liveLegs.reduce((a, l) => a + (l.plannedMiles ?? l.estMiles ?? 0), 0) : null;
  const milesEst = milesKnown && liveLegs.some((l) => l.plannedMiles == null);
  // money in USD: each carrier rate in its own currency (a Mexican carrier in pesos), converted; the load's rate at its rate
  const fxOf = (cur: string) => pickRate(cur, null, companySettings.fx).rateE4;
  const carrierCost = legs.filter((l) => l.state !== "cancelled").reduce((a, l) => a + toHome(l.carrierRateCents ?? 0, l.carrierRateCurrency ?? "USD", fxOf(l.carrierRateCurrency ?? "USD")), 0) + toHome(order.tollsFeesCents ?? 0, order.currency, fxOf(order.currency));
  const covered = legs.every((l) => !["unassigned", "declined"].includes(l.state));
  const rate = order.rateTbd ? null : order.rateCents;
  const rateUsd = rate == null ? null : toHome(rate, order.currency, fxOf(order.currency));
  // one margin everywhere: the same P&L as the Money tab (carriers, driver pay — estimated until a statement pays it — fuel, tolls), in USD
  const headPnl = rate != null && covered && ["owner", "dispatcher", "billing"].includes(ctx.role) ? await orderPnl(ctx, id).catch(() => null) : null;
  const margin = headPnl ? headPnl.margin : rateUsd != null && covered ? rateUsd - carrierCost : null;
  const fxHint = order.currency !== "USD" ? ` · in USD, ${order.currency} at ${((headPnl?.fx?.rateE4 ?? fxOf(order.currency)) / 10000).toFixed(4)}` : "";
  const weightLb = (order.freight ?? []).reduce((a, f) => a + (f.weightLb ?? 0), 0) || order.weightLbs || null;
  const facts: [string, string, string?][] = [
    ["Pickup", atStop(pickup?.windowStart ?? pickup?.windowEnd, pickup), place(pickup)],
    ["Delivery", atStop(delivery?.windowStart ?? delivery?.windowEnd, delivery), place(delivery)],
    ["Rate", rate == null ? "TBD" : formatCents(rate, order.currency), order.rateType !== "flat" && order.rateUnitCents != null ? `${formatCents(order.rateUnitCents, order.currency)} × ${order.rateQty ?? "?"}` : undefined],
    ["Carrier cost", carrierCost ? formatCents(headPnl ? headPnl.carrierCost + headPnl.extra : carrierCost, "USD") : "—", carrierCost && legs.some((l) => (l.carrierRateCurrency ?? "USD") !== "USD") ? "carriers paid in their own currency, shown in USD" : undefined],
    ["Margin", margin == null ? "—" : formatCents(margin, "USD"), margin != null && headPnl ? `${headPnl.marginPct}% after carriers, driver pay${headPnl.driverPayEstimated ? " (est.)" : ""}, fuel${fxHint}` : margin != null && rateUsd ? `${((margin / rateUsd) * 100).toFixed(1)}%${fxHint}` : covered ? undefined : "legs not covered yet"],
    ["Miles", miles == null ? "—" : `${miles.toLocaleString("en-US")}${milesEst ? " est." : ""}`, miles && rateUsd ? `${formatCents(Math.round(rateUsd / miles), "USD")} / mile${order.currency !== "USD" ? " (USD)" : ""}${milesEst ? " est." : ""}` : undefined],
  ];
  // where it is: the leg on the road, its last position and ETA, and the check calls
  const liveLeg = legs.find((l) => ["dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"].includes(l.state)) ?? null;
  const tracking = liveLeg
    ? await (async () => {
        const [{ lastSeen }, { boardEtas }] = await Promise.all([import("@/domain/check-calls"), import("@/domain/tracking")]);
        const [seen, etas] = await Promise.all([lastSeen(ctx, liveLeg), boardEtas(ctx)]);
        return { seen, seenMin: seen?.ageMin ?? null, eta: etas[liveLeg.id] ?? null };
      })()
    : null;
  const etaStop = tracking?.eta ? (stops.find((x) => x.name === tracking.eta!.stopName) ?? delivery) : delivery;
  const destZone = zoneOf(etaStop);
  /** A leg event happens at a stop: pickup-side steps on the leg's first stop's clock, delivery-side on its last. */
  const eventZone = (e: { legId: string; stopId: string | null; toState: string | null }) => {
    if (e.stopId) return zoneOf(stopById.get(e.stopId));
    const leg = legs.find((l) => l.id === e.legId);
    if (!leg) return companyZone;
    const end = ["at_delivery", "completed", "en_route"].includes(e.toState ?? "") ? leg.toStopId : leg.fromStopId;
    return zoneOf(stopById.get(end ?? ""));
  };
  const pinned = notes.filter((n) => n.pinned);
  const locList: Loc[] = locations.map((l) => ({ id: l.id, name: String(l.name), country: String(l.country), kind: String(l.kind), address: (l.address ?? null) as Loc["address"] }));
  const flagsOpen = tl.flags.filter((f) => !f.clearedAt);

  const legsTable = (
    <div className="card overflow-hidden">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between">
        <div className="text-headline font-extrabold">Legs</div>
        <Link href={`/dispatch?order=${order.id}`} className="text-callout text-teal font-semibold">
          Assign on Dispatch →
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>From → To</th>
              <th>Who</th>
              <th>State</th>
              <th>Miles</th>
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
                <td>{l.assigneeKind === "truck" ? `Unit ${tName.get(l.truckId ?? "")}${l.driverId ? ` · ${dName.get(l.driverId)}` : ""}${l.coDriverId ? ` / ${dName.get(l.coDriverId)}` : ""}` : l.assigneeKind === "carrier" ? `${carName.get(l.carrierId ?? "")}${l.carrierRateCents != null ? ` · ${formatCents(l.carrierRateCents, l.carrierRateCurrency ?? "USD")}` : ""}` : <span className="text-faint">—</span>}</td>
                <td>
                  <Pill tone={l.state === "completed" ? "green" : l.state === "declined" ? "red" : l.state === "unassigned" ? "slate" : l.state === "cancelled" ? "slate" : "teal"}>{LEG_LABEL[l.state]}</Pill>
                </td>
                <td>
                  <LegMiles legId={l.id} miles={l.plannedMiles} est={l.estMiles} locked={closed || ["invoiced", "paid"].includes(order.state)} />
                </td>
                <td className="text-muted text-callout">{l.dispatchedAt ? when(l.dispatchedAt) : "—"}</td>
                <td className="text-muted text-callout">{l.completedAt ? when(l.completedAt, zoneOf(stopById.get(l.toStopId ?? ""))) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const timeline = (
    <div className="card p-5">
      <div className="text-headline font-extrabold mb-3">Timeline</div>
      {tl.events.length === 0 ? (
        <div className="text-muted text-callout">Nothing has moved yet.</div>
      ) : (
        <ul className="space-y-2.5">
          {tl.events.map((e) => {
            const leg = legs.find((l) => l.id === e.legId);
            return (
              <li key={e.id} className="text-callout flex gap-2.5">
                <span className={`timeline-dot mt-1.5 ${e.verified ? "done" : ""}`} title={e.verified ? "Verified (GPS/app)" : "Reported"} />
                <div>
                  <div>
                    <span className="font-bold">{leg ? `${LEG_TYPE_LABEL[leg.type]} leg` : "Leg"}</span> → {e.toState ? LEG_LABEL[e.toState as keyof typeof LEG_LABEL] : e.kind === "tender" ? <span className={(e.data as { state?: string } | null)?.state === "expired" || (e.data as { state?: string } | null)?.state === "declined" ? "text-red font-semibold" : ""}>Tender {(e.data as { state?: string } | null)?.state ?? ""}</span> : e.kind}
                    <span className="text-faint"> · {e.source.replace("_", " ")}</span>
                  </div>
                  <div className="text-muted">
                    {when(e.at, eventZone(e))}
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
  );

  const history = (
    <div className="card p-5">
      <div className="text-headline font-extrabold mb-3">History</div>
      <ul className="space-y-2.5">
        {tl.audits.map((h) => (
          <li key={h.id} className="text-callout">
            <div className="flex justify-between gap-2">
              <span className="font-bold capitalize">{h.action}</span>
              <span className="text-faint whitespace-nowrap">{when(h.at)}</span>
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
  );

  return (
    <div>
      {/* header */}
      <div className="bg-white border-b border-line px-5 md:px-8 pt-5 pb-5" data-testid="load-header">
        <div className="eyebrow mb-2">
          <Link href="/orders" className="hover:text-teal">
            Loads
          </Link>{" "}
          / {order.orderNumber}
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="mono text-title1 font-extrabold tracking-tight">{order.orderNumber}</h1>
              <Pill tone={order.state === "exception" ? "amber" : order.state === "cancelled" ? "slate" : ["delivered", "ready_to_bill"].includes(order.state) ? "green" : "teal"}>{order.tonu ? "TONU" : STATE_LABEL[order.state]}</Pill>
              {order.priority !== "none" && <Pill tone={order.priority === "high" ? "red" : order.priority === "medium" ? "amber" : "slate"}>{order.priority} priority</Pill>}
              {order.lockedAt && (
                <span title={`Locked ${when(order.lockedAt)}${order.lockedBy ? ` by ${who.get(order.lockedBy) ?? ""}` : ""}`}>
                  <Pill tone="navy">locked</Pill>
                </span>
              )}
              {order.kind === "shipment" && order.tripId && (
                <Link href={`/trips/${order.tripId}`}>
                  <Pill tone="navy">shipment on a trip →</Pill>
                </Link>
              )}
              {order.kind === "trip" && (
                <Link href={`/trips/${order.id}`}>
                  <Pill tone="navy">tailgate trip →</Pill>
                </Link>
              )}
            </div>
            <div className="text-muted text-body mt-1">
              <span className="font-semibold text-ink">{cName.get(order.customerId ?? "") ?? cName.get(order.brokerId ?? "") ?? "No customer"}</span>
              {" · "}
              {place(pickup)} → {place(delivery)}
              {" · "}
              {EQUIPMENT[order.equipment] ?? order.equipment}
              {order.holdReason ? ` · on hold: ${order.holdReason}` : ""}
              {order.cancelReason ? ` · ${order.tonu ? "TONU" : "cancelled"}: ${order.cancelReason}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <OrderActions
              order={J(order)}
              ends={
                stops.length
                  ? {
                      pickup: { name: stops[0].name, at: stops[0].windowStart?.toISOString() ?? stops[0].windowEnd?.toISOString() ?? null, zone: stopZone({ country: stops[0].country, address: stops[0].address }, companyZone) },
                      delivery: { name: stops[stops.length - 1].name, at: stops[stops.length - 1].windowStart?.toISOString() ?? stops[stops.length - 1].windowEnd?.toISOString() ?? null, zone: stopZone({ country: stops[stops.length - 1].country, address: stops[stops.length - 1].address }, companyZone) },
                    }
                  : null
              }
            />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mt-5 rounded-xl border border-line overflow-hidden" data-testid="load-facts">
          {facts.map(([k, v, sub]) => (
            <div key={k} className="px-4 py-3 border-r border-b xl:border-b-0 border-line last:border-r-0 bg-white">
              <div className="text-caption font-bold text-faint">{k}</div>
              <div className="text-headline font-extrabold tabular-nums mt-0.5 truncate">{v}</div>
              {sub && <div className="text-footnote text-muted truncate">{sub}</div>}
            </div>
          ))}
        </div>
      </div>

      <LoadTabs
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: (
              <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
                <div className="space-y-6 min-w-0">
                  {legsTable}
                  <div className="card p-5">
                    <div className="text-headline font-extrabold mb-4">Load details</div>
                    <OrderEditor order={J(order)} customers={customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) })).sort((p, q) => p.name.localeCompare(q.name))} entities={entities.map((e) => ({ id: e.id, name: String(e.legalName) }))} readOnly={readOnly} />
                  </div>
                </div>
                <aside className="space-y-4 min-w-0">
                  {liveLeg && tracking && (
                    <div className="card p-5" data-testid="tracking-card">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-headline font-extrabold">Where it is</div>
                        <Link href="/fleet/map" className="text-callout text-teal font-semibold">
                          Map →
                        </Link>
                      </div>
                      <div className="text-callout space-y-1 mb-3">
                        <div>
                          <span className="text-muted">Last position </span>
                          {tracking.seen ? (
                            <b>
                              {tracking.seen.place} · {tracking.seenMin} min ago
                            </b>
                          ) : (
                            <b className="text-amber">none in 12 h — ask the driver or send the tracking link</b>
                          )}
                        </div>
                        {tracking.eta && (
                          <div className={tracking.eta.late ? "text-red font-semibold" : "text-teal font-semibold"}>
                            ETA {fmtWhen(tracking.eta.at, destZone)} at {tracking.eta.stopName} · {tracking.eta.miles} mi{tracking.eta.late ? " — past the window" : ""}
                          </div>
                        )}
                      </div>
                      {!readOnly && <CheckCallBox orderId={order.id} legId={liveLeg.id} zone={destZone} reefer={order.equipment.includes("reefer")} onDone={undefined} />}
                    </div>
                  )}
                  <PeopleCard order={J({ id: order.id, salesAgentId: order.salesAgentId, csrId: order.csrId, dispatcherId: order.dispatcherId, priority: order.priority, updatedAt: order.updatedAt })} people={people.filter((p) => !p.archivedAt || [order.salesAgentId, order.csrId, order.dispatcherId].includes(p.id)).map((p) => ({ id: p.id, name: p.name }))} readOnly={readOnly} />
                  {flagsOpen.length > 0 && (
                    <div className="card p-5">
                      <div className="text-body font-extrabold mb-3">Flags</div>
                      <ul className="space-y-2.5">
                        {flagsOpen.map((f) => (
                          <li key={f.id} className="text-callout">
                            <span className={`pill ${f.level === "red" ? "pill-red" : "pill-amber"}`}>{f.code}</span> <span className="font-semibold">{f.title}</span>
                            {f.detail && <div className="text-muted">{f.detail}</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {pinned.length > 0 && (
                    <div className="card p-5">
                      <div className="text-body font-extrabold mb-3">Pinned notes</div>
                      <ul className="space-y-3">
                        {pinned.map((n) => (
                          <li key={n.id} className="text-callout">
                            <div className="text-caption font-bold text-faint">{NOTE_LABEL[n.kind] ?? n.kind}</div>
                            <div className="whitespace-pre-wrap">{n.body}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </aside>
              </div>
            ),
          },
          {
            id: "stops",
            label: "Stops",
            count: stops.length,
            content: (
              <div className="max-w-5xl">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-muted text-body">{restructure ? "Add, move or remove stops; the legs are re-cut from them." : order.lockedAt ? "Unlock the load to change its stops." : "The stops of a delivered or closed load are final."}</div>
                  {restructure && <AddStop orderId={order.id} stops={stops.map((s) => ({ id: s.id, name: s.name }))} firstOpen={lastReached + 1} zone={companyZone} locations={locList} />}
                </div>
                <div className="space-y-2 card p-4" data-testid="stops-card">
                  {stops.map((s, i) => (
                    <StopEditor key={s.id} orderId={order.id} index={i} count={stops.length} stop={J(s)} readOnly={readOnly} restructure={restructure} zone={companyZone} locations={locList} />
                  ))}
                </div>
              </div>
            ),
          },
          {
            id: "money",
            label: "Money",
            content: (
              <div className="space-y-6 max-w-6xl">
                <MoneyBox order={J({ id: order.id, rateCents: order.rateCents, rateTbd: order.rateTbd, currency: order.currency, rateType: order.rateType, rateUnitCents: order.rateUnitCents, rateQty: order.rateQty, fuelRule: order.fuelRule, fuelPct: order.fuelPct, fuelCentsPerMile: order.fuelCentsPerMile, tollsFeesCents: order.tollsFeesCents, updatedAt: order.updatedAt })} readOnly={readOnly || order.tonu} suggestedMiles={miles} weightLb={weightLb} />
                {billingView && <Charges orderId={id} charges={J(chargeRows)} docs={docRows.filter((d) => d.status !== "pending").map((d) => ({ id: d.id, code: d.code, fileName: d.fileName }))} requiredDocs={requiredDocs} requiredRefs={requiredRefsFor(cust as { requiredRefs?: string[] | null } | undefined, order.refs ?? {})} pnl={pnl} locked={order.state === "cancelled" && !order.tonu} invoiced={["invoiced", "paid"].includes(order.state)} orderNumber={order.orderNumber} role={ctx.role} currency={order.currency} />}
              </div>
            ),
          },
          {
            id: "documents",
            label: "Documents",
            count: docRows.length,
            content: <DocumentsPanel orderId={order.id} docs={J(docRows)} required={requiredDocs} canUpload={["owner", "billing", "dispatcher"].includes(ctx.role) && !closed} />,
          },
          {
            id: "notes",
            label: "Notes",
            count: notes.length,
            content: <NotesPanel orderId={order.id} notes={J(notes)} me={ctx.userId} isOwner={ctx.role === "owner"} />,
          },
          {
            id: "activity",
            label: "Activity",
            content: (
              <div className="grid lg:grid-cols-2 gap-6 items-start">
                {timeline}
                {history}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function fmt(v: unknown) {
  if (v == null || v === "") return "—";
  if (typeof v === "number" && v > 1000) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
