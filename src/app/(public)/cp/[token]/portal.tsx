"use client";

import { shortDate } from "@/lib/time";
import { useState, useTransition } from "react";
import { ZoneProvider, useClock } from "@/components/zone";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui";
import { portalRequestLoadAction } from "../../actions";

/** The customer's page: their loads with live tracking, delivered loads with the POD, invoices and balance, and a load request form. */

type Stop = { id: string; seq: number; type: string; name: string; city: string | null; state: string | null; country: string; windowStart: string | null; windowEnd: string | null; arrivedAt: string | null; departedAt: string | null };
type Load = { eta: { at: string; stopName: string; late: boolean } | null; id: string; orderNumber: string; state: string; stateKey?: string; stateLabel: string; step: string | null; stepKey?: string | null; equipment: string; refs: { po: string | null; shipment: string | null; reference: string | null; rate_con: string | null }; cargoNote: string | null; stops: Stop[]; deliveredAt: string | null; createdAt: string; source: string; trackingUrl: string | null; docs: { id: string; code: string; fileName: string; createdAt: string }[]; invoice: { id: string; number: string | null; state: string; totalCents: number; url: string | null } | null };
type Invoice = { id: string; number: string | null; state: string; issuedAt: string | null; dueAt: string | null; totalCents: number; openCents: number; pastDueDays: number; currency: string; orders: string[]; url: string | null };
type Data = { company: string; customer: { id: string; name: string; kind: string; termsDays: number | null; country?: string }; active: Load[]; requested: Load[]; delivered: Load[]; cancelled: Load[]; invoices: Invoice[]; balance: { openCents: number; pastDueCents: number; currency: string } };

const money = (c: number, cur = "USD") => `${cur === "USD" ? "$" : cur + " "}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const day = (d: string | null | undefined) => (d ? shortDate(d) : "—");
const placeOf = (s: Stop) => `${s.name}${s.city ? ` · ${s.city}` : ""}${s.state ? `, ${s.state}` : ""}`;
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "blue", booked: "slate", dispatched: "teal", in_transit: "teal", exception: "red", delivered: "green", ready_to_bill: "green", invoiced: "green", paid: "green", cancelled: "slate" };
const INV_TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { issued: "amber", sent: "amber", partially_paid: "amber", paid: "green", closed: "green", void: "slate", disputed: "red" };
const EQUIPMENT: [string, string][] = [["53_dry", "53' dry van"], ["53_reefer", "53' reefer"], ["48_dry", "48' dry van"], ["flatbed", "Flatbed"], ["sprinter", "Sprinter"], ["straight", "Straight truck"]];

/** English and Spanish: a Mexican shipper reads this page too. The default follows the customer's country; one tap switches. */
type Lang = "en" | "es";
const STR = {
  en: {
    lang: "en" as Lang,
    portal: "customer portal", intro: (c: string) => `Your loads with ${c}: where they are, the paperwork, and your invoices. Keep this link — it is yours.`, pastDue: "past due", open: "open", nothingOwed: "Nothing owed",
    loads: "Loads", delivered: "Delivered", invoices: "Invoices", request: "Request a load", nothingMoving: "Nothing moving right now.", requestArrow: "Request a load →", noDeliveries: "No deliveries in the last 90 days.",
    balance: "Balance", ofItPastDue: "of it past due", nothingPastDue: "nothing past due", terms: "terms net", noInvoices: "No invoices yet.", invoice: "Invoice", issued: "Issued", due: "Due", total: "Total", openCol: "Open", dPastDue: "d past due", partlyPaid: "partly paid",
    received: "Received. Dispatch will price it and confirm with you before it moves.", nextStop: "Next stop", etaLabel: "ETA", arrived: "arrived", deliveredAt: "Delivered", track: "Track", hideStops: "Hide stops ▴", stops: "stops ▾", window: "window", in: "in", out: "out",
    reqReceived: "Request received", reqIs: (n: string, c: string) => `It is ${n} with ${c}. Dispatch will price it and confirm with you before it moves.`, seeLoads: "See your loads", reqTitle: "Request a load", reqIntro: (c: string) => `Two ends and what it is. ${c} prices it and confirms with you; nothing moves until then.`,
    pickup: "Pickup", shipper: "Shipper / location", city: "City", state: "State", country: "Country", readyWhen: "Ready when", delivery: "Delivery", consignee: "Consignee / location", deliverBy: "Deliver by", theLoad: "The load", equipment: "Equipment", po: "PO #", yourRef: "Your reference", whoToCall: "Who to call", whatIsIt: "What is it", sending: "Sending…", send: "Send the request",
    doc: { POD: "Proof of delivery", BOL: "Bill of lading", RATE_CON: "Rate confirmation", carta_porte: "Carta porte", invoice: "Commercial invoice", packing_list: "Packing list" } as Record<string, string>,
    orderState: { draft: "Requested", booked: "Booked", assigning: "Assigning a truck", dispatched: "Driver assigned", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Delivered", invoiced: "Delivered", paid: "Delivered", cancelled: "Cancelled" } as Record<string, string>,
    legStep: { unassigned: "Pending", planned: "Planned", dispatched: "Sent", accepted: "Accepted", en_route_to_pickup: "To pickup", at_pickup: "At pickup", loaded: "Loaded", en_route: "En route", at_delivery: "At delivery", completed: "Delivered", declined: "Finding another truck", cancelled: "Cancelled" } as Record<string, string>,
    invState: { issued: "Issued", sent: "Sent", partially_paid: "Partly paid", paid: "Paid", closed: "Paid", void: "Void", disputed: "Disputed" } as Record<string, string>,
  },
  es: {
    lang: "es" as Lang,
    portal: "portal del cliente", intro: (c: string) => `Tus embarques con ${c}: dónde van, los documentos y tus facturas. Guarda este enlace, es tuyo.`, pastDue: "vencido", open: "por pagar", nothingOwed: "Nada pendiente",
    loads: "Embarques", delivered: "Entregados", invoices: "Facturas", request: "Solicitar un embarque", nothingMoving: "Nada en movimiento por ahora.", requestArrow: "Solicitar un embarque →", noDeliveries: "Sin entregas en los últimos 90 días.",
    balance: "Saldo", ofItPastDue: "vencido", nothingPastDue: "nada vencido", terms: "crédito", noInvoices: "Aún no hay facturas.", invoice: "Factura", issued: "Emitida", due: "Vence", total: "Total", openCol: "Por pagar", dPastDue: "d de vencida", partlyPaid: "pago parcial",
    received: "Recibido. Despacho lo cotiza y te confirma antes de moverlo.", nextStop: "Siguiente parada", etaLabel: "llegada estimada", arrived: "llegó", deliveredAt: "Entregado", track: "Rastrear", hideStops: "Ocultar paradas ▴", stops: "paradas ▾", window: "cita", in: "entrada", out: "salida",
    reqReceived: "Solicitud recibida", reqIs: (n: string, c: string) => `Es la ${n} con ${c}. Despacho la cotiza y te confirma antes de moverla.`, seeLoads: "Ver tus embarques", reqTitle: "Solicitar un embarque", reqIntro: (c: string) => `Origen, destino y qué es. ${c} lo cotiza y te confirma; nada se mueve hasta entonces.`,
    pickup: "Recolección", shipper: "Remitente / lugar", city: "Ciudad", state: "Estado", country: "País", readyWhen: "Listo cuándo", delivery: "Entrega", consignee: "Destinatario / lugar", deliverBy: "Entregar antes de", theLoad: "La carga", equipment: "Equipo", po: "No. de PO", yourRef: "Tu referencia", whoToCall: "A quién llamar", whatIsIt: "Qué es", sending: "Enviando…", send: "Enviar la solicitud",
    doc: { POD: "Comprobante de entrega", BOL: "Bill of lading", RATE_CON: "Confirmación de tarifa", carta_porte: "Carta porte", invoice: "Factura comercial", packing_list: "Lista de empaque" } as Record<string, string>,
    orderState: { draft: "Solicitado", booked: "Reservado", assigning: "Asignando unidad", dispatched: "Operador asignado", in_transit: "En tránsito", exception: "En espera", delivered: "Entregado", ready_to_bill: "Entregado", invoiced: "Entregado", paid: "Entregado", cancelled: "Cancelado" } as Record<string, string>,
    legStep: { unassigned: "Pendiente", planned: "Planeado", dispatched: "Enviado", accepted: "Aceptado", en_route_to_pickup: "Hacia la carga", at_pickup: "En la carga", loaded: "Cargado", en_route: "En ruta", at_delivery: "En la entrega", completed: "Entregado", declined: "Buscando otra unidad", cancelled: "Cancelado" } as Record<string, string>,
    invState: { issued: "Emitida", sent: "Enviada", partially_paid: "Pago parcial", paid: "Pagada", closed: "Pagada", void: "Anulada", disputed: "En disputa" } as Record<string, string>,
  },
};

export function CustomerPortal({ token, data, timeZone }: { token: string; data: Data; timeZone: string }) {
  return (
    <ZoneProvider value={timeZone}>
      <CustomerPortalBody token={token} data={data} />
    </ZoneProvider>
  );
}

function CustomerPortalBody({ token, data }: { token: string; data: Data }) {
  const [tab, setTab] = useState<"loads" | "delivered" | "invoices" | "request">(data.active.length || data.requested.length ? "loads" : data.delivered.length ? "delivered" : "request");
  const [lang, setLang] = useState<Lang>(data.customer.country === "MX" ? "es" : "en");
  const s = STR[lang];
  const counts = { loads: data.active.length + data.requested.length, delivered: data.delivered.length, invoices: data.invoices.filter((i) => i.openCents > 0).length, request: 0 };
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">
            {data.company} · {s.portal}
          </div>
          <div className="h1">{data.customer.name}</div>
          <div className="text-callout text-muted mt-0.5">{s.intro(data.company)}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {data.balance.pastDueCents > 0 ? <Pill tone="red">{money(data.balance.pastDueCents, data.balance.currency)} {s.pastDue}</Pill> : data.balance.openCents > 0 ? <Pill tone="amber">{money(data.balance.openCents, data.balance.currency)} {s.open}</Pill> : <Pill tone="green">{s.nothingOwed}</Pill>}
          <button className="text-footnote font-semibold text-teal" onClick={() => setLang(lang === "en" ? "es" : "en")} data-testid="lang">
            {lang === "en" ? "Español" : "English"}
          </button>
        </div>
      </div>

      <div className="flex gap-1.5 mt-4 flex-wrap">
        {(
          [
            ["loads", s.loads],
            ["delivered", s.delivered],
            ["invoices", s.invoices],
            ["request", s.request],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className="stage-tab" data-active={tab === k} onClick={() => setTab(k)}>
            {l} {counts[k] > 0 && <span className="count">{counts[k]}</span>}
          </button>
        ))}
      </div>

      {tab === "loads" && (
        <div className="mt-4 space-y-3">
          {data.active.length + data.requested.length === 0 && (
            <div className="card p-5 text-center text-muted">
              {s.nothingMoving}{" "}
              <button className="text-teal font-semibold" onClick={() => setTab("request")}>
                {s.requestArrow}
              </button>
            </div>
          )}
          {data.requested.map((l) => (
            <LoadCard key={l.id} l={l} token={token} s={s} />
          ))}
          {data.active.map((l) => (
            <LoadCard key={l.id} l={l} token={token} s={s} />
          ))}
        </div>
      )}

      {tab === "delivered" && (
        <div className="mt-4 space-y-3">
          {data.delivered.length === 0 && <div className="card p-5 text-center text-muted">{s.noDeliveries}</div>}
          {data.delivered.map((l) => (
            <LoadCard key={l.id} l={l} token={token} s={s} />
          ))}
        </div>
      )}

      {tab === "invoices" && (
        <div className="mt-4">
          <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="eyebrow">{s.balance}</div>
              <div className="text-title2 font-extrabold mono">{money(data.balance.openCents, data.balance.currency)}</div>
              <div className="text-footnote text-muted">
                {data.balance.pastDueCents > 0 ? `${money(data.balance.pastDueCents, data.balance.currency)} ${s.ofItPastDue}` : s.nothingPastDue}
                {data.customer.termsDays ? ` · ${s.terms} ${data.customer.termsDays}` : ""}
              </div>
            </div>
          </div>
          <div className="card mt-3 overflow-x-auto">
            {data.invoices.length === 0 ? (
              <div className="p-5 text-center text-muted">{s.noInvoices}</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{s.invoice}</th>
                    <th>{s.loads}</th>
                    <th>{s.issued}</th>
                    <th>{s.due}</th>
                    <th className="text-right">{s.total}</th>
                    <th className="text-right">{s.openCol}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="font-bold mono">{i.number ?? "—"}</div>
                        <Pill tone={INV_TONE[i.state] ?? "slate"}>{s.invState[i.state] ?? i.state}</Pill>
                      </td>
                      <td className="text-callout mono">{i.orders.join(", ")}</td>
                      <td className="text-callout">{day(i.issuedAt)}</td>
                      <td className="text-callout">
                        {day(i.dueAt)}
                        {i.pastDueDays > 0 && <div className="text-red text-footnote font-semibold">{i.pastDueDays} {s.dPastDue}</div>}
                      </td>
                      <td className="text-right mono">{money(i.totalCents, i.currency)}</td>
                      <td className="text-right mono font-bold">{i.openCents ? money(i.openCents, i.currency) : "—"}</td>
                      <td className="text-right">
                        {i.url && (
                          <a className="btn btn-sm" href={i.url} target="_blank" rel="noreferrer">
                            PDF
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "request" && <RequestForm token={token} company={data.company} s={s} onDone={() => setTab("loads")} />}
    </div>
  );
}

type Strings = (typeof STR)[Lang];

function LoadCard({ l, token, s }: { l: Load; token: string; s: Strings }) {
  // every stop on its own clock, labelled (a Mexican pickup reads CST, a Laredo delivery CDT)
  const clock = useClock();
  const at = (d: string | null | undefined, st: Stop) => clock.stop(d, { country: st.country, name: st.name, address: { city: st.city, state: st.state } }, { style: "short" });
  const win = (st: Stop) => clock.window({ country: st.country, name: st.name, address: { city: st.city, state: st.state }, windowStart: st.windowStart, windowEnd: st.windowEnd }, { short: true });
  const [open, setOpen] = useState(false);
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const next = l.stops.find((s) => !s.departedAt);
  return (
    <div className="card p-4" data-testid="load-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold mono">{l.orderNumber}</span>
            <Pill tone={l.stateKey === "assigning" ? "blue" : (TONE[l.state] ?? "slate")}>{s.orderState[l.stateKey ?? l.state] ?? l.stateLabel}</Pill>
            {l.step && ["dispatched", "in_transit", "exception"].includes(l.state) && l.stateKey !== "assigning" && <span className="text-footnote text-muted">{(l.stepKey && s.legStep[l.stepKey]) || l.step}</span>}
          </div>
          <div className="font-bold text-body mt-1 truncate">
            {first ? placeOf(first) : "—"} → {last ? placeOf(last) : "—"}
          </div>
          <div className="text-callout text-muted mt-0.5">
            {[l.refs.po && `PO ${l.refs.po}`, l.refs.shipment && `Shipment ${l.refs.shipment}`, l.refs.reference && `Ref ${l.refs.reference}`, l.equipment.replace("_", " ")].filter(Boolean).join(" · ")}
          </div>
          {l.state === "draft" && <div className="text-callout text-blue mt-1">{s.received}</div>}
          {["booked", "dispatched", "in_transit", "exception"].includes(l.state) && next && (
            <div className="text-callout mt-1">
              {s.nextStop}: <b>{next.name}</b>
              {next.windowStart ? ` · ${win(next)}` : ""}
              {next.arrivedAt ? ` · ${s.arrived} ${at(next.arrivedAt, next)}` : ""}
              {l.eta && !next.arrivedAt && <span className={`font-semibold ${l.eta.late ? "text-red" : "text-teal"}`}> · {s.etaLabel} {at(l.eta.at, l.stops.find((x) => x.name === l.eta!.stopName) ?? next)}</span>}
            </div>
          )}
          {l.deliveredAt && <div className="text-callout text-green mt-1">{s.deliveredAt} {last ? at(l.deliveredAt, last) : clock.at(l.deliveredAt, { style: "short" })}</div>}
        </div>
        <div className="flex flex-col gap-1.5 items-end shrink-0">
          {l.trackingUrl && ["booked", "dispatched", "in_transit", "exception"].includes(l.state) && (
            <a className="btn btn-sm btn-primary" href={`${l.trackingUrl}?lang=${s.lang}`} target="_blank" rel="noreferrer">
              {s.track}
            </a>
          )}
          {l.docs.map((d) => (
            <a key={d.id} className="btn btn-sm" href={`/cp/${token}/doc/${d.id}`} target="_blank" rel="noreferrer">
              {s.doc[d.code] ?? d.code}
            </a>
          ))}
          {l.invoice?.url && (
            <a className="btn btn-sm" href={l.invoice.url} target="_blank" rel="noreferrer">
              {s.invoice} {l.invoice.number}
            </a>
          )}
        </div>
      </div>
      <button className="text-footnote text-muted mt-2 font-semibold" onClick={() => setOpen(!open)}>
        {open ? s.hideStops : `${l.stops.length} ${s.stops}`}
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5">
          {l.stops.map((st, i) => (
            <li key={st.id} className="flex gap-2 text-callout">
              <span className="mono text-faint w-4">{i + 1}</span>
              <div>
                <div className="font-semibold">
                  {placeOf(st)} <span className="text-faint font-normal">· {st.type.replace("_", " ")}</span>
                </div>
                <div className="text-footnote text-muted">
                  {st.windowStart ? `${s.window} ${win(st)}` : ""}
                  {st.arrivedAt ? `${st.windowStart ? " · " : ""}${s.in} ${at(st.arrivedAt, st)}` : ""}
                  {st.departedAt ? ` · ${s.out} ${at(st.departedAt, st)}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RequestForm({ token, company, s, onDone }: { token: string; company: string; s: Strings; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [f, setF] = useState({ pName: "", pCity: "", pState: "", pCountry: "US", pWhen: "", dName: "", dCity: "", dState: "", dCountry: "US", dWhen: "", equipment: "53_dry", po: "", reference: "", cargo: "", contact: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = () =>
    start(async () => {
      setErr(null);
      const r = await portalRequestLoadAction(token, {
        pickup: { name: f.pName, city: f.pCity, state: f.pState, country: f.pCountry, windowStart: f.pWhen ? new Date(f.pWhen) : null },
        delivery: { name: f.dName, city: f.dCity, state: f.dState, country: f.dCountry, windowStart: f.dWhen ? new Date(f.dWhen) : null },
        equipment: f.equipment,
        po: f.po,
        reference: f.reference,
        cargoNote: f.cargo,
        contact: f.contact,
      });
      if (r.ok) {
        setDone(r.data.orderNumber);
        router.refresh();
      } else setErr({ message: r.error, field: r.field });
    });
  if (done)
    return (
      <div className="card p-6 mt-4 text-center">
        <div className="h2">{s.reqReceived}</div>
        <p className="text-muted mt-1">{s.reqIs(done, company)}</p>
        <button className="btn btn-primary mt-4" onClick={onDone}>
          {s.seeLoads}
        </button>
      </div>
    );
  return (
    <div className="card p-5 mt-4">
      <div className="h2">{s.reqTitle}</div>
      <div className="text-callout text-muted mt-0.5 mb-3">{s.reqIntro(company)}</div>
      <div className="eyebrow mb-1">{s.pickup}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">{s.shipper}</label>
          <input className="input" value={f.pName} onChange={set("pName")} aria-label={s.shipper} aria-invalid={err?.field === "pickup"} />
        </div>
        <div>
          <label className="label">{s.city}</label>
          <input className="input" value={f.pCity} onChange={set("pCity")} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">{s.state}</label>
            <input className="input" value={f.pState} onChange={set("pState")} />
          </div>
          <div>
            <label className="label">{s.country}</label>
            <select className="select" value={f.pCountry} onChange={set("pCountry")}>
              <option value="US">US</option>
              <option value="MX">MX</option>
              <option value="CA">CA</option>
            </select>
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">{s.readyWhen}</label>
          <input type="datetime-local" className="input" value={f.pWhen} onChange={set("pWhen")} />
        </div>
      </div>
      <div className="eyebrow mb-1 mt-4">{s.delivery}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">{s.consignee}</label>
          <input className="input" value={f.dName} onChange={set("dName")} aria-label={s.consignee} aria-invalid={err?.field === "delivery"} />
        </div>
        <div>
          <label className="label">{s.city}</label>
          <input className="input" value={f.dCity} onChange={set("dCity")} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">{s.state}</label>
            <input className="input" value={f.dState} onChange={set("dState")} />
          </div>
          <div>
            <label className="label">{s.country}</label>
            <select className="select" value={f.dCountry} onChange={set("dCountry")}>
              <option value="US">US</option>
              <option value="MX">MX</option>
              <option value="CA">CA</option>
            </select>
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">{s.deliverBy}</label>
          <input type="datetime-local" className="input" value={f.dWhen} onChange={set("dWhen")} />
        </div>
      </div>
      <div className="eyebrow mb-1 mt-4">{s.theLoad}</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">{s.equipment}</label>
          <select className="select" value={f.equipment} onChange={set("equipment")}>
            {EQUIPMENT.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">{s.po}</label>
          <input className="input" value={f.po} onChange={set("po")} />
        </div>
        <div>
          <label className="label">{s.yourRef}</label>
          <input className="input" value={f.reference} onChange={set("reference")} />
        </div>
        <div>
          <label className="label">{s.whoToCall}</label>
          <input className="input" value={f.contact} onChange={set("contact")} placeholder="Name · phone" />
        </div>
        <div className="col-span-2">
          <label className="label">{s.whatIsIt}</label>
          <input className="input" value={f.cargo} onChange={set("cargo")} placeholder="Pieces · weight · hazmat?" aria-label={s.whatIsIt} />
        </div>
      </div>
      {err && <div className="error mt-3">{err.message}</div>}
      <button className="btn btn-primary w-full justify-center mt-4" style={{ height: 48 }} disabled={pending} onClick={submit}>
        {pending ? s.sending : s.send}
      </button>
    </div>
  );
}
