import { resolveToken } from "@/lib/tokens";
import { fmtIn, zoneAbbrev } from "@/lib/time";
import { tenantZone } from "@/domain/company";
import { trackingView } from "@/domain/tracking";
import { Pill } from "@/components/ui";
import { LEG_LABEL } from "@/domain/states";
import type { LegState } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tracking" };


const STATE_LABEL: Record<string, string> = { draft: "Booked", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "In transit", delivered: "Delivered", ready_to_bill: "Delivered", invoiced: "Delivered", paid: "Delivered", cancelled: "Cancelled" };

export default async function TrackPage({ params }: PageProps<"/track/[token]">) {
  const { token } = await params;
  const t = await resolveToken(token, "tracking_link");
  if (!t)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This tracking link isn&apos;t valid</div>
        <p className="text-muted mt-1">It may have been replaced. Ask your carrier contact for the current one.</p>
      </div>
    );
  const v = await trackingView(t.ctx.tenantId, t.subjectId);
  const zone = await tenantZone(t.ctx.tenantId);
  const fmt = (d: Date | string | null | undefined) => fmtIn(d, zone);
  const doneStops = new Set(v.stops.filter((s) => s.departedAt).map((s) => s.id));
  const hereStop = v.stops.find((s) => s.arrivedAt && !s.departedAt);
  const lastTouched = [...v.stops].reverse().find((s) => s.arrivedAt || s.departedAt);
  const nextStop = v.stops.find((s) => !s.arrivedAt && (!lastTouched || s.seq > lastTouched.seq));
  const customerEvents = v.events.filter((e) => e.toState && !["planned", "dispatched", "accepted", "unassigned", "declined", "cancelled"].includes(e.toState));
  const pos = v.lastPosition;
  const bbox = pos ? `${Number(pos.lng) - 0.6},${Number(pos.lat) - 0.4},${Number(pos.lng) + 0.6},${Number(pos.lat) + 0.4}` : null;
  return (
    <div>
      <div className="eyebrow">{v.carrier} · shipment tracking</div>
      <div className="h1 mt-1 flex items-center gap-3">
        {v.order.orderNumber}
        <Pill tone={v.order.state === "delivered" || v.order.deliveredAt ? "green" : v.order.state === "cancelled" ? "slate" : "teal"}>{STATE_LABEL[v.order.state] ?? v.order.state}</Pill>
      </div>
      <div className="text-muted text-[13px] mt-1">
        {[v.order.refs.po && `PO ${v.order.refs.po}`, v.order.refs.shipment && `Shipment ${v.order.refs.shipment}`, v.order.refs.reference && `Ref ${v.order.refs.reference}`].filter(Boolean).join(" · ") || v.order.equipment.replace("_", " ")}
      </div>

      <div className="card p-5 mt-4">
        <div className="eyebrow mb-3">Route</div>
        <ol className="space-y-3">
          {v.stops.map((s, i) => {
            const done = doneStops.has(s.id);
            const here = hereStop?.id === s.id;
            const next = !done && !here && nextStop?.id === s.id && v.order.state !== "delivered" && !v.order.deliveredAt;
            return (
              <li key={s.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={`timeline-dot mt-1.5 ${done ? "done" : here ? "now" : ""}`} />
                  {i < v.stops.length - 1 && <span className="w-px flex-1 bg-line mt-1" />}
                </div>
                <div className="pb-1">
                  <div className="font-bold">
                    {s.name}
                    <span className="text-faint font-normal">
                      {s.city ? ` · ${s.city}${s.state ? `, ${s.state}` : ""}` : ""} · {s.country}
                    </span>
                  </div>
                  <div className="text-[12.5px] text-muted">
                    {s.type.replace("_", " ")}
                    {s.windowStart ? ` · window ${fmt(s.windowStart)}${s.windowEnd ? ` – ${fmt(s.windowEnd)}` : ""}` : ""}
                  </div>
                  <div className="text-[12.5px]">
                    {s.arrivedAt && <span className="text-teal font-semibold">Arrived {fmt(s.arrivedAt)}</span>}
                    {s.departedAt && <span className="text-teal font-semibold"> · Departed {fmt(s.departedAt)}</span>}
                    {next && !s.arrivedAt && <span className="text-amber font-semibold">Next</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between">
          <div className="eyebrow">Last known position</div>
          {pos && <span className="text-[12px] text-muted">{fmt(pos.at)}</span>}
        </div>
        {pos ? (
          <>
            <div className="font-bold mt-1">{pos.place ?? `${Number(pos.lat).toFixed(3)}, ${Number(pos.lng).toFixed(3)}`}</div>
            <iframe title="map" className="w-full rounded-lg border border-line mt-3" style={{ height: 240 }} src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${pos.lat},${pos.lng}`} loading="lazy" />
            <a className="text-[12.5px] text-teal font-semibold mt-2 inline-block" href={`https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}`} target="_blank" rel="noreferrer">
              Open in Google Maps
            </a>
          </>
        ) : (
          <div className="text-muted mt-1 text-[13.5px]">No position yet. It appears once the truck is moving.</div>
        )}
      </div>

      {customerEvents.length > 0 && (
        <div className="card p-5 mt-4">
          <div className="eyebrow mb-2">Updates</div>
          <ul className="space-y-1.5 text-[13px]">
            {customerEvents.slice(0, 12).map((e, i) => {
              // on a multi-leg move, say which stop a leg's step refers to ("Delivered" at the border yard is not the final delivery)
              const leg = v.legs.length > 1 ? v.legs.find((l) => l.id === e.legId) : null;
              const stopName = leg ? v.stops.find((st) => st.id === (["at_delivery", "completed", "en_route"].includes(e.toState ?? "") ? leg.toStopId : leg.fromStopId))?.name : null;
              return (
              <li key={i} className="flex justify-between gap-3">
                <span className="font-semibold">
                  {LEG_LABEL[(e.toState ?? "unassigned") as LegState]}
                  {stopName && <span className="text-muted font-normal"> · {stopName}</span>}
                </span>
                <span className="text-muted whitespace-nowrap">
                  {fmt(e.at)}
                  {e.verified ? " · GPS" : ""}
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-4 text-[12px] text-faint text-center">Times shown in {zoneAbbrev(zone)}. Questions? Contact {v.carrier} dispatch.</div>
    </div>
  );
}
