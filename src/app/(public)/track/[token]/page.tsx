import { resolveToken } from "@/lib/tokens";
import { fmtWhen, fmtWindow, stopZone } from "@/lib/time";
import { tenantZone } from "@/domain/company";
import { trackingView } from "@/domain/tracking";
import { Pill } from "@/components/ui";
import { LEG_LABEL, LEG_LABEL_ES } from "@/domain/states";
import type { LegState } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tracking" };


const STATE_LABEL: Record<string, string> = { draft: "Booked", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "In transit", delivered: "Delivered", ready_to_bill: "Delivered", invoiced: "Delivered", paid: "Delivered", cancelled: "Cancelled" };
const STATE_LABEL_ES: Record<string, string> = { draft: "Reservado", booked: "Reservado", dispatched: "Despachado", in_transit: "En tránsito", exception: "En tránsito", delivered: "Entregado", ready_to_bill: "Entregado", invoiced: "Entregado", paid: "Entregado", cancelled: "Cancelado" };
const STOP_TYPE_ES: Record<string, string> = { pickup: "recolección", delivery: "entrega", border_yard: "patio fronterizo", yard: "patio", stop: "parada" };

/** English or Spanish: the customer's country decides, ?lang= overrides. */
const STR = {
  en: { tracking: "shipment tracking", route: "Route", window: "window", arrived: "Arrived", departed: "Departed", next: "Next", lastPos: "Last known position", openMaps: "Open in Google Maps", noPos: "No position yet. It appears once the truck is moving.", updates: "Updates", times: "Every time is on the stop's local clock", questions: (c: string) => `Questions? Contact ${c} dispatch.`, other: "Español", po: "PO", shipment: "Shipment", ref: "Ref", eta: "ETA", fromGps: "from GPS at", fromCall: "from dispatch at" },
  es: { tracking: "rastreo de embarque", route: "Ruta", window: "cita", arrived: "Llegó", departed: "Salió", next: "Siguiente", lastPos: "Última posición conocida", openMaps: "Abrir en Google Maps", noPos: "Aún sin posición. Aparece cuando el camión está en movimiento.", updates: "Actualizaciones", times: "Cada hora está en la hora local de la parada", questions: (c: string) => `¿Dudas? Contacta a despacho de ${c}.`, other: "English", po: "PO", shipment: "Embarque", ref: "Ref", eta: "Llegada estimada", fromGps: "según GPS de las", fromCall: "según despacho a las" },
};

export default async function TrackPage({ params, searchParams }: PageProps<"/track/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const t = await resolveToken(token, "tracking_link");
  if (!t)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This tracking link isn&apos;t valid</div>
        <p className="text-muted mt-1">It may have been replaced. Ask your carrier contact for the current one.</p>
      </div>
    );
  const v = await trackingView(t.ctx.tenantId, t.subjectId);
  const lang: "en" | "es" = sp.lang === "es" || sp.lang === "en" ? sp.lang : v.customerCountry === "MX" ? "es" : "en";
  const S = STR[lang];
  const legLabel = lang === "es" ? LEG_LABEL_ES : LEG_LABEL;
  const zone = await tenantZone(t.ctx.tenantId);
  // each stop on its own clock with the zone's name; anything else on the company's
  const fmt = (d: Date | string | null | undefined, st?: (typeof v.stops)[number] | null) => fmtWhen(d, st ? stopZone(st, zone) : zone, { style: "short" });
  const doneStops = new Set(v.stops.filter((s) => s.departedAt).map((s) => s.id));
  const hereStop = v.stops.find((s) => s.arrivedAt && !s.departedAt);
  const lastTouched = [...v.stops].reverse().find((s) => s.arrivedAt || s.departedAt);
  const nextStop = v.stops.find((s) => !s.arrivedAt && (!lastTouched || s.seq > lastTouched.seq));
  const customerEvents = v.events.filter((e) => e.toState && !["planned", "dispatched", "accepted", "unassigned", "declined", "cancelled"].includes(e.toState));
  const pos = v.lastPosition;
  const bbox = pos ? `${Number(pos.lng) - 0.6},${Number(pos.lat) - 0.4},${Number(pos.lng) + 0.6},${Number(pos.lat) + 0.4}` : null;
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="eyebrow">
          {v.carrier} · {S.tracking}
        </div>
        <a className="text-footnote font-semibold text-teal" href={`?lang=${lang === "en" ? "es" : "en"}`} data-testid="lang">
          {S.other}
        </a>
      </div>
      <div className="h1 mt-1 flex items-center gap-3">
        {v.order.orderNumber}
        <Pill tone={v.order.state === "delivered" || v.order.deliveredAt ? "green" : v.order.state === "cancelled" ? "slate" : "teal"}>{(lang === "es" ? STATE_LABEL_ES : STATE_LABEL)[v.order.state] ?? v.order.state}</Pill>
      </div>
      <div className="text-muted text-callout mt-1">
        {[v.order.refs.po && `${S.po} ${v.order.refs.po}`, v.order.refs.shipment && `${S.shipment} ${v.order.refs.shipment}`, v.order.refs.reference && `${S.ref} ${v.order.refs.reference}`].filter(Boolean).join(" · ") || v.order.equipment.replace("_", " ")}
      </div>

      <div className="card p-5 mt-4">
        <div className="eyebrow mb-3">{S.route}</div>
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
                  <div className="text-callout text-muted">
                    {lang === "es" ? (STOP_TYPE_ES[s.type] ?? s.type) : s.type.replace("_", " ")}
                    {s.windowStart ? ` · ${S.window} ${fmtWindow(s.windowStart, s.windowEnd, stopZone(s, zone), { short: true })}` : ""}
                  </div>
                  <div className="text-callout">
                    {s.arrivedAt && <span className="text-teal font-semibold">{S.arrived} {fmt(s.arrivedAt, s)}</span>}
                    {s.departedAt && <span className="text-teal font-semibold"> · {S.departed} {fmt(s.departedAt, s)}</span>}
                    {next && !s.arrivedAt && <span className="text-amber font-semibold">{S.next}</span>}
                    {(() => {
                      const e = Object.values(v.etas).find((x) => x.stopId === s.id);
                      return e && !s.arrivedAt ? (
                        <span className={`font-semibold ${e.late ? "text-red" : "text-teal"}`}>
                          {" "}
                          · {S.eta} {fmt(e.at, s)} <span className="text-faint font-normal">({e.source === "check_call" ? S.fromCall : S.fromGps} {fmt(e.positionAt)})</span>
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between">
          <div className="eyebrow">{S.lastPos}</div>
          {pos && <span className="text-footnote text-muted">{fmt(pos.at)}</span>}
        </div>
        {pos ? (
          <>
            <div className="font-bold mt-1">{pos.place ?? `${Number(pos.lat).toFixed(3)}, ${Number(pos.lng).toFixed(3)}`}</div>
            <iframe title="map" className="w-full rounded-lg border border-line mt-3" style={{ height: 240 }} src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${pos.lat},${pos.lng}`} loading="lazy" />
            <a className="text-callout text-teal font-semibold mt-2 inline-block" href={`https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}`} target="_blank" rel="noreferrer">
              {S.openMaps}
            </a>
          </>
        ) : (
          <div className="text-muted mt-1 text-body">{S.noPos}</div>
        )}
      </div>

      {customerEvents.length > 0 && (
        <div className="card p-5 mt-4">
          <div className="eyebrow mb-2">{S.updates}</div>
          <ul className="space-y-1.5 text-callout">
            {customerEvents.slice(0, 12).map((e, i) => {
              // on a multi-leg move, say which stop a leg's step refers to ("Delivered" at the border yard is not the final delivery)
              const leg = v.legs.length > 1 ? v.legs.find((l) => l.id === e.legId) : null;
              const legOf = v.legs.find((l) => l.id === e.legId);
              const evStop = legOf ? (v.stops.find((st) => st.id === (["at_delivery", "completed", "en_route"].includes(e.toState ?? "") ? legOf.toStopId : legOf.fromStopId)) ?? null) : null;
              const stopName = leg ? evStop?.name : null;
              return (
              <li key={i} className="flex justify-between gap-3">
                <span className="font-semibold">
                  {legLabel[(e.toState ?? "unassigned") as LegState]}
                  {stopName && <span className="text-muted font-normal"> · {stopName}</span>}
                </span>
                <span className="text-muted whitespace-nowrap">
                  {fmt(e.at, evStop)}
                  {e.verified ? " · GPS" : ""}
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-4 text-footnote text-faint text-center">
        {S.times}. {S.questions(v.carrier)}
      </div>
    </div>
  );
}
