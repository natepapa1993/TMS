"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { createLoadAction, readRateConAction, templateDraftAction, saveBuilderTemplateAction, suggestRateAction } from "../actions";
import type { RateSuggestion } from "@/domain/rates";
import { toZoneInput, fromZoneInput } from "@/lib/time";
import { StopFields, blankStop, stopPayload, draftZone, placeLine, timeLine, STOP_LABEL, STOP_TONE, type Loc, type StopDraft } from "@/components/stop-fields";
import { legsFromStops, LEG_TYPE_LABEL, stopTimeProblems } from "@/domain/zones";

/**
 * The load builder: who pays and what for, the stops — as many as the load has, in order, each with
 * its place and time — the freight and the references. The legs are cut from the stops (a leg ends
 * where the trailer changes hands; a leg that changes country is the crossing) and shown as you type.
 *
 * Layout: a step bar to jump between the four sections, one roomy section per card, stops as a
 * route where each stop opens to edit and folds to one line, and a sticky summary to book from.
 */

const REF_KEYS: [string, string][] = [
  ["reference", "Customer load #"],
  ["po", "PO"],
  ["rate_con", "Rate con #"],
  ["shipment", "Shipment / BOL #"],
  ["asn", "ASN"],
];
const EQUIPMENT: [string, string][] = [
  ["53_dry", "53' dry van"],
  ["53_reefer", "53' reefer"],
  ["48_dry", "48' dry van"],
  ["flatbed", "Flatbed"],
  ["sprinter", "Sprinter / cargo van"],
  ["straight", "Straight truck"],
  ["power_only", "Power only"],
];
const SECTIONS: [string, string][] = [
  ["sec-customer", "Customer & rate"],
  ["sec-stops", "Stops"],
  ["sec-freight", "Freight"],
  ["sec-refs", "References"],
];
type Freight = { commodity: string; pieces: string; packaging: string; weightLb: string; hazmat: boolean };
const blankFreight = (): Freight => ({ commodity: "", pieces: "", packaging: "", weightLb: "", hazmat: false });

function Section({ id, n, title, hint, action, children }: { id: string; n: number; title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card p-6 md:p-8 scroll-mt-28">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <span className="w-7 h-7 shrink-0 rounded-full bg-navy text-white grid place-items-center text-[12px] font-extrabold mt-0.5">{n}</span>
          <div>
            <h2 className="text-[18px] font-extrabold tracking-tight">{title}</h2>
            {hint && <p className="text-muted text-[13.5px] mt-1 max-w-[62ch]">{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function OrderForm({ customers, entities, locations, templates = [], zone = "America/Chicago" }: { customers: { id: string; name: string; kind: string }[]; entities: { id: string; name: string }[]; locations: Loc[]; templates?: { id: string; name: string; customer: string | null }[]; zone?: string }) {
  const [f, setF] = useState({ customerId: "", brokerId: "", billingEntityId: entities.length === 1 ? entities[0].id : "", equipment: "53_dry", rate: "", rateTbd: false, currency: "USD", cargoNote: "" });
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [freight, setFreight] = useState<Freight[]>([blankFreight()]);
  const [stops, setStops] = useState<StopDraft[]>(() => [blankStop("pickup"), blankStop("delivery")]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(stops.map((s) => s.key)));
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [active, setActive] = useState(SECTIONS[0][0]);
  const [pending, start] = useTransition();
  const [reading, startRead] = useTransition();
  const [rateCon, setRateCon] = useState<{ id: string; fileName: string; warnings: string[] } | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tpl, setTpl] = useState(() => ({ id: "", date: new Date(Date.now() + 86400_000).toISOString().slice(0, 10) }));
  const [tplMsg, setTplMsg] = useState<string | null>(null);
  const [offer, setOffer] = useState<RateSuggestion | null>(null);
  const [contract, setContract] = useState<RateSuggestion | null>(null);
  // a saved lane's times come back on each stop's own clock
  const toLocalInput = (iso: string | null, st: { country: string; state?: string | null }) => toZoneInput(iso, draftZone({ country: st.country, state: st.state ?? "" }, zone));

  /** Fill the builder from a saved lane on a date. */
  const applyTemplate = () =>
    startRead(async () => {
      setTplMsg(null);
      if (!tpl.id) return setTplMsg("Pick a template");
      const r = await templateDraftAction(tpl.id, tpl.date);
      if (!r.ok) return setTplMsg(r.error);
      const d = r.data.data;
      setF((x) => ({ ...x, customerId: d.customerId ?? "", brokerId: d.brokerId ?? "", billingEntityId: d.billingEntityId ?? x.billingEntityId, equipment: d.equipment, rate: d.rateCents != null ? (d.rateCents / 100).toFixed(2) : "", rateTbd: d.rateCents == null, currency: d.currency, cargoNote: d.cargoNote ?? "" }));
      setRefs({ ...d.refs });
      setFreight(d.freight.length ? d.freight.map((l) => ({ commodity: l.commodity, pieces: l.pieces != null ? String(l.pieces) : "", packaging: l.packaging ?? "", weightLb: l.weightLb != null ? String(l.weightLb) : "", hazmat: !!l.hazmat })) : [blankFreight()]);
      const next = r.data.stops.map((st) => ({ ...blankStop(st.type, st.country), locationId: st.locationId, name: st.name, line1: st.line1 ?? "", city: st.city ?? "", state: st.state ?? "", postalCode: st.postalCode ?? "", country: st.country, appointment: st.appointment, windowStart: toLocalInput(st.windowStart, st), windowEnd: toLocalInput(st.windowEnd, st), ref: st.ref ?? "", contact: st.contact ?? "", notes: st.notes ?? "" }));
      setStops(next);
      setOpen(new Set());
      setTplMsg(`Filled from “${r.data.name}” for ${tpl.date}`);
    });

  const saveAsTemplate = () =>
    start(async () => {
      const name = window.prompt("Name this lane (e.g. Canton → Toronto, Acme)")?.trim();
      if (!name) return;
      const r = await saveBuilderTemplateAction(name, { ...f, refs, freight, stops: stops.map((st) => stopPayload(st, zone)) });
      setTplMsg(r.ok ? `Saved as template “${name}”` : r.error);
    });

  /** Fill the builder from what the reader found on the rate con. */
  const readRateCon = (file: File) =>
    startRead(async () => {
      setReadErr(null);
      const fd = new FormData();
      fd.set("file", file);
      const r = await readRateConAction(fd);
      if (!r.ok) return setReadErr(r.error);
      const d = r.data;
      setF((x) => ({ ...x, customerId: d.customerId ?? x.customerId, rate: d.rate || x.rate, rateTbd: d.rate ? false : x.rateTbd, currency: d.currency || x.currency, equipment: d.equipment ?? x.equipment, cargoNote: x.cargoNote || d.notes }));
      setRefs((x) => ({ ...x, ...d.refs }));
      if (d.freight.length) setFreight(d.freight);
      if (d.stops.length) {
        const next = d.stops.map((st) => {
          const loc = st.locationId ? locations.find((l) => l.id === st.locationId) : null;
          const base = { ...blankStop(st.type, st.country), ...st, name: st.name, saveLocation: false };
          return loc ? { ...base, locationId: loc.id } : { ...base, locationId: null };
        });
        setStops(next);
        setOpen(new Set(next.map((x) => x.key)));
      }
      setRateCon({ id: d.documentId, fileName: file.name, warnings: d.warnings });
    });

  const setStop = (i: number, patch: Partial<StopDraft>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const insertAt = (i: number) => {
    const st = blankStop(i === 0 ? "pickup" : "delivery", stops[Math.max(0, i - 1)]?.country ?? "US");
    setStops((s) => [...s.slice(0, i), st, ...s.slice(i)]);
    setOpen((o) => new Set(o).add(st.key));
  };
  const remove = (i: number) => setStops((s) => (s.length <= 2 ? s : s.filter((_, j) => j !== i)));
  const move = (i: number, d: -1 | 1) =>
    setStops((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const out = [...s];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const legs = useMemo(() => legsFromStops(stops.map((st) => ({ type: st.type, country: st.country }))), [stops]);

  // the customer's contract rate for this lane, looked up as the customer, equipment and route change
  const laneKey = JSON.stringify([f.customerId, f.equipment, stops.map((st) => [st.locationId, st.name.trim(), st.city.trim(), st.state.trim(), st.windowStart.slice(0, 10)])]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      if (!f.customerId) return live && setOffer(null);
      const r = await suggestRateAction({ customerId: f.customerId, equipment: f.equipment, stops: stops.map((st) => ({ locationId: st.locationId, name: st.name, city: st.city, state: st.state, windowStart: st.windowStart })) });
      if (live) setOffer(r.ok ? r.data : null);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneKey]);
  const applyContract = (o: RateSuggestion) => {
    setContract(o);
    setF((x) => ({ ...x, rate: o.rateCents != null ? (o.rateCents / 100).toFixed(2) : x.rate, rateTbd: o.rateCents == null ? x.rateTbd : false, currency: o.currency }));
  };
  const money = (c: number, cur = f.currency) => `${cur} ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fuelText = contract ? (contract.fuel.rule === "pct" ? `${contract.fuel.pct}% of line haul` : contract.fuel.rule === "per_mile" ? `${contract.fuel.centsPerMile}¢/mi` : "Included") : "Included";
  const name = (i: number) => stops[i]?.name.trim() || `Stop ${i + 1}`;
  const customer = customers.find((c) => c.id === f.customerId);
  const rateText = f.rateTbd || !f.rate.trim() ? "To be confirmed" : `${f.currency} ${Number(f.rate.replace(/[$,\s]/g, "")).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const timing = stopTimeProblems(stops.map((st) => ({ windowStart: fromZoneInput(st.windowStart, draftZone(st, zone)), windowEnd: fromZoneInput(st.windowEnd, draftZone(st, zone)) })));
  const checks = [
    { ok: !!f.customerId, label: "Bill-to customer" },
    { ok: f.rateTbd || !!f.rate.trim(), label: "Rate (or to be confirmed)" },
    { ok: stops.some((s) => s.type === "pickup"), label: "A pickup" },
    { ok: stops.some((s) => s.type === "delivery"), label: "A delivery" },
    { ok: stops.every((s) => s.name.trim()), label: "Every stop has a location" },
    { ok: !timing.length, label: timing.length ? `Stop times: ${timing[0]}` : "Stop times in order" },
  ];
  const done: Record<string, boolean> = {
    "sec-customer": checks[0].ok && checks[1].ok,
    "sec-stops": checks[2].ok && checks[3].ok && checks[4].ok && checks[5].ok,
    "sec-freight": freight.some((l) => l.commodity.trim() || l.pieces.trim() || l.weightLb.trim()),
    "sec-refs": Object.values(refs).some((v) => v?.trim()),
  };

  // highlight the section in view on the step bar
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (seen) setActive(seen.target.id);
    }, { rootMargin: "-120px 0px -55% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const submit = (book: boolean) =>
    start(async () => {
      setErr(null);
      const r = await createLoadAction({
        ...f,
        refs,
        freight,
        stops: stops.map((st) => stopPayload(st, zone)),
        book,
        rateConDocId: rateCon?.id ?? null,
        contract: contract ? { rateId: contract.rateId, rateType: contract.rateType, unitCents: contract.unitCents, miles: contract.miles, fuelRule: contract.fuel.rule === "included" ? "included" : contract.fuel.rule, fuelPct: contract.fuel.pct, fuelCentsPerMile: contract.fuel.centsPerMile } : null,
      });
      if (r && !r.ok) {
        setErr({ field: r.field, message: r.error });
        if (r.field === "stops") setOpen((o) => new Set([...o, ...stops.filter((s) => !s.name.trim()).map((s) => s.key)]));
      }
    });

  return (
    <div>
      {/* header */}
      <div className="max-w-[1320px] mx-auto px-5 md:px-10 pt-8 pb-6">
        <div className="eyebrow mb-2">
          <Link href="/orders" className="hover:text-teal">
            Orders
          </Link>{" "}
          / New load
        </div>
        <h1 className="text-[28px] font-extrabold tracking-tight leading-tight">New load</h1>
        <p className="text-muted text-[14.5px] mt-2 max-w-[70ch]">Who pays, every stop in the order the truck runs them, the freight and the references. The load is split into legs wherever the trailer changes hands.</p>
        {templates.length > 0 && (
          <div className="mt-5 flex items-center gap-3 flex-wrap rounded-xl border border-line bg-white px-5 py-4" data-testid="template-strip">
            <div className="flex-1 min-w-[200px]">
              <div className="font-bold text-[14.5px]">Start from a template</div>
              <div className="text-muted text-[13px] mt-0.5">{tplMsg ?? "A lane you run often: pick it and the pickup date; everything fills in."}</div>
            </div>
            <select className="select w-64" value={tpl.id} onChange={(e) => setTpl({ ...tpl, id: e.target.value })} aria-label="Template">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.customer ? ` · ${t.customer}` : ""}
                </option>
              ))}
            </select>
            <input type="date" className="input w-40" value={tpl.date} onChange={(e) => setTpl({ ...tpl, date: e.target.value })} aria-label="Pickup date" />
            <button type="button" className="btn" disabled={reading || !tpl.id} onClick={applyTemplate}>
              Use template
            </button>
          </div>
        )}
        <div className="mt-5 flex items-center gap-4 flex-wrap rounded-xl border border-dashed border-line bg-white px-5 py-4" data-testid="ratecon-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) readRateCon(file); }}>
          <div className="flex-1 min-w-[240px]">
            <div className="font-bold text-[14.5px]">{rateCon ? `Filled from ${rateCon.fileName}` : "Have the rate con? Start from it."}</div>
            <div className="text-muted text-[13px] mt-0.5">{rateCon ? "Check every field below before booking; the rate con goes on the load." : "Drop the PDF here or choose it — the customer, rate, references, freight and every stop fill in."}</div>
            {rateCon?.warnings.map((w) => (
              <div key={w} className="text-amber text-[12.5px] mt-1 font-semibold">
                {w}
              </div>
            ))}
            {readErr && (
              <div className="error mt-1" role="alert">
                {readErr}
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" aria-label="Rate con file" onChange={(e) => { const file = e.target.files?.[0]; if (file) readRateCon(file); e.target.value = ""; }} />
          <button type="button" className="btn" disabled={reading} onClick={() => fileRef.current?.click()}>
            {reading ? "Reading…" : rateCon ? "Read another" : "Upload rate con"}
          </button>
        </div>
      </div>

      {/* step bar */}
      <nav className="sticky top-12 lg:top-0 z-20 bg-ground/90 backdrop-blur border-y border-line" aria-label="Sections">
        <div className="max-w-[1320px] mx-auto px-5 md:px-10 flex gap-1 overflow-x-auto">
          {SECTIONS.map(([id, label], i) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={() => setActive(id)}
              className={`flex items-center gap-2.5 px-4 h-14 shrink-0 border-b-2 text-[14px] font-semibold transition-colors ${active === id ? "border-teal text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              <span className={`w-6 h-6 rounded-full grid place-items-center text-[11px] font-extrabold ${done[id] ? "bg-teal text-white" : active === id ? "bg-navy text-white" : "bg-line text-muted"}`}>{done[id] ? "✓" : i + 1}</span>
              {label}
            </a>
          ))}
        </div>
      </nav>

      <div className="max-w-[1320px] mx-auto px-5 md:px-10 py-8 grid lg:grid-cols-[minmax(0,1fr)_360px] gap-8 lg:gap-10 items-start">
        <div className="space-y-8 min-w-0 form-roomy">
          {/* 1 — customer & rate */}
          <Section id="sec-customer" n={1} title="Customer & rate" hint="Who you bill for this load and what they pay.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-5">
              <div>
                <label className="label" htmlFor="l-customer">
                  Bill to (customer or broker)
                </label>
                <select id="l-customer" className="select" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} aria-invalid={err?.field === "customerId"}>
                  <option value="">Choose…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.kind === "broker" ? " (broker)" : ""}
                    </option>
                  ))}
                </select>
                {customers.length === 0 && (
                  <div className="help">
                    No customers yet —{" "}
                    <Link href="/settings/customers?add=1" className="text-teal font-semibold">
                      add one
                    </Link>
                    .
                  </div>
                )}
              </div>
              <div>
                <label className="label" htmlFor="l-broker">
                  Broker on the load <span className="font-normal text-faint">(if different)</span>
                </label>
                <select id="l-broker" className="select" value={f.brokerId} onChange={(e) => setF({ ...f, brokerId: e.target.value })}>
                  <option value="">None</option>
                  {customers
                    .filter((c) => c.kind === "broker")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="l-rate">
                  Rate
                </label>
                <div className="flex gap-2">
                  <input id="l-rate" className="input" inputMode="decimal" value={f.rate} onChange={(e) => { setF({ ...f, rate: e.target.value }); setContract(null); }} placeholder="0.00" aria-invalid={err?.field === "rateCents" || err?.field === "rate"} disabled={f.rateTbd} />
                  <select className="select w-28 shrink-0" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label="Currency">
                    <option>USD</option>
                    <option>MXN</option>
                    <option>CAD</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 mt-2.5 text-[13px] cursor-pointer text-muted">
                  <input type="checkbox" className="accent-teal w-4 h-4" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> Rate to be confirmed
                </label>
                {offer && (
                  <div className="mt-3 rounded-lg border border-teal/30 bg-teal/5 px-3.5 py-3 text-[13px]" data-testid="contract-rate">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold">Contract rate · {offer.lane}</div>
                        <div className="text-muted mt-0.5">
                          {offer.rateType === "per_mile" ? `${money(offer.unitCents, offer.currency)}/mi` : money(offer.unitCents, offer.currency)}
                          {offer.rateType === "per_mile" && (offer.miles ? ` × ${offer.miles.toLocaleString()} mi = ${money(offer.rateCents ?? 0, offer.currency)}${offer.minimumApplied ? " (minimum)" : ""}` : " — pick saved locations to estimate the miles")}
                        </div>
                        <div className="text-muted">Fuel: {offer.fuel.rule === "pct" ? `${offer.fuel.pct}%` : offer.fuel.rule === "per_mile" ? `${offer.fuel.centsPerMile}¢/mi` : "included"}{offer.fuel.note && offer.fuel.rule === "included" ? ` — ${offer.fuel.note}` : offer.fuel.note ? ` (${offer.fuel.note})` : ""}</div>
                        {offer.notes && <div className="text-faint mt-0.5">{offer.notes}</div>}
                      </div>
                      {contract?.rateId === offer.rateId && contract.rateCents === offer.rateCents ? (
                        <span className="pill pill-green shrink-0">Applied</span>
                      ) : (
                        <button type="button" className="btn btn-sm shrink-0" onClick={() => applyContract(offer)}>
                          Apply
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="label" htmlFor="l-equipment">
                  Equipment
                </label>
                <select id="l-equipment" className="select" value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })}>
                  {EQUIPMENT.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              {entities.length > 1 && (
                <div>
                  <label className="label" htmlFor="l-entity">
                    Bill from
                  </label>
                  <select id="l-entity" className="select" value={f.billingEntityId} onChange={(e) => setF({ ...f, billingEntityId: e.target.value })}>
                    <option value="">Default</option>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </Section>

          {/* 2 — stops */}
          <Section id="sec-stops" n={2} title="Stops" hint="In the order the truck runs them. Add a yard, border yard, transload or terminal wherever the trailer changes hands — the load splits into legs there." action={<span className="text-[13px] text-muted whitespace-nowrap mt-1">{stops.length} stops</span>}>
            <ol className="relative" data-testid="stops">
              {stops.map((st, i) => {
                const isOpen = open.has(st.key);
                const place = placeLine(st);
                const when = timeLine(st);
                const missing = err?.field === "stops" && !st.name.trim();
                return (
                  <li key={st.key} className="relative pl-12 md:pl-14">
                    {/* the route line */}
                    {i < stops.length - 1 && <span className="absolute left-[15px] md:left-[19px] top-10 -bottom-2 w-0.5 bg-line" aria-hidden />}
                    <span className={`absolute left-0 top-4 w-8 h-8 md:w-10 md:h-10 rounded-full grid place-items-center text-[12px] md:text-[13px] font-extrabold ring-4 ring-white ${st.name.trim() ? "bg-navy text-white" : "bg-white text-muted border-2 border-line"}`}>{i + 1}</span>

                    <div className={`rounded-xl border bg-white transition-shadow ${isOpen ? "border-line shadow-[var(--shadow-card)]" : "border-line hover:border-faint"} ${missing ? "border-red" : ""}`} data-testid="stop">
                      <div className="flex items-center gap-3 px-4 md:px-5 py-4">
                        <button type="button" className="flex-1 min-w-0 text-left" onClick={() => toggle(st.key)} aria-expanded={isOpen} aria-label={`${isOpen ? "Fold" : "Edit"} stop ${i + 1}`}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`pill pill-${STOP_TONE[st.type] ?? "slate"}`}>{STOP_LABEL[st.type] ?? st.type}</span>
                            <span className={`font-bold text-[15px] truncate ${st.name.trim() ? "" : "text-faint font-semibold"}`}>{st.name.trim() || "Location not set"}</span>
                          </div>
                          {(place || when) && (
                            <div className="text-muted text-[13px] mt-1 truncate">
                              {place}
                              {place && when ? " · " : ""}
                              {when}
                            </div>
                          )}
                        </button>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button type="button" className="btn btn-ghost btn-sm w-8 px-0 justify-center" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move stop ${i + 1} up`} title="Move up">
                            ↑
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm w-8 px-0 justify-center" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label={`Move stop ${i + 1} down`} title="Move down">
                            ↓
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm text-red" disabled={stops.length <= 2} onClick={() => remove(i)} aria-label={`Remove stop ${i + 1}`}>
                            Remove
                          </button>
                          <button type="button" className="btn btn-sm ml-1" onClick={() => toggle(st.key)}>
                            {isOpen ? "Done" : "Edit"}
                          </button>
                        </div>
                      </div>
                      {isOpen && (
                        <div className="border-t border-line px-4 md:px-6 py-6">
                          <StopFields stop={st} index={i} locations={locations} onChange={(p) => setStop(i, p)} invalid={err?.field === "stops"} companyZone={zone} />
                        </div>
                      )}
                    </div>

                    <div className="h-10 flex items-center">
                      {i < stops.length - 1 && (
                        <button type="button" className="text-[12.5px] text-teal font-semibold px-2 py-1 rounded-md hover:bg-teal-soft" onClick={() => insertAt(i + 1)} aria-label={`Insert a stop after stop ${i + 1}`}>
                          + Insert stop here
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="w-full h-14 rounded-xl border-2 border-dashed border-line text-teal font-bold text-[14px] hover:border-teal hover:bg-teal-soft transition-colors" onClick={() => insertAt(stops.length)}>
              + Add stop
            </button>
          </Section>

          {/* 3 — freight */}
          <Section
            id="sec-freight"
            n={3}
            title="Freight"
            hint="What's on the trailer. Optional to book; needed on the crossing paperwork."
            action={
              <button type="button" className="btn btn-sm mt-1" onClick={() => setFreight((x) => [...x, blankFreight()])}>
                + Add line
              </button>
            }
          >
            <div className="hidden md:grid grid-cols-[minmax(0,2fr)_100px_150px_130px_90px_40px] gap-4 mb-2">
              {["Commodity", "Pieces", "Packaging", "Weight (lb)", "Hazmat", ""].map((h) => (
                <span key={h} className="label m-0">
                  {h}
                </span>
              ))}
            </div>
            <div className="space-y-3">
              {freight.map((l, i) => (
                <div key={i} className="grid grid-cols-2 md:grid-cols-[minmax(0,2fr)_100px_150px_130px_90px_40px] gap-4 items-center">
                  <input className="input col-span-2 md:col-span-1" placeholder="Commodity" value={l.commodity} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, commodity: e.target.value } : y)))} aria-label={`Freight ${i + 1} commodity`} />
                  <input className="input" placeholder="Pieces" inputMode="numeric" value={l.pieces} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, pieces: e.target.value } : y)))} aria-label={`Freight ${i + 1} pieces`} />
                  <input className="input" placeholder="Pallets, boxes…" value={l.packaging} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, packaging: e.target.value } : y)))} aria-label={`Freight ${i + 1} packaging`} />
                  <input className="input" placeholder="lb" inputMode="numeric" value={l.weightLb} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, weightLb: e.target.value } : y)))} aria-label={`Freight ${i + 1} weight`} />
                  <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input type="checkbox" className="accent-teal w-4 h-4" checked={l.hazmat} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, hazmat: e.target.checked } : y)))} /> <span className="md:sr-only">Hazmat</span>
                  </label>
                  <button type="button" className="btn btn-ghost btn-sm text-red justify-self-end" disabled={freight.length === 1} onClick={() => setFreight((x) => x.filter((_, j) => j !== i))} aria-label={`Remove freight ${i + 1}`}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-6">
              <label className="label" htmlFor="l-cargo">
                Note on the freight <span className="font-normal text-faint">(optional)</span>
              </label>
              <input id="l-cargo" className="input" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} aria-label="Freight note" />
            </div>
          </Section>

          {/* 4 — references */}
          <Section id="sec-refs" n={4} title="References" hint="The numbers the customer, the broker and the docks will quote. All optional.">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-5 gap-y-5">
              {REF_KEYS.map(([k, l]) => (
                <div key={k}>
                  <label className="label" htmlFor={`ref-${k}`}>
                    {l}
                  </label>
                  <input id={`ref-${k}`} className="input" value={refs[k] ?? ""} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} />
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* summary */}
        <aside data-testid="load-summary" className="lg:sticky lg:top-[88px] space-y-4">
          <div className="card p-6">
            <div className="text-[16px] font-extrabold tracking-tight">Summary</div>
            <dl className="mt-4 space-y-3 text-[13.5px]">
              {(
                [
                  ["Bill to", customer?.name ?? "—"],
                  ["Rate", rateText],
                  ["Fuel", fuelText],
                  ["Equipment", EQUIPMENT.find(([v]) => v === f.equipment)?.[1] ?? f.equipment],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold text-right truncate">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="h-px bg-line my-5" />
            <div className="flex items-baseline justify-between">
              <div className="text-[13px] font-bold">Legs</div>
              <div className="text-[12px] text-muted">
                {legs.length} leg{legs.length === 1 ? "" : "s"} · {stops.length} stops
              </div>
            </div>
            <ol className="mt-3 space-y-2" data-testid="legs-preview">
              {legs.map((l, k) => (
                <li key={k} className="rounded-lg bg-ground px-3.5 py-3">
                  <div className="text-[13px] font-bold">
                    Leg {k + 1} · {LEG_TYPE_LABEL[l.type] ?? l.type}
                  </div>
                  <div className="text-muted text-[12.5px] mt-0.5 truncate">
                    {name(l.from)} → {name(l.to)}
                    {l.to - l.from > 1 ? ` · ${l.to - l.from - 1} stop${l.to - l.from - 1 === 1 ? "" : "s"} on the way` : ""}
                  </div>
                </li>
              ))}
            </ol>

            <div className="h-px bg-line my-5" />
            <div className="text-[13px] font-bold mb-2.5">Before booking</div>
            <ul className="space-y-2 text-[13px]">
              {checks.map((c) => (
                <li key={c.label} className={`flex items-center gap-2.5 ${c.ok ? "text-ink" : "text-muted"}`}>
                  <span className={`w-5 h-5 rounded-full grid place-items-center text-[11px] font-extrabold ${c.ok ? "bg-teal text-white" : "border-2 border-line"}`}>{c.ok ? "✓" : ""}</span>
                  {c.label}
                </li>
              ))}
            </ul>

            {err && (
              <div className="error mt-5 rounded-lg bg-red-soft px-3 py-2.5 text-[13px]" role="alert">
                {err.message}
              </div>
            )}
            <button className="btn btn-primary btn-lg w-full justify-center mt-6 h-12 text-[15px]" disabled={pending} onClick={() => submit(true)}>
              {pending ? "Creating…" : "Create & book"}
            </button>
            <button className="btn w-full justify-center mt-2.5 h-10" disabled={pending} onClick={() => submit(false)}>
              Save as draft
            </button>
            <button type="button" className="w-full mt-2.5 text-[12.5px] text-teal font-semibold hover:underline" disabled={pending} onClick={saveAsTemplate}>
              Save as a template for next time
            </button>
            {tplMsg && templates.length === 0 && <div className="text-[12px] text-muted mt-1 text-center">{tplMsg}</div>}
            <p className="mt-4 text-[12px] text-muted leading-relaxed">A booked load goes to Pending on Dispatch, ready to assign leg by leg.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
