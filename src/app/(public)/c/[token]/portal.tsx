"use client";

import { useRef, useState, useTransition } from "react";
import { ZoneProvider, useClock } from "@/components/zone";
import { shortDate } from "@/lib/time";
import { call } from "@/lib/client-call";
import { useRouter } from "next/navigation";
import { Pill, Modal } from "@/components/ui";
import { portalRespondAction, portalAdvanceAction, portalDriverAction, portalUploadAction, portalInvoiceAction, portalPodAction } from "../../actions";
import type { LegState } from "@/db/schema";

/** The partner carrier's page (spec Module 10): offers, loads, pay, documents, score. English with Spanish under it. */

type Place = { name: string; city: string | null; state: string | null; country: string; address?: { city?: string | null; state?: string | null } | null; windowStart: string | null; windowEnd: string | null; contact: string | null; notes: string | null } | null;
type Offer = { id: string; legId: string; orderNumber: string; type: string; rateCents: number | null; currency: string; expiresAt: string; message: string | null; from: Place; to: Place; equipment: string | null; cargoNote: string | null };
type Bill = { id: string; state: string; expectedCents: number; invoicedCents: number | null; approvedCents: number | null; paidCents: number | null; paidAt: string | null; payDate: string | null; shortPayNote: string | null; carrierInvoiceNumber: string | null; currency?: string } | null;
type Leg = { id: string; seq: number; type: string; state: string; stateLabel: string; next: { to: LegState; en: string; es: string } | null; orderNumber: string; equipment: string | null; cargoNote: string | null; refs: Record<string, string>; rateCents: number | null; rateCurrency?: string; from: Place; to: Place; driverName: string | null; driverPhone: string | null; unitNumber: string | null; trailerNumber: string | null; completedAt: string | null; podOnFile: boolean; driverLink: string | null; bill: Bill };
type Data = {
  company: string;
  carrier: { id: string; name: string; country: string; doNotUse: boolean };
  offers: Offer[];
  active: Leg[];
  completed: Leg[];
  compliance: { dispatchable: boolean; items: { key: string; label: string; status: string; expiresAt: string | null }[] } | null;
  docs: { id: string; typeName: string; fileName: string; expiresAt: string | null; number: string | null; status: string; createdAt: string }[];
  types: { id: string; name: string; tracksExpiry: boolean; required: boolean }[];
  score: { days: number; offered: number; answered: number; accepted: number; declined: number; expired: number; acceptancePct: number | null; loads: number; onTimePct: number | null; onTimeOf: number; trackedPct: number | null };
};

const money = (c: number | null | undefined, cur = "USD") => (c == null ? "—" : `${cur} ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const place = (p: Place) => (p ? `${p.name}${p.city ? `, ${p.city}` : ""}${p.state ? ` ${p.state}` : ""}` : "—");
const BILL_LABEL: Record<string, string> = { expected: "Send your invoice · Envía tu factura", received: "Invoice received — under review · Factura recibida", approved: "Approved for payment · Aprobada", scheduled: "Payment scheduled · Pago programado", paid: "Paid · Pagada", disputed: "Question on the invoice · Pregunta sobre la factura" };

export function CarrierPortal({ token, data, timeZone }: { token: string; data: Data; timeZone: string }) {
  return (
    <ZoneProvider value={timeZone}>
      <CarrierPortalBody token={token} data={data} />
    </ZoneProvider>
  );
}

function CarrierPortalBody({ token, data }: { token: string; data: Data }) {
  const router = useRouter();
  const [tab, setTab] = useState<"offers" | "loads" | "pay" | "docs">(data.offers.length ? "offers" : data.active.length ? "loads" : "loads");
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const refresh = (text: string, err = false) => {
    setMsg({ text, err });
    router.refresh();
  };
  const counts = { offers: data.offers.length, loads: data.active.length, pay: data.completed.filter((l) => l.bill && l.bill.state !== "paid").length, docs: data.compliance ? data.compliance.items.filter((i) => i.status !== "ok" && i.status !== "na").length : 0 };
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">{data.company} · carrier portal</div>
          <div className="h1">{data.carrier.name}</div>
          <div className="text-callout text-muted mt-0.5">Your loads with {data.company}. Keep this link — it is yours. · Tus cargas con {data.company}. Guarda este enlace.</div>
        </div>
        {data.compliance && <Pill tone={!data.compliance.dispatchable ? "red" : counts.docs ? "amber" : "green"}>{!data.compliance.dispatchable ? "Documents needed" : counts.docs ? `${counts.docs} document${counts.docs === 1 ? "" : "s"} to update` : "Documents OK"}</Pill>}
      </div>
      {data.carrier.doNotUse && <div className="mt-3 rounded-lg border border-red/40 bg-red/5 p-3 text-callout text-red font-semibold">This account is on hold with {data.company}. Call dispatch. · Cuenta en pausa; llama a despacho.</div>}
      {msg && <div className={`mt-3 rounded-lg p-3 text-callout font-semibold ${msg.err ? "bg-red/10 text-red" : "bg-teal-soft text-teal"}`}>{msg.text}</div>}

      <div className="flex gap-1.5 mt-4 flex-wrap">
        {(
          [
            ["offers", "Offers · Ofertas"],
            ["loads", "Loads · Cargas"],
            ["pay", "Pay · Pagos"],
            ["docs", "Documents · Documentos"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className="stage-tab" data-active={tab === k} onClick={() => setTab(k)}>
            {l} {counts[k] > 0 && <span className="count">{counts[k]}</span>}
          </button>
        ))}
      </div>

      {tab === "offers" && (
        <div className="mt-4 space-y-3">
          {data.offers.length === 0 && <div className="card p-5 text-center text-muted">No open offers right now. · Sin ofertas abiertas.</div>}
          {data.offers.map((o) => (
            <OfferCard key={o.id} token={token} o={o} onDone={refresh} />
          ))}
        </div>
      )}

      {tab === "loads" && (
        <div className="mt-4 space-y-3">
          {data.active.length === 0 && <div className="card p-5 text-center text-muted">Nothing assigned right now. · Nada asignado por ahora.</div>}
          {data.active.map((l) => (
            <LegCard key={l.id} token={token} l={l} onDone={refresh} />
          ))}
        </div>
      )}

      {tab === "pay" && (
        <div className="mt-4 space-y-3">
          {data.completed.length === 0 && <div className="card p-5 text-center text-muted">No delivered loads in the last 60 days. · Sin entregas en 60 días.</div>}
          {data.completed.map((l) => (
            <PayCard key={l.id} token={token} l={l} onDone={refresh} />
          ))}
        </div>
      )}

      {tab === "docs" && <DocsPanel token={token} data={data} onDone={refresh} />}

      <div className="card mt-6 p-4">
        <div className="eyebrow mb-1">Your score · Tu puntaje (last {data.score.days} days)</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-title3 font-extrabold mono">{data.score.acceptancePct == null ? "—" : `${data.score.acceptancePct}%`}</div>
            <div className="text-footnote text-muted">accepted · {data.score.accepted}/{data.score.answered} answered</div>
          </div>
          <div>
            <div className="text-title3 font-extrabold mono">{data.score.onTimePct == null ? "—" : `${data.score.onTimePct}%`}</div>
            <div className="text-footnote text-muted">on time · of {data.score.onTimeOf} with a window</div>
          </div>
          <div>
            <div className="text-title3 font-extrabold mono">{data.score.trackedPct == null ? "—" : `${data.score.trackedPct}%`}</div>
            <div className="text-footnote text-muted">tracked · {data.score.loads} loads</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OfferCard({ token, o, onDone }: { token: string; o: Offer; onDone: (t: string, err?: boolean) => void }) {
  const clock = useClock();
  const at = (p: Place, end = false) => (p ? clock.stop(end ? p.windowEnd : p.windowStart, { country: p.country, name: p.name, address: { city: p.city, state: p.state } }) : null);
  const [mode, setMode] = useState<"idle" | "accept" | "decline">("idle");
  const [f, setF] = useState({ name: "", driverName: "", driverPhone: "", unitNumber: "", unitPlate: "", trailerNumber: "", note: "" });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [mins] = useState(() => Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 60000)); // read once; the page refreshes on every action
  const go = (accept: boolean) =>
    start(async () => {
      setErr(null);
      const r = await portalRespondAction(token, o.id, { accept, name: f.name, note: f.note || null, driverName: f.driverName || null, driverPhone: f.driverPhone || null, unitNumber: f.unitNumber || null, unitPlate: f.unitPlate || null, trailerNumber: f.trailerNumber || null });
      if (r.ok) onDone(accept ? `Accepted ${o.orderNumber} — it is on your Loads tab. · Aceptada.` : `Declined ${o.orderNumber}. · Rechazada.`);
      else setErr(r.error);
    });
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-extrabold mono">{o.orderNumber}</span> <span className="text-muted text-callout">{o.type} leg</span>
        </div>
        <div className="text-title3 font-extrabold mono">{money(o.rateCents, o.currency)}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-callout">
        <div>
          <div className="eyebrow">Pickup · Carga</div>
          <div className="font-semibold">{place(o.from)}</div>
          <div className="text-muted text-footnote">{at(o.from) ?? "ASAP"}</div>
        </div>
        <div>
          <div className="eyebrow">Delivery · Entrega</div>
          <div className="font-semibold">{place(o.to)}</div>
          <div className="text-muted text-footnote">{o.to?.windowEnd ? `by ${at(o.to, true)}` : ""}</div>
        </div>
      </div>
      <div className="text-callout text-muted mt-2">
        {o.equipment?.replace("_", " ")}
        {o.cargoNote ? ` · ${o.cargoNote}` : ""}
        {o.message ? ` · ${o.message}` : ""} · answer within {mins > 90 ? `${Math.round(mins / 60)} h` : `${Math.max(mins, 0)} min`}
      </div>
      {mode === "idle" ? (
        <div className="flex gap-2 mt-3">
          <button className="btn btn-primary btn-lg flex-1 justify-center" onClick={() => setMode("accept")}>
            Accept · Aceptar
          </button>
          <button className="btn btn-lg" onClick={() => setMode("decline")}>
            Decline · Rechazar
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <input className="input" placeholder="Your name · Tu nombre" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {mode === "accept" && (
            <>
              <input className="input" placeholder="Driver name · Nombre del operador" value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <input className="input" placeholder="Driver phone" value={f.driverPhone} onChange={(e) => setF({ ...f, driverPhone: e.target.value })} />
                <input className="input" placeholder="Unit · Unidad" value={f.unitNumber} onChange={(e) => setF({ ...f, unitNumber: e.target.value })} />
                <input className="input mono" placeholder="Plates · Placas" value={f.unitPlate} onChange={(e) => setF({ ...f, unitPlate: e.target.value })} />
                <input className="input mono" placeholder="Trailer · Caja" value={f.trailerNumber} onChange={(e) => setF({ ...f, trailerNumber: e.target.value })} />
              </div>
            </>
          )}
          <input className="input" placeholder={mode === "accept" ? "Note (optional)" : "Why? · ¿Por qué?"} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          {err && <div className="error">{err}</div>}
          <div className="flex gap-2">
            <button className={`btn btn-lg flex-1 justify-center ${mode === "accept" ? "btn-primary" : "btn-danger"}`} disabled={pending} onClick={() => go(mode === "accept")}>
              {mode === "accept" ? "Confirm accept · Confirmar" : "Confirm decline · Confirmar"}
            </button>
            <button className="btn btn-lg" onClick={() => setMode("idle")}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LegCard({ token, l, onDone }: { token: string; l: Leg; onDone: (t: string, err?: boolean) => void }) {
  const clock = useClock();
  const at = (p: Place, end = false) => (p ? clock.stop(end ? p.windowEnd : p.windowStart, { country: p.country, name: p.name, address: { city: p.city, state: p.state } }) : null);
  const [driver, setDriver] = useState(false);
  const [f, setF] = useState({ driverName: l.driverName ?? "", driverPhone: l.driverPhone ?? "", unitNumber: l.unitNumber ?? "", trailerNumber: l.trailerNumber ?? "", by: "" });
  const [err, setErr] = useState<string | null>(null);
  const [seal, setSeal] = useState("");
  const [pending, start] = useTransition();
  const sealAsk = l.next?.to === "loaded" ? "Seal applied # · Sello puesto" : l.next?.to === "at_delivery" ? "Seal found # · Sello encontrado" : null;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-extrabold mono">{l.orderNumber}</span> <span className="text-muted text-callout">{l.type} leg</span>
        </div>
        <Pill tone={l.state === "accepted" || l.state === "dispatched" ? "blue" : "teal"}>{l.stateLabel}</Pill>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-callout">
        <div>
          <div className="eyebrow">Pickup · Carga</div>
          <div className="font-semibold">{place(l.from)}</div>
          <div className="text-muted text-footnote">{at(l.from) ?? ""}</div>
          {l.from?.contact && <div className="text-muted text-footnote">{l.from.contact}</div>}
        </div>
        <div>
          <div className="eyebrow">Delivery · Entrega</div>
          <div className="font-semibold">{place(l.to)}</div>
          <div className="text-muted text-footnote">{l.to?.windowEnd ? `by ${at(l.to, true)}` : ""}</div>
          {l.to?.contact && <div className="text-muted text-footnote">{l.to.contact}</div>}
        </div>
      </div>
      <div className="text-callout text-muted mt-2">
        {l.equipment?.replace("_", " ")}
        {l.cargoNote ? ` · ${l.cargoNote}` : ""} · {money(l.rateCents, l.rateCurrency)} ·{" "}
        <a className="text-teal font-semibold" href={`/c/${token}/ratecon/${l.id}`} target="_blank" rel="noreferrer">
          Rate confirmation PDF
        </a>
      </div>
      <div className="mt-2 text-callout flex items-center justify-between gap-2">
        <span>
          <span className="eyebrow mr-1">Driver · Operador</span>
          {l.driverName ? (
            <>
              <b>{l.driverName}</b>
              {l.driverPhone ? ` ${l.driverPhone}` : ""}
              {l.unitNumber ? ` · unit ${l.unitNumber}` : ""}
              {l.trailerNumber ? ` · trailer ${l.trailerNumber}` : ""}
            </>
          ) : (
            <span className="text-amber font-semibold">not set · sin asignar</span>
          )}
        </span>
        <button className="btn btn-sm" onClick={() => setDriver(true)}>
          {l.driverName ? "Change" : "Set driver"}
        </button>
      </div>
      {l.driverLink && (
        <div className="mt-2 text-callout flex items-center gap-2 flex-wrap" data-testid="driver-link">
          <span className="text-muted">Your driver&apos;s link · El enlace de tu operador:</span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(l.driverLink!);
                onDone("Link copied · Enlace copiado");
              } catch {
                onDone(l.driverLink!);
              }
            }}
          >
            Copy · Copiar
          </button>
          {l.driverPhone && (
            <a className="btn btn-sm" href={`https://wa.me/${l.driverPhone.replace(/\D/g, "")}?text=${encodeURIComponent(`${l.driverName ?? ""}, load ${l.orderNumber} — one button per step, keep it open while driving · un botón por paso, déjalo abierto: ${l.driverLink}`)}`} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
          )}
          <span className="text-faint">one button per step, GPS while open · the POD photo at the delivery</span>
        </div>
      )}
      {l.state === "at_delivery" && <PodButton token={token} leg={l} onDone={onDone} />}
      {sealAsk && <input className="input mono mt-3" placeholder={sealAsk} value={seal} onChange={(e) => setSeal(e.target.value)} aria-label={sealAsk.split(" #")[0]} />}
      {l.next && (
        <button
          className="btn btn-primary btn-lg w-full justify-center mt-3"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await portalAdvanceAction(token, l.id, l.next!.to, undefined, seal.trim() || null);
              if (r.ok) {
                setSeal("");
                onDone(`${l.orderNumber}: ${l.next!.en} · ${l.next!.es}`);
              } else onDone(r.error, true);
            })
          }
        >
          {l.next.en} · {l.next.es}
        </button>
      )}
      {driver && (
        <Modal open onClose={() => setDriver(false)} title={`Driver for ${l.orderNumber} · Operador`} footer={<><button className="btn" onClick={() => setDriver(false)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.driverName.trim()} onClick={() => start(async () => { setErr(null); const r = await portalDriverAction(token, l.id, f); if (r.ok) { setDriver(false); onDone("Driver saved · Operador guardado"); } else setErr(r.error); })}>Save</button></>}>
          <div className="space-y-2">
            <input className="input" placeholder="Driver name · Nombre del operador" value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} autoFocus />
            <input className="input" placeholder="Driver phone / WhatsApp" value={f.driverPhone} onChange={(e) => setF({ ...f, driverPhone: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input className="input" placeholder="Unit · Unidad" value={f.unitNumber} onChange={(e) => setF({ ...f, unitNumber: e.target.value })} />
              <input className="input" placeholder="Trailer · Caja" value={f.trailerNumber} onChange={(e) => setF({ ...f, trailerNumber: e.target.value })} />
            </div>
            <input className="input" placeholder="Your name · Tu nombre" value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} />
            {err && <div className="error">{err}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function PayCard({ token, l, onDone }: { token: string; l: Leg; onDone: (t: string, err?: boolean) => void }) {
  const ref = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const b = l.bill;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-extrabold mono">{l.orderNumber}</span> <span className="text-muted text-callout">{l.type} leg · delivered {l.completedAt ? shortDate(l.completedAt) : ""}</span>
        </div>
        <div className="text-headline font-extrabold mono">{money(b?.paidCents ?? b?.approvedCents ?? b?.expectedCents ?? l.rateCents, b?.currency ?? l.rateCurrency)}</div>
      </div>
      <div className="text-callout mt-1">
        {place(l.from)} → {place(l.to)}
      </div>
      {b && (
        <div className="mt-2 flex items-center justify-between gap-2 text-callout">
          <span>
            <Pill tone={b.state === "paid" ? "green" : b.state === "approved" || b.state === "scheduled" ? "teal" : b.state === "disputed" ? "red" : "amber"}>{BILL_LABEL[b.state] ?? b.state}</Pill>
            {b.carrierInvoiceNumber && <span className="text-muted ml-1">#{b.carrierInvoiceNumber}</span>}
            {b.payDate && !b.paidAt && <span className="text-muted ml-1">· pay date {shortDate(b.payDate)}</span>}
            {b.paidAt && <span className="text-muted ml-1">· paid {shortDate(b.paidAt)}</span>}
            {b.shortPayNote && <div className="text-amber text-footnote">{b.shortPayNote}</div>}
          </span>
          {(b.state === "expected" || b.state === "received" || b.state === "disputed") && (
            <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
              {b.state === "expected" ? "Send invoice · Facturar" : "Resend invoice"}
            </button>
          )}
        </div>
      )}
      <a className="text-teal font-semibold text-callout" href={`/c/${token}/ratecon/${l.id}`} target="_blank" rel="noreferrer">
        Rate confirmation PDF
      </a>
      <PodButton token={token} leg={l} onDone={onDone} />
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Invoice for ${l.orderNumber} · Factura`} footer={<><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={pending} onClick={() => start(async () => { setErr(null); const r = await call(() => portalInvoiceAction(token, l.id, new FormData(ref.current!))); if (r.ok) { setOpen(false); onDone("Invoice received — we check it against the rate confirmation and the POD. · Factura recibida."); } else setErr(r.error); })}>Send · Enviar</button></>}>
          <form ref={ref} className="space-y-2" onSubmit={(e) => e.preventDefault()}>
            <div className="text-callout text-muted">Agreed rate · Tarifa acordada: <b>{money(b?.expectedCents ?? l.rateCents, b?.currency ?? l.rateCurrency)}</b>. Bill the agreed amount plus any accessorials we approved.</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Amount (USD) · Monto</label>
                <input name="amount" className="input" inputMode="decimal" defaultValue={((b?.expectedCents ?? l.rateCents ?? 0) / 100).toFixed(2)} />
              </div>
              <div>
                <label className="label">Your invoice # · Tu folio</label>
                <input name="invoiceNumber" className="input" />
              </div>
            </div>
            <label className="block border-2 border-dashed border-line rounded-lg p-4 text-center cursor-pointer hover:border-teal">
              <input name="file" type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" />
              <div className="font-semibold text-callout">Attach the invoice PDF (optional) · Adjunta la factura</div>
            </label>
            {!l.podOnFile && <div className="text-callout text-amber font-semibold">No POD on file for this load yet — we pay on a clean POD; send it from the card behind this. · Falta el POD.</div>}
            {err && <div className="error">{err}</div>}
          </form>
        </Modal>
      )}
    </div>
  );
}

function DocsPanel({ token, data, onDone }: { token: string; data: Data; onDone: (t: string, err?: boolean) => void }) {
  const ref = useRef<HTMLFormElement>(null);
  const [typeId, setTypeId] = useState(data.types[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const type = data.types.find((t) => t.id === typeId);
  return (
    <div className="mt-4 space-y-3">
      {data.compliance && (
        <div className="card p-4">
          <div className="eyebrow mb-1">What {data.company} needs from you · Lo que necesita {data.company}</div>
          <ul className="space-y-1 text-callout">
            {data.compliance.items.map((i) => (
              <li key={i.key} className="flex justify-between gap-2">
                <span>{i.label}</span>
                <span className={i.status === "ok" || i.status === "na" ? "text-green font-semibold" : i.status === "expiring" ? "text-amber font-semibold" : "text-red font-bold"}>{i.status === "ok" ? "OK" : i.status === "na" ? "—" : i.status === "expiring" ? `expiring ${i.expiresAt ? shortDate(i.expiresAt) : ""}` : i.status === "expired" ? "EXPIRED · VENCIDO" : "missing · falta"}</span>
              </li>
            ))}
            {data.compliance.items.length === 0 && <li className="text-muted">Nothing required right now.</li>}
          </ul>
        </div>
      )}
      {data.types.length > 0 && (
        <form ref={ref} className="card p-4 space-y-2" onSubmit={(e) => e.preventDefault()}>
          <div className="eyebrow">Upload a document · Subir documento</div>
          <select name="documentTypeId" className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {data.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="block border-2 border-dashed border-line rounded-lg p-4 text-center cursor-pointer hover:border-teal">
            <input name="file" type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" />
            <div className="font-semibold text-callout">Choose a PDF or photo · Elige PDF o foto</div>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {type?.tracksExpiry && (
              <div>
                <label className="label">Expires · Vence</label>
                <input name="expiresAt" type="date" className="input" />
              </div>
            )}
            <div>
              <label className="label">Number (policy, permit) · Número</label>
              <input name="number" className="input" />
            </div>
          </div>
          {err && <div className="error">{err}</div>}
          <button className="btn btn-primary w-full justify-center" disabled={pending} onClick={() => start(async () => { setErr(null); const r = await call(() => portalUploadAction(token, new FormData(ref.current!))); if (r.ok) onDone("Document received · Documento recibido"); else setErr(r.error); })}>
            Upload · Subir
          </button>
        </form>
      )}
      {data.docs.length > 0 && (
        <div className="card p-4">
          <div className="eyebrow mb-1">On file · En expediente</div>
          <ul className="space-y-1 text-callout">
            {data.docs.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span>
                  <b>{d.typeName}</b> {d.number ? `#${d.number}` : ""} <span className="text-muted">{d.fileName}</span>
                </span>
                <span className="text-muted">{d.status === "superseded" ? "replaced" : d.expiresAt ? `expires ${shortDate(d.expiresAt)}` : shortDate(d.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The carrier's POD for a leg: one pick, straight onto the order; a check once it is there. */
function PodButton({ token, leg, onDone }: { token: string; leg: Leg; onDone: (t: string, err?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [just, setJust] = useState(false);
  const ok = leg.podOnFile || just;
  return (
    <label className={`btn btn-sm mt-2 ${ok ? "btn-ghost text-teal" : ""}`} data-testid={`pod-${leg.id}`}>
      <input
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        disabled={busy}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          const fd = new FormData();
          fd.set("file", f);
          const r = await call(() => portalPodAction(token, leg.id, fd));
          setBusy(false);
          e.target.value = "";
          if (r.ok) {
            setJust(true);
            onDone(`POD received for ${leg.orderNumber} · POD recibido`);
          } else onDone(r.error, true);
        }}
      />
      {busy ? "Sending… · Enviando…" : ok ? "✓ POD on file · another · otro" : "📎 Send POD · Mandar POD"}
    </label>
  );
}
