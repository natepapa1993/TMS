"use client";

import { useMemo, useState, useTransition } from "react";
import { createOrderAction, type StopForm } from "../actions";

type Loc = { id: string; name: string; country: string; kind: string; address: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } };
const STOP_LABEL: Record<string, string> = { pickup: "Pickup", delivery: "Delivery", yard: "Yard", border_yard: "Border yard", transload: "Transload", customs: "Customs", terminal: "Terminal" };
const REF_KEYS = ["rate_con", "po", "asn", "shipment", "reference"];
const REF_LABEL: Record<string, string> = { rate_con: "Rate con", po: "PO", asn: "ASN", shipment: "Shipment", reference: "Reference" };
const fmtAddr = (a: Loc["address"]) => [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");

export function OrderForm({ customers, entities, locations, templates }: { customers: { id: string; name: string; kind: string }[]; entities: { id: string; name: string }[]; locations: Loc[]; templates: { key: string; label: string; description: string; stops: string[] }[] }) {
  const [template, setTemplate] = useState(templates[1]?.key ?? templates[0].key);
  const tpl = useMemo(() => templates.find((t) => t.key === template)!, [template, templates]);
  const blank = (type: string, i: number): StopForm => ({ type: type as StopForm["type"], name: "", address: "", country: type === "border_yard" ? "MX" : i === 0 ? "MX" : "US", windowStart: "", windowEnd: "", appointment: false, contact: "", notes: "" });
  const [stops, setStops] = useState<StopForm[]>(() => tpl.stops.map((t, i) => blank(t, i)));
  const [f, setF] = useState({ customerId: "", brokerId: "", billingEntityId: entities[0]?.id ?? "", equipment: "53_dry", rate: "", rateTbd: false, currency: "USD", cargoNote: "" });
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = useTransition();

  const changeTemplate = (key: string) => {
    setTemplate(key);
    const t = templates.find((x) => x.key === key)!;
    setStops((prev) => t.stops.map((type, i) => (i === 0 && prev[0] ? { ...prev[0], type: type as StopForm["type"] } : i === t.stops.length - 1 && prev[prev.length - 1] ? { ...prev[prev.length - 1], type: type as StopForm["type"] } : blank(type, i))));
  };
  const setStop = (i: number, patch: Partial<StopForm>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const applyLocation = (i: number, id: string) => {
    const l = locations.find((x) => x.id === id);
    if (l) setStop(i, { name: l.name, address: fmtAddr(l.address), country: l.country });
  };

  const submit = (book: boolean) =>
    start(async () => {
      setErr(null);
      const r = await createOrderAction({ ...f, refs, template, stops, book });
      if (r && !r.ok) setErr({ field: r.field, message: r.error });
    });

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-5 items-start [&>*]:min-w-0">
      <div className="space-y-4">
        <div className="card p-5">
          <div className="h2 mb-3">Who & what</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Bill to (customer or broker)</label>
              <select className="select" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} aria-invalid={err?.field === "customerId"}>
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.kind === "broker" ? " (broker)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Broker on the load (if different)</label>
              <select className="select" value={f.brokerId} onChange={(e) => setF({ ...f, brokerId: e.target.value })}>
                <option value="">—</option>
                {customers.filter((c) => c.kind === "broker").map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Rate</label>
              <div className="flex gap-2">
                <input className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="0.00" aria-invalid={err?.field === "rateCents" || err?.field === "rate"} disabled={f.rateTbd} />
                <select className="select w-24" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
                  <option>USD</option>
                  <option>MXN</option>
                </select>
              </div>
              <label className="flex items-center gap-2 mt-1.5 text-[12.5px] cursor-pointer">
                <input type="checkbox" className="accent-teal" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> Rate to be confirmed
              </label>
            </div>
            <div>
              <label className="label">Equipment</label>
              <select className="select" value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })}>
                {["53_dry", "53_reefer", "48_dry", "flatbed", "sprinter", "straight", "power_only"].map((e) => (
                  <option key={e} value={e}>
                    {e.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Bill from</label>
              <select className="select" value={f.billingEntityId} onChange={(e) => setF({ ...f, billingEntityId: e.target.value })}>
                <option value="">—</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Cargo note</label>
              <input className="input" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} placeholder="26 pallets auto parts, 38,000 lb, no hazmat" />
            </div>
          </div>
          <div className="eyebrow mt-4 mb-2">References</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {REF_KEYS.map((k) => (
              <div key={k}>
                <label className="label">{REF_LABEL[k] ?? k.replace("_", " ")}</label>
                <input className="input" value={refs[k] ?? ""} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="h2">Stops & legs</div>
            <select className="select w-72" value={template} onChange={(e) => changeTemplate(e.target.value)}>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="text-muted text-[12.5px] mb-3">{tpl.description}.</div>
          <div className="space-y-3">
            {stops.map((st, i) => (
              <div key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded-full bg-navy text-white grid place-items-center text-[11px] font-extrabold">{i + 1}</span>
                  <span className="font-bold">{STOP_LABEL[st.type] ?? st.type}</span>
                  <select className="select w-56 h-8 ml-auto text-[12.5px]" value="" onChange={(e) => applyLocation(i, e.target.value)}>
                    <option value="">Use a saved location…</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.country})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-[1.2fr_2fr_80px] gap-2">
                  <input className="input" placeholder="Name" value={st.name} onChange={(e) => setStop(i, { name: e.target.value })} aria-invalid={err?.field === "stops" && !st.name} />
                  <input className="input" placeholder="Street, City, ST 00000" value={st.address} onChange={(e) => setStop(i, { address: e.target.value })} />
                  <select className="select" value={st.country} onChange={(e) => setStop(i, { country: e.target.value })}>
                    <option>MX</option>
                    <option>US</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-[1fr_1fr_auto_1fr] gap-2 mt-2">
                  <div>
                    <label className="label">Window from</label>
                    <input type="datetime-local" className="input" value={st.windowStart} onChange={(e) => setStop(i, { windowStart: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">to</label>
                    <input type="datetime-local" className="input" value={st.windowEnd} onChange={(e) => setStop(i, { windowEnd: e.target.value })} />
                  </div>
                  <label className="flex items-end gap-2 pb-2 text-[12.5px] cursor-pointer whitespace-nowrap">
                    <input type="checkbox" className="accent-teal" checked={st.appointment} onChange={(e) => setStop(i, { appointment: e.target.checked })} /> Appt
                  </label>
                  <div>
                    <label className="label">Contact / notes</label>
                    <input className="input" value={st.contact} onChange={(e) => setStop(i, { contact: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <aside className="card p-5 sticky top-5">
        <div className="h2">Create</div>
        <p className="text-muted text-[13px] mt-1 mb-4">Booked orders land in Pending on Dispatch. A draft stays here until you book it.</p>
        {err && (
          <div className="error mb-3" role="alert">
            {err.message}
          </div>
        )}
        <button className="btn btn-primary btn-lg w-full justify-center" disabled={pending} onClick={() => submit(true)}>
          {pending ? "Creating…" : "Create & book"}
        </button>
        <button className="btn w-full justify-center mt-2" disabled={pending} onClick={() => submit(false)}>
          Save as draft
        </button>
        <div className="mt-4 text-[12px] text-muted">
          Booking needs a customer or broker and a rate (or TBD). Stops need a name. Legs are cut from the template: {tpl.stops.length - 1} leg{tpl.stops.length > 2 ? "s" : ""}.
        </div>
      </aside>
    </div>
  );
}
