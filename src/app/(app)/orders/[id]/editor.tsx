"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOrderAction, updateStopAction, addStopAction, removeStopAction, moveStopAction, lockAction, tonuAction, templateFromOrderAction } from "../actions";
import { bookAction, cancelAction, holdAction, releaseAction, setLegMilesAction, copyOrderAction } from "../../dispatch/actions";
import { Confirm, Modal, MoreMenu, Toast, useToast } from "@/components/ui";
import { StopFields, blankStop, stopPayload, STOP_LABEL, COUNTRIES, type Loc, type StopDraft } from "@/components/stop-fields";
import { stopZone, toZoneInput, fromZoneInput, fmtIn, zoneAbbrev } from "@/lib/time";

const REF_LABEL: Record<string, string> = { rate_con: "Rate con", po: "PO", asn: "ASN", shipment: "Shipment", reference: "Reference" };
type Order = { id: string; state: string; kind?: string; customerId: string | null; brokerId: string | null; billingEntityId: string | null; equipment: string; rateCents: number | null; rateTbd: boolean; currency: string; fuelRule: string; fuelPct: number | null; tollsFeesCents: number | null; refs: Record<string, string>; cargoNote: string | null; updatedAt: string; lockedAt?: string | null; tonu?: boolean };
type Stop = { id: string; type: string; name: string; country: string; address: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } | null; windowStart: string | null; windowEnd: string | null; appointment: boolean; contact: string | null; notes: string | null; arrivedAt: string | null; departedAt: string | null; sealIn?: string | null; sealOut?: string | null };

const fmtAddr = (a: Stop["address"]) => (a ? [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") : "");

export function OrderEditor({ order, customers, entities, readOnly }: { order: Order; customers: { id: string; name: string; kind: string }[]; entities: { id: string; name: string }[]; readOnly: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ customerId: order.customerId ?? "", brokerId: order.brokerId ?? "", billingEntityId: order.billingEntityId ?? "", equipment: order.equipment, cargoNote: order.cargoNote ?? "" });
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
          <label className="label">Equipment</label>
          <select className="select" value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })}>
            {(
              [
                ["53_dry", "53' dry van"],
                ["53_reefer", "53' reefer"],
                ["48_dry", "48' dry van"],
                ["flatbed", "Flatbed"],
                ["sprinter", "Sprinter / cargo van"],
                ["straight", "Straight truck"],
                ["power_only", "Power only"],
              ] as const
            ).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cargo note</label>
          <input className="input" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} />
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
            {pending ? "Saving…" : "Save details"}
          </button>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </fieldset>
  );
}

export function StopEditor({ orderId, index, count, stop, readOnly, restructure, zone: companyZone = "America/Chicago" }: { orderId: string; index: number; count: number; stop: Stop; readOnly: boolean; restructure: boolean; zone?: string }) {
  // times are typed and shown on the stop's own clock
  const zone = stopZone({ country: stop.country, address: stop.address as { state?: string } | null }, companyZone);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: stop.name, address: fmtAddr(stop.address), country: stop.country, windowStart: toZoneInput(stop.windowStart, zone), windowEnd: toZoneInput(stop.windowEnd, zone), appointment: stop.appointment, contact: stop.contact ?? "", notes: stop.notes ?? "", sealIn: stop.sealIn ?? "", sealOut: stop.sealOut ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const done = !!stop.departedAt;
  const t = useToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const change = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={() => setOpen(!open)}>
        <span className={`w-6 h-6 rounded-full grid place-items-center text-caption font-extrabold ${done ? "bg-teal text-white" : stop.arrivedAt ? "bg-teal-soft text-teal" : "bg-line text-muted"}`}>{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">
            {stop.name} <span className="text-faint font-normal">· {STOP_LABEL[stop.type] ?? stop.type.replace("_", " ")} · {stop.country}</span>
          </div>
          <div className="text-muted text-callout truncate">
            {fmtAddr(stop.address) || "no address"}
            {stop.windowStart ? ` · ${fmtIn(stop.windowStart, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
            {stop.arrivedAt ? ` · in ${fmtIn(stop.arrivedAt, zone, { hour: "numeric", minute: "2-digit", month: undefined, day: undefined })}` : ""}
            {stop.departedAt ? ` · out ${fmtIn(stop.departedAt, zone, { hour: "numeric", minute: "2-digit", month: undefined, day: undefined })}` : ""}
            {stop.sealIn || stop.sealOut ? <span className="mono"> · seal {stop.sealIn ? `in ${stop.sealIn}` : ""}{stop.sealIn && stop.sealOut ? " / " : ""}{stop.sealOut ? `out ${stop.sealOut}` : ""}</span> : ""}
          </div>
        </div>
        {restructure && !readOnly && !stop.arrivedAt && (
          <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-ghost btn-sm" disabled={pending || index === 0} onClick={() => change("Stop moved — legs re-cut", () => moveStopAction(orderId, stop.id, -1))} aria-label={`Move stop ${index + 1} up`} title="Move up">
              ↑
            </button>
            <button className="btn btn-ghost btn-sm" disabled={pending || index === count - 1} onClick={() => change("Stop moved — legs re-cut", () => moveStopAction(orderId, stop.id, 1))} aria-label={`Move stop ${index + 1} down`} title="Move down">
              ↓
            </button>
            <button className="btn btn-ghost btn-sm text-red" disabled={pending || count <= 2} onClick={() => setConfirmRemove(true)} aria-label={`Remove stop ${index + 1}`} title="Remove">
              ×
            </button>
          </span>
        )}
        <span className="text-faint">{open ? "▴" : "▾"}</span>
      </div>
      <Confirm open={confirmRemove} title={`Remove ${stop.name}?`} body="The legs are re-cut from the remaining stops. A leg that no longer exists loses its assignment." confirmLabel="Remove stop" danger onClose={() => setConfirmRemove(false)} onConfirm={() => { setConfirmRemove(false); change("Stop removed — legs re-cut", () => removeStopAction(orderId, stop.id)); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
      {open && (
        <fieldset disabled={readOnly} className="px-3 pb-3 border-t border-line pt-3">
          <div className="grid grid-cols-2 md:grid-cols-[1.2fr_2fr_80px] gap-2">
            <input className="input" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input className="input" placeholder="Street, City, ST 00000" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            <select className="select" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} aria-label="Country">
              {COUNTRIES.map(([v]) => (
                <option key={v}>{v}</option>
              ))}
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
            <label className="flex items-end gap-2 pb-2 text-callout cursor-pointer whitespace-nowrap">
              <input type="checkbox" className="accent-teal" checked={f.appointment} onChange={(e) => setF({ ...f, appointment: e.target.checked })} /> Appt
            </label>
            <div>
              <label className="label">Contact</label>
              <input className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_120px_120px] gap-2 mt-2">
            <div>
              <label className="label">Notes for the driver</label>
              <input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </div>
            <div>
              <label className="label">Seal found</label>
              <input className="input mono" value={f.sealIn} onChange={(e) => setF({ ...f, sealIn: e.target.value })} aria-label="Seal found" placeholder="on opening" />
            </div>
            <div>
              <label className="label">Seal applied</label>
              <input className="input mono" value={f.sealOut} onChange={(e) => setF({ ...f, sealOut: e.target.value })} aria-label="Seal applied" placeholder="on leaving" />
            </div>
          </div>
          {!readOnly && (
            <div className="flex justify-end items-center gap-3 mt-3">
              {err && <span className="error m-0">{err}</span>}
              <button
                className="btn btn-primary btn-sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await updateStopAction(orderId, stop.id, { ...f, windowStart: f.windowStart ? (fromZoneInput(f.windowStart, zone)?.toISOString() ?? "") : "", windowEnd: f.windowEnd ? (fromZoneInput(f.windowEnd, zone)?.toISOString() ?? "") : "" });
                    if (r.ok) {
                      setOpen(false);
                      setErr(null);
                      t.ok(`Stop ${index + 1} saved`);
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

type End = { name: string; at: string | null; zone: string };

export function OrderActions({ order, ends = null }: { order: Order; ends?: { pickup: End; delivery: End } | null }) {
  const router = useRouter();
  const t = useToast();
  const [again, setAgain] = useState<{ pickup: string; delivery: string } | null>(null);
  const [againErr, setAgainErr] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const [hold, setHold] = useState(false);
  const [tonu, setTonu] = useState(false);
  const [tonuF, setTonuF] = useState({ amount: "", reason: "" });
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
          title="A new draft with the same customer, rate, equipment and stops for new dates; references and assignments start over"
          onClick={() => {
            setAgainErr(null);
            if (!ends) return setAgain({ pickup: "", delivery: "" });
            // the old times moved to the next day they can happen, same time of day; the dispatcher changes them here
            const DAY = 86400_000;
            const old = ends.pickup.at ? new Date(ends.pickup.at).getTime() : null;
            const shift = old ? Math.max(1, Math.ceil((Date.now() - old) / DAY)) * DAY : DAY;
            const moved = (at: string | null, zone: string) => (at ? toZoneInput(new Date(new Date(at).getTime() + shift), zone) : "");
            setAgain({ pickup: moved(ends.pickup.at, ends.pickup.zone) || toZoneInput(new Date(Date.now() + DAY), ends.pickup.zone), delivery: moved(ends.delivery.at, ends.delivery.zone) });
          }}
        >
          Book again
        </button>
      )}
      <Modal
        open={!!again}
        onClose={() => setAgain(null)}
        title="Book it again — for when?"
        footer={
          <>
            <button className="btn" onClick={() => setAgain(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !again?.pickup}
              onClick={() =>
                again &&
                start(async () => {
                  const pickupAt = fromZoneInput(again.pickup, ends?.pickup.zone ?? "America/Chicago");
                  const deliveryAt = again.delivery ? fromZoneInput(again.delivery, ends?.delivery.zone ?? "America/Chicago") : null;
                  const r = await copyOrderAction(order.id, { pickupAt: pickupAt?.toISOString() ?? null, deliveryAt: deliveryAt?.toISOString() ?? null });
                  if (r.ok) router.push(`/orders/${r.data.id}`);
                  else setAgainErr(r.error);
                })
              }
            >
              Make the draft
            </button>
          </>
        }
      >
        <p className="text-callout text-muted mb-3">Same customer, rate, equipment and stops. The PO, customer load #, rate con and every truck start over — add the new load&apos;s references on the draft.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="again-pu">
              Pickup{ends ? ` · ${ends.pickup.name}` : ""}
            </label>
            <input id="again-pu" type="datetime-local" className="input" value={again?.pickup ?? ""} onChange={(e) => again && setAgain({ ...again, pickup: e.target.value })} />
            {ends && <div className="help">{zoneAbbrev(ends.pickup.zone)} — the stop&apos;s own clock</div>}
          </div>
          <div>
            <label className="label" htmlFor="again-del">
              Delivery{ends ? ` · ${ends.delivery.name}` : ""}
            </label>
            <input id="again-del" type="datetime-local" className="input" value={again?.delivery ?? ""} onChange={(e) => again && setAgain({ ...again, delivery: e.target.value })} />
            {ends && <div className="help">{zoneAbbrev(ends.delivery.zone)} — the stop&apos;s own clock</div>}
          </div>
        </div>
        {againErr && <div className="error mt-2">{againErr}</div>}
      </Modal>
      {["booked", "dispatched", "in_transit"].includes(order.state) && (
        <button className="btn" onClick={() => setHold(true)}>
          Hold
        </button>
      )}
      {order.state === "exception" && (
        <button className="btn btn-primary" disabled={pending} onClick={() => run("Released", () => releaseAction(order.id))}>
          Release hold
        </button>
      )}
      <MoreMenu label="More actions for this load">
        {(order.kind ?? "order") === "order" && (
          <button
            className="menu-item"
            role="menuitem"
            disabled={pending}
            title="Save this lane as a template: stops, times of day, rate and freight"
            onClick={() => {
              const name = window.prompt("Name the template (e.g. Canton → Toronto, Acme)")?.trim();
              if (name) run(`Saved as template “${name}”`, () => templateFromOrderAction(order.id, name));
            }}
          >
            Save as template
          </button>
        )}
        {(order.kind ?? "order") === "order" && ["booked", "dispatched", "in_transit", "exception"].includes(order.state) && (
          <button className="menu-item" role="menuitem" onClick={() => setTonu(true)} title="Truck ordered, not used: cancel and bill the TONU fee">
            TONU — truck ordered, not used
          </button>
        )}
        {!["paid", "cancelled"].includes(order.state) && (
          <button className="menu-item" role="menuitem" disabled={pending} onClick={() => run(order.lockedAt ? "Unlocked" : "Locked — no edits until unlocked", () => lockAction(order.id, !order.lockedAt))}>
            {order.lockedAt ? "Unlock" : "Lock"}
          </button>
        )}
        {["draft", "booked", "dispatched", "in_transit", "exception"].includes(order.state) && (
          <>
            <div className="menu-sep" />
            <button className="menu-item danger" role="menuitem" onClick={() => setCancel(true)}>
              Cancel order
            </button>
          </>
        )}
      </MoreMenu>
      <Modal
        open={tonu}
        onClose={() => setTonu(false)}
        title="Truck ordered, not used"
        footer={
          <>
            <button className="btn" onClick={() => setTonu(false)}>
              Back
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await tonuAction(order.id, tonuF.amount, tonuF.reason);
                  if (r.ok) {
                    setTonu(false);
                    t.ok("TONU — the fee goes to billing");
                    router.refresh();
                  } else t.err(r.error);
                })
              }
            >
              Cancel &amp; bill TONU
            </button>
          </>
        }
      >
        <p className="text-body text-muted mb-4">The open legs are cancelled and the load is billed the TONU fee instead of the line haul. It goes to billing without a POD or BOL.</p>
        <div className="grid grid-cols-[160px_1fr] gap-3">
          <div>
            <label className="label" htmlFor="tonu-amount">
              TONU fee ({order.currency})
            </label>
            <input id="tonu-amount" className="input" inputMode="decimal" value={tonuF.amount} onChange={(e) => setTonuF({ ...tonuF, amount: e.target.value })} placeholder="250.00" />
          </div>
          <div>
            <label className="label" htmlFor="tonu-reason">
              Why
            </label>
            <input id="tonu-reason" className="input" value={tonuF.reason} onChange={(e) => setTonuF({ ...tonuF, reason: e.target.value })} placeholder="Shipper cancelled at the dock" />
          </div>
        </div>
      </Modal>
      <Confirm open={hold} onClose={() => setHold(false)} title="Put on hold" needReason="Why?" confirmLabel="Hold" onConfirm={(r) => { setHold(false); run("On hold", () => holdAction(order.id, r)); }} />
      <Confirm open={cancel} onClose={() => setCancel(false)} title="Cancel this order" body="Open legs are cancelled. A moving leg must come back first." needReason="Reason" confirmLabel="Cancel order" danger onConfirm={(r) => { setCancel(false); run("Cancelled", () => cancelAction(order.id, r)); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

/** Inline planned-miles cell on the legs table: type, blur or Enter to save. */
export function LegMiles({ legId, miles, est = null, locked }: { legId: string; miles: number | null; est?: number | null; locked: boolean }) {
  const router = useRouter();
  const [v, setV] = useState(miles != null ? String(miles) : "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  if (locked) return <span className="mono">{miles ?? (est != null ? `${est} est.` : "—")}</span>;
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
      <input className="input w-20 h-7 px-2 mono" inputMode="numeric" value={v} aria-label="Planned miles" onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} placeholder={est != null ? `${est} est.` : "mi"} title={est != null && miles == null ? `Estimated ${est} mi from the stops — type the real miles to replace it` : undefined} aria-invalid={state === "error"} />
      {state === "saved" && <span className="text-teal text-caption font-bold">✓</span>}
      {msg && <span className="error m-0 text-caption">{msg}</span>}
    </span>
  );
}

/** "Add stop" on an existing load: a full stop, placed where it happens. Legs are re-cut on the server. */
export function AddStop({ orderId, stops, locations, firstOpen, zone = "America/Chicago" }: { orderId: string; stops: { id: string; name: string }[]; locations: Loc[]; firstOpen: number; zone?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StopDraft>(() => blankStop("delivery", "US"));
  const [position, setPosition] = useState(stops.length);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => {
    setOpen(false);
    setErr(null);
    setDraft(blankStop("delivery", "US"));
  };
  const positions = Array.from({ length: stops.length + 1 }, (_, i) => i).filter((i) => i >= firstOpen);
  return (
    <>
      <button className="btn btn-sm" onClick={() => { setPosition(stops.length); setOpen(true); }}>
        + Add stop
      </button>
      <Modal
        open={open}
        onClose={close}
        wide
        title="Add a stop"
        footer={
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setErr(null);
                  if (!draft.name.trim()) return setErr("Where is the stop?");
                  const r = await addStopAction(orderId, position, stopPayload(draft, zone));
                  if (r.ok) {
                    close();
                    router.refresh();
                  } else setErr(r.error);
                })
              }
            >
              {pending ? "Adding…" : "Add stop"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="add-stop-position">
              Where in the route
            </label>
            <select id="add-stop-position" className="select" value={position} onChange={(e) => setPosition(Number(e.target.value))}>
              {positions.map((i) => (
                <option key={i} value={i}>
                  {i === 0 ? `Before ${stops[0]?.name ?? "the first stop"}` : i === stops.length ? `After ${stops[stops.length - 1]?.name} (last)` : `Between ${stops[i - 1].name} and ${stops[i].name}`}
                </option>
              ))}
            </select>
          </div>
          <StopFields stop={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} locations={locations} index={99} invalid={!!err} companyZone={zone} />
          {err && (
            <div className="error" role="alert">
              {err}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
