"use client";

/**
 * One stop, the way every TMS enters it: what happens there, where (a saved location or typed in),
 * when (an appointment or a first-come window), the reference the dock will ask for, who to call and
 * what the driver needs to know. Used by the load builder and by "Add stop" on an existing load.
 */

import type { ReactNode } from "react";
import { stopZone, fromZoneInput, toZoneInput, zoneAbbrev, fmtWhen, fmtWindow } from "@/lib/time";

export type Loc = { id: string; name: string; country: string; kind: string; address: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } | null };

export type StopDraft = {
  key: string;
  type: string;
  locationId: string | null;
  name: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  appointment: boolean;
  windowStart: string;
  windowEnd: string;
  ref: string;
  contact: string;
  notes: string;
  saveLocation: boolean;
};

export const STOP_TYPES: [string, string, string][] = [
  ["pickup", "Pickup", "freight goes on"],
  ["delivery", "Delivery", "freight comes off"],
  ["yard", "Yard (hand-off)", "the trailer is dropped for another truck; a leg ends here"],
  ["border_yard", "Border yard (hand-off)", "the trailer waits at the border for the crossing truck; a leg ends here"],
  ["transload", "Transload (hand-off)", "freight moves to another trailer; a leg ends here"],
  ["customs", "Customs / inspection", "the truck stops for customs; not a hand-off"],
  ["terminal", "Terminal (hand-off)", "a rail or port terminal; a leg ends here"],
];
export const STOP_LABEL: Record<string, string> = Object.fromEntries(STOP_TYPES.map(([v, l]) => [v, l]));
export const STOP_HINT: Record<string, string> = Object.fromEntries(STOP_TYPES.map(([v, , h]) => [v, h]));
/** Pill tone per stop type: freight on / off / hand-off / customs. */
export const STOP_TONE: Record<string, string> = { pickup: "teal", delivery: "navy", yard: "amber", border_yard: "amber", transload: "amber", terminal: "amber", customs: "blue" };

export const COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["MX", "Mexico"],
  ["CA", "Canada"],
];

let n = 0;
export const blankStop = (type = "delivery", country = "US"): StopDraft => ({ key: `s${Date.now()}${n++}`, type, locationId: null, name: "", line1: "", city: "", state: "", postalCode: "", country, appointment: false, windowStart: "", windowEnd: "", ref: "", contact: "", notes: "", saveLocation: false });

/** A draft stop from a saved location. */
export function fromLocation(st: StopDraft, l: Loc): StopDraft {
  return { ...st, locationId: l.id, name: l.name, line1: l.address?.line1 ?? "", city: l.address?.city ?? "", state: l.address?.state ?? "", postalCode: l.address?.postalCode ?? "", country: l.country || "US", saveLocation: false };
}

/** "Canton, MI · US" */
export const placeLine = (st: Pick<StopDraft, "city" | "state" | "country">) => [[st.city, st.state].filter(Boolean).join(", "), st.country].filter(Boolean).join(" · ");

/** "Oct 2, 8:00 AM – 2:00 PM CST" / "Appt Oct 2, 9:30 AM CST" / "": the typed wall clock, on the stop's own clock. */
export function timeLine(st: Pick<StopDraft, "appointment" | "windowStart" | "windowEnd" | "country" | "state" | "city" | "name">, companyZone = "America/Chicago") {
  if (!st.windowStart) return "";
  const z = draftZone(st, companyZone);
  const a = fromZoneInput(st.windowStart, z);
  if (!a) return "";
  const b = st.windowEnd ? fromZoneInput(st.windowEnd, z) : null;
  if (st.appointment) return `Appt ${fmtWhen(a, z, { style: "short" })}`;
  if (!b) return `${fmtWhen(a, z, { style: "short" })} onward`;
  return fmtWindow(a, b, z, { short: true }) ?? "";
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-caption font-bold text-faint">{title}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  );
}

export function StopFields({ stop, onChange, locations, index, invalid, companyZone = "America/Chicago" }: { stop: StopDraft; onChange: (patch: Partial<StopDraft>) => void; locations: Loc[]; index: number; invalid?: boolean; companyZone?: string }) {
  const id = (f: string) => `stop-${index}-${f}`;
  const linked = stop.locationId ? locations.find((l) => l.id === stop.locationId) : null;
  const n1 = index + 1;
  return (
    <div className="form-roomy space-y-7">
      <Group title="Where">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-x-4 gap-y-4">
          <div className="md:col-span-2">
            <label className="label" htmlFor={id("type")}>
              Stop type
            </label>
            <select id={id("type")} className="select" value={stop.type} onChange={(e) => onChange({ type: e.target.value })} aria-label={`Stop ${n1} type`}>
              {STOP_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <div className="help">{STOP_HINT[stop.type]}</div>
          </div>
          <div className="md:col-span-4">
            <label className="label" htmlFor={id("loc")}>
              Location {linked && <span className="text-teal font-semibold">· saved location</span>}
            </label>
            <input
              id={id("loc")}
              className="input"
              list={`locations-${index}`}
              value={stop.name}
              placeholder={locations.length ? "Company or place name — or pick a saved location" : "Company or place name"}
              aria-invalid={invalid && !stop.name.trim()}
              aria-label={`Stop ${n1} location`}
              onChange={(e) => {
                const v = e.target.value;
                const l = locations.find((x) => x.name === v);
                onChange(l ? fromLocation(stop, l) : { name: v, locationId: stop.locationId && linked?.name !== v ? null : stop.locationId });
              }}
            />
            <datalist id={`locations-${index}`}>
              {locations.map((l) => (
                <option key={l.id} value={l.name}>
                  {[l.address?.city, l.address?.state, l.country].filter(Boolean).join(", ")}
                </option>
              ))}
            </datalist>
          </div>
          <div className="md:col-span-6">
            <label className="label" htmlFor={id("street")}>
              Street address
            </label>
            <input id={id("street")} className="input" value={stop.line1} onChange={(e) => onChange({ line1: e.target.value })} aria-label={`Stop ${n1} street`} />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor={id("city")}>
              City
            </label>
            <input id={id("city")} className="input" value={stop.city} onChange={(e) => onChange({ city: e.target.value })} aria-label={`Stop ${n1} city`} />
          </div>
          <div className="md:col-span-1">
            <label className="label" htmlFor={id("state")}>
              State / prov.
            </label>
            <input id={id("state")} className="input" value={stop.state} onChange={(e) => onChange({ state: e.target.value })} aria-label={`Stop ${n1} state`} />
          </div>
          <div className="md:col-span-1">
            <label className="label" htmlFor={id("postal")}>
              ZIP / postal
            </label>
            <input id={id("postal")} className="input" value={stop.postalCode} onChange={(e) => onChange({ postalCode: e.target.value })} aria-label={`Stop ${n1} postal code`} />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor={id("country")}>
              Country
            </label>
            <select id={id("country")} className="select" value={stop.country} onChange={(e) => onChange({ country: e.target.value })} aria-label={`Stop ${n1} country`}>
              {COUNTRIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!stop.locationId && stop.name.trim() && (
          <label className="flex items-center gap-2 mt-4 text-callout cursor-pointer text-muted">
            <input type="checkbox" className="accent-teal w-4 h-4" checked={stop.saveLocation} onChange={(e) => onChange({ saveLocation: e.target.checked })} /> Save &ldquo;{stop.name.trim()}&rdquo; as a location for next time
          </label>
        )}
      </Group>

      <Group title={`When · on the stop's clock (${zoneAbbrev(draftZone(stop, companyZone))})`}>
        <div className="inline-flex rounded-lg border border-line bg-ground p-1 mb-4" role="group" aria-label={`Stop ${n1} time kind`}>
          {([
            [false, "Window · first come"],
            [true, "Appointment"],
          ] as const).map(([appt, l]) => (
            <button key={l} type="button" aria-pressed={stop.appointment === appt} onClick={() => onChange({ appointment: appt })} className={`px-4 h-9 rounded-md text-callout font-semibold transition-colors ${stop.appointment === appt ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
          <div>
            <label className="label" htmlFor={id("from")}>
              {stop.appointment ? "Appointment" : "Opens"}
            </label>
            <input id={id("from")} type="datetime-local" className="input" value={stop.windowStart} onChange={(e) => onChange({ windowStart: e.target.value })} aria-label={`Stop ${n1} from`} />
          </div>
          <div>
            <label className="label" htmlFor={id("to")}>
              {stop.appointment ? "Until (optional)" : "Closes"}
            </label>
            <input id={id("to")} type="datetime-local" className="input" value={stop.windowEnd} onChange={(e) => onChange({ windowEnd: e.target.value })} aria-label={`Stop ${n1} to`} />
          </div>
        </div>
      </Group>

      <Group title="At the dock">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
          <div>
            <label className="label" htmlFor={id("ref")}>
              {stop.type === "pickup" ? "Pickup # / PO" : stop.type === "delivery" ? "Delivery # / PO" : "Reference"}
            </label>
            <input id={id("ref")} className="input" value={stop.ref} onChange={(e) => onChange({ ref: e.target.value })} aria-label={`Stop ${n1} reference`} />
          </div>
          <div>
            <label className="label" htmlFor={id("contact")}>
              Contact
            </label>
            <input id={id("contact")} className="input" placeholder="Name · phone" value={stop.contact} onChange={(e) => onChange({ contact: e.target.value })} aria-label={`Stop ${n1} contact`} />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor={id("notes")}>
              Instructions for the driver
            </label>
            <input id={id("notes")} className="input" value={stop.notes} onChange={(e) => onChange({ notes: e.target.value })} aria-label={`Stop ${n1} instructions`} />
          </div>
        </div>
      </Group>
    </div>
  );
}

/** The zone a stop's times are typed in: a border city's own clock, else its state or province, else its country, else the company's. */
export function draftZone(st: Pick<StopDraft, "country" | "state"> & Partial<Pick<StopDraft, "city" | "name">>, companyZone = "America/Chicago") {
  return stopZone({ country: st.country, name: st.name ?? null, address: { state: st.state, city: st.city ?? null } }, companyZone);
}

type SavedStop = { id?: string; type: string; locationId?: string | null; name: string; country: string; address: { line1?: string; city?: string; state?: string; postalCode?: string } | null; windowStart: string | Date | null; windowEnd: string | Date | null; appointment: boolean; contact: string | null; notes: string | null; refs?: Record<string, string> | null };

/** A saved stop as the editor's draft: its structured address as is, its times on its own clock. */
export function draftFromStop(st: SavedStop, companyZone = "America/Chicago"): StopDraft {
  const a = st.address ?? {};
  const d: StopDraft = { key: st.id ?? `s${n++}`, type: st.type, locationId: st.locationId ?? null, name: st.name, line1: a.line1 ?? "", city: a.city ?? "", state: a.state ?? "", postalCode: a.postalCode ?? "", country: st.country || "US", appointment: st.appointment, windowStart: "", windowEnd: "", ref: st.refs?.reference ?? st.refs?.pickup ?? st.refs?.delivery ?? "", contact: st.contact ?? "", notes: st.notes ?? "", saveLocation: false };
  const z = draftZone(d, companyZone);
  return { ...d, windowStart: toZoneInput(st.windowStart, z), windowEnd: toZoneInput(st.windowEnd, z) };
}

/**
 * Only what the dispatcher changed, as the server wants it (B4: saving a new window must not touch the city, the
 * state or the coordinates). Times are sent when they were edited or when the stop moved to another clock.
 */
export function stopPatch(before: StopDraft, after: StopDraft, companyZone = "America/Chicago"): Partial<StopPayload> {
  const out: Record<string, unknown> = {};
  const trim = (v: string) => v.trim();
  for (const k of ["type", "locationId", "country", "appointment"] as const) if (before[k] !== after[k]) out[k] = after[k];
  for (const k of ["name", "line1", "city", "state", "postalCode", "ref", "contact", "notes"] as const) if (trim(before[k]) !== trim(after[k])) out[k] = trim(after[k]);
  const zb = draftZone(before, companyZone);
  const za = draftZone(after, companyZone);
  for (const k of ["windowStart", "windowEnd"] as const) if (before[k] !== after[k] || zb !== za) out[k] = after[k] ? (fromZoneInput(after[k], za)?.toISOString() ?? "") : "";
  return out as Partial<StopPayload>;
}

/** What the server gets for a stop: times typed on the stop's own clock become instants. */
export function stopPayload(st: StopDraft, companyZone = "America/Chicago") {
  const z = draftZone(st, companyZone);
  const inst = (v: string) => (v ? (fromZoneInput(v, z)?.toISOString() ?? "") : "");
  return { type: st.type, locationId: st.locationId, name: st.name.trim(), line1: st.line1.trim(), city: st.city.trim(), state: st.state.trim(), postalCode: st.postalCode.trim(), country: st.country, appointment: st.appointment, windowStart: inst(st.windowStart), windowEnd: inst(st.windowEnd), ref: st.ref.trim(), contact: st.contact.trim(), notes: st.notes.trim(), saveLocation: st.saveLocation };
}
export type StopPayload = ReturnType<typeof stopPayload>;
