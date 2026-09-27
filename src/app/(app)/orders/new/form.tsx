"use client";

import { useMemo, useState, useTransition } from "react";
import { createLoadAction } from "../actions";
import { StopFields, blankStop, stopPayload, STOP_LABEL, type Loc, type StopDraft } from "@/components/stop-fields";
import { legsFromStops, LEG_TYPE_LABEL } from "@/domain/zones";

/**
 * The load builder: who pays and what for, what the freight is, and the stops — as many as the load
 * has, in order, each with its place and time. The legs are cut from the stops (a leg ends where the
 * trailer changes hands; a leg that changes country is the crossing) and shown as you type.
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
type Freight = { commodity: string; pieces: string; packaging: string; weightLb: string; hazmat: boolean };
const blankFreight = (): Freight => ({ commodity: "", pieces: "", packaging: "", weightLb: "", hazmat: false });

export function OrderForm({ customers, entities, locations }: { customers: { id: string; name: string; kind: string }[]; entities: { id: string; name: string }[]; locations: Loc[] }) {
  const [f, setF] = useState({ customerId: "", brokerId: "", billingEntityId: entities.length === 1 ? entities[0].id : "", equipment: "53_dry", rate: "", rateTbd: false, currency: "USD", cargoNote: "" });
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [freight, setFreight] = useState<Freight[]>([blankFreight()]);
  const [stops, setStops] = useState<StopDraft[]>(() => [blankStop("pickup"), blankStop("delivery")]);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = useTransition();

  const setStop = (i: number, patch: Partial<StopDraft>) => setStops((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const insertAt = (i: number) => setStops((s) => [...s.slice(0, i), blankStop(i === 0 ? "pickup" : "delivery", s[Math.max(0, i - 1)]?.country ?? "US"), ...s.slice(i)]);
  const remove = (i: number) => setStops((s) => (s.length <= 2 ? s : s.filter((_, j) => j !== i)));
  const move = (i: number, d: -1 | 1) =>
    setStops((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const out = [...s];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const legs = useMemo(() => legsFromStops(stops.map((st) => ({ type: st.type, country: st.country }))), [stops]);
  const name = (i: number) => stops[i]?.name.trim() || `stop ${i + 1}`;

  const submit = (book: boolean) =>
    start(async () => {
      setErr(null);
      const r = await createLoadAction({ ...f, refs, freight, stops: stops.map(stopPayload), book });
      if (r && !r.ok) setErr({ field: r.field, message: r.error });
    });

  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-5 items-start [&>*]:min-w-0">
      <div className="space-y-4">
        <div className="card p-5">
          <div className="h2 mb-3">Customer & rate</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="l-customer">
                Bill to (customer or broker)
              </label>
              <select id="l-customer" className="select" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} aria-invalid={err?.field === "customerId"}>
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.kind === "broker" ? " (broker)" : ""}
                  </option>
                ))}
              </select>
              {customers.length === 0 && <div className="help">No customers yet — add them under Settings → Customers & brokers.</div>}
            </div>
            <div>
              <label className="label" htmlFor="l-broker">
                Broker on the load (if different)
              </label>
              <select id="l-broker" className="select" value={f.brokerId} onChange={(e) => setF({ ...f, brokerId: e.target.value })}>
                <option value="">—</option>
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
                <input id="l-rate" className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="0.00" aria-invalid={err?.field === "rateCents" || err?.field === "rate"} disabled={f.rateTbd} />
                <select className="select w-24" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label="Currency">
                  <option>USD</option>
                  <option>MXN</option>
                  <option>CAD</option>
                </select>
              </div>
              <label className="flex items-center gap-2 mt-1.5 text-[12.5px] cursor-pointer">
                <input type="checkbox" className="accent-teal" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> Rate to be confirmed
              </label>
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
                  <option value="">— default —</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="eyebrow mt-4 mb-2">References</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {REF_KEYS.map(([k, l]) => (
              <div key={k}>
                <label className="label" htmlFor={`ref-${k}`}>
                  {l}
                </label>
                <input id={`ref-${k}`} className="input" value={refs[k] ?? ""} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-2">
            <div className="h2">Freight</div>
            <button type="button" className="btn btn-sm" onClick={() => setFreight((x) => [...x, blankFreight()])}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {freight.map((l, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-[2fr_90px_130px_120px_auto_auto] gap-2 items-center">
                <input className="input col-span-2 md:col-span-1" placeholder="Commodity" value={l.commodity} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, commodity: e.target.value } : y)))} aria-label={`Freight ${i + 1} commodity`} />
                <input className="input" placeholder="Pieces" inputMode="numeric" value={l.pieces} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, pieces: e.target.value } : y)))} aria-label={`Freight ${i + 1} pieces`} />
                <input className="input" placeholder="Pallets, boxes…" value={l.packaging} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, packaging: e.target.value } : y)))} aria-label={`Freight ${i + 1} packaging`} />
                <input className="input" placeholder="Weight (lb)" inputMode="numeric" value={l.weightLb} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, weightLb: e.target.value } : y)))} aria-label={`Freight ${i + 1} weight`} />
                <label className="flex items-center gap-1.5 text-[12.5px] cursor-pointer">
                  <input type="checkbox" className="accent-teal" checked={l.hazmat} onChange={(e) => setFreight((x) => x.map((y, j) => (j === i ? { ...y, hazmat: e.target.checked } : y)))} /> Hazmat
                </label>
                <button type="button" className="btn btn-ghost btn-sm text-red" disabled={freight.length === 1} onClick={() => setFreight((x) => x.filter((_, j) => j !== i))} aria-label={`Remove freight ${i + 1}`}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <input className="input mt-2" placeholder="Note on the freight (optional)" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} aria-label="Freight note" />
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-1">
            <div className="h2">Stops</div>
            <span className="text-[12.5px] text-muted">{stops.length} stops</span>
          </div>
          <div className="text-[12.5px] text-muted mb-3">In the order the truck runs them. Add every pickup and drop; add a yard, border yard or transload where the trailer changes hands and the load is split into legs there.</div>
          <div className="space-y-2" data-testid="stops">
            {stops.map((st, i) => (
              <div key={st.key}>
                <div className="rounded-lg border border-line p-3" data-testid="stop">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-6 h-6 rounded-full bg-navy text-white grid place-items-center text-[11px] font-extrabold">{i + 1}</span>
                    <span className="font-bold">{STOP_LABEL[st.type] ?? st.type}</span>
                    <span className="ml-auto flex gap-1">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move stop ${i + 1} up`}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label={`Move stop ${i + 1} down`}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm text-red" disabled={stops.length <= 2} onClick={() => remove(i)} aria-label={`Remove stop ${i + 1}`}>
                        Remove
                      </button>
                    </span>
                  </div>
                  <StopFields stop={st} index={i} locations={locations} onChange={(p) => setStop(i, p)} invalid={err?.field === "stops"} />
                </div>
                {i < stops.length - 1 && (
                  <div className="flex justify-center -my-0.5">
                    <button type="button" className="text-[12px] text-teal font-semibold px-2 py-0.5 hover:underline" onClick={() => insertAt(i + 1)} aria-label={`Insert a stop after stop ${i + 1}`}>
                      + insert stop here
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="btn w-full justify-center mt-3" onClick={() => insertAt(stops.length)}>
            + Add stop
          </button>
        </div>
      </div>

      <aside className="card p-5 lg:sticky lg:top-5">
        <div className="h2">Legs</div>
        <div className="text-[12.5px] text-muted mt-0.5 mb-2">Cut from the stops: a leg ends where the trailer changes hands. Each leg is assigned on its own — your truck or a partner carrier.</div>
        <ol className="space-y-1.5 text-[13px] mb-4" data-testid="legs-preview">
          {legs.map((l, k) => (
            <li key={k} className="rounded-lg bg-ground px-3 py-2">
              <b>
                Leg {k + 1} · {LEG_TYPE_LABEL[l.type] ?? l.type}
              </b>
              <div className="text-muted text-[12.5px] truncate">
                {name(l.from)} → {name(l.to)}
                {l.to - l.from > 1 ? ` · ${l.to - l.from - 1} stop${l.to - l.from - 1 === 1 ? "" : "s"} on the way` : ""}
              </div>
            </li>
          ))}
        </ol>
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
        <div className="mt-3 text-[12px] text-muted">Booking needs the bill-to and a rate (or rate to be confirmed). Every stop needs a location name. A booked load goes to Pending on Dispatch.</div>
      </aside>
    </div>
  );
}
