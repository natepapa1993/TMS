"use client";

import { fold } from "@/lib/fold";
import { useEffect, useMemo, useRef, useState, useTransition, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Confirm, Toast, useToast, KV, Spinner } from "@/components/ui";
import { LEG_LABEL } from "@/domain/states";
import type { LegState } from "@/db/schema";
import type { RankedCandidate as Candidate } from "@/domain/planner";
import * as A from "./actions";
import { BUCKETS, ALERTS, bucketsOf, alertsOf, urgency, currentLeg, nextStop, type BucketKey, type AlertKey } from "@/domain/board-buckets";
import { fmtIn, stopZone, zonedDate, toZoneInput, fromZoneInput, zoneAbbrev } from "@/lib/time";
import { CheckCallBox } from "./check-call";

/**
 * The trip board: every open load on one dense screen, most urgent first. Buckets (Needs truck,
 * Tendered, Planned, Sent, In transit, Delivered) and alert chips (Late, At risk, No ping, No truck
 * < 24h, Picks / Delivers today, Flagged) filter it; a row shows status, pickup and delivery at the
 * stop's own time, the next stop with its ETA against the appointment, the power, the last GPS ping
 * and the money. Click a row for the panel with the one next action and the check calls.
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
  estMiles: number | null;
  fromStopId: string | null;
  toStopId: string | null;
  truckUnit: string | null;
  trailerId: string | null;
  trailerUnit: string | null;
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
export type Row = { order: Order; stops: Stop[]; legs: Leg[]; openFlags: Flag[]; stage: "pending" | "planned" | "dispatched" | "delivered" | "closed"; customerName: string | null; tenders: Tender[]; shipments: number; podMissing: boolean };

export type BoardData = {
  rows: Row[];
  etas?: Record<string, { at: string; stopName: string; miles: number | null; late: boolean; positionAt: string; source?: "gps" | "check_call" }>;
  customers: { id: string; name: string; kind: string; note: string | null }[];
  carriers: { id: string; name: string; country: string; doNotUse: boolean }[];
  drivers: { id: string; name: string; driverType: string; currentTruckId: string | null }[];
  trucks: { id: string; unitNumber: string; status: string }[];
  role: string;
  ediInbox: number;
  messages: number;
  requests: number;
  zone: string;
  pings: { byTruck: Record<string, string>; byLeg: Record<string, string> };
  lastCalls: Record<string, { at: string; status: string; location: string | null; note: string | null; etaAt?: string | null; legId?: string | null }>;
  trailers: { id: string; unitNumber: string; status: string }[];
  locations: { id: string; name: string; kind: string; country: string; city: string | null }[];
};

const subscribeCompact = (cb: () => void) => {
  window.addEventListener("board-compact", cb);
  return () => window.removeEventListener("board-compact", cb);
};
const readCompact = () => {
  try {
    return localStorage.getItem("board.compact") === "1";
  } catch {
    return false;
  }
};
const EQUIPMENT_LABEL: Record<string, string> = { "53_dry": "53' dry van", "53_reefer": "53' reefer", "48_dry": "48' dry van", flatbed: "Flatbed", sprinter: "Sprinter van", straight: "Straight truck", power_only: "Power only" };
const STATUS_LABEL: Record<string, string> = { unassigned: "Needs truck", declined: "Declined", planned: "Planned", dispatched: "Sent", accepted: "Accepted", en_route_to_pickup: "To pickup", at_pickup: "At pickup", loaded: "Loaded", en_route: "En route", at_delivery: "At delivery", completed: "Delivered" };
const ago = (iso: string | null, now: number) => {
  if (!iso) return null;
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const LEG_TYPE_LABEL: Record<string, string> = { mx: "MX", ca: "CA", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equip." };
const money = (c: number | null, cur = "USD") => (c == null ? "TBD" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(c / 100));
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

export function DispatchBoard({ data, initialOrder, initialBucket, initialChip }: { data: BoardData; initialOrder?: string; initialBucket?: BucketKey; initialChip?: AlertKey }) {
  const router = useRouter();
  const t = useToast();
  const initialRow = initialOrder ? data.rows.find((r) => r.order.id === initialOrder) : undefined;
  const [bucket, setBucket] = useState<BucketKey>(initialRow ? (initialRow.order.state === "draft" ? "drafts" : initialRow.stage === "delivered" ? "delivered" : "all") : (initialBucket ?? "all"));
  const [chips, setChips] = useState<Set<AlertKey>>(new Set(initialChip ? [initialChip] : []));
  // a per-viewer preference: read after hydration (the server can't know it), written on change
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);
  const setCompact = (on: boolean) => {
    try {
      localStorage.setItem("board.compact", on ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event("board-compact"));
  };
  const [q, setQ] = useState("");
  const [selectedId, setSelectedIdRaw] = useState<string | null>(initialRow?.order.id ?? null);
  const [popup, setPopup] = useState<null | { kind: "assign" | "split" | "hold" | "cancel" | "oos" | "decline" | "drivers" | "track"; legId?: string }>(null);
  // Selecting another order always drops any popup that belonged to the previous one.
  const setSelectedId = useCallback((id: string | null) => {
    setPopup(null);
    setSelectedIdRaw(id);
  }, []);
  const [pending, start] = useTransition();
  // the clock the row math uses; ticks every minute so "late" and ping ages stay true without a reload
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  const scored = useMemo(() => {
    const ctx = {
      now,
      etas: data.etas ?? {},
      lastPing: (l: { id: string; truckId: string | null }) => data.pings.byLeg[l.id] ?? (l.truckId ? (data.pings.byTruck[l.truckId] ?? null) : null),
      today: (st: { country: string; address: { state?: string } | null }) => zonedDate(new Date(now), stopZone(st, data.zone)),
      dayOf: (iso: string, st: { country: string; address: { state?: string } | null }) => zonedDate(new Date(iso), stopZone(st, data.zone)),
    };
    return data.rows.map((r) => {
      const b = bucketsOf(r);
      const a = alertsOf(r, ctx as never);
      return { r, b, a, u: urgency(r, a) };
    });
  }, [data, now]);
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((s) => [s.key, scored.filter((x) => x.b.has(s.key)).length])), [scored]);
  const alertCounts = useMemo(() => Object.fromEntries(ALERTS.map((s) => [s.key, scored.filter((x) => (bucket === "all" || x.b.has(bucket)) && x.a.has(s.key)).length])), [scored, bucket]);
  const rows = useMemo(() => {
    // searching on All looks everywhere, drafts and this week's deliveries too (m4)
    let base = scored.filter((x) => x.b.has(bucket) || (bucket === "all" && q.trim() !== "" && x.b.size > 0));
    if (chips.size) base = base.filter((x) => [...chips].every((c) => x.a.has(c)));
    if (q.trim()) {
      const s = fold(q.trim());
      base = base.filter(({ r }) => [r.order.orderNumber, r.customerName, ...r.stops.flatMap((x) => [x.name, x.address?.city ?? ""]), ...r.legs.flatMap((l) => [l.truckUnit ?? "", l.carrierName ?? "", l.driverName ?? "", l.trailerUnit ?? ""]), ...Object.values(r.order.refs)].some((x) => fold(x).includes(s)));
    }
    return base.sort((p, q2) => (bucket === "delivered" ? 0 : p.u - q2.u));
  }, [scored, bucket, chips, q]);
  const selected = data.rows.find((r) => r.order.id === selectedId) ?? null;
  const rowsRef = useRef<string[]>([]);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    rowsRef.current = rows.map((x) => x.r.order.id);
    selectedRef.current = selectedId;
  }, [rows, selectedId]);
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
      if (e.key === "n") router.push("/orders/new");
      if (e.key === "j" || e.key === "k") {
        const ids = rowsRef.current;
        if (!ids.length) return;
        const i = selectedRef.current ? ids.indexOf(selectedRef.current) : -1;
        const next = e.key === "j" ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
        setSelectedId(ids[next]);
        document.querySelector(`[data-order="${ids[next]}"]`)?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
      // Escape closes the top-most thing: a popup handles its own Escape; only close the panel when none is open.
      if (e.key === "Escape" && !document.querySelector(".overlay")) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelectedId, router]);

  const canDispatch = ["owner", "dispatcher"].includes(data.role);

  return (
    <div className="min-h-screen">
      {/* on wide screens the side panel sits beside the board (like an inspector) instead of covering its tabs */}
      <div className={`min-w-0 transition-[padding] ${selected ? "lg:pr-[420px]" : ""}`}>
        <div className="px-gutter pt-6 pb-3 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="eyebrow mb-1">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="h1">Dispatch</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input id="board-search" className="input w-60 max-w-full" placeholder="Search order, customer, unit…  /" value={q} onChange={(e) => setQ(e.target.value)} />
            <Link href="/messages" className="btn" title="What drivers and carriers wrote to the company WhatsApp">
              Messages{data.messages ? <span className="badge">{data.messages}</span> : null}
            </Link>
            {data.requests > 0 && (
              <button className="btn border-amber text-amber font-bold" title="Load requests from the customer portal: price, confirm, book" onClick={() => setBucket("drafts")}>
                Requests · {data.requests}
              </button>
            )}
            <Link href="/edi" className="btn" title="EDI tenders, 214 status and 210 invoices">
              EDI{data.ediInbox ? <span className="badge">{data.ediInbox}</span> : null}
            </Link>
            <span className="segmented" role="group" aria-label="View">
              <span aria-current="page">Board</span>
              <Link href="/dispatch/planner">
                Planner
              </Link>
            </span>
            {canDispatch && (
              <button className="btn btn-primary" onClick={() => router.push("/orders/new")} title="Shortcut: n">
                + New load
              </button>
            )}
          </div>
        </div>
        <div className="px-gutter pb-2 flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Board buckets">
          {BUCKETS.map((s) => (
            <button key={s.key} role="tab" aria-selected={bucket === s.key} className="stage-tab" data-active={bucket === s.key} onClick={() => setBucket(s.key)} title={s.hint}>
              {s.label} <span className="count">{counts[s.key]}</span>
            </button>
          ))}
        </div>
        <div className="px-gutter pb-3 flex items-center gap-1.5 flex-wrap" data-testid="board-chips">
          {ALERTS.map((c) => {
            const on = chips.has(c.key);
            const n = alertCounts[c.key];
            const hot = c.key === "late" || c.key === "no_ping" || c.key === "uncovered_soon";
            return (
              <button
                key={c.key}
                className={`chip ${on ? "chip-on" : ""} ${n && hot ? "chip-hot" : ""}`}
                aria-pressed={on}
                title={c.hint}
                disabled={!n && !on}
                onClick={() => setChips((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.key)) next.delete(c.key);
                  else next.add(c.key);
                  return next;
                })}
              >
                {c.label} <b>{n}</b>
              </button>
            );
          })}
          {chips.size > 0 && (
            <button className="btn btn-ghost btn-sm text-muted" onClick={() => setChips(new Set())}>
              Clear
            </button>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-callout text-muted cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> Compact
          </label>
        </div>
        <div className="px-gutter pb-10">
          <div className={`card overflow-x-auto trip-board ${compact ? "trip-compact" : ""}`} data-testid="trip-board">
            <div className="row trip-row trip-head" role="row">
              <div>Load</div>
              <div>Status</div>
              <div>Pickup</div>
              <div>Delivery</div>
              <div>Next stop · ETA</div>
              <div>Power</div>
              <div title="Last GPS position">Ping</div>
              <div className="text-right">Rate</div>
            </div>
            {rows.length === 0 ? (
              <div className="py-14 text-center border-t border-line">
                <div className="font-bold">{q || chips.size ? "Nothing matches" : bucket === "needs" ? "Every leg is covered" : `Nothing in ${BUCKETS.find((b) => b.key === bucket)?.label}`}</div>
                <div className="text-muted text-callout mt-1">{bucket === "all" && !q ? "New loads land here. Press n to build one." : " "}</div>
              </div>
            ) : (
              rows.map(({ r, a }) => <BoardRow key={r.order.id} r={r} alerts={a} data={data} now={now} selected={r.order.id === selectedId} onClick={() => setSelectedId(r.order.id)} />)
            )}
          </div>
          <div className="mt-3 text-footnote text-faint flex gap-4 flex-wrap">
            <span>{rows.length} load{rows.length === 1 ? "" : "s"} · most urgent first</span>
            <span>
              <span className="kbd">n</span> new load
            </span>
            <span>
              <span className="kbd">/</span> search
            </span>
            <span>
              <span className="kbd">j</span> <span className="kbd">k</span> move
            </span>
            <span>
              <span className="kbd">esc</span> close panel
            </span>
            <span>Times are local to each stop.</span>
          </div>
        </div>
      </div>

      {selected && (
        <SidePanel
          key={selected.order.id}
          r={selected}
          data={data}
          busy={pending}
          canDispatch={canDispatch}
          onClose={() => setSelectedId(null)}
          onPopup={setPopup}
          run={run}
          onToast={(msg) => {
            t.ok(msg);
            router.refresh();
          }}
        />
      )}


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
      {selected && popup?.kind === "split" && popupLeg && <SplitModal leg={popupLeg} stops={selected.stops} locations={data.locations} onClose={() => setPopup(null)} onDone={(msg) => { setPopup(null); t.ok(msg); router.refresh(); }} />}
      <Confirm open={popup?.kind === "hold"} onClose={() => setPopup(null)} title="Put this load on hold" body="Nothing is sent and the driver's steps are frozen until it's released. The reason shows on the row and in the driver's app." needReason="Why?" confirmLabel="Hold" onConfirm={(reason) => { setPopup(null); if (selected) run("On hold", () => A.holdAction(selected.order.id, reason)); }} />
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

function BoardRow({ r, alerts, data, now, selected, onClick }: { r: Row; alerts: Set<AlertKey>; data: BoardData; now: number; selected: boolean; onClick: () => void }) {
  const first = r.stops.find((s) => s.type === "pickup") ?? r.stops[0];
  const last = [...r.stops].reverse().find((s) => s.type === "delivery") ?? r.stops[r.stops.length - 1];
  const cur = currentLeg(r.legs);
  const ns = nextStop(r);
  const hold = r.order.state === "exception";
  const red = r.openFlags.some((f) => f.level === "red");
  const eta = cur ? data.etas?.[cur.id] : undefined;
  const at = (iso: string | null, st: Stop | undefined) => (iso && st ? fmtIn(iso, stopZone(st, data.zone), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
  const apptOf = (st: Stop | null | undefined) => (st ? (st.windowEnd ?? st.windowStart) : null);
  const nsAppt = apptOf(ns);
  const etaTone = eta && nsAppt ? (new Date(eta.at).getTime() > new Date(nsAppt).getTime() ? "late" : new Date(eta.at).getTime() > new Date(nsAppt).getTime() - 3600_000 ? "risk" : "ok") : eta?.late ? "late" : eta ? "ok" : null;
  const needing = r.legs.filter((l) => l.state === "unassigned" || l.state === "declined");
  const tender = r.tenders.find((x) => x.state === "sent");
  const ping = cur ? (data.pings.byLeg[cur.id] ?? (cur.truckId ? data.pings.byTruck[cur.truckId] : undefined) ?? null) : null;
  const rolling = cur && ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"].includes(cur.state);
  const pingAge = rolling ? ago(ping, now) : null;
  const pingTone = rolling ? (!ping || now - new Date(ping).getTime() > 2 * 3600_000 ? "text-red font-bold" : now - new Date(ping).getTime() > 3600_000 ? "text-amber font-semibold" : "text-muted") : "text-faint";
  const liveLegs = r.legs.filter((l) => l.state !== "cancelled");
  const miles = liveLegs.reduce((a, l) => a + (l.plannedMiles ?? l.estMiles ?? 0), 0);
  const milesEst = liveLegs.some((l) => l.plannedMiles == null);
  const call = data.lastCalls[r.order.id];
  const status = hold ? "On hold" : r.order.state === "draft" ? "Draft" : cur ? STATUS_LABEL[cur.state] ?? LEG_LABEL[cur.state] : "Delivered";
  const statusTone = hold ? "amber" : r.order.state === "draft" ? "slate" : cur ? legTone(cur.state) : "green";
  const place2 = (st: Stop | undefined) => (st ? [st.address?.city || st.name, st.address?.state].filter(Boolean).join(", ") : "—");
  return (
    <div className={`row trip-row ${alerts.has("late") ? "trip-late" : ""}`} data-order={r.order.id} data-selected={selected} aria-pressed={selected} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick()}>
      <div className="min-w-0">
        <div className="font-extrabold mono flex items-center gap-1.5">
          {r.order.orderNumber}
          {r.openFlags.length > 0 && <span className={`w-2 h-2 rounded-full ${red ? "bg-red" : "bg-amber"}`} title={r.openFlags.map((f) => f.title).join(", ")} />}
        </div>
        <div className="sub truncate">{r.order.kind === "trip" ? `Tailgate trip · ${r.shipments} shipment${r.shipments === 1 ? "" : "s"}` : (r.customerName ?? "No customer")}</div>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1 flex-wrap">
          <Pill tone={statusTone}>{status}</Pill>
          {alerts.has("late") && <span className="pill pill-red">Late</span>}
          {!alerts.has("late") && alerts.has("at_risk") && <span className="pill pill-amber">At risk</span>}
          {r.openFlags.some((f) => f.code === "breakdown") && <span className="pill pill-red" title={r.openFlags.find((f) => f.code === "breakdown")?.title}>Breakdown</span>}
          {r.openFlags.some((f) => f.code === "truck_removed") && <span className="pill pill-red" title={r.openFlags.find((f) => f.code === "truck_removed")?.title}>Truck removed</span>}
          {r.podMissing && <span className="pill pill-amber" title="No POD yet: billing can't invoice it">No POD</span>}
        </div>
        <div className="sub truncate" title={r.legs.map((l) => `${LEG_TYPE_LABEL[l.type]}: ${LEG_LABEL[l.state]}`).join(" · ")}>
          {r.legs.length > 1 ? r.legs.map((l) => `${LEG_TYPE_LABEL[l.type]}${l.state === "completed" ? " ✓" : l.state === "unassigned" || l.state === "declined" ? " ○" : " ●"}`).join(" · ") : cur ? `${LEG_TYPE_LABEL[cur.type]} leg` : ""}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-semibold" title={first ? place(first) : ""}>{place2(first)}</div>
        <div className={`sub truncate ${first && !first.arrivedAt && first.windowStart && new Date(first.windowStart).getTime() < now && cur && ["unassigned", "declined", "planned", "dispatched", "accepted", "en_route_to_pickup"].includes(cur.state) ? "text-red font-semibold" : ""}`}>
          {first?.departedAt ? `out ${at(first.departedAt, first)}` : (at(first?.windowStart ?? null, first) ?? "no appointment")}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-semibold" title={last ? place(last) : ""}>{place2(last)}</div>
        <div className="sub truncate">{last?.arrivedAt ? `in ${at(last.arrivedAt, last)}` : (at(apptOf(last), last) ?? "no appointment")}</div>
      </div>
      <div className="min-w-0">
        {ns && cur && r.stage !== "delivered" ? (
          <>
            <div className="truncate text-callout" title={place(ns)}>
              {ns.id === first?.id ? "Pickup" : ns.id === last?.id ? "Delivery" : ns.name}
            </div>
            <div className={`sub truncate ${etaTone === "late" ? "text-red font-bold" : etaTone === "risk" ? "text-amber font-semibold" : etaTone === "ok" ? "text-teal font-semibold" : ""}`} data-testid={eta ? "row-eta" : undefined}>
              {eta ? `ETA ${fmtIn(eta.at, stopZone(ns, data.zone), { hour: "numeric", minute: "2-digit", weekday: "short", month: undefined, day: undefined })}${eta.source === "check_call" ? " · check call" : eta.miles != null ? ` · ${eta.miles} mi` : ""}` : call ? `${call.location ?? call.status.replace(/_/g, " ")} · ${ago(call.at, now)} ago` : at(nsAppt, ns) ? `appt ${at(nsAppt, ns)}` : "—"}
            </div>
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>
      <div className="min-w-0">
        {cur?.state === "declined" ? (
          <>
            <div className="text-red font-semibold truncate">Needs truck</div>
            <div className="sub truncate text-red" title={cur.declineReason ?? undefined}>declined by {cur.assigneeKind === "carrier" ? (cur.carrierName ?? "the carrier") : (cur.driverName ?? `unit ${cur.truckUnit ?? ""}`)}</div>
          </>
        ) : cur?.assigneeKind === "truck" ? (
          <>
            <div className="truncate font-semibold">
              Unit {cur.truckUnit}
              {cur.trailerUnit ? <span className="text-muted font-normal"> · Tr {cur.trailerUnit}</span> : null}
            </div>
            <div className="sub truncate">{cur.driverName ?? "no driver"}{cur.coDriverId ? " + team" : ""}</div>
          </>
        ) : cur?.assigneeKind === "carrier" ? (
          <>
            <div className="truncate font-semibold">{cur.carrierName}</div>
            <div className="sub truncate">{tender ? `tender out · ${Math.max(0, Math.round((new Date(tender.expiresAt).getTime() - now) / 60000))} min left` : "partner carrier"}</div>
          </>
        ) : tender ? (
          <>
            <div className="truncate font-semibold">{tender.carrierName}</div>
            <div className="sub truncate text-amber">tendered · {Math.max(0, Math.round((new Date(tender.expiresAt).getTime() - now) / 60000))} min left</div>
          </>
        ) : cur ? (
          <div className="text-red font-semibold truncate">Needs truck</div>
        ) : (
          <span className="text-faint">—</span>
        )}
        {needing.length > 0 && cur && !["unassigned", "declined"].includes(cur.state) && <div className="sub text-red truncate">{needing.map((l) => LEG_TYPE_LABEL[l.type]).join(", ")} leg needs truck</div>}
      </div>
      <div className={`text-callout tabular-nums ${pingTone}`} title={ping ? `Last position ${new Date(ping).toLocaleString()}` : rolling ? "No GPS position" : ""}>
        {rolling ? (pingAge ?? "none") : "—"}
      </div>
      <div className="text-right min-w-0">
        <div className="font-semibold tabular-nums">{r.order.rateTbd ? "TBD" : money(r.order.rateCents, r.order.currency)}</div>
        <div className="sub tabular-nums" title={milesEst && miles ? "Miles estimated from the stops — type the real miles on the load" : undefined}>{miles ? `${miles.toLocaleString()} mi${milesEst ? " est." : ""}${r.order.rateCents && !r.order.rateTbd ? ` · ${new Intl.NumberFormat("en-US", { style: "currency", currency: r.order.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(r.order.rateCents / 100 / miles)}/mi` : ""}` : ""}</div>
      </div>
    </div>
  );
}

const STAMPS: LegState[] = ["en_route_to_pickup", "at_pickup", "en_route", "at_delivery"];

function SidePanel({ r, data, busy, canDispatch, onClose, onPopup, run, onToast }: { r: Row; data: BoardData; busy: boolean; canDispatch: boolean; onClose: () => void; onPopup: (p: { kind: "assign" | "split" | "hold" | "cancel" | "oos" | "decline" | "drivers" | "track"; legId?: string }) => void; run: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => void; onToast: (msg: string) => void }) {
  const nl = nextLeg(r);
  const [confirming, setConfirming] = useState<{ legId: string; label: string; when: string } | null>(null);
  const [pullBack, setPullBack] = useState<Leg | null>(null);
  const [waiving, setWaiving] = useState(false);
  // the clock a step stamps is the clock of the stop it happens at
  const zoneOfLeg = (l: Leg) => {
    const st = r.stops.find((x) => x.id === (["en_route_to_pickup", "at_pickup"].includes(l.state) ? l.fromStopId : l.toStopId));
    return st ? stopZone(st, data.zone) : data.zone;
  };
  const hold = r.order.state === "exception";
  const closed = r.order.state === "cancelled";
  const customerNote = data.customers.find((c) => c.id === (r.order.customerId ?? r.order.brokerId))?.note?.trim() || null;

  // The one primary action for where this order is right now.
  let primary: { label: string; onClick: () => void; tone?: "primary" | "plain" } | null = null;
  if (!closed && nl && canDispatch) {
    if (hold) primary = { label: "Release hold", onClick: () => run("Released", () => A.releaseAction(r.order.id)) };
    else if (nl.state === "unassigned" || nl.state === "declined") primary = { label: `Assign ${LEG_TYPE_LABEL[nl.type]} leg`, onClick: () => onPopup({ kind: "assign", legId: nl.id }) };
    else if (nl.state === "planned") primary = { label: nl.assigneeKind === "carrier" ? "Send to carrier" : "Send to driver", onClick: () => run("Sent", () => A.dispatchAction(nl.id)) };
    else if (forwardLabel(nl, r.stops)) {
      const label = forwardLabel(nl, r.stops)!;
      // steps that stamp a clock at a stop (arrived, loaded, delivered) ask for the time first: a stray click shouldn't deliver a load
      primary = STAMPS.includes(nl.state) ? { label, onClick: () => setConfirming({ legId: nl.id, label, when: toZoneInput(new Date(), zoneOfLeg(nl)) }) } : { label, onClick: () => run(label, () => A.advanceAction(nl.id, "next")) };
    }
  }
  const stopById = new Map(r.stops.map((s) => [s.id, s]));
  const dest = [...r.stops].reverse().find((s) => s.type === "delivery") ?? r.stops[r.stops.length - 1];
  const rolling = !!nl && ["accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"].includes(nl.state);
  const stopAt = (iso: string | null, st: Stop) => (iso ? fmtIn(iso, stopZone(st, data.zone), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);

  return (
    <aside className="fixed right-0 top-0 z-30 w-full sm:w-[420px] h-screen overflow-y-auto border-l border-line bg-white shadow-[0_0_40px_rgba(15,23,42,0.18)]" aria-label={`Load ${r.order.orderNumber}`}>
      <div className="px-5 pt-5 pb-4 border-b border-line">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="h2 mono">{r.order.orderNumber}</span>
              {hold && <Pill tone="amber">On hold</Pill>}
              {closed && <Pill tone="slate">Cancelled</Pill>}
            </div>
            <div className="text-muted text-callout">{r.order.kind === "trip" ? `Tailgate trip · ${r.shipments} shipment${r.shipments === 1 ? "" : "s"}` : `${r.customerName ?? "No customer"} · ${money(r.order.rateCents, r.order.currency)}`}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        {customerNote && (
          <div className="mx-4 mb-3 rounded-lg border border-teal/30 bg-teal-soft/40 px-3 py-2 text-callout whitespace-pre-wrap" data-testid="customer-note">
            <b>{r.customerName}:</b> {customerNote}
          </div>
        )}
        {hold && r.order.holdReason && <div className="mt-2 text-callout px-2.5 py-1.5 rounded-md bg-amber-soft text-amber font-semibold">Hold: {r.order.holdReason}</div>}
        {r.openFlags.map((f) => (
          <div key={f.id} className={`mt-2 text-callout px-2.5 py-1.5 rounded-md font-semibold flex items-start gap-2 ${f.level === "red" ? "bg-red-soft text-red" : "bg-amber-soft text-amber"}`} data-testid="flag">
            <span className="flex-1 min-w-0">
              {f.title}
              {f.detail ? <span className="font-normal"> — {f.detail}</span> : null}
            </span>
            {canDispatch && (
              <button className="btn btn-ghost btn-sm shrink-0 -my-1" title={f.code === "breakdown" ? "The truck runs again: put it back in the planner" : "Dealt with: take it off the board"} onClick={() => run(f.code === "breakdown" ? "Breakdown cleared — the truck is back in the planner" : "Flag cleared", () => A.clearFlagAction(f.id))}>
                {f.code === "breakdown" ? "Fixed" : "Clear"}
              </button>
            )}
          </div>
        ))}
        {r.podMissing && (
          <div className="mt-2 text-callout px-2.5 py-1.5 rounded-md bg-amber-soft text-amber font-semibold" data-testid="pod-missing">
            No POD yet — billing can&apos;t invoice this load until the POD is on file.
            <div className="flex gap-2 mt-1.5">
              <Link href={`/orders/${r.order.id}?tab=documents`} className="btn btn-sm">
                Upload POD
              </Link>
              {canDispatch && (
                <button className="btn btn-sm btn-ghost" onClick={() => setWaiving(true)}>
                  Bill without POD…
                </button>
              )}
            </div>
          </div>
        )}
        {primary && !confirming && (
          <button className="btn btn-primary btn-lg w-full justify-center mt-4" onClick={primary.onClick} disabled={busy}>
            {busy ? <Spinner /> : primary.label}
          </button>
        )}
        {confirming && nl && confirming.legId === nl.id && (
          <div className="mt-4 rounded-lg border border-teal/40 bg-teal-soft/30 p-3 space-y-2" data-testid="stamp-confirm">
            <label className="flex items-center gap-2 text-callout font-semibold">
              {confirming.label} at
              <input id="stamp-when" type="datetime-local" className="input h-9 flex-1" value={confirming.when} onChange={(e) => setConfirming({ ...confirming, when: e.target.value })} />
              <span className="text-muted font-normal text-footnote">{zoneAbbrev(zoneOfLeg(nl))}</span>
            </label>
            <div className="flex gap-2">
              <button
                className="btn btn-primary btn-lg flex-1 justify-center"
                disabled={busy}
                onClick={() => {
                  const at = fromZoneInput(confirming.when, zoneOfLeg(nl));
                  const label = confirming.label;
                  setConfirming(null);
                  run(label, () => A.advanceAction(nl.id, "next", { at: at?.toISOString() }));
                }}
              >
                Confirm {confirming.label.toLowerCase()}
              </button>
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {!closed && canDispatch && (
          <div className="grid grid-cols-5 gap-1 mt-2">
            <QuickBtn label="Track" hint="Tracking link, driver app link, last position" onClick={() => onPopup({ kind: "track" })} />
            <QuickBtn label="Split" onClick={() => nl && onPopup({ kind: "split", legId: nl.id })} disabled={!nl || ["at_delivery", "completed"].includes(nl.state)} />
            <QuickBtn label="Change" hint="Re-assign this leg" onClick={() => nl && onPopup({ kind: "assign", legId: nl.id })} disabled={!nl || !["planned", "dispatched", "accepted"].includes(nl.state)} />
            <QuickBtn label="Unit OOS" onClick={() => nl && onPopup({ kind: "oos", legId: nl.id })} disabled={!nl?.truckId} />
            <QuickBtn label={hold ? "Release" : "Hold"} hint={hold ? "Let the load move again" : "Freeze the load: nothing is sent and the driver's steps stop until it's released"} onClick={() => (hold ? run("Released", () => A.releaseAction(r.order.id)) : onPopup({ kind: "hold" }))} disabled={!hold && !["booked", "dispatched", "in_transit"].includes(r.order.state)} />
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
                    <div className="font-bold text-callout">
                      {l.seq}. {LEG_TYPE_LABEL[l.type]} <span className="text-muted font-normal">{from?.name} → {to?.name}</span>
                    </div>
                    <Pill tone={legTone(l.state)}>{LEG_LABEL[l.state]}</Pill>
                  </div>
                  <div className="text-callout text-muted mt-1">
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
                    {data.etas?.[l.id] && (
                      <div className={data.etas[l.id].late ? "text-red font-semibold" : "text-teal font-semibold"} data-testid="eta" title={data.etas[l.id].source === "check_call" ? "From the last check call — a newer GPS position replaces it" : `${data.etas[l.id].miles} mi from the last position at ${new Date(data.etas[l.id].positionAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}>
                        ETA {new Date(data.etas[l.id].at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })} at {data.etas[l.id].stopName}
                        {data.etas[l.id].source === "check_call" ? " (check call)" : ""}
                        {data.etas[l.id].late ? " — past the window" : ""}
                      </div>
                    )}
                    {(() => {
                      const tn = r.tenders.find((t) => t.legId === l.id && (t.state === "sent" || (l.state === "accepted" && t.state === "accepted")));
                      if (!tn) return null;
                      const mins = Math.round((new Date(tn.expiresAt).getTime() - Date.now()) / 60000);
                      return tn.state === "sent" ? (
                        <div className="mt-1 text-footnote">
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
                        <div className="mt-1 text-footnote text-green">
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
                          <button className="btn btn-sm" onClick={() => (l.assigneeKind === "carrier" && l.state === "accepted" ? setPullBack(l) : run("Back to Pending", () => A.unplanAction(l.id)))}>
                            Pull back
                          </button>
                        </>
                      )}
                      {forwardLabel(l, r.stops) && l.state !== "dispatched" && (
                        <button className="btn btn-sm" onClick={() => (STAMPS.includes(l.state) && l.id === nl?.id ? setConfirming({ legId: l.id, label: forwardLabel(l, r.stops)!, when: toZoneInput(new Date(), zoneOfLeg(l)) }) : run("Updated", () => A.advanceAction(l.id, "next")))}>
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
        {r.order.state !== "draft" && !closed && canDispatch && (
          <details className="accordion" open={rolling}>
            <summary>
              Check calls {data.lastCalls[r.order.id] && <span className="text-faint font-normal">· last {new Date(data.lastCalls[r.order.id].at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>}
            </summary>
            <div className="pb-3">
              {(() => {
                // the ETA a dispatcher types is for the stop the truck is heading to; it drives Late and At risk until a newer GPS position
                const ns = nextStop(r) ?? dest;
                return <CheckCallBox orderId={r.order.id} legId={nl?.id ?? null} zone={ns ? stopZone(ns, data.zone) : data.zone} etaStop={ns?.name ?? null} reefer={r.order.equipment.includes("reefer")} onDone={onToast} />;
              })()}
            </div>
          </details>
        )}
        <details className="accordion" open>
          <summary>
            Stops <span className="text-faint font-normal">{r.stops.length}</span>
          </summary>
          <ol className="pb-3 space-y-2">
            {r.stops.map((s) => (
              <li key={s.id} className="flex gap-3 text-callout">
                <span className={`timeline-dot mt-1.5 ${s.departedAt ? "done" : s.arrivedAt ? "now" : ""}`} />
                <div className="min-w-0">
                  <div className="font-semibold truncate">
                    {place(s)} <span className="text-faint font-normal">· {s.country}</span>
                  </div>
                  <div className="text-muted text-footnote">
                    {s.type.replace("_", " ")}
                    {s.windowStart ? ` · ${stopAt(s.windowStart, s)}${s.windowEnd ? `–${stopAt(s.windowEnd, s)}` : ""}` : ""}
                    {s.arrivedAt ? ` · in ${stopAt(s.arrivedAt, s)}` : ""}
                    {s.departedAt ? ` · out ${stopAt(s.departedAt, s)}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </details>
        <Confirm
          open={!!pullBack}
          onClose={() => setPullBack(null)}
          title={`Take this leg back from ${pullBack?.carrierName ?? "the carrier"}?`}
          body={`They already accepted it. They'll get a cancellation by email or WhatsApp, and the leg goes back to Needs truck.`}
          needReason="Why (the carrier sees it)"
          confirmLabel="Pull back & tell them"
          danger
          onConfirm={(reason) => {
            const l = pullBack;
            setPullBack(null);
            if (l) run("Pulled back — cancellation sent to the carrier", () => A.pullBackAction(l.id, { reason, confirmCarrier: true }));
          }}
        />
        <Confirm
          open={waiving}
          onClose={() => setWaiving(false)}
          title="Bill without a POD?"
          body="Billing can invoice it without the proof of delivery. Use it when the POD will not come (a drop at a yard, an electronic signature). The reason goes on the record."
          needReason="Why there is no POD"
          confirmLabel="Bill without POD"
          onConfirm={(reason) => {
            setWaiving(false);
            run("Sent to billing without a POD", () => A.waivePodAction(r.order.id, reason));
          }}
        />
        <details className="accordion">
          <summary>Details</summary>
          <div className="pb-3">
            <KV k="Rate" v={r.order.rateTbd ? "TBD" : money(r.order.rateCents, r.order.currency)} />
            <KV k="Equipment" v={EQUIPMENT_LABEL[r.order.equipment] ?? r.order.equipment.replace(/_/g, " ")} />
            <KV k="Legs" v={`${r.legs.length} · cut from ${r.stops.length} stops`} />
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
    <button className="btn btn-sm justify-center px-1 text-footnote" onClick={onClick} disabled={disabled} title={hint}>
      {label}
    </button>
  );
}

/* ---------- popups ---------- */

function AssignModal({ leg, order, data, onClose, onDone }: { leg: Leg; order: Order; data: BoardData; onClose: () => void; onDone: (msg: string) => void }) {
  const [tab, setTab] = useState<"truck" | "carrier">(leg.type === "mx" ? "carrier" : "truck");
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState<{ truckId: string; driverId: string | null; coDriverId: string | null } | null>(null);
  const [trailerId, setTrailerId] = useState(leg.trailerId ?? "");
  const [openedAt] = useState(() => Date.now());
  const [carrierId, setCarrierId] = useState(leg.carrierId ?? "");
  const [celig, setCelig] = useState<{ ok: boolean; hardBlocked: boolean; findings: { level: string; message: string }[] } | null>(null);
  const [cscore, setCscore] = useState<{ score: { days: number; loads: number; answered: number; acceptancePct: number | null; onTimePct: number | null; trackedPct: number | null; billed: number; billedOver: number; overCents: number }; dispatchable: boolean; problems: string[] } | null>(null);
  const [carrierRate, setCarrierRate] = useState(leg.carrierRateCents != null ? (leg.carrierRateCents / 100).toFixed(2) : "");
  const [lane, setLane] = useState<{ lane: string; rateCents: number; fuelRule: string; fuelValue: number | null; validTo: string | null } | null>(null);
  const [miles, setMiles] = useState(leg.plannedMiles != null ? String(leg.plannedMiles) : "");
  const [override, setOverride] = useState("");
  const [needsOverride, setNeedsOverride] = useState<{ message: string; hard: boolean; safety?: boolean } | null>(null);
  // paperwork blocks are Safety's to override; schedule calls (double booking, time off) are dispatch's
  const canSafetyOverride = ["owner", "compliance"].includes(data.role);
  const eligibilityFail = (r: { error: string; hardBlocked?: boolean; findings?: { level: string; code: string }[] }) => {
    const safety = (r.findings ?? []).some((f) => f.level === "red" && !(f.code === "schedule_conflict" || f.code.startsWith("event_") || f.code === "no_driver"));
    setNeedsOverride({ message: r.error, hard: !!r.hardBlocked || (safety && !canSafetyOverride), safety });
  };
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
          else if (r.code === "eligibility") eligibilityFail(r);
          else setErr(r.error);
          return;
        }
      }
      const a = tab === "truck" ? (pick ? { kind: "truck" as const, ...pick, trailerId: trailerId || null } : null) : { kind: "carrier" as const, carrierId, carrierRateCents: rateCents };
      if (!a) return setErr("Pick a unit");
      const r = sendNow && (leg.state === "unassigned" || leg.state === "declined" || leg.state === "planned") ? await A.planAndDispatchAction(leg.id, a, opts) : await A.planAction(leg.id, a, opts);
      if (r.ok) onDone(sendNow ? (tab === "carrier" ? "Marked sent — confirm by phone, then press Accepted" : "Assigned and sent") : "Assigned — in Planned");
      else if (r.code === "eligibility") eligibilityFail(r);
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
          <label className="mr-auto flex items-center gap-2 text-callout cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} /> Send right away
          </label>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={pending || (needsOverride?.hard ?? false)}>
            {pending ? "Working…" : needsOverride && !needsOverride.hard ? (needsOverride.safety ? "Override & assign" : "Assign anyway") : sendNow ? (tab === "carrier" && tender.channel !== "phone" ? "Send tender" : "Assign & send") : "Assign"}
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
            {cands[0]?.pickupPassed && (
              <div className="mx-1 mb-2 rounded-md bg-red-soft text-red text-callout font-semibold px-3 py-2" role="alert">
                {cands[0].reach?.message ?? "The pickup time has passed"}
              </div>
            )}
            {cands.map((c) => {
              const active = pick?.truckId === c.truckId;
              return (
                <div key={c.truckId} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer ${active ? "bg-teal-soft" : "hover:bg-ground"} ${c.hardBlocked ? "opacity-60" : ""}`} onClick={() => !c.hardBlocked && setPick({ truckId: c.truckId, driverId: c.driverId, coDriverId: null })}>
                  <span className={`w-2.5 h-2.5 rounded-full flex-none ${c.hardBlocked ? "bg-red" : c.ok && c.reach?.status !== "late" ? (c.busy.length ? "bg-amber" : "bg-green") : "bg-amber"}`} />
                  <div className="w-16 font-extrabold mono">{c.unitNumber}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-callout truncate">
                      {c.driverName ?? <span className="text-faint">no driver</span>}
                      <span className="text-muted text-footnote">
                        {c.freeAt && new Date(c.freeAt).getTime() > openedAt + 15 * 60_000 ? ` · free ${new Date(c.freeAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : " · free now"}
                        {c.freeWhere ? ` at ${c.freeWhere}` : ""}
                        {c.deadheadMi != null ? ` · ${c.deadheadMi} mi empty` : ""}
                      </span>
                    </div>
                    <div className={`text-footnote truncate ${c.hardBlocked || (c.safetySignoff && !canSafetyOverride) ? "text-red" : c.ok && c.reach?.status !== "late" ? "text-muted" : "text-amber font-semibold"}`} title={c.findings.map((f) => f.message).join("\n")} data-testid="cand-reason">
                      {c.safetySignoff && !canSafetyOverride && !c.hardBlocked ? `needs Safety: ${c.reason.replace(/^needs override: /, "")}` : c.reason}
                    </div>
                  </div>
                  {c.hardBlocked && <Pill tone="red">Blocked</Pill>}
                  {!c.hardBlocked && !c.ok && <Pill tone="amber">Override</Pill>}
                  {!c.hardBlocked && c.ok && c.reach?.status === "late" && <Pill tone="amber">Can&apos;t make it</Pill>}
                </div>
              );
            })}
            <div className="flex items-center gap-2 px-3 pt-3 mt-1 border-t border-line">
              <label className="label m-0" htmlFor="plan-trailer">
                Trailer
              </label>
              <select id="plan-trailer" className="select w-40" value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
                <option value="">— none / customer&apos;s —</option>
                {data.trailers.map((tr) => (
                  <option key={tr.id} value={tr.id} disabled={tr.status === "oos"}>
                    {tr.unitNumber}
                    {tr.status === "oos" ? " (out of service)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 px-3 pt-3">
              <label className="label m-0" htmlFor="plan-miles">
                Planned miles
              </label>
              <input id="plan-miles" className="input w-28" inputMode="numeric" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder={leg.estMiles != null ? `${leg.estMiles} est.` : "for pay & fuel"} />
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
                setCscore(null);
                setCelig(null);
                if (!id) return;
                // say up front whether this carrier can run this leg (cabotage, authority, insurance), not only on send
                A.carrierEligibilityAction(leg.id, id).then((r) => r.ok && setCelig(r.data as never));
                A.carrierPickAction(id).then((r) => r.ok && setCscore(r.data));
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
            {celig && celig.findings.some((f) => f.level === "red") && (
              <div className={`mt-1.5 text-callout rounded-lg px-3 py-2 font-semibold ${celig.hardBlocked ? "bg-red-soft text-red" : "bg-amber-soft text-amber"}`} data-testid="carrier-elig">
                {celig.hardBlocked ? "Can't run this leg: " : "Needs Safety's sign-off: "}
                {celig.findings.filter((f) => f.level === "red").map((f) => f.message).join("; ")}
              </div>
            )}
            {cscore && (
              <div className={`mt-1.5 text-callout rounded-lg border px-3 py-2 ${cscore.dispatchable ? "border-line bg-ground" : "border-red/40 bg-red-soft/40"}`} data-testid="carrier-pick">
                <span className="font-semibold">Last {cscore.score.days} days:</span> {cscore.score.loads} load{cscore.score.loads === 1 ? "" : "s"}
                {cscore.score.acceptancePct != null ? ` · ${cscore.score.acceptancePct}% of ${cscore.score.answered} offers accepted` : " · no offers answered yet"}
                {cscore.score.onTimePct != null ? ` · ${cscore.score.onTimePct}% on time` : ""}
                {cscore.score.trackedPct != null ? ` · ${cscore.score.trackedPct}% tracked` : ""}
                {cscore.score.billed ? ` · ${cscore.score.billedOver ? `${cscore.score.billedOver} of ${cscore.score.billed} bills over the rate ($${(cscore.score.overCents / 100).toLocaleString("en-US")})` : `${cscore.score.billed} bills at the rate`}` : ""}
                {!cscore.dispatchable && <div className="text-red font-semibold mt-0.5">Blocked by compliance: {cscore.problems.join(", ") || "see their record"}</div>}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">Carrier rate (USD)</label>
              <input className="input" inputMode="decimal" value={carrierRate} onChange={(e) => setCarrierRate(e.target.value)} placeholder="what you pay them" />
              {rateCents != null && order.rateCents != null && !order.rateTbd && (
                <div className={`help font-semibold ${order.rateCents - rateCents < order.rateCents * 0.1 ? "text-red" : order.rateCents - rateCents < order.rateCents * 0.15 ? "text-amber" : "text-green"}`} data-testid="tender-margin">
                  Margin {money(order.rateCents - rateCents, order.currency)} · {Math.round(((order.rateCents - rateCents) / order.rateCents) * 1000) / 10}% of the load
                </div>
              )}
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
        <div className={`mt-3 px-3 py-2 rounded-lg text-callout ${needsOverride.hard ? "bg-red-soft text-red" : "bg-amber-soft text-amber"}`}>
          <div className="font-bold">{needsOverride.hard ? (needsOverride.safety && !canSafetyOverride ? "Blocked — needs Safety's sign-off (Safety or the owner can override it)." : "Blocked — no override exists for this.") : needsOverride.safety ? "Needs a safety override" : "Schedule conflict — confirm with a reason"}</div>
          <div>{needsOverride.message}</div>
          {!needsOverride.hard && <input className="input mt-2" placeholder={needsOverride.safety ? "Reason for the override (goes on the driver's and the load's record)" : "Why it still works (e.g. finishes early, relay)"} value={override} onChange={(e) => setOverride(e.target.value)} />}
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

const SPLIT_KINDS: [string, string][] = [
  ["border_yard", "Border yard (hand-off)"],
  ["yard", "Yard (hand-off)"],
  ["transload", "Transload"],
  ["terminal", "Terminal"],
];

function SplitModal({ leg, stops, locations, onClose, onDone }: { leg: Leg; stops: Stop[]; locations: BoardData["locations"]; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [country, setCountry] = useState(stops.find((s) => s.id === leg.toStopId)?.country ?? "US");
  const [type, setType] = useState<string>(leg.type === "crossing" && stops.find((s) => s.id === leg.fromStopId)?.country === "MX" ? "border_yard" : "yard");
  // saved yards first: the places loads are handed off at
  const saved = [...locations].sort((p, q) => Number(["border_yard", "yard", "transload", "terminal"].includes(q.kind)) - Number(["border_yard", "yard", "transload", "terminal"].includes(p.kind)) || p.name.localeCompare(q.name));
  const pickName = (v: string) => {
    setName(v);
    const l = locations.find((x) => x.name === v) ?? locations.find((x) => fold(x.name) === fold(v.trim()));
    setLocationId(l?.id ?? null);
    if (l) {
      setCountry(l.country);
      if (["border_yard", "yard", "transload", "terminal"].includes(l.kind)) setType(l.kind);
    }
  };
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
                const r = await A.splitAction(leg.id, { type: type as never, name: name.trim(), country, locationId });
                if (r.ok) onDone("Split. The second half is in Pending; both halves are named by the countries they run in.");
                else setErr(r.error);
              })
            }
          >
            Split
          </button>
        </>
      }
    >
      <div className="text-callout text-muted mb-3">
        {from?.name} → <b className="text-ink">new stop</b> → {to?.name}. The first half keeps {leg.truckUnit ? `unit ${leg.truckUnit}` : leg.carrierName ?? "its assignment"}; the second half needs a truck.
      </div>
      <div className="grid grid-cols-[1fr_170px_88px] gap-2">
        <div>
          <label className="label" htmlFor="split-where">
            Where {locationId && <span className="text-teal font-semibold">· saved location</span>}
          </label>
          <input id="split-where" className="input" list="split-locations" value={name} onChange={(e) => pickName(e.target.value)} placeholder="Yard or terminal name" autoFocus />
          <datalist id="split-locations">
            {saved.map((l) => (
              <option key={l.id} value={l.name}>
                {[l.city, l.country].filter(Boolean).join(", ")}
                {fold(l.name) !== l.name.toLowerCase() ? ` · ${fold(l.name)}` : ""}
              </option>
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="split-kind">
            Kind
          </label>
          <select id="split-kind" className="select" value={type} onChange={(e) => setType(e.target.value)}>
            {SPLIT_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Country</label>
          <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option>US</option>
            <option>MX</option>
            <option>CA</option>
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
  const [carrierLinks, setCarrierLinks] = useState<{ legId: string; legLabel: string; url: string; driverName: string | null; driverPhone: string | null }[]>([]);
  const [carrierTo, setCarrierTo] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [custTo, setCustTo] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (input: { kind: "driver" | "tracking" | "carrier_driver"; orderId: string; driverId?: string; legId?: string; to?: string }) => {
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
    const carrierLegs = r.legs.filter((l) => l.assigneeKind === "carrier" && l.carrierId && !["completed", "cancelled", "unassigned"].includes(l.state));
    Promise.all(carrierLegs.map((l) => A.carrierDriverLinkAction(l.id).then((x) => (x.ok ? { legId: l.id, legLabel: `${LEG_TYPE_LABEL[l.type]} leg`, ...x.data } : null)))).then((rs) => setCarrierLinks(rs.filter((x): x is NonNullable<typeof x> => !!x)));
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
          <div className="text-callout text-muted mb-1.5">Stops, progress, last position. No rates, no phones. Same link for the life of the order.</div>
          {link ? (
            <>
              <div className="flex gap-2">
                <input className="input mono text-callout" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
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
          <div className="text-callout text-muted mb-1.5">Send the driver their link once; it stays theirs. One button per step, GPS with every press.</div>
          {driverLinks.length === 0 ? (
            <div className="text-callout text-muted">No driver on this order yet.</div>
          ) : (
            driverLinks.map((d) => (
              <div key={d.url} className="flex items-center gap-2 mb-1.5">
                <span className="w-36 font-semibold truncate text-callout">{d.name}</span>
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
        {carrierLinks.length > 0 && (
          <div data-testid="carrier-driver-links">
            <div className="label">Partner carrier&apos;s driver</div>
            <div className="text-callout text-muted mb-1.5">No ELD to read, so their phone is the tracking: one link per leg with one button per step and GPS while it is open. The carrier can send it from their portal too.</div>
            {carrierLinks.map((c) => (
              <div key={c.legId} className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="w-36 font-semibold truncate text-callout">
                  {c.driverName ?? <span className="text-amber">driver not named</span>} <span className="text-faint font-normal">· {c.legLabel}</span>
                </span>
                <button className="btn btn-sm" onClick={() => copy(c.url, c.url)}>
                  {copied === c.url ? "Copied" : "Copy link"}
                </button>
                <input className="input w-40" placeholder={c.driverPhone ?? "driver's WhatsApp"} value={carrierTo[c.legId] ?? ""} onChange={(e) => setCarrierTo({ ...carrierTo, [c.legId]: e.target.value })} aria-label="Carrier driver WhatsApp" />
                <button className="btn btn-sm" disabled={sending || !(carrierTo[c.legId]?.trim() || c.driverPhone)} title="Through the company WhatsApp Business number" onClick={() => send({ kind: "carrier_driver", orderId: r.order.id, legId: c.legId, to: carrierTo[c.legId] })}>
                  Send on WhatsApp
                </button>
                {wa(carrierTo[c.legId] || c.driverPhone, `${c.driverName ?? "Hi"}, load ${r.order.orderNumber} — one button per step, keep it open while driving: ${c.url}`) && (
                  <a className="btn btn-sm btn-ghost" href={wa(carrierTo[c.legId] || c.driverPhone, `${c.driverName ?? "Hi"}, load ${r.order.orderNumber} — one button per step, keep it open while driving: ${c.url}`)!} target="_blank" rel="noreferrer">
                    wa.me
                  </a>
                )}
                <a className="btn btn-sm btn-ghost" href={c.url} target="_blank" rel="noreferrer">
                  Preview
                </a>
              </div>
            ))}
          </div>
        )}
        {sent && <div className={`text-callout font-semibold ${sent.startsWith("✗") ? "text-red" : "text-teal"}`}>{sent}</div>}
      </div>
    </Modal>
  );
}
