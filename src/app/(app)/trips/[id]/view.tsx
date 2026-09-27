"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { addShipmentAction, removeShipmentAction, bookTripAction, holdShipmentAction, releaseShipmentAction, previewFitAction } from "../actions";

type Stop = { id: string; seq: number; type: string; name: string; country: string; address: { city?: string; state?: string } | null; arrivedAt: string | null; departedAt: string | null };
type Shipment = { id: string; orderNumber: string; state: string; customerId: string | null; customerName: string; rateCents: number | null; rateTbd: boolean; refs: Record<string, string>; pickupStopId: string | null; deliveryStopId: string | null; loadSeq: number | null; pieces: number | null; weightLbs: number | null; linearFt: number | null; cubeFt: number | null; stackable: boolean; hazmat: boolean; holdReason: string | null; pod: boolean; docCodes: string[]; invoice: { id: string; number: string | null; state: string } | null; costShare: number; cargoNote: string | null };
type StopLoad = { stopId: string; seq: number; name: string; type: string; on: string[]; off: string[]; afterWeightLbs: number; afterLinearFt: number; afterCubeFt: number; afterPieces: number };
type Capacity = { capacity: { source: string; linearFt: number; weightLbs: number; cubeFt: number }; perStop: StopLoad[]; peak: { weightLbs: number; linearFt: number; cubeFt: number }; spaceLeft: { weightLbs: number; linearFt: number; cubeFt: number | null }; fillPct: number; overWith: string[] };

const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "slate", booked: "blue", dispatched: "amber", in_transit: "teal", exception: "red", delivered: "green", ready_to_bill: "green", invoiced: "green", paid: "green", cancelled: "slate" };
const LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "On the truck", exception: "Held", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Removed" };
const stopName = (stops: Stop[], id: string | null) => stops.find((s) => s.id === id)?.name ?? "?";

export function TripView({ tripId, state, stops, shipments, capacity, customers, canEdit }: { tripId: string; state: string; stops: Stop[]; shipments: Shipment[]; capacity: Capacity; customers: { id: string; name: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [adding, setAdding] = useState(false);
  const [hold, setHold] = useState<Shipment | null>(null);
  const [remove, setRemove] = useState<Shipment | null>(null);
  const [pending, start] = useTransition();
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  const live = shipments.filter((s) => s.state !== "cancelled");
  const revenue = live.reduce((a, s) => a + (s.rateCents ?? 0), 0);
  const editable = canEdit && !["delivered", "ready_to_bill", "invoiced", "paid", "cancelled"].includes(state);
  return (
    <div className="grid grid-cols-[1fr_300px] gap-5 items-start">
      <div className="space-y-5">
        {/* capacity + load plan */}
        <div className="card p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="h2">Load plan</div>
              <div className="text-muted text-[12.5px]">Capacity from {capacity.capacity.source}: {capacity.capacity.linearFt} ft · {capacity.capacity.weightLbs.toLocaleString()} lb{capacity.capacity.cubeFt ? ` · ${capacity.capacity.cubeFt.toLocaleString()} cu ft` : ""}. Loaded LIFO: what comes off last goes in first.</div>
            </div>
            <div className="text-right">
              <div className={`text-[22px] font-extrabold mono ${capacity.overWith.length ? "text-red" : ""}`}>{capacity.fillPct}%</div>
              <div className="text-[11.5px] text-muted">
                peak {capacity.peak.linearFt} ft · {capacity.peak.weightLbs.toLocaleString()} lb · {capacity.spaceLeft.linearFt} ft left
              </div>
            </div>
          </div>
          {capacity.overWith.length > 0 && <div className="mt-2 text-red text-[13px] font-semibold">Over capacity: {capacity.overWith.join(", ")}</div>}
          <Trailer stops={stops} shipments={live} capacity={capacity} />
          <table className="table mt-4 -mx-5 w-[calc(100%+40px)]">
            <thead>
              <tr>
                <th>#</th>
                <th>Stop</th>
                <th>Off</th>
                <th>On</th>
                <th className="text-right">After · lb</th>
                <th className="text-right">ft</th>
                <th className="text-right">pcs</th>
                <th>Clock</th>
              </tr>
            </thead>
            <tbody>
              {capacity.perStop.map((st) => {
                const stop = stops.find((x) => x.id === st.stopId)!;
                return (
                  <tr key={st.stopId}>
                    <td className="mono">{st.seq}</td>
                    <td>
                      <div className="font-bold">{stop.name}</div>
                      <div className="text-muted text-[12px]">
                        {stop.type.replace("_", " ")} · {[stop.address?.city, stop.address?.state].filter(Boolean).join(", ")} {stop.country}
                      </div>
                    </td>
                    <td className="text-[12.5px]">{st.off.map((id) => shipments.find((s) => s.id === id)?.orderNumber).join(", ") || <span className="text-faint">—</span>}</td>
                    <td className="text-[12.5px]">{st.on.map((id) => shipments.find((s) => s.id === id)?.orderNumber).join(", ") || <span className="text-faint">—</span>}</td>
                    <td className="text-right mono">{st.afterWeightLbs.toLocaleString()}</td>
                    <td className="text-right mono">{st.afterLinearFt}</td>
                    <td className="text-right mono">{st.afterPieces}</td>
                    <td className="text-[12px] text-muted whitespace-nowrap">
                      {stop.arrivedAt ? `in ${new Date(stop.arrivedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
                      {stop.departedAt ? ` · out ${new Date(stop.departedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* shipments */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="h2">Shipments</div>
              <div className="text-muted text-[12.5px]">
                {live.length} on the trip · {formatCents(revenue)} revenue · each keeps its own customer, references, documents, POD and invoice.
              </div>
            </div>
            {editable && (
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                + Shipment
              </button>
            )}
          </div>
          {live.length === 0 ? (
            <div className="py-8 text-center text-muted">No shipments yet. Add the first one — the trip cannot be booked without one.</div>
          ) : (
            <table className="table -mx-5 w-[calc(100%+40px)]">
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Shipment</th>
                  <th>Customer</th>
                  <th>On → Off</th>
                  <th className="text-right">Pcs · lb · ft</th>
                  <th className="text-right">Rate</th>
                  <th>State</th>
                  <th>Docs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {live.map((s) => (
                  <tr key={s.id}>
                    <td className="mono text-muted">{s.loadSeq}</td>
                    <td>
                      <Link href={`/orders/${s.id}`} className="font-extrabold mono hover:text-teal whitespace-nowrap">
                        {s.orderNumber}
                      </Link>
                      <div className="text-[12px] text-muted">{Object.values(s.refs).join(" · ")}</div>
                      {s.hazmat && <Pill tone="red">HAZMAT</Pill>}
                    </td>
                    <td>{s.customerName}</td>
                    <td className="text-[12.5px]">
                      {stopName(stops, s.pickupStopId)} → {stopName(stops, s.deliveryStopId)}
                    </td>
                    <td className="text-right mono text-[12.5px] whitespace-nowrap">
                      {s.pieces ?? "—"} · {(s.weightLbs ?? 0).toLocaleString()} · {s.linearFt ?? "—"}
                    </td>
                    <td className="text-right mono font-semibold">{s.rateTbd || s.rateCents == null ? <span className="text-faint">TBD</span> : formatCents(s.rateCents)}</td>
                    <td>
                      <Pill tone={TONE[s.state]} title={s.holdReason ?? undefined}>
                        {LABEL[s.state]}
                      </Pill>
                      {s.holdReason && <div className="text-[11.5px] text-red">{s.holdReason}</div>}
                    </td>
                    <td className="space-x-1">
                      <Pill tone={s.pod ? "green" : "slate"}>POD</Pill>
                      {s.invoice && (
                        <Link href={`/billing/invoices/${s.invoice.id}`}>
                          <Pill tone="teal">{s.invoice.number ?? "draft"}</Pill>
                        </Link>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {canEdit && s.state === "exception" && (
                        <button className="btn btn-sm" disabled={pending} onClick={() => run("Released", () => releaseShipmentAction(tripId, s.id))}>
                          Release
                        </button>
                      )}
                      {canEdit && ["booked", "dispatched", "in_transit"].includes(s.state) && (
                        <button className="btn btn-sm btn-ghost text-amber" onClick={() => setHold(s)}>
                          Hold
                        </button>
                      )}
                      {editable && ["draft", "booked", "dispatched", "exception"].includes(s.state) && (
                        <button className="btn btn-sm btn-ghost text-red" onClick={() => setRemove(s)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <aside className="space-y-4">
        <div className="card p-4">
          <div className="eyebrow mb-2">Next</div>
          {state === "draft" ? (
            <>
              <button className="btn btn-primary w-full justify-center" disabled={pending || !live.length} onClick={() => run("Booked — it is on the dispatch board", () => bookTripAction(tripId))}>
                Book the trip
              </button>
              <div className="help mt-1">Books every shipment with it. Then assign and send the legs from Dispatch like any order.</div>
            </>
          ) : (
            <div className="text-[13px]">
              Assign, send and advance the trip&apos;s legs from{" "}
              <Link href="/dispatch" className="text-teal font-semibold">
                Dispatch
              </Link>
              ; shipments follow the stop clocks. Crossing paperwork for every shipment lives on the crossing workbench.
            </div>
          )}
        </div>
        <div className="card p-4">
          <div className="eyebrow mb-2">Cost split</div>
          <div className="text-[12.5px] text-muted mb-2">Trip costs (unit, carriers, fuel) reach each shipment&apos;s P&amp;L by its share — weight by default (Settings → Company).</div>
          <ul className="space-y-1 text-[12.5px]">
            {live.map((s) => (
              <li key={s.id} className="flex justify-between">
                <span className="mono">{s.orderNumber}</span>
                <span>{Math.round(s.costShare * 1000) / 10}%</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {adding && <AddShipment tripId={tripId} stops={stops} customers={customers} onClose={() => setAdding(false)} onDone={() => { setAdding(false); t.ok("Shipment added"); router.refresh(); }} />}
      <Confirm open={!!hold} onClose={() => setHold(null)} title={`Hold ${hold?.orderNumber}`} body="It stays where it is while the trip continues; release it when it can move. Held shipments drop out of the crossing gate." needReason="Why" confirmLabel="Hold" onConfirm={(reason) => { const s = hold!; setHold(null); run("Held", () => holdShipmentAction(tripId, s.id, reason)); }} />
      <Confirm open={!!remove} onClose={() => setRemove(null)} title={`Remove ${remove?.orderNumber} from the trip`} body="The shipment order is cancelled. Only possible before it is on the truck." needReason="Reason" confirmLabel="Remove" danger onConfirm={(reason) => { const s = remove!; setRemove(null); run("Removed", () => removeShipmentAction(tripId, s.id, reason)); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

/** Top-down trailer: nose on the left, each shipment a block proportional to its linear feet, in load order. */
function Trailer({ stops, shipments, capacity }: { stops: Stop[]; shipments: Shipment[]; capacity: Capacity }) {
  const total = capacity.capacity.linearFt || 53;
  const ordered = [...shipments].sort((p, q) => (p.loadSeq ?? 99) - (q.loadSeq ?? 99));
  const used = ordered.reduce((a, s) => a + (s.linearFt ?? 0), 0);
  const seqOf = (id: string | null) => stops.find((s) => s.id === id)?.seq ?? 0;
  return (
    <div className="mt-4">
      <div className="flex items-stretch h-16 rounded-lg border-2 border-line overflow-hidden bg-ground" title="Peak load, nose to tail" data-testid="trailer">
        <div className="w-3 bg-navy/80" title="nose" />
        {ordered.map((s) => (
          <div key={s.id} className={`flex flex-col justify-center px-1.5 border-r border-white/70 text-[10.5px] leading-tight overflow-hidden ${s.hazmat ? "bg-red/20" : s.state === "exception" ? "bg-amber/30" : "bg-teal-soft"}`} style={{ width: `${Math.max(((s.linearFt ?? 0) / total) * 100, 3)}%` }} title={`${s.orderNumber} · ${s.customerName} · ${s.linearFt ?? "?"} ft · off at stop ${seqOf(s.deliveryStopId)}`}>
            <div className="font-bold mono truncate">{s.orderNumber.slice(-5)}</div>
            <div className="truncate text-muted">{s.customerName}</div>
            <div className="text-faint">off @{seqOf(s.deliveryStopId)}</div>
          </div>
        ))}
        <div className="flex-1 flex items-center justify-center text-[11px] text-faint">{Math.max(total - used, 0)} ft free</div>
      </div>
    </div>
  );
}

function AddShipment({ tripId, stops, customers, onClose, onDone }: { tripId: string; stops: Stop[]; customers: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const pickups = stops.filter((s) => s.type === "pickup" || s.type === "transload" || s.type === "yard");
  const drops = stops.filter((s) => s.type === "delivery" || s.type === "transload" || s.type === "yard");
  const [f, setF] = useState({ customerId: customers[0]?.id ?? "", rate: "", rateTbd: false, po: "", reference: "", pickupStopId: pickups[0]?.id ?? "", deliveryStopId: drops[drops.length - 1]?.id ?? "", pieces: "", weightLbs: "", linearFt: "", cubeFt: "", stackable: true, hazmat: false, cargoNote: "" });
  const [fit, setFit] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!f.pickupStopId || !f.deliveryStopId) return;
    let alive = true;
    previewFitAction(tripId, { pickupStopId: f.pickupStopId, deliveryStopId: f.deliveryStopId, weightLbs: f.weightLbs, linearFt: f.linearFt, cubeFt: f.cubeFt }).then((r) => {
      if (!alive) return;
      if (!r.ok) return setFit({ ok: false, text: r.error });
      setFit(r.data.overWith.length ? { ok: false, text: `Will not fit: ${r.data.overWith.join(", ")}` } : { ok: true, text: `Fits · ${r.data.spaceLeft.linearFt} ft and ${r.data.spaceLeft.weightLbs.toLocaleString()} lb would remain at the peak` });
    });
    return () => {
      alive = false;
    };
  }, [tripId, f.pickupStopId, f.deliveryStopId, f.weightLbs, f.linearFt, f.cubeFt]);
  return (
    <Modal open onClose={onClose} wide title="Add a shipment" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.customerId} onClick={() => start(async () => { setErr(null); const r = await addShipmentAction(tripId, { ...f, refs: { po: f.po, reference: f.reference } }); if (r.ok) onDone(); else setErr(r.error); })}>Add</button></>}>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Customer</label>
          <select className="select" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} aria-label="Customer">
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Rate (USD)</label>
          <input className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} disabled={f.rateTbd} aria-label="Rate" />
          <label className="flex items-center gap-2 mt-1 text-[12.5px] cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> TBD
          </label>
        </div>
        <div>
          <label className="label">PO / reference</label>
          <div className="flex gap-1">
            <input className="input" placeholder="PO" value={f.po} onChange={(e) => setF({ ...f, po: e.target.value })} aria-label="PO" />
            <input className="input" placeholder="ref" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} aria-label="Reference" />
          </div>
        </div>
        <div>
          <label className="label">On at</label>
          <select className="select" value={f.pickupStopId} onChange={(e) => setF({ ...f, pickupStopId: e.target.value })} aria-label="Pickup stop">
            {pickups.map((s) => (
              <option key={s.id} value={s.id}>
                {s.seq}. {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Off at</label>
          <select className="select" value={f.deliveryStopId} onChange={(e) => setF({ ...f, deliveryStopId: e.target.value })} aria-label="Delivery stop">
            {drops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.seq}. {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cargo note</label>
          <input className="input" value={f.cargoNote} onChange={(e) => setF({ ...f, cargoNote: e.target.value })} aria-label="Cargo note" />
        </div>
        <div>
          <label className="label">Pieces</label>
          <input className="input" inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} aria-label="Pieces" />
        </div>
        <div>
          <label className="label">Weight (lb)</label>
          <input className="input" inputMode="numeric" value={f.weightLbs} onChange={(e) => setF({ ...f, weightLbs: e.target.value })} aria-label="Weight" />
        </div>
        <div>
          <label className="label">Linear feet</label>
          <input className="input" inputMode="numeric" value={f.linearFt} onChange={(e) => setF({ ...f, linearFt: e.target.value })} aria-label="Linear feet" />
        </div>
        <div>
          <label className="label">Cube (cu ft)</label>
          <input className="input" inputMode="numeric" value={f.cubeFt} onChange={(e) => setF({ ...f, cubeFt: e.target.value })} aria-label="Cube" />
        </div>
        <label className="flex items-center gap-2 text-[13px] cursor-pointer mt-6">
          <input type="checkbox" className="accent-teal" checked={f.stackable} onChange={(e) => setF({ ...f, stackable: e.target.checked })} /> Stackable
        </label>
        <label className="flex items-center gap-2 text-[13px] cursor-pointer mt-6">
          <input type="checkbox" className="accent-teal" checked={f.hazmat} onChange={(e) => setF({ ...f, hazmat: e.target.checked })} /> Hazmat
        </label>
      </div>
      {fit && <div className={`mt-3 text-[13px] font-semibold ${fit.ok ? "text-teal" : "text-red"}`} data-testid="fit">{fit.text}</div>}
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}
