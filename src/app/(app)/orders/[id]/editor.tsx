"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOrderAction, updateStopAction } from "../actions";
import { bookAction, cancelAction, holdAction, releaseAction, setLegMilesAction, copyOrderAction } from "../../dispatch/actions";
import { Confirm, Toast, useToast } from "@/components/ui";

const REF_LABEL: Record<string, string> = { rate_con: "Rate con", po: "PO", asn: "ASN", shipment: "Shipment", reference: "Reference" };
type Order = { id: string; state: string; kind?: string; customerId: string | null; brokerId: string | null; billingEntityId: string | null; equipment: string; rateCents: number | null; rateTbd: boolean; currency: string; fuelRule: string; fuelPct: number | null; tollsFeesCents: number | null; refs: Record<string, string>; cargoNote: string | null; updatedAt: string };
type Stop = { id: string; type: string; name: string; country: string; address: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } | null; windowStart: string | null; windowEnd: string | null; appointment: boolean; contact: string | null; notes: string | null; arrivedAt: string | null; departedAt: string | null };

const toLocal = (s: string | null) => (s ? new Date(new Date(s).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
const fmtAddr = (a: Stop["address"]) => (a ? [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") : "");

export function OrderEditor({ order, customers, entities, readOnly }: { order: Order; customers: { id: string; name: string; kind: string }[]; entities: { id: string; name: string }[]; readOnly: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ customerId: order.customerId ?? "", brokerId: order.brokerId ?? "", billingEntityId: order.billingEntityId ?? "", equipment: order.equipment, rate: order.rateCents != null ? (order.rateCents / 100).toFixed(2) : "", rateTbd: order.rateTbd, currency: order.currency, cargoNote: order.cargoNote ?? "", fuelRule: order.fuelRule ?? "included", fuelPct: order.fuelPct != null ? String(order.fuelPct) : "", tollsFees: order.tollsFeesCents != null ? (order.tollsFeesCents / 100).toFixed(2) : "" });
  const [refs, setRefs] = useState<Record<string, string>>({ rate_con: "", po: "", asn: "", shipment: "", reference: "", ...order.refs });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <fieldset disabled={readOnly} className="contents">
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <label className="label">Bill to (customer or broker)</label>
          <select className="select" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>
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
        <div>
          <label className="label">Rate</label>
          <div className="flex gap-2">
            <input className="input" inputMode="decimal" aria-label="Rate" value={f.rate} disabled={f.rateTbd || readOnly} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            <select className="select w-24" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              <option>USD</option>
              <option>MXN</option>
            </select>
          </div>
          <label className="flex items-center gap-2 mt-1.5 text-[12.5px] cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> TBD
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
          <label className="label">Cargo note</label>
          <input className="input" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} />
        </div>
        <div>
          <label className="label">Fuel</label>
          <div className="flex gap-2">
            <select className="select" value={f.fuelRule} onChange={(e) => setF({ ...f, fuelRule: e.target.value })} aria-label="Fuel rule">
              <option value="included">Included in the rate</option>
              <option value="pct">Surcharge % of line haul</option>
            </select>
            {f.fuelRule === "pct" && <input className="input w-20" inputMode="numeric" value={f.fuelPct} onChange={(e) => setF({ ...f, fuelPct: e.target.value })} placeholder="%" aria-label="Fuel percent" />}
          </div>
        </div>
        <div>
          <label className="label">Tolls &amp; fees (cost)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
            <input className="input pl-7" inputMode="decimal" value={f.tollsFees} onChange={(e) => setF({ ...f, tollsFees: e.target.value })} placeholder="0.00" aria-label="Tolls and fees" />
          </div>
          <div className="help">Known extra cost for the P&amp;L — not billed.</div>
        </div>
      </div>
      <div className="eyebrow mt-4 mb-2">References</div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {Object.keys(refs).map((k) => (
          <div key={k}>
            <label className="label">{REF_LABEL[k] ?? k.replace(/_/g, " ")}</label>
            <input className="input" value={refs[k]} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} aria-label={`${REF_LABEL[k] ?? k} reference`} />
          </div>
        ))}
      </div>
      {!readOnly && (
        <div className="flex items-center justify-end gap-3 mt-4">
          {err && <span className="error m-0">{err}</span>}
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await updateOrderAction(order.id, { ...f, refs }, order.updatedAt);
                if (r.ok) {
                  t.ok("Saved");
                  router.refresh();
                } else setErr(r.error);
              })
            }
          >
            {pending ? "Saving…" : "Save order"}
          </button>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </fieldset>
  );
}

export function StopEditor({ orderId, index, stop, readOnly }: { orderId: string; index: number; stop: Stop; readOnly: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: stop.name, address: fmtAddr(stop.address), country: stop.country, windowStart: toLocal(stop.windowStart), windowEnd: toLocal(stop.windowEnd), appointment: stop.appointment, contact: stop.contact ?? "", notes: stop.notes ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const done = !!stop.departedAt;
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={() => setOpen(!open)}>
        <span className={`w-6 h-6 rounded-full grid place-items-center text-[11px] font-extrabold ${done ? "bg-teal text-white" : stop.arrivedAt ? "bg-teal-soft text-teal" : "bg-line text-muted"}`}>{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">
            {stop.name} <span className="text-faint font-normal">· {stop.type.replace("_", " ")} · {stop.country}</span>
          </div>
          <div className="text-muted text-[12.5px] truncate">
            {fmtAddr(stop.address) || "no address"}
            {stop.windowStart ? ` · ${new Date(stop.windowStart).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
            {stop.arrivedAt ? ` · in ${new Date(stop.arrivedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
            {stop.departedAt ? ` · out ${new Date(stop.departedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
          </div>
        </div>
        <span className="text-faint">{open ? "▴" : "▾"}</span>
      </div>
      {open && (
        <fieldset disabled={readOnly} className="px-3 pb-3 border-t border-line pt-3">
          <div className="grid grid-cols-2 md:grid-cols-[1.2fr_2fr_80px] gap-2">
            <input className="input" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input className="input" placeholder="Street, City, ST 00000" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            <select className="select" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
              <option>MX</option>
              <option>US</option>
            </select>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-[1fr_1fr_auto_1fr] gap-2 mt-2">
            <div>
              <label className="label">Window from</label>
              <input type="datetime-local" className="input" value={f.windowStart} onChange={(e) => setF({ ...f, windowStart: e.target.value })} />
            </div>
            <div>
              <label className="label">to</label>
              <input type="datetime-local" className="input" value={f.windowEnd} onChange={(e) => setF({ ...f, windowEnd: e.target.value })} />
            </div>
            <label className="flex items-end gap-2 pb-2 text-[12.5px] cursor-pointer whitespace-nowrap">
              <input type="checkbox" className="accent-teal" checked={f.appointment} onChange={(e) => setF({ ...f, appointment: e.target.checked })} /> Appt
            </label>
            <div>
              <label className="label">Contact</label>
              <input className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} />
            </div>
          </div>
          <div className="mt-2">
            <label className="label">Notes for the driver</label>
            <input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
          {!readOnly && (
            <div className="flex justify-end items-center gap-3 mt-3">
              {err && <span className="error m-0">{err}</span>}
              <button
                className="btn btn-primary btn-sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await updateStopAction(orderId, stop.id, { ...f, windowStart: f.windowStart ? new Date(f.windowStart).toISOString() : "", windowEnd: f.windowEnd ? new Date(f.windowEnd).toISOString() : "" });
                    if (r.ok) {
                      setOpen(false);
                      router.refresh();
                    } else setErr(r.error);
                  })
                }
              >
                Save stop
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

export function OrderActions({ order }: { order: Order }) {
  const router = useRouter();
  const t = useToast();
  const [cancel, setCancel] = useState(false);
  const [hold, setHold] = useState(false);
  const [pending, start] = useTransition();
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <>
      {order.state === "draft" && (
        <button className="btn btn-primary" disabled={pending} onClick={() => run("Booked — it's in Pending on Dispatch", () => bookAction(order.id))}>
          Book
        </button>
      )}
      {(order.kind ?? "order") === "order" && (
        <button
          className="btn"
          disabled={pending}
          title="A new draft with the same customer, rate, equipment and stops; windows, references and assignments start over"
          onClick={() =>
            start(async () => {
              const r = await copyOrderAction(order.id);
              if (r.ok) router.push(`/orders/${r.data.id}`);
              else t.err(r.error);
            })
          }
        >
          Book again
        </button>
      )}
      {["dispatched", "in_transit"].includes(order.state) && (
        <button className="btn" onClick={() => setHold(true)}>
          Hold
        </button>
      )}
      {order.state === "exception" && (
        <button className="btn btn-primary" disabled={pending} onClick={() => run("Released", () => releaseAction(order.id))}>
          Release hold
        </button>
      )}
      {["draft", "booked", "dispatched", "in_transit", "exception"].includes(order.state) && (
        <button className="btn btn-danger" onClick={() => setCancel(true)}>
          Cancel order
        </button>
      )}
      <Confirm open={hold} onClose={() => setHold(false)} title="Put on hold" needReason="Why?" confirmLabel="Hold" onConfirm={(r) => { setHold(false); run("On hold", () => holdAction(order.id, r)); }} />
      <Confirm open={cancel} onClose={() => setCancel(false)} title="Cancel this order" body="Open legs are cancelled. A moving leg must come back first." needReason="Reason" confirmLabel="Cancel order" danger onConfirm={(r) => { setCancel(false); run("Cancelled", () => cancelAction(order.id, r)); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

/** Inline planned-miles cell on the legs table: type, blur or Enter to save. */
export function LegMiles({ legId, miles, locked }: { legId: string; miles: number | null; locked: boolean }) {
  const router = useRouter();
  const [v, setV] = useState(miles != null ? String(miles) : "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  if (locked) return <span className="mono">{miles ?? "—"}</span>;
  const save = async () => {
    if (v === (miles != null ? String(miles) : "")) return;
    setState("saving");
    const r = await setLegMilesAction(legId, v);
    if (r.ok) {
      setState("saved");
      setMsg(null);
      router.refresh();
    } else {
      setState("error");
      setMsg(r.error);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input className="input w-20 h-7 px-2 mono" inputMode="numeric" value={v} aria-label="Planned miles" onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} placeholder="mi" aria-invalid={state === "error"} />
      {state === "saved" && <span className="text-teal text-[11px] font-bold">✓</span>}
      {msg && <span className="error m-0 text-[11px]">{msg}</span>}
    </span>
  );
}
