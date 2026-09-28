"use client";

import { useEffect, useState, useTransition } from "react";
import { checkCallAction, checkCallsAction } from "./actions";
import { fmtWhen, fromZoneInput, zoneAbbrev } from "@/lib/time";

const STATUSES: [string, string][] = [
  ["on_time", "On time"],
  ["running_late", "Running late"],
  ["at_shipper", "At shipper"],
  ["loading", "Loading"],
  ["at_receiver", "At receiver"],
  ["unloading", "Unloading"],
  ["at_border", "At the border"],
  ["traffic", "Traffic delay"],
  ["weather", "Weather delay"],
  ["breakdown", "Breakdown"],
  ["fuel_stop", "Fuel stop"],
  ["rest", "On a break (HOS)"],
  ["other", "Other"],
];
const LABEL = Object.fromEntries(STATUSES);

type Call = { id: string; at: string | Date; status: string; location: string | null; etaAt: string | Date | null; tempF: number | null; note: string | null; sentTo: string | null; source: string };

/**
 * One-line check call: status, where (blank = the last GPS position), ETA at the stop's own clock,
 * reefer temperature, a note, and "send to the customer". The log of earlier calls sits under it.
 */
export function CheckCallBox({ orderId, legId, zone, reefer, onDone }: { orderId: string; legId: string | null; zone: string; reefer: boolean; onDone?: (msg: string) => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [f, setF] = useState({ status: "on_time", location: "", eta: "", tempF: "", note: "", send: false });
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const load = () => checkCallsAction(orderId).then((r) => setCalls(r.ok ? (r.data as Call[]) : []));
  useEffect(() => {
    let live = true;
    checkCallsAction(orderId).then((r) => live && setCalls(r.ok ? (r.data as Call[]) : []));
    return () => {
      live = false;
    };
  }, [orderId]);
  const abbr = zoneAbbrev(zone);
  const save = () =>
    start(async () => {
      setErr(null);
      const eta = f.eta ? fromZoneInput(f.eta, zone)?.toISOString() ?? "" : "";
      const r = await checkCallAction(orderId, { legId, status: f.status, location: f.location, eta, tempF: f.tempF, note: f.note, send: f.send });
      if (!r.ok) return setErr(r.error);
      setF({ status: f.status, location: "", eta: "", tempF: "", note: "", send: false });
      await load();
      const msg = r.data.sentTo ? `Check call logged and sent to ${r.data.sentTo}` : "Check call logged";
      if (onDone) onDone(msg);
      else setSaved(msg);
    });
  return (
    <div className="space-y-2" data-testid="check-call">
      <div className="grid grid-cols-2 gap-2">
        <select id="cc-status" aria-label="Check call status" className="select h-9 text-callout" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input id="cc-location" aria-label="Where" className="input h-9 text-callout" placeholder="Where (blank = last GPS)" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        <label className="col-span-2 flex items-center gap-2 text-footnote text-muted">
          ETA ({abbr})
          <input id="cc-eta" type="datetime-local" className="input h-9 text-callout flex-1" value={f.eta} onChange={(e) => setF({ ...f, eta: e.target.value })} />
          {reefer && <input id="cc-temp" aria-label="Reefer °F" className="input h-9 text-callout w-16" inputMode="numeric" placeholder="°F" value={f.tempF} onChange={(e) => setF({ ...f, tempF: e.target.value })} />}
        </label>
        <input id="cc-note" aria-label="Check call note" className="input h-9 text-callout col-span-2" placeholder="Note (what the driver said)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-callout cursor-pointer mr-auto">
          <input id="cc-send" type="checkbox" className="accent-teal" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /> Email to the customer
        </label>
        <button className="btn btn-sm btn-primary" disabled={pending} onClick={save}>
          Log check call
        </button>
      </div>
      {err && <div className="error m-0">{err}</div>}
      {saved && !err && (
        <div className="text-callout text-green font-semibold" role="status">
          {saved}
        </div>
      )}
      {calls && calls.length > 0 && (
        <ul className="text-callout divide-y divide-line border-t border-line" data-testid="check-calls">
          {calls.slice(0, 8).map((c) => (
            <li key={c.id} className="py-1.5">
              <div className="flex justify-between gap-2">
                <span className={`font-semibold ${["breakdown", "running_late", "weather", "traffic"].includes(c.status) ? "text-red" : ""}`}>{LABEL[c.status] ?? c.status}</span>
                <span className="text-faint whitespace-nowrap">{fmtWhen(c.at, zone, { style: "short" })}</span>
              </div>
              <div className="text-muted">
                {[c.location, c.etaAt ? `ETA ${fmtWhen(c.etaAt, zone, { style: "short" })}` : null, c.tempF != null ? `${c.tempF}°F` : null, c.note].filter(Boolean).join(" · ")}
                {c.sentTo && <span className="text-teal"> · sent to {c.sentTo}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
