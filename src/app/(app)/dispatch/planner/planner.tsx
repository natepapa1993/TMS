"use client";

import { fold } from "@/lib/fold";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { roadMiles } from "@/lib/geo";
import type { PlannerDriver, PlannerLeg, PlannerTruck } from "@/domain/planner";
import { planAction, planAndDispatchAction } from "../actions";
import { rankAction, addEventAction, deleteEventAction, dispatchManyAction } from "./actions";

type Candidate = { truckId: string; unitNumber: string; driverId: string | null; driverName: string | null; ok: boolean; hardBlocked: boolean; reason: string; score: number; reach?: { status: "ok" | "late" | "past" | "unknown"; arriveAt: string | null; message: string | null } | null; pickupPassed?: boolean };
/** How a ranked truck fits the picked load, in one line and one colour. */
const fit = (c: Candidate): { text: string; tone: "red" | "amber" | "green" } =>
  c.hardBlocked ? { text: `Blocked: ${c.reason}`, tone: "red" }
  : !c.ok ? { text: `Override: ${c.reason.replace(/^needs override:\s*/i, "")}`, tone: "amber" }
  : c.pickupPassed ? { text: "Pickup time passed — move the appointment first", tone: "amber" }
  : c.reach?.status === "late" ? { text: c.reach.message ?? c.reason, tone: "amber" }
  : c.reason.startsWith("free") ? { text: c.reach?.message ?? "Ready for this load", tone: "green" }
  : { text: c.reason, tone: "green" };
const FIT_CLASS = { red: "text-red", amber: "text-amber", green: "text-green" } as const;
const passed = (l: PlannerLeg) => {
  const by = l.from.until ?? l.from.at;
  return !!by && new Date(by).getTime() < Date.now();
};

const LEG_LABEL: Record<string, string> = { mx: "MX", ca: "CA", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment" };
const STATUS: Record<PlannerDriver["status"], [string, "green" | "blue" | "teal" | "slate"]> = { available: ["Available", "green"], planned: ["Planned", "blue"], on_load: ["On a load", "teal"], off: ["Off", "slate"] };
const TRUCK_STATUS: Record<PlannerTruck["status"], [string, "green" | "blue" | "amber" | "red"]> = { available: ["Available", "green"], waiting_crossing: ["Waiting on crossing", "amber"], on_load: ["On a load", "blue"], unavailable: ["Unavailable", "red"] };
const TRUCK_ORDER: PlannerTruck["status"][] = ["available", "waiting_crossing", "on_load", "unavailable"];
const TYPE_LABEL: Record<string, string> = { CDL: "CDL", B1: "B-1", DUAL: "CDL + B-1" };
/** Who gets put on a leg: a truck with its driver, and the co-driver when it runs team. */
type Assignee = { truckId: string | null; driverId: string | null; coDriverId: string | null; unit: string | null; name: string };
const ofDriver = (d: PlannerDriver): Assignee => ({ truckId: d.truckId, driverId: d.driverId, coDriverId: null, unit: d.unit, name: d.name });
const ofTruck = (t: PlannerTruck): Assignee => ({ truckId: t.truckId, driverId: t.crew[0]?.driverId ?? null, coDriverId: t.team ? (t.crew[1]?.driverId ?? null) : null, unit: t.unit, name: t.crew.map((c) => c.name).join(" & ") || "no driver" });

const EVENT_KINDS: [string, string][] = [
  ["vacation", "Vacation"],
  ["home_time", "Home time"],
  ["restart", "34-h restart"],
  ["sick", "Sick / emergency"],
  ["repair", "In the shop"],
  ["work_order", "Work order"],
  ["other", "Unavailable"],
];

const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const shortWhen = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const city = (p: { city: string | null; state: string | null; name: string; country: string }) => [[p.city, p.state].filter(Boolean).join(", ") || p.name, p.country !== "US" ? p.country : ""].filter(Boolean).join(" · ");
const money = (c: number | null, cur: string) => (c == null ? "TBD" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(c / 100));
const hrs = (m: number | null) => (m == null ? "—" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);
/** "Today 3:00 PM", "Tomorrow 9:00 AM", "Wed, Sep 30 9:00 AM" — what a dispatcher says out loud */
const friendly = (s: string | null) => {
  if (!s) return "—";
  const d = new Date(s);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400_000);
  return days === 0 ? `Today ${t}` : days === 1 ? `Tomorrow ${t}` : days === -1 ? `Yesterday ${t}` : `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${t}`;
};
const isToday = (s: string | null, add = 0) => !!s && new Date(s).toDateString() === new Date(Date.now() + add * 86400_000).toDateString();

export function Planner({ data, canPlan }: { data: { legs: PlannerLeg[]; drivers: PlannerDriver[]; trucks: PlannerTruck[] }; canPlan: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [legQ, setLegQ] = useState("");
  const [legF, setLegF] = useState("all");
  const [drvQ, setDrvQ] = useState("");
  const [drvF, setDrvF] = useState("all");
  const [view, setView] = useState<"trucks" | "drivers">("trucks");
  const [trkF, setTrkF] = useState<"all" | PlannerTruck["status"]>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [ranked, setRanked] = useState<Record<string, Candidate[]>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState<null | { leg: PlannerLeg; who: Assignee; send: boolean; message: string }>(null);
  const [overrideWhy, setOverrideWhy] = useState("");
  const [eventFor, setEventFor] = useState<EventSubject | null>(null);

  const leg = data.legs.find((l) => l.legId === sel) ?? null;
  const legs = useMemo(() => {
    const q = fold(legQ.trim());
    return data.legs.filter((l) => (legF === "unassigned" ? l.state !== "planned" : legF === "planned" ? l.state === "planned" : legF === "today" ? isToday(l.from.at) : legF === "tomorrow" ? isToday(l.from.at, 1) : true) && (!q || [l.orderNumber, l.customer, l.from.name, l.from.city, l.to.name, l.to.city].some((x) => fold(x).includes(q))));
  }, [data.legs, legQ, legF]);

  const cands = sel ? ranked[sel] : undefined;
  const drivers = useMemo(() => {
    const q = fold(drvQ.trim());
    const rows = data.drivers
      .filter((d) => (drvF === "all" ? true : d.status === drvF) && (!q || [d.name, d.unit, d.availableIn, d.dispatcher].some((x) => fold(x).includes(q))))
      .map((d) => {
        const c = cands?.find((x) => x.truckId === d.truckId);
        const dh = leg && d.availableLat != null && d.availableLng != null && leg.from.lat != null && leg.from.lng != null ? Math.round(roadMiles({ lat: d.availableLat, lng: d.availableLng }, { lat: leg.from.lat, lng: leg.from.lng })) : null;
        return { d, c, dh };
      });
    if (leg && cands) return rows.sort((p, q) => (p.c?.score ?? 9999) - (q.c?.score ?? 9999) || (p.dh ?? 99999) - (q.dh ?? 99999));
    return rows.sort((p, q) => (p.d.availableAt ?? "").localeCompare(q.d.availableAt ?? "") || p.d.name.localeCompare(q.d.name));
  }, [data.drivers, drvQ, drvF, cands, leg]);

  const trucks = useMemo(() => {
    const q = fold(drvQ.trim());
    const rows = data.trucks
      .filter((t) => (trkF === "all" || t.status === trkF) && (!q || [t.unit, t.availableIn, t.dispatcher, ...t.crew.map((c) => c.name)].some((x) => fold(x).includes(q))))
      .map((t) => {
        const c = cands?.find((x) => x.truckId === t.truckId);
        const dh = leg && t.availableLat != null && t.availableLng != null && leg.from.lat != null && leg.from.lng != null ? Math.round(roadMiles({ lat: t.availableLat, lng: t.availableLng }, { lat: leg.from.lat, lng: leg.from.lng })) : null;
        return { t, c, dh };
      });
    if (leg && cands) return rows.sort((p, q) => (p.c?.score ?? 9999) - (q.c?.score ?? 9999) || (p.dh ?? 99999) - (q.dh ?? 99999));
    return rows.sort((p, q) => TRUCK_ORDER.indexOf(p.t.status) - TRUCK_ORDER.indexOf(q.t.status) || (p.t.availableAt ?? "").localeCompare(q.t.availableAt ?? "") || p.t.unit.localeCompare(q.t.unit, "en-US", { numeric: true }));
  }, [data.trucks, drvQ, trkF, cands, leg]);

  const pick = (l: PlannerLeg) => {
    setSel(l.legId);
    if (!ranked[l.legId])
      start(async () => {
        const r = await rankAction(l.legId);
        if (r.ok) setRanked((m) => ({ ...m, [l.legId]: r.data as Candidate[] }));
        else t.err(r.error);
      });
  };

  const assign = (l: PlannerLeg, d: Assignee, send: boolean, why?: string) =>
    start(async () => {
      if (!d.truckId) return t.err(`${d.name} has no truck; set one on Fleet`);
      const a = { kind: "truck" as const, truckId: d.truckId, driverId: d.driverId, coDriverId: d.coDriverId };
      const opts = why ? { override: true, reason: why } : {};
      const r = send ? await planAndDispatchAction(l.legId, a, opts) : await planAction(l.legId, a, opts);
      if (r.ok) {
        t.ok(`${l.orderNumber} → ${d.unit} · ${d.name}${send ? " — sent" : " — planned"}`);
        setOverride(null);
        setOverrideWhy("");
        setSel(null);
        setRanked({});
        router.refresh();
      } else if (r.code === "eligibility" && !r.hardBlocked && !why) {
        setOverride({ leg: l, who: d, send, message: r.error });
      } else t.err(r.error);
    });

  const plannedPicked = data.legs.filter((l) => picked.has(l.legId) && l.state === "planned");

  return (
    <div className="px-5 md:px-8 pt-6 pb-8">
      <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="eyebrow mb-1">Dispatch</div>
          <h1 className="text-title2 font-extrabold tracking-tight">Planner</h1>
          <div className="text-muted text-callout mt-0.5">Pick a load on the left; the trucks on the right rank for it — who can run it, and how far they are from the pickup.</div>
        </div>
        <div className="segmented" role="group" aria-label="View">
          <Link href="/dispatch">
            Board
          </Link>
          <span aria-current="page">Planner</span>
        </div>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)] gap-5 items-start">
        {/* loads */}
        <section className="card overflow-hidden" aria-label="Loads to cover">
          <div className="px-4 pt-4 pb-3 border-b border-line">
            <div className="flex items-center justify-between gap-3">
              <div className="text-headline font-extrabold">
                Loads to cover <span className="text-muted font-semibold">{data.legs.length}</span>
              </div>
              <input className="input h-8 w-52 text-callout" placeholder="Search load, customer, city" value={legQ} onChange={(e) => setLegQ(e.target.value)} aria-label="Search loads" />
            </div>
            <div className="flex gap-1 mt-3 flex-wrap">
              {[
                ["all", "All"],
                ["unassigned", "Unassigned"],
                ["planned", "Planned, not sent"],
                ["today", "Pickup today"],
                ["tomorrow", "Tomorrow"],
              ].map(([k, l]) => (
                <button key={k} type="button" className="quick-chip" data-active={legF === k} onClick={() => setLegF(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {plannedPicked.length > 0 && canPlan && (
            <div className="flex items-center gap-3 px-4 py-2 bg-navy text-white text-callout" data-testid="planner-bulk">
              <span className="font-semibold">{plannedPicked.length} planned selected</span>
              <button
                type="button"
                className="font-semibold hover:underline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await dispatchManyAction(plannedPicked.map((l) => l.legId));
                    if (!r.ok) return t.err(r.error);
                    setPicked(new Set());
                    router.refresh();
                    if (r.data.failed.length) t.err(`Sent ${r.data.sent}; ${r.data.failed.length} not sent: ${r.data.failed[0]}`);
                    else t.ok(`Sent ${r.data.sent} to the drivers`);
                  })
                }
              >
                Send to drivers
              </button>
              <button type="button" className="ml-auto text-white/70 hover:text-white" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </div>
          )}
          <div className="max-h-[calc(100vh-270px)] overflow-auto">
            {legs.length === 0 ? (
              <div className="p-12 text-center text-muted text-body">{data.legs.length ? "Nothing matches." : "Every load has a truck."}</div>
            ) : (
              <ul>
                {legs.map((l) => (
                  <li key={l.legId} className={`border-b border-line last:border-b-0 ${sel === l.legId ? "bg-teal-soft" : "hover:bg-ground"}`} data-testid="planner-leg">
                    <div className="flex items-start gap-3 px-4 py-3 cursor-pointer" onClick={() => pick(l)} role="button" aria-pressed={sel === l.legId} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && pick(l)}>
                      {l.state === "planned" ? <input type="checkbox" className="accent-teal mt-1" checked={picked.has(l.legId)} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(l.legId); else n.delete(l.legId); return n; })} aria-label={`Select ${l.orderNumber}`} /> : <span className="w-[13px]" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="mono font-bold text-body">{l.orderNumber}</span>
                          <span className="text-footnote text-muted">
                            {LEG_LABEL[l.type] ?? l.type}
                            {l.legCount > 1 ? ` · leg ${l.legSeq}/${l.legCount}` : ""}
                          </span>
                          {l.priority !== "none" && <Pill tone={l.priority === "high" ? "red" : l.priority === "medium" ? "amber" : "slate"}>{l.priority}</Pill>}
                          {l.state === "planned" ? <Pill tone="blue">{l.assigned}</Pill> : l.state === "declined" ? <Pill tone="red">declined</Pill> : null}
                          {passed(l) && <Pill tone="red" title="The pickup appointment is already past: call the shipper and move it">pickup passed</Pill>}
                          <span className="ml-auto text-callout text-muted tabular-nums">
                            {l.miles != null ? `${l.miles.toLocaleString("en-US")} mi${l.milesEst ? " est." : ""} · ` : ""}
                            {money(l.rateCents, l.currency)}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-1.5 text-callout">
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{city(l.from)}</div>
                            <div className="text-muted text-footnote truncate">{shortWhen(l.from.at) || "no time"}</div>
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold truncate">→ {city(l.to)}</div>
                            <div className="text-muted text-footnote truncate">{shortWhen(l.to.at) || "no time"}</div>
                          </div>
                        </div>
                        {l.customer && <div className="text-footnote text-muted mt-1 truncate">{l.customer}</div>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* trucks (or drivers) */}
        {view === "trucks" ? (
          <TrucksPanel
            rows={trucks}
            all={data.trucks}
            leg={leg}
            cands={cands}
            pending={pending}
            canPlan={canPlan}
            q={drvQ}
            setQ={setDrvQ}
            filter={trkF}
            setFilter={setTrkF}
            onClear={() => setSel(null)}
            onAssign={(tr, send) => leg && assign(leg, ofTruck(tr), send)}
            onTimeOff={(tr) => setEventFor({ name: tr.crew[0]?.name ?? `Unit ${tr.unit}`, driverId: tr.crew[0]?.driverId ?? null, truckId: tr.truckId, unit: tr.unit })}
            onRemoveEvent={(id) => start(async () => { const r = await deleteEventAction(id); if (r.ok) { t.ok("Removed"); router.refresh(); } else t.err(r.error); })}
            switcher={<ViewSwitch view={view} setView={setView} />}
          />
        ) : (
        <section className="card overflow-hidden" aria-label="Drivers">
          <div className="px-4 pt-4 pb-3 border-b border-line">
            <div className="flex items-center justify-between gap-3">
              <div className="text-headline font-extrabold min-w-0 truncate">
                {leg ? (
                  <>
                    Drivers for <span className="mono">{leg.orderNumber}</span> <span className="text-muted font-semibold text-callout">{city(leg.from)} → {city(leg.to)}</span>
                  </>
                ) : (
                  <>
                    Drivers <span className="text-muted font-semibold">{data.drivers.length}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ViewSwitch view={view} setView={setView} />
                <input className="input h-8 w-48 text-callout" placeholder="Search driver, unit, city" value={drvQ} onChange={(e) => setDrvQ(e.target.value)} aria-label="Search drivers" />
              </div>
            </div>
            <div className="flex gap-1 mt-3 flex-wrap items-center">
              {[
                ["all", "All"],
                ["available", "Available"],
                ["planned", "Planned"],
                ["on_load", "On a load"],
                ["off", "Off"],
              ].map(([k, l]) => (
                <button key={k} type="button" className="quick-chip" data-active={drvF === k} onClick={() => setDrvF(k)}>
                  {l}
                  <span className="count">{k === "all" ? data.drivers.length : data.drivers.filter((d) => d.status === k).length}</span>
                </button>
              ))}
              {leg && (
                <button type="button" className="ml-auto text-callout text-teal font-semibold" onClick={() => setSel(null)}>
                  Clear selection
                </button>
              )}
            </div>
          </div>
          <div className="max-h-[calc(100vh-270px)] overflow-auto">
            {drivers.length === 0 ? (
              <div className="p-12 text-center text-muted text-body">{data.drivers.length ? "Nothing matches." : "No drivers yet — add them under Settings → Drivers."}</div>
            ) : (
              <table className="planner-table">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Status</th>
                    <th>Free</th>
                    <th>Next</th>
                    <th className="text-right">HOS</th>
                    {leg && <th className="text-right">Deadhead</th>}
                    {leg && <th>Fit</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {drivers.map(({ d, c, dh }) => {
                    const [label, tone] = STATUS[d.status];
                    return (
                      <tr key={d.driverId} data-testid="planner-driver">
                        <td>
                          <div className="font-bold">{d.name}</div>
                          <div className="text-footnote text-muted">
                            {d.unit ? `Unit ${d.unit}` : "no truck"} · {d.driverType}
                            {d.dispatcher ? ` · ${d.dispatcher}` : ""}
                          </div>
                        </td>
                        <td>
                          <Pill tone={tone}>{label}</Pill>
                          {d.current && <div className="text-footnote text-muted mt-0.5">{d.current.orderNumber} → {d.current.to}</div>}
                          {d.events.slice(0, 2).map((e) => (
                            <div key={e.id} className="text-footnote mt-0.5 flex items-center gap-1">
                              <span className={e.hard ? "text-red font-semibold" : "text-amber font-semibold"}>{e.label}</span>
                              <span className="text-muted">
                                {shortWhen(e.startsAt)} – {shortWhen(e.endsAt)}
                              </span>
                              {canPlan && (
                                <button type="button" className="text-faint hover:text-red" aria-label={`Remove ${e.label}`} onClick={() => start(async () => { const r = await deleteEventAction(e.id); if (r.ok) { t.ok("Removed"); router.refresh(); } else t.err(r.error); })}>
                                  ✕
                                </button>
                              )}
                            </div>
                          ))}
                        </td>
                        <td>
                          <div className="font-semibold">{d.status === "available" && !d.events.some((e) => e.hard && new Date(e.startsAt) <= new Date()) ? "Now" : when(d.availableAt)}</div>
                          <div className="text-footnote text-muted">{d.availableIn ?? "—"}</div>
                        </td>
                        <td className="text-callout">{d.next ? `${d.next.orderNumber} · ${shortWhen(d.next.at)}` : <span className="text-faint">—</span>}</td>
                        <td className="text-right tabular-nums text-callout" title={d.hos?.at ? `from the ELD ${when(d.hos.at)}` : "no ELD hours yet"}>
                          {d.hos ? `${hrs(d.hos.driveMin)} / ${hrs(d.hos.cycleMin)}` : <span className="text-faint">—</span>}
                        </td>
                        {leg && <td className="text-right tabular-nums">{dh != null ? `${dh.toLocaleString("en-US")} mi` : <span className="text-faint">—</span>}</td>}
                        {leg && (
                          <td className="max-w-[240px]">
                            {!c ? <span className="text-faint text-callout">{pending && !cands ? "…" : d.truckId ? "—" : "no truck"}</span> : <span className={`text-callout font-semibold ${FIT_CLASS[fit(c).tone]}`} title={c.reason}>{fit(c).text}</span>}
                          </td>
                        )}
                        <td className="text-right whitespace-nowrap">
                          {leg && canPlan && d.truckId && !c?.hardBlocked && (
                            <span className="inline-flex gap-1">
                              <button type="button" className="btn btn-sm" disabled={pending} onClick={() => assign(leg, ofDriver(d), false)}>
                                Assign
                              </button>
                              <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => assign(leg, ofDriver(d), true)} title="Assign and send to the driver">
                                Assign &amp; send
                              </button>
                            </span>
                          )}
                          {!leg && canPlan && (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEventFor({ name: d.name, driverId: d.driverId, truckId: d.truckId, unit: d.unit })}>
                              + Time off
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
        )}
      </div>

      <Modal
        open={!!override}
        onClose={() => setOverride(null)}
        title="Assign anyway?"
        footer={
          <>
            <button className="btn" onClick={() => setOverride(null)}>
              Back
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !overrideWhy.trim()}
              onClick={() => {
                if (override) assign(override.leg, override.who, override.send, overrideWhy.trim());
              }}
            >
              Override &amp; assign
            </button>
          </>
        }
      >
        <p className="text-body mb-3">{override?.message}</p>
        <label className="label" htmlFor="ov-why">
          Why is it OK? (kept on the record)
        </label>
        <input id="ov-why" className="input" value={overrideWhy} onChange={(e) => setOverrideWhy(e.target.value)} />
      </Modal>

      {eventFor && <EventModal driver={eventFor} onClose={() => setEventFor(null)} onDone={(m) => (setEventFor(null), t.ok(m), router.refresh())} />}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

type EventSubject = { name: string; driverId: string | null; truckId: string | null; unit: string | null };

function EventModal({ driver, onClose, onDone }: { driver: EventSubject; onClose: () => void; onDone: (msg: string) => void }) {
  const today = new Date();
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({ subject: driver.driverId ? "driver" : "truck", kind: driver.driverId ? "vacation" : "repair", startsAt: local(today), endsAt: local(new Date(today.getTime() + 2 * 86400_000)), hard: true, note: "" });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const repair = ["repair", "work_order"].includes(f.kind);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Time off — ${driver.name}`}
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
                setErr(null);
                const subjectKind = (repair && driver.truckId) || !driver.driverId ? "truck" : f.subject;
                const subjectId = subjectKind === "truck" ? driver.truckId! : driver.driverId!;
                const r = await addEventAction({ subjectKind, subjectId, kind: f.kind, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), hard: f.hard, note: f.note });
                if (r.ok) onDone(`${EVENT_KINDS.find(([v]) => v === f.kind)?.[1]} added`);
                else setErr(r.error);
              })
            }
          >
            Add
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="ev-kind">
            What
          </label>
          <select id="ev-kind" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {EVENT_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {repair && <div className="help">{driver.truckId ? `Blocks unit ${driver.unit}.` : "This driver has no truck to put in the shop."}</div>}
        </div>
        <div>
          <label className="label" htmlFor="ev-from">
            From
          </label>
          <input id="ev-from" type="datetime-local" className="input" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="ev-to">
            Until
          </label>
          <input id="ev-to" type="datetime-local" className="input" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />
        </div>
        <div className="col-span-2">
          <label className="label" htmlFor="ev-note">
            Note
          </label>
          <input id="ev-note" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-callout cursor-pointer">
          <input type="checkbox" className="accent-teal w-4 h-4" checked={f.hard} onChange={(e) => setF({ ...f, hard: e.target.checked })} /> Blocks assignment (untick to only warn)
        </label>
        {err && (
          <div className="error col-span-2" role="alert">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ViewSwitch({ view, setView }: { view: "trucks" | "drivers"; setView: (v: "trucks" | "drivers") => void }) {
  return (
    <div className="segmented" role="group" aria-label="Show">
      <button type="button" aria-pressed={view === "trucks"} onClick={() => setView("trucks")}>
        Trucks
      </button>
      <button type="button" aria-pressed={view === "drivers"} onClick={() => setView("drivers")}>
        Drivers
      </button>
    </div>
  );
}

type TruckRow = { t: PlannerTruck; c: Candidate | undefined; dh: number | null };

function TrucksPanel(p: {
  rows: TruckRow[];
  all: PlannerTruck[];
  leg: PlannerLeg | null;
  cands: Candidate[] | undefined;
  pending: boolean;
  canPlan: boolean;
  q: string;
  setQ: (v: string) => void;
  filter: "all" | PlannerTruck["status"];
  setFilter: (v: "all" | PlannerTruck["status"]) => void;
  onClear: () => void;
  onAssign: (t: PlannerTruck, send: boolean) => void;
  onTimeOff: (t: PlannerTruck) => void;
  onRemoveEvent: (id: string) => void;
  switcher: React.ReactNode;
}) {
  const { leg } = p;
  // no ELD connected yet: the HOS column would be all dashes
  const showHos = p.all.some((t) => t.hos);
  return (
    <section className="card overflow-hidden" aria-label="Trucks">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-headline font-extrabold min-w-0 truncate">
            {leg ? (
              <>
                Trucks for <span className="mono">{leg.orderNumber}</span> <span className="text-muted font-semibold text-callout">{city(leg.from)} → {city(leg.to)}</span>
              </>
            ) : (
              <>
                Trucks <span className="text-muted font-semibold">{p.all.length}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {p.switcher}
            <input className="input h-8 w-44 text-callout" placeholder="Search unit, driver, city" value={p.q} onChange={(e) => p.setQ(e.target.value)} aria-label="Search trucks" />
          </div>
        </div>
        <div className="flex gap-1 mt-3 flex-wrap items-center">
          {(["all", ...TRUCK_ORDER] as const).map((k) => (
            <button key={k} type="button" className="quick-chip" data-active={p.filter === k} onClick={() => p.setFilter(k)}>
              {k === "all" ? "All" : TRUCK_STATUS[k][0]}
              <span className="count">{k === "all" ? p.all.length : p.all.filter((t) => t.status === k).length}</span>
            </button>
          ))}
          {leg && (
            <button type="button" className="ml-auto text-callout text-teal font-semibold" onClick={p.onClear}>
              Clear selection
            </button>
          )}
        </div>
        {leg && passed(leg) && (
          <div className="mt-2 rounded-md bg-red-soft text-red text-callout font-semibold px-3 py-2" role="alert" data-testid="pickup-passed">
            The pickup appointment ({shortWhen(leg.from.until ?? leg.from.at)}) has already passed — call the shipper and move it before you send a truck.
          </div>
        )}
      </div>
      <div className="max-h-[calc(100vh-270px)] overflow-auto">
        {p.rows.length === 0 ? (
          <div className="p-12 text-center text-muted text-body">{p.all.length ? "Nothing matches." : "No trucks yet — add them under Fleet."}</div>
        ) : (
          <table className="planner-table truck-table">
            <thead>
              <tr>
                <th>Truck</th>
                <th>Status</th>
                <th>{leg ? "Free · empty miles" : "Free"}</th>
                {showHos && <th className="text-right">HOS</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {p.rows.map(({ t, c, dh }) => {
                const [label, tone] = TRUCK_STATUS[t.status];
                const evs = t.events.filter((e) => new Date(e.endsAt) > new Date() && !(t.why?.startsWith(e.label) && new Date(e.startsAt) <= new Date()));
                return (
                  <tr key={t.truckId} data-testid="planner-truck" data-status={t.status}>
                    <td>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-headline font-bold tabular-nums whitespace-nowrap">Unit {t.unit}</span>
                        {t.crew.length > 0 && <span className={`crew-tag ${t.team ? "crew-team" : ""}`}>{t.team ? "Team" : "Solo"}</span>}
                      </div>
                      {t.crew.length === 0 ? (
                        <div className="text-footnote text-faint mt-1">no driver</div>
                      ) : (
                        <div className="mt-1 grid gap-1">
                          {t.crew.map((d) => (
                            <div key={d.driverId} className="flex items-center gap-1.5 text-callout">
                              <span className="font-semibold truncate">{d.name}</span>
                              <span className={`type-tag type-${d.driverType.toLowerCase()}`}>{TYPE_LABEL[d.driverType] ?? d.driverType}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {t.dispatcher && <div className="text-footnote text-muted mt-0.5">{t.dispatcher}</div>}
                    </td>
                    <td className="min-w-[170px]">
                      <Pill tone={tone}>{label}</Pill>
                      {t.why && <div className={`text-footnote mt-1 ${t.status === "unavailable" ? "text-red" : t.status === "on_load" ? "text-amber font-semibold" : "text-ink-2"}`}>{t.why}</div>}
                      {t.status === "on_load" && t.current && <div className="text-footnote text-muted mt-1">{t.current.orderNumber} → {t.current.to}</div>}
                      {leg && c && (
                        <div className={`text-footnote font-semibold mt-1.5 line-clamp-3 ${FIT_CLASS[fit(c).tone]}`} title={c.reason} data-testid="truck-fit" data-reach={c.reach?.status ?? "unknown"}>
                          {fit(c).text}
                        </div>
                      )}
                      {leg && !c && p.pending && !p.cands && <div className="text-footnote text-faint mt-1.5">checking…</div>}
                      {evs.slice(0, 2).map((e) => (
                        <div key={e.id} className="text-footnote mt-1">
                          <span className={e.hard ? "text-red font-semibold" : "text-amber font-semibold"}>{e.label}</span>{" "}
                          <span className="text-muted">
                            {friendly(e.startsAt)} – {friendly(e.endsAt)}
                          </span>
                          {p.canPlan && (
                            <button type="button" className="ml-1 text-faint hover:text-red" aria-label={`Remove ${e.label}`} onClick={() => p.onRemoveEvent(e.id)}>
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      <div className="font-semibold whitespace-nowrap">{t.status === "available" ? "Now" : t.status === "waiting_crossing" ? "Once it crosses" : t.status === "unavailable" && !t.availableAt ? "—" : friendly(t.availableAt)}</div>
                      <div className="text-footnote text-muted">
                        {t.availableIn ?? "—"}
                        {leg && dh != null && <span className="text-ink-2 font-semibold"> · {dh.toLocaleString("en-US")} mi empty</span>}
                      </div>
                      {!leg && t.next && t.status !== "waiting_crossing" && (
                        <div className="text-footnote text-muted mt-0.5">
                          Next <span className="mono">{t.next.orderNumber}</span> · {friendly(t.next.at)}
                        </div>
                      )}
                    </td>
                    {showHos && (
                      <td className="text-right tabular-nums text-callout whitespace-nowrap" title={t.hos?.at ? `from the ELD ${when(t.hos.at)}` : "no ELD hours yet"}>
                        {t.hos ? `${hrs(t.hos.driveMin)} / ${hrs(t.hos.cycleMin)}` : <span className="text-faint">—</span>}
                      </td>
                    )}
                    <td className="text-right">
                      {leg ? (
                        p.canPlan &&
                        t.crew.length > 0 &&
                        !c?.hardBlocked && (
                          <div className="grid gap-1.5 justify-items-stretch">
                            <button type="button" className="btn btn-sm btn-primary whitespace-nowrap" disabled={p.pending} onClick={() => p.onAssign(t, true)} title="Assign and send to the driver">
                              Assign &amp; send
                            </button>
                            <button type="button" className="btn btn-sm whitespace-nowrap" disabled={p.pending} onClick={() => p.onAssign(t, false)}>
                              Assign
                            </button>
                          </div>
                        )
                      ) : (
                        p.canPlan && (
                          <button type="button" className="text-footnote text-muted hover:text-teal whitespace-nowrap" onClick={() => p.onTimeOff(t)} aria-label={`Time off for unit ${t.unit}`}>
                            + time off
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
