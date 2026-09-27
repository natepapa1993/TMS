"use client";

import { useEffect, useMemo, useState, useTransition, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Confirm, Toast, useToast, KV, Spinner } from "@/components/ui";
import { LEG_LABEL, STAGE_OF_LEG } from "@/domain/states";
import type { LegState } from "@/db/schema";
import type { Candidate } from "@/domain/orders";
import * as A from "./actions";

/**
 * The dispatch board (Design: Dispatch-Clean). Five things per row, one primary action in the
 * panel, everything else behind a click. Stage tabs = Pending / Planned / Dispatched / Delivered.
 */

type Leg = {
  id: string;
  seq: number;
  type: string;
  state: LegState;
  assigneeKind: string | null;
  truckId: string | null;
  driverId: string | null;
  coDriverId: string | null;
  carrierId: string | null;
  carrierRateCents: number | null;
  plannedMiles: number | null;
  fromStopId: string | null;
  toStopId: string | null;
  truckUnit: string | null;
  driverName: string | null;
  carrierName: string | null;
  declineReason: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
};
type Stop = { id: string; seq: number; type: string; name: string; country: string; windowStart: string | null; windowEnd: string | null; arrivedAt: string | null; departedAt: string | null; address: { city?: string; state?: string } | null };
type Order = { id: string; orderNumber: string; state: string; kind: string; rateCents: number | null; rateTbd: boolean; currency: string; equipment: string; refs: Record<string, string>; holdReason: string | null; legTemplate: string | null; customerId: string | null; brokerId: string | null };
type Flag = { id: string; code: string; level: string; title: string; detail: string | null; legId: string | null };
type Tender = { id: string; legId: string; carrierId: string; carrierName: string; state: string; channel: string; sentTo: string | null; expiresAt: string; respondedAt: string | null; respondedBy: string | null; responseNote: string | null; driverName: string | null; driverPhone: string | null; unitNumber: string | null; rateCents: number | null; link: string; delivery: { state: string; error: string | null } | null };
export type Row = { order: Order; stops: Stop[]; legs: Leg[]; openFlags: Flag[]; stage: "pending" | "planned" | "dispatched" | "delivered" | "closed"; customerName: string | null; tenders: Tender[]; shipments: number };

export type BoardData = {
  rows: Row[];
  customers: { id: string; name: string; kind: string; note: string | null }[];
  carriers: { id: string; name: string; country: string; doNotUse: boolean }[];
  drivers: { id: string; name: string; driverType: string; currentTruckId: string | null }[];
  trucks: { id: string; unitNumber: string; status: string }[];
  templates: { key: string; label: string; description: string }[];
  role: string;
  ediInbox: number;
  messages: number;
  requests: number;
};

const STAGES = [
  { key: "pending", label: "Pending", hint: "Built, nobody on it yet" },
  { key: "planned", label: "Planned", hint: "Truck or carrier picked, not sent" },
  { key: "dispatched", label: "Dispatched", hint: "Sent, accepted, or moving" },
  { key: "delivered", label: "Delivered", hint: "Ready for billing" },
] as const;

const LEG_TYPE_LABEL: Record<string, string> = { mx: "MX", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equip." };
const money = (c: number | null, cur = "USD") => (c == null ? "TBD" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(c / 100));
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
const place = (st: Stop) => st.name + (st.address?.city ? `, ${st.address.city}` : "") + (st.address?.state ? ` ${st.address.state}` : "");

function nextLeg(r: Row): Leg | null {
  return r.legs.find((l) => l.state !== "completed" && l.state !== "cancelled") ?? null;
}
function legTone(state: LegState): "slate" | "teal" | "amber" | "red" | "green" | "blue" {
  if (state === "completed") return "green";
  if (state === "declined") return "red";
  if (state === "planned") return "blue";
  if (state === "unassigned") return "slate";
  if (state === "dispatched") return "amber";
  return "teal";
}
function forwardLabel(leg: Pick<Leg, "state" | "fromStopId" | "toStopId">, stops: Stop[]): string | null {
  // a stop in between (tailgate leg with three or more stops) is clocked before the delivery
  if (leg.state === "en_route") {
    const from = stops.find((x) => x.id === leg.fromStopId);
    const to = stops.find((x) => x.id === leg.toStopId);
    const mid = from && to ? stops.filter((x) => x.seq > from.seq && x.seq < to.seq).sort((a, b) => a.seq - b.seq).find((x) => !x.departedAt) : undefined;
    if (mid) return mid.arrivedAt ? `Leaving ${mid.name}` : `Arrived at ${mid.name}`;
  }
  const map: Partial<Record<LegState, string>> = { dispatched: "Mark accepted", accepted: "Rolling to pickup", en_route_to_pickup: "Arrived at pickup", at_pickup: "Loaded", loaded: "En route", en_route: "Arrived at delivery", at_delivery: "Delivered" };
  return map[leg.state] ?? null;
}

export function DispatchBoard({ data }: { data: BoardData }) {
  const router = useRouter();
  const t = useToast();
  const [stage, setStage] = useState<(typeof STAGES)[number]["key"]>("pending");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedIdRaw] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [popup, setPopup] = useState<null | { kind: "assign" | "split" | "hold" | "cancel" | "oos" | "decline" | "drivers" | "track"; legId?: string }>(null);
  // Selecting another order always drops any popup that belonged to the previous one.
  const setSelectedId = useCallback((id: string | null) => {
    setPopup(null);
    setSelectedIdRaw(id);
  }, []);
  const [pending, start] = useTransition();

  const counts = useMemo(() => Object.fromEntries(STAGES.map((s) => [s.key, data.rows.filter((r) => r.stage === s.key).length])), [data.rows]);
  const attention = data.rows.filter((r) => r.openFlags.length || r.order.state === "exception").length;
  const rows = useMemo(() => {
    const base = data.rows.filter((r) => r.stage === stage);
    if (!q.trim()) return base;
    const s = q.toLowerCase();
    return base.filter((r) => [r.order.orderNumber, r.customerName, ...r.stops.map((x) => x.name), ...r.legs.map((l) => l.truckUnit ?? l.carrierName ?? ""), ...Object.values(r.order.refs)].some((x) => x?.toLowerCase().includes(s)));
  }, [data.rows, stage, q]);
  const selected = data.rows.find((r) => r.order.id === selectedId) ?? null;
  const popupLeg = (popup?.legId && selected?.legs.find((l) => l.id === popup.legId)) || null;

  const run = useCallback(
    (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
      start(async () => {
        const r = await fn();
        if (r.ok) {
          t.ok(label);
          router.refresh();
        } else t.err(r.error ?? "Could not do that");
      }),
    [router, t],
  );

  // keyboard: n = new, esc = close panel, / = search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/)) return;
      if (e.key === "n") setNewOpen(true);
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
      // Escape closes the top-most thing: a popup handles its own Escape; only close the panel when none is open.
      if (e.key === "Escape" && !document.querySelector(".overlay")) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelectedId]);

  const canDispatch = ["owner", "dispatcher"].includes(data.role);

  return (
    <div className="flex min-h-screen">
      <div className="flex-1 min-w-0">
        <div className="px-7 pt-6 pb-3 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="eyebrow mb-1">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="h1">Dispatch</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input id="board-search" className="input w-60 max-w-full" placeholder="Search order, customer, unit…  /" value={q} onChange={(e) => setQ(e.target.value)} />
            <Link href="/messages" className={`btn ${data.messages ? "border-amber text-amber font-bold" : ""}`} title="What drivers and carriers wrote to the company WhatsApp">
              Messages{data.messages ? ` · ${data.messages}` : ""}
            </Link>
            {data.requests > 0 && (
              <Link href="/orders?state=draft" className="btn border-amber text-amber font-bold" title="Load requests from the customer portal: price, confirm, book">
                Requests · {data.requests}
              </Link>
            )}
            <Link href="/edi" className={`btn ${data.ediInbox ? "border-amber text-amber font-bold" : ""}`} title="EDI tenders, 214 status and 210 invoices">
              EDI{data.ediInbox ? ` · ${data.ediInbox} waiting` : ""}
            </Link>
            {canDispatch && (
              <button className="btn btn-primary" onClick={() => setNewOpen(true)} title="Shortcut: n">
                + New order
              </button>
            )}
          </div>
        </div>
        <div className="px-7 pb-3 flex items-center gap-1.5 flex-wrap">
          {STAGES.map((s) => (
            <button key={s.key} className="stage-tab" data-active={stage === s.key} onClick={() => setStage(s.key)} title={s.hint}>
              {s.label} <span className="count">{counts[s.key]}</span>
            </button>
          ))}
          {attention > 0 && (
            <span className="ml-auto pill pill-red" title="Orders with an open flag or on hold">
              ● {attention} need attention
            </span>
          )}
        </div>
        <div className="px-7 pb-10">
          <div className="card overflow-hidden">
            <div className="row text-[11px] font-bold tracking-wider uppercase text-faint border-t-0 cursor-default hover:bg-transparent" style={{ gridTemplateColumns: "150px 1.6fr 1fr 150px 130px" }}>
              <div>Order</div>
              <div>Route</div>
              <div>Next leg</div>
              <div>When</div>
              <div>Status</div>
            </div>
            {rows.length === 0 ? (
              <div className="py-16 text-center border-t border-line">
                <div className="font-bold">{q ? "Nothing matches" : stage === "pending" ? "Nothing pending" : `Nothing ${stage}`}</div>
                <div className="text-muted text-[13px] mt-1">{stage === "pending" && !q ? "New orders land here. Press n to add one." : " "}</div>
              </div>
            ) : (
              rows.map((r) => <BoardRow key={r.order.id} r={r} selected={r.order.id === selectedId} onClick={() => setSelectedId(r.order.id)} />)
            )}
          </div>
          <div className="mt-3 text-[12px] text-faint flex gap-4">
            <span>
              <span className="kbd">n</span> new order
            </span>
            <span>
              <span className="kbd">/</span> search
            </span>
            <span>
              <span className="kbd">esc</span> close panel
            </span>
          </div>
        </div>
      </div>

      {selected && (
        <SidePanel
          r={selected}
          data={data}
          busy={pending}
          canDispatch={canDispatch}
          onClose={() => setSelectedId(null)}
          onPopup={setPopup}
          run={run}
        />
      )}

      <NewOrderModal open={newOpen} onClose={() => setNewOpen(false)} data={data} onCreated={(id) => {
        setNewOpen(false);
        setStage("pending");
        setSelectedId(id);
        t.ok("Order created and booked. It's in Pending.");
        router.refresh();
      }} />

      {selected && popup?.kind === "assign" && popupLeg && (
        <AssignModal
          leg={popupLeg}
          order={selected.order}
          data={data}
          onClose={() => setPopup(null)}
          onDone={(msg) => {
            setPopup(null);
            t.ok(msg);
            router.refresh();
          }}
        />
      )}
      {selected && popup?.kind === "track" && <TrackModal r={selected} onClose={() => setPopup(null)} />}
      {selected && popup?.kind === "drivers" && popupLeg && (
        <DriversModal leg={popupLeg} data={data} onClose={() => setPopup(null)} onDone={(msg) => { setPopup(null); t.ok(msg); router.refresh(); }} />
      )}
      {selected && popup?.kind === "split" && popupLeg && <SplitModal leg={popupLeg} stops={selected.stops} onClose={() => setPopup(null)} onDone={(msg) => { setPopup(null); t.ok(msg); router.refresh(); }} />}
      <Confirm open={popup?.kind === "hold"} onClose={() => setPopup(null)} title="Put this order on hold" body="Nothing more gets sent until it's released. The reason shows on the row." needReason="Why?" confirmLabel="Hold" onConfirm={(reason) => { setPopup(null); if (selected) run("On hold", () => A.holdAction(selected.order.id, reason)); }} />
      <Confirm open={popup?.kind === "cancel"} onClose={() => setPopup(null)} title="Cancel this order" body="Open legs are cancelled. Moving legs must come back first." needReason="Reason (goes on the record)" confirmLabel="Cancel order" danger onConfirm={(reason) => { setPopup(null); if (selected) run("Order cancelled", () => A.cancelAction(selected.order.id, reason)); }} />
      <Confirm open={popup?.kind === "decline"} onClose={() => setPopup(null)} title="Mark declined" body="The leg goes back to Pending with a red flag so it's picked up again." needReason="Why did they decline?" confirmLabel="Declined" onConfirm={(reason) => { const legId = popup?.legId; setPopup(null); if (legId) run("Leg declined — back in Pending", () => A.declineAction(legId, reason)); }} />
      <Confirm
        open={popup?.kind === "oos"}
        onClose={() => setPopup(null)}
        title={`Put unit out of service`}
        body="Its planned and sent legs go back to Pending. A moving leg keeps going but gets a red flag."
        needReason="Reason"
        confirmLabel="Unit OOS"
        danger
        onConfirm={(reason) => {
          const leg = selected?.legs.find((l) => l.id === popup?.legId);
          setPopup(null);
          if (leg?.truckId) run(`Unit ${leg.truckUnit} out of service`, () => A.oosAction(leg.truckId!, reason));
        }}
      />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

function BoardRow({ r, selected, onClick }: { r: Row; selected: boolean; onClick: () => void }) {
  const first = r.stops[0];
  const last = r.stops[r.stops.length - 1];
  const nl = nextLeg(r);
  const hold = r.order.state === "exception";
  const red = r.openFlags.some((f) => f.level === "red");
  return (
    <div className="row" style={{ gridTemplateColumns: "150px 1.6fr 1fr 150px 130px" }} data-selected={selected} aria-pressed={selected} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick()}>
      <div className="min-w-0">
        <div className="font-extrabold mono">{r.order.orderNumber}</div>
        <div className="text-muted text-[12.5px] truncate">{r.order.kind === "trip" ? `Tailgate trip · ${r.shipments} shipment${r.shipments === 1 ? "" : "s"}` : (r.customerName ?? "No customer")}</div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-semibold">
          {first ? place(first) : "—"} <span className="text-faint">→</span> {last ? place(last) : "—"}
        </div>
        <div className="flex gap-1 mt-1">
          {r.legs.map((l) => (
            <span key={l.id} className={`pill pill-${legTone(l.state)}`} style={{ height: 18, fontSize: 10.5 }} title={`${LEG_TYPE_LABEL[l.type]} · ${LEG_LABEL[l.state]}`}>
              {LEG_TYPE_LABEL[l.type]}
            </span>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        {nl ? (
          <>
            <div className="font-semibold truncate">
              {LEG_TYPE_LABEL[nl.type]} leg · {nl.truckUnit ? `Unit ${nl.truckUnit}` : nl.carrierName ?? <span className="text-faint">nobody yet</span>}
            </div>
            <div className="text-muted text-[12.5px] truncate">{nl.driverName ?? (nl.assigneeKind === "carrier" ? "partner carrier" : nl.truckUnit ? "no driver" : "")}</div>
          </>
        ) : (
          <div className="text-muted">All legs done</div>
        )}
      </div>
      <div className="text-[12.5px]">
        <div className="font-semibold">{when(first?.windowStart) ?? <span className="text-faint">no window</span>}</div>
        <div className="text-muted">{last?.windowEnd ? `by ${when(last.windowEnd)}` : ""}</div>
      </div>
      <div className="flex items-center gap-1.5">
        {hold ? <Pill tone="amber">On hold</Pill> : nl ? <Pill tone={legTone(nl.state)}>{LEG_LABEL[nl.state]}</Pill> : <Pill tone="green">Delivered</Pill>}
        {r.openFlags.length > 0 && <span className={`w-2 h-2 rounded-full ${red ? "bg-red" : "bg-amber"}`} title={r.openFlags.map((f) => f.title).join(", ")} />}
      </div>
    </div>
  );
}

function SidePanel({ r, data, busy, canDispatch, onClose, onPopup, run }: { r: Row; data: BoardData; busy: boolean; canDispatch: boolean; onClose: () => void; onPopup: (p: { kind: "assign" | "split" | "hold" | "cancel" | "oos" | "decline" | "drivers" | "track"; legId?: string }) => void; run: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => void }) {
  const nl = nextLeg(r);
  const hold = r.order.state === "exception";
  const closed = r.order.state === "cancelled";
  const customerNote = data.customers.find((c) => c.id === (r.order.customerId ?? r.order.brokerId))?.note?.trim() || null;

  // The one primary action for where this order is right now.
  let primary: { label: string; onClick: () => void; tone?: "primary" | "plain" } | null = null;
  if (!closed && nl && canDispatch) {
    if (hold) primary = { label: "Release hold", onClick: () => run("Released", () => A.releaseAction(r.order.id)) };
    else if (nl.state === "unassigned" || nl.state === "declined") primary = { label: `Assign ${LEG_TYPE_LABEL[nl.type]} leg`, onClick: () => onPopup({ kind: "assign", legId: nl.id }) };
    else if (nl.state === "planned") primary = { label: nl.assigneeKind === "carrier" ? "Send to carrier" : "Send to driver", onClick: () => run("Sent", () => A.dispatchAction(nl.id)) };
    else if (forwardLabel(nl, r.stops)) primary = { label: forwardLabel(nl, r.stops)!, onClick: () => run(LEG_LABEL[STAGE_OF_LEG[nl.state] === "dispatched" ? nl.state : nl.state], () => A.advanceAction(nl.id, "next")) };
  }
  const stopById = new Map(r.stops.map((s) => [s.id, s]));

  return (
    <aside className="w-[400px] flex-none border-l border-line bg-white sticky top-0 h-screen overflow-y-auto">
      <div className="px-5 pt-5 pb-4 border-b border-line">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="h2 mono">{r.order.orderNumber}</span>
              {hold && <Pill tone="amber">On hold</Pill>}
              {closed && <Pill tone="slate">Cancelled</Pill>}
            </div>
            <div className="text-muted text-[13px]">{r.order.kind === "trip" ? `Tailgate trip · ${r.shipments} shipment${r.shipments === 1 ? "" : "s"}` : `${r.customerName ?? "No customer"} · ${money(r.order.rateCents, r.order.currency)}`}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        {customerNote && (
          <div className="mx-4 mb-3 rounded-lg border border-teal/30 bg-teal-soft/40 px-3 py-2 text-[12.5px] whitespace-pre-wrap" data-testid="customer-note">
            <b>{r.customerName}:</b> {customerNote}
          </div>
        )}
        {hold && r.order.holdReason && <div className="mt-2 text-[12.5px] px-2.5 py-1.5 rounded-md bg-amber-soft text-amber font-semibold">Hold: {r.order.holdReason}</div>}
        {r.openFlags.map((f) => (
          <div key={f.id} className={`mt-2 text-[12.5px] px-2.5 py-1.5 rounded-md font-semibold ${f.level === "red" ? "bg-red-soft text-red" : "bg-amber-soft text-amber"}`}>
            {f.title}
            {f.detail ? <span className="font-normal"> — {f.detail}</span> : null}
          </div>
        ))}
        {primary && (
          <button className="btn btn-primary btn-lg w-full justify-center mt-4" onClick={primary.onClick} disabled={busy}>
            {busy ? <Spinner /> : primary.label}
          </button>
        )}
        {!closed && canDispatch && (
          <div className="grid grid-cols-5 gap-1 mt-2">
            <QuickBtn label="Track" hint="Tracking link, driver app link, last position" onClick={() => onPopup({ kind: "track" })} />
            <QuickBtn label="Split" onClick={() => nl && onPopup({ kind: "split", legId: nl.id })} disabled={!nl || ["at_delivery", "completed"].includes(nl.state)} />
            <QuickBtn label="Change" hint="Re-assign this leg" onClick={() => nl && onPopup({ kind: "assign", legId: nl.id })} disabled={!nl || !["planned", "dispatched", "accepted"].includes(nl.state)} />
            <QuickBtn label="Unit OOS" onClick={() => nl && onPopup({ kind: "oos", legId: nl.id })} disabled={!nl?.truckId} />
            <QuickBtn label={hold ? "Release" : "Hold"} onClick={() => (hold ? run("Released", () => A.releaseAction(r.order.id)) : onPopup({ kind: "hold" }))} disabled={!hold && !["dispatched", "in_transit"].includes(r.order.state)} />
          </div>
        )}
      </div>

      <div className="px-5 divide-y divide-line">
        <details className="accordion" open>
          <summary>
            Legs <span className="text-faint font-normal">{r.legs.length}</span>
          </summary>
          <div className="pb-3 space-y-2">
            {r.legs.map((l) => {
              const from = l.fromStopId ? stopById.get(l.fromStopId) : null;
              const to = l.toStopId ? stopById.get(l.toStopId) : null;
              const isNext = nl?.id === l.id;
              return (
                <div key={l.id} className={`rounded-lg border p-3 ${isNext ? "border-teal bg-teal-soft/40" : "border-line"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold text-[13px]">
                      {l.seq}. {LEG_TYPE_LABEL[l.type]} <span className="text-muted font-normal">{from?.name} → {to?.name}</span>
                    </div>
                    <Pill tone={legTone(l.state)}>{LEG_LABEL[l.state]}</Pill>
                  </div>
                  <div className="text-[12.5px] text-muted mt-1">
                    {l.assigneeKind === "truck" ? (
                      <>
                        Unit <b className="text-ink">{l.truckUnit}</b>
                        {l.driverName ? (
                          <>
                            {" "}
                            · <b className="text-ink">{l.driverName}</b>
                          </>
                        ) : (
                          " · no driver"
                        )}
                        {l.coDriverId && <> · team</>}
                      </>
                    ) : l.assigneeKind === "carrier" ? (
                      <>
                        <b className="text-ink">{l.carrierName}</b>
                        {l.carrierRateCents != null && <> · {money(l.carrierRateCents)}</>}
                      </>
                    ) : (
                      "Nobody assigned"
                    )}
                    {l.declineReason && <div className="text-red">Declined: {l.declineReason}</div>}
                    {(() => {
                      const tn = r.tenders.find((t) => t.legId === l.id && (t.state === "sent" || (l.state === "accepted" && t.state === "accepted")));
                      if (!tn) return null;
                      const mins = Math.round((new Date(tn.expiresAt).getTime() - Date.now()) / 60000);
                      return tn.state === "sent" ? (
                        <div className="mt-1 text-[12px]">
                          <span className="pill pill-amber">Tender out</span> {tn.channel} to {tn.sentTo ?? tn.carrierName} · {mins > 0 ? `${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`} left` : "expiring"}
                          {tn.delivery && (
                            <span className={`ml-1 pill ${tn.delivery.state === "failed" ? "pill-red" : tn.delivery.state === "queued" ? "pill-amber" : tn.delivery.state === "logged" ? "pill-slate" : "pill-green"}`} title={tn.delivery.error ?? (tn.delivery.state === "logged" ? "no sending provider connected — share the link yourself" : undefined)}>
                              {tn.delivery.state === "logged" ? "not delivered" : tn.delivery.state}
                            </span>
                          )}
                          <a className="btn btn-ghost btn-sm ml-1" href={tn.link} target="_blank" rel="noreferrer" title="The carrier's accept/decline page — paste it into WhatsApp if they didn't get the email">
                            Link
                          </a>
                          {canDispatch && (
                            <button className="btn btn-ghost btn-sm ml-1 text-red" onClick={() => run("Tender withdrawn", () => A.withdrawTenderAction(l.id))}>
                              Withdraw
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="mt-1 text-[12px] text-green">
                          ✓ {tn.respondedBy} accepted{tn.driverName ? ` · driver ${tn.driverName}${tn.driverPhone ? ` ${tn.driverPhone}` : ""}${tn.unitNumber ? ` · unit ${tn.unitNumber}` : ""}` : ""}
                        </div>
                      );
                    })()}
                  </div>
                  {canDispatch && !closed && l.state !== "completed" && l.state !== "cancelled" && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(l.state === "unassigned" || l.state === "declined") && (
                        <button className="btn btn-sm" onClick={() => onPopup({ kind: "assign", legId: l.id })}>
                          Assign
                        </button>
                      )}
                      {l.state === "planned" && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => run("Sent", () => A.dispatchAction(l.id))} disabled={hold}>
                            Send
                          </button>
                          <button className="btn btn-sm" onClick={() => onPopup({ kind: "assign", legId: l.id })}>
                            Change
                          </button>
                          <button className="btn btn-sm" onClick={() => run("Back to Pending", () => A.unplanAction(l.id))}>
                            Unplan
                          </button>
                        </>
                      )}
                      {(l.state === "dispatched" || l.state === "accepted") && (
                        <>
                          {l.state === "dispatched" && (
                            <button className="btn btn-sm" onClick={() => run("Accepted", () => A.acceptAction(l.id))}>
                              Accepted
                            </button>
                          )}
                          <button className="btn btn-sm" onClick={() => onPopup({ kind: "decline", legId: l.id })}>
                            Declined
                          </button>
                          <button className="btn btn-sm" onClick={() => run("Back to Planned", () => A.unplanAction(l.id))}>
                            Pull back
                          </button>
                        </>
                      )}
                      {forwardLabel(l, r.stops) && l.state !== "dispatched" && (
                        <button className="btn btn-sm" onClick={() => run("Updated", () => A.advanceAction(l.id, "next"))}>
                          {forwardLabel(l, r.stops)}
                        </button>
                      )}
                      {l.assigneeKind === "truck" && (
                        <button className="btn btn-sm btn-ghost" onClick={() => onPopup({ kind: "drivers", legId: l.id })}>
                          Drivers
                        </button>
                      )}
                      {l.type === "crossing" && (
                        <Link href={`/crossing?leg=${l.id}`} className="btn btn-sm btn-ghost text-teal">
                          Crossing →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
        <details className="accordion" open>
          <summary>
            Stops <span className="text-faint font-normal">{r.stops.length}</span>
          </summary>
          <ol className="pb-3 space-y-2">
            {r.stops.map((s) => (
              <li key={s.id} className="flex gap-3 text-[13px]">
                <span className={`timeline-dot mt-1.5 ${s.departedAt ? "done" : s.arrivedAt ? "now" : ""}`} />
                <div className="min-w-0">
                  <div className="font-semibold truncate">
                    {place(s)} <span className="text-faint font-normal">· {s.country}</span>
                  </div>
                  <div className="text-muted text-[12px]">
                    {s.type.replace("_", " ")}
                    {s.windowStart ? ` · ${when(s.windowStart)}${s.windowEnd ? `–${when(s.windowEnd)}` : ""}` : ""}
                    {s.arrivedAt ? ` · in ${when(s.arrivedAt)}` : ""}
                    {s.departedAt ? ` · out ${when(s.departedAt)}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </details>
        <details className="accordion">
          <summary>Details</summary>
          <div className="pb-3">
            <KV k="Rate" v={r.order.rateTbd ? "TBD" : money(r.order.rateCents, r.order.currency)} />
            <KV k="Equipment" v={r.order.equipment.replace("_", " ")} />
            <KV k="Template" v={data.templates.find((x) => x.key === r.order.legTemplate)?.label} />
            {Object.entries(r.order.refs).map(([k, v]) => (
              <KV key={k} k={k.replace(/_/g, " ")} v={v} />
            ))}
            <div className="mt-3 flex gap-2">
              <Link href={r.order.kind === "trip" ? `/trips/${r.order.id}` : `/orders/${r.order.id}`} className="btn btn-sm">
                {r.order.kind === "trip" ? "Open trip" : "Open order"}
              </Link>
              {canDispatch && !closed && (
                <button className="btn btn-sm btn-danger" onClick={() => onPopup({ kind: "cancel" })}>
                  Cancel order
                </button>
              )}
            </div>
          </div>
        </details>
      </div>
    </aside>
  );
}

function QuickBtn({ label, onClick, disabled, hint }: { label: string; onClick?: () => void; disabled?: boolean; hint?: string }) {
  return (
    <button className="btn btn-sm justify-center px-1 text-[11.5px]" onClick={onClick} disabled={disabled} title={hint}>
      {label}
    </button>
  );
}

/* ---------- popups ---------- */

function NewOrderModal({ open, onClose, data, onCreated }: { open: boolean; onClose: () => void; data: BoardData; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ customerId: "", pickup: "", pickupCountry: "MX", delivery: "", deliveryCountry: "US", rate: "", template: "mx_crossing_us", ref: "" });
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const reset = () => {
    setErr(null);
    setF((s) => ({ ...s, pickup: "", delivery: "", rate: "", ref: "" }));
  };
  const close = () => {
    reset();
    onClose();
  };
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = () =>
    start(async () => {
      if (!f.customerId) return setErr({ field: "customerId", message: "Pick who's paying" });
      if (!f.pickup.trim()) return setErr({ field: "pickup", message: "Where does it pick up?" });
      if (!f.delivery.trim()) return setErr({ field: "delivery", message: "Where does it deliver?" });
      const r = await A.quickOrderAction({ ...f, refs: f.ref.trim() ? { reference: f.ref.trim() } : undefined });
      if (r.ok) {
        reset();
        onCreated(r.data.order.id);
      } else setErr({ field: r.field, message: r.error });
    });
  return (
    <Modal
      open={open}
      onClose={close}
      title="New order"
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={pending}>
            {pending ? "Creating…" : "Create & book"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Customer / broker</label>
          <select className="select" value={f.customerId} onChange={(e) => set("customerId", e.target.value)} aria-invalid={err?.field === "customerId"} autoFocus>
            <option value="">—</option>
            {data.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.kind === "broker" ? " (broker)" : ""}
              </option>
            ))}
          </select>
          {data.customers.length === 0 && (
            <div className="help">
              No customers yet —{" "}
              <Link href="/settings/customers?add=1" className="text-teal font-semibold">
                add one
              </Link>
              .
            </div>
          )}
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <div>
            <label className="label">Pickup</label>
            <input className="input" value={f.pickup} onChange={(e) => set("pickup", e.target.value)} placeholder="Planta Monterrey" aria-invalid={err?.field === "pickup"} />
          </div>
          <div>
            <label className="label">Country</label>
            <select className="select" value={f.pickupCountry} onChange={(e) => set("pickupCountry", e.target.value)}>
              <option>MX</option>
              <option>US</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <div>
            <label className="label">Delivery</label>
            <input className="input" value={f.delivery} onChange={(e) => set("delivery", e.target.value)} placeholder="GM Arlington" aria-invalid={err?.field === "delivery"} />
          </div>
          <div>
            <label className="label">Country</label>
            <select className="select" value={f.deliveryCountry} onChange={(e) => set("deliveryCountry", e.target.value)}>
              <option>US</option>
              <option>MX</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Rate (USD)</label>
            <input className="input" inputMode="decimal" value={f.rate} onChange={(e) => set("rate", e.target.value)} placeholder="blank = TBD" aria-invalid={err?.field === "rate"} />
          </div>
          <div>
            <label className="label">Reference / PO</label>
            <input className="input" value={f.ref} onChange={(e) => set("ref", e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Legs</label>
          <select className="select" value={f.template} onChange={(e) => set("template", e.target.value)}>
            {data.templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} — {t.description}
              </option>
            ))}
          </select>
        </div>
        {err && (
          <div className="error" role="alert">
            {err.message}
          </div>
        )}
        <div className="help">Yards are filled in from the template; rename them on the order. Everything else can be added later.</div>
      </div>
    </Modal>
  );
}

function AssignModal({ leg, order, data, onClose, onDone }: { leg: Leg; order: Order; data: BoardData; onClose: () => void; onDone: (msg: string) => void }) {
  const [tab, setTab] = useState<"truck" | "carrier">(leg.type === "mx" ? "carrier" : "truck");
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState<{ truckId: string; driverId: string | null; coDriverId: string | null } | null>(null);
  const [carrierId, setCarrierId] = useState(leg.carrierId ?? "");
  const [carrierRate, setCarrierRate] = useState(leg.carrierRateCents != null ? (leg.carrierRateCents / 100).toFixed(2) : "");
  const [lane, setLane] = useState<{ lane: string; rateCents: number; fuelRule: string; fuelValue: number | null; validTo: string | null } | null>(null);
  const [miles, setMiles] = useState(leg.plannedMiles != null ? String(leg.plannedMiles) : "");
  const [override, setOverride] = useState("");
  const [needsOverride, setNeedsOverride] = useState<{ message: string; hard: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [sendNow, setSendNow] = useState(true);
  const [tender, setTender] = useState({ channel: "email" as "email" | "phone" | "whatsapp", expires: "60", message: "" });

  useEffect(() => {
    A.candidatesAction(leg.id).then((r) => setCands(r.ok ? r.data : []));
  }, [leg.id]);

  const rateCents = carrierRate.trim() ? Math.round(Number(carrierRate.replace(/[$,]/g, "")) * 100) : null;
  const go = () =>
    start(async () => {
      setErr(null);
      const milesN = miles.trim() ? Number(miles.replace(/[,\s]/g, "")) : null;
      if (milesN != null && (!Number.isFinite(milesN) || milesN < 0)) return setErr("Miles must be a number");
      const opts = { ...(needsOverride && override.trim() ? { override: true, reason: override.trim() } : {}), ...(tab === "truck" ? { plannedMiles: milesN } : {}) };
      if (tab === "carrier") {
        if (!carrierId) return setErr("Pick a carrier");
        if (sendNow && (tender.channel === "email" || tender.channel === "whatsapp")) {
          const r = await A.tenderAction(leg.id, { carrierId, rateCents, channel: tender.channel, expiresInMinutes: Number(tender.expires), message: tender.message.trim() || null, ...opts });
          if (r.ok) onDone(`Tender ${tender.channel === "whatsapp" ? "sent on WhatsApp" : "emailed"} to ${r.data.to} — expires in ${tender.expires} min`);
          else if (r.code === "eligibility") setNeedsOverride({ message: r.error, hard: !!r.hardBlocked });
          else setErr(r.error);
          return;
        }
      }
      const a = tab === "truck" ? (pick ? { kind: "truck" as const, ...pick } : null) : { kind: "carrier" as const, carrierId, carrierRateCents: rateCents };
      if (!a) return setErr("Pick a unit");
      const r = sendNow && (leg.state === "unassigned" || leg.state === "declined" || leg.state === "planned") ? await A.planAndDispatchAction(leg.id, a, opts) : await A.planAction(leg.id, a, opts);
      if (r.ok) onDone(sendNow ? (tab === "carrier" ? "Marked sent — confirm by phone, then press Accepted" : "Assigned and sent") : "Assigned — in Planned");
      else if (r.code === "eligibility") setNeedsOverride({ message: r.error, hard: !!r.hardBlocked });
      else setErr(r.error);
    });

  const driversFor = (truckId: string) => data.drivers.filter((d) => d.currentTruckId === truckId);

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={
        <span>
          Assign · {order.orderNumber} · {LEG_TYPE_LABEL[leg.type]} leg
        </span>
      }
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} /> Send right away
          </label>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={pending || (needsOverride?.hard ?? false)}>
            {pending ? "Working…" : needsOverride && !needsOverride.hard ? "Override & assign" : sendNow ? (tab === "carrier" && tender.channel !== "phone" ? "Send tender" : "Assign & send") : "Assign"}
          </button>
        </>
      }
    >
      <div className="flex gap-1.5 mb-3">
        <button className="stage-tab" data-active={tab === "truck"} onClick={() => setTab("truck")}>
          Our trucks
        </button>
        <button className="stage-tab" data-active={tab === "carrier"} onClick={() => setTab("carrier")}>
          Partner carrier
        </button>
      </div>
      {tab === "truck" ? (
        !cands ? (
          <div className="py-8 text-center text-muted">
            <Spinner /> Ranking units…
          </div>
        ) : cands.length === 0 ? (
          <div className="py-8 text-center text-muted">
            No trucks yet.{" "}
            <Link href="/settings/trucks?add=1" className="text-teal font-semibold">
              Add one
            </Link>
          </div>
        ) : (
          <div className="max-h-[380px] overflow-auto -mx-1">
            {cands.map((c) => {
              const active = pick?.truckId === c.truckId;
              return (
                <div key={c.truckId} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer ${active ? "bg-teal-soft" : "hover:bg-ground"} ${c.hardBlocked ? "opacity-60" : ""}`} onClick={() => !c.hardBlocked && setPick({ truckId: c.truckId, driverId: c.driverId, coDriverId: null })}>
                  <span className={`w-2.5 h-2.5 rounded-full flex-none ${c.hardBlocked ? "bg-red" : c.ok ? (c.busy.length ? "bg-amber" : "bg-green") : "bg-amber"}`} />
                  <div className="w-16 font-extrabold mono">{c.unitNumber}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate">{c.driverName ?? <span className="text-faint">no driver</span>}</div>
                    <div className={`text-[12px] truncate ${c.hardBlocked ? "text-red" : c.ok ? "text-muted" : "text-amber"}`}>{c.reason}</div>
                  </div>
                  {c.hardBlocked && <Pill tone="red">Blocked</Pill>}
                  {!c.hardBlocked && !c.ok && <Pill tone="amber">Override</Pill>}
                </div>
              );
            })}
            <div className="flex items-center gap-2 px-3 pt-3 mt-1 border-t border-line">
              <label className="label m-0" htmlFor="plan-miles">
                Planned miles
              </label>
              <input id="plan-miles" className="input w-28" inputMode="numeric" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="for pay & fuel" />
              <span className="help m-0">Per-mile driver pay and the fuel estimate come from this. Editable later on the order.</span>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Carrier</label>
            <select
              className="select"
              value={carrierId}
              onChange={(e) => {
                const id = e.target.value;
                setCarrierId(id);
                setLane(null);
                if (!id) return;
                // the lane rate on file prefills what we pay; the dispatcher can still type another number
                A.laneRateAction(leg.id, id).then((r) => {
                  if (r.ok && r.data) {
                    setLane({ ...r.data, validTo: r.data.validTo ? String(r.data.validTo) : null });
                    setCarrierRate((r.data.rateCents / 100).toFixed(2));
                  }
                });
              }}
            >
              <option value="">—</option>
              {data.carriers.map((c) => (
                <option key={c.id} value={c.id} disabled={c.doNotUse}>
                  {c.name} ({c.country}){c.doNotUse ? " — do not use" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">Carrier rate (USD)</label>
              <input className="input" inputMode="decimal" value={carrierRate} onChange={(e) => setCarrierRate(e.target.value)} placeholder="what you pay them" />
              {lane && (
                <div className="help" data-testid="lane-rate">
                  Lane rate on file: {lane.lane} · fuel {lane.fuelRule === "included" ? "included" : lane.fuelRule === "pct" ? `${lane.fuelValue ?? 0}% extra` : `${((lane.fuelValue ?? 0) / 100).toFixed(2)}/mi extra`}
                  {lane.validTo ? ` · valid to ${new Date(lane.validTo).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </div>
              )}
            </div>
            <div>
              <label className="label">Tender by</label>
              <select className="select" value={tender.channel} onChange={(e) => setTender({ ...tender, channel: e.target.value as "email" | "phone" | "whatsapp" })}>
                <option value="email">Email with accept link</option>
                <option value="whatsapp">WhatsApp with accept link</option>
                <option value="phone">Phone — I&apos;ll confirm myself</option>
              </select>
            </div>
            <div>
              <label className="label">Answer within</label>
              <select className="select" value={tender.expires} onChange={(e) => setTender({ ...tender, expires: e.target.value })} disabled={tender.channel !== "email"}>
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="240">4 hours</option>
                <option value="1440">24 hours</option>
              </select>
            </div>
          </div>
          {tender.channel === "email" && (
            <div>
              <label className="label">Note to the carrier (optional)</label>
              <input className="input" value={tender.message} onChange={(e) => setTender({ ...tender, message: e.target.value })} placeholder="Team drivers please. Pickup appointment is firm." />
              <div className="help">They get the pickup, delivery, equipment, rate and a link to accept or decline. No answer by the deadline = back to Pending with a flag.</div>
            </div>
          )}
        </div>
      )}
      {pick && tab === "truck" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="label">Driver</label>
            <select className="select" value={pick.driverId ?? ""} onChange={(e) => setPick({ ...pick, driverId: e.target.value || null })}>
              <option value="">—</option>
              {[...driversFor(pick.truckId), ...data.drivers.filter((d) => d.currentTruckId !== pick.truckId)].map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.driverType})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Co-driver (team)</label>
            <select className="select" value={pick.coDriverId ?? ""} onChange={(e) => setPick({ ...pick, coDriverId: e.target.value || null })}>
              <option value="">—</option>
              {data.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.driverType})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {needsOverride && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-[13px] ${needsOverride.hard ? "bg-red-soft text-red" : "bg-amber-soft text-amber"}`}>
          <div className="font-bold">{needsOverride.hard ? "Blocked — no override exists for this." : "Needs an override"}</div>
          <div>{needsOverride.message}</div>
          {!needsOverride.hard && <input className="input mt-2" placeholder="Reason for the override (goes on the record)" value={override} onChange={(e) => setOverride(e.target.value)} />}
        </div>
      )}
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}

function DriversModal({ leg, data, onClose, onDone }: { leg: Leg; data: BoardData; onClose: () => void; onDone: (msg: string) => void }) {
  const [driverId, setDriverId] = useState(leg.driverId ?? "");
  const [coDriverId, setCoDriverId] = useState(leg.coDriverId ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Drivers on unit ${leg.truckUnit}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await A.setDriversAction(leg.id, { driverId: driverId || null, coDriverId: coDriverId || null });
                if (r.ok) onDone("Drivers updated");
                else setErr(r.error);
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Driver</label>
          <select className="select" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">—</option>
            {data.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.driverType})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Co-driver</label>
          <select className="select" value={coDriverId} onChange={(e) => setCoDriverId(e.target.value)}>
            <option value="">—</option>
            {data.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.driverType})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="help mt-2">Eligibility re-runs: a B-1 driver can&apos;t go on a US leg, and the system won&apos;t let you.</div>
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}

function SplitModal({ leg, stops, onClose, onDone }: { leg: Leg; stops: Stop[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState(stops.find((s) => s.id === leg.toStopId)?.country ?? "US");
  const [type, setType] = useState<"yard" | "transload" | "terminal">("yard");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const from = stops.find((s) => s.id === leg.fromStopId);
  const to = stops.find((s) => s.id === leg.toStopId);
  return (
    <Modal
      open
      onClose={onClose}
      title="Split this leg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={pending || !name.trim()}
            onClick={() =>
              start(async () => {
                const r = await A.splitAction(leg.id, { type, name: name.trim(), country });
                if (r.ok) onDone("Split. The second half is in Pending.");
                else setErr(r.error);
              })
            }
          >
            Split
          </button>
        </>
      }
    >
      <div className="text-[13px] text-muted mb-3">
        {from?.name} → <b className="text-ink">new stop</b> → {to?.name}. The first half keeps {leg.truckUnit ? `unit ${leg.truckUnit}` : leg.carrierName ?? "its assignment"}; the second half needs a truck.
      </div>
      <div className="grid grid-cols-[1fr_110px_88px] gap-2">
        <div>
          <label className="label">Where</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="San Antonio yard" autoFocus />
        </div>
        <div>
          <label className="label">Kind</label>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="yard">Yard</option>
            <option value="transload">Transload</option>
            <option value="terminal">Terminal</option>
          </select>
        </div>
        <div>
          <label className="label">Country</label>
          <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option>US</option>
            <option>MX</option>
          </select>
        </div>
      </div>
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}

function TrackModal({ r, onClose }: { r: Row; onClose: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [driverLinks, setDriverLinks] = useState<{ id: string; name: string; url: string; phone: string | null; whatsapp: string | null }[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [custTo, setCustTo] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const nl = nextLeg(r);
  const send = async (input: { kind: "driver" | "tracking"; orderId: string; driverId?: string; to?: string }) => {
    setSending(true);
    setSent(null);
    const x = await A.sendLinkWhatsAppAction(input);
    setSending(false);
    if (!x.ok) return setSent(`✗ ${x.error}`);
    setSent(x.data.state === "logged" ? `Logged for ${x.data.to} — connect WhatsApp Business under Settings → Integrations to deliver it` : x.data.state === "failed" ? `✗ ${x.data.error}` : `Sent to ${x.data.to}`);
  };
  useEffect(() => {
    A.trackingLinkAction(r.order.id).then((x) => x.ok && setLink(x.data.url));
    const ids = [...new Set(r.legs.flatMap((l) => [l.driverId, l.coDriverId]).filter((x): x is string => !!x))];
    Promise.all(ids.map((id) => A.driverLinkAction(id).then((x) => (x.ok ? { id, ...x.data } : null)))).then((rs) => setDriverLinks(rs.filter((x): x is NonNullable<typeof x> => !!x)));
  }, [r.order.id, r.legs]);
  const copy = async (s: string, what: string) => {
    try {
      await navigator.clipboard.writeText(s);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked; the text is visible to select */
    }
  };
  const wa = (phone: string | null, text: string) => (phone ? `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}` : null);
  return (
    <Modal open onClose={onClose} title={`Track · ${r.order.orderNumber}`}>
      <div className="space-y-4">
        <div>
          <div className="label">Customer tracking link</div>
          <div className="text-[12.5px] text-muted mb-1.5">Stops, progress, last position. No rates, no phones. Same link for the life of the order.</div>
          {link ? (
            <>
              <div className="flex gap-2">
                <input className="input mono text-[12.5px]" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn" onClick={() => copy(link, "tracking")}>
                  {copied === "tracking" ? "Copied" : "Copy"}
                </button>
                <a className="btn" href={link} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
              <div className="flex gap-2 mt-1.5">
                <input className="input w-52" placeholder="customer WhatsApp +1 …" value={custTo} onChange={(e) => setCustTo(e.target.value)} aria-label="Customer WhatsApp" />
                <button className="btn btn-sm" disabled={sending || !custTo.trim()} onClick={() => send({ kind: "tracking", orderId: r.order.id, to: custTo })}>
                  Send on WhatsApp
                </button>
              </div>
            </>
          ) : (
            <Spinner />
          )}
        </div>
        <div>
          <div className="label">Driver app</div>
          <div className="text-[12.5px] text-muted mb-1.5">Send the driver their link once; it stays theirs. One button per step, GPS with every press.</div>
          {driverLinks.length === 0 ? (
            <div className="text-[13px] text-muted">No driver on this order yet.</div>
          ) : (
            driverLinks.map((d) => (
              <div key={d.url} className="flex items-center gap-2 mb-1.5">
                <span className="w-36 font-semibold truncate text-[13px]">{d.name}</span>
                <button className="btn btn-sm" onClick={() => copy(d.url, d.url)}>
                  {copied === d.url ? "Copied" : "Copy link"}
                </button>
                {wa(d.whatsapp ?? d.phone, `${d.name}, your loads: ${d.url}`) && (
                  <>
                    <button className="btn btn-sm" disabled={sending} title="Through the company WhatsApp Business number" onClick={() => send({ kind: "driver", orderId: r.order.id, driverId: d.id })}>
                      Send on WhatsApp
                    </button>
                    <a className="btn btn-sm btn-ghost" href={wa(d.whatsapp ?? d.phone, `${d.name}, your loads: ${d.url}`)!} target="_blank" rel="noreferrer" title="From your own phone / WhatsApp Web">
                      wa.me
                    </a>
                  </>
                )}
                <a className="btn btn-sm btn-ghost" href={d.url} target="_blank" rel="noreferrer">
                  Preview
                </a>
              </div>
            ))
          )}
        </div>
        {sent && <div className={`text-[12.5px] font-semibold ${sent.startsWith("✗") ? "text-red" : "text-teal"}`}>{sent}</div>}
        {nl?.assigneeKind === "carrier" && <div className="text-[12.5px] text-muted">This leg is with a partner carrier: their driver details come back on the tender. ELD tracking for partner carriers arrives with the carrier portal.</div>}
      </div>
    </Modal>
  );
}
