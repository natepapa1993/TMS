"use client";

/**
 * One stop, the way every TMS enters it: what happens there, where (a saved location or typed in),
 * when (an appointment or a first-come window), the reference the dock will ask for, who to call and
 * what the driver needs to know. Used by the load builder and by "Add stop" on an existing load.
 */

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

export function StopFields({ stop, onChange, locations, index, invalid }: { stop: StopDraft; onChange: (patch: Partial<StopDraft>) => void; locations: Loc[]; index: number; invalid?: boolean }) {
  const id = (f: string) => `stop-${index}-${f}`;
  const linked = stop.locationId ? locations.find((l) => l.id === stop.locationId) : null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2">
        <div>
          <label className="label" htmlFor={id("type")}>
            Stop type
          </label>
          <select id={id("type")} className="select" value={stop.type} onChange={(e) => onChange({ type: e.target.value })} aria-label={`Stop ${index + 1} type`}>
            {STOP_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={id("loc")}>
            Location {linked && <span className="text-teal font-normal">· saved location</span>}
          </label>
          <input
            id={id("loc")}
            className="input"
            list={`locations-${index}`}
            value={stop.name}
            placeholder="Type a name, or pick a saved location"
            aria-invalid={invalid && !stop.name.trim()}
            aria-label={`Stop ${index + 1} location`}
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
      </div>
      <div className="grid grid-cols-2 md:grid-cols-[2fr_1.2fr_110px_110px_150px] gap-2">
        <input className="input col-span-2 md:col-span-1" placeholder="Street address" value={stop.line1} onChange={(e) => onChange({ line1: e.target.value })} aria-label={`Stop ${index + 1} street`} />
        <input className="input" placeholder="City" value={stop.city} onChange={(e) => onChange({ city: e.target.value })} aria-label={`Stop ${index + 1} city`} />
        <input className="input" placeholder="State / prov." value={stop.state} onChange={(e) => onChange({ state: e.target.value })} aria-label={`Stop ${index + 1} state`} />
        <input className="input" placeholder="ZIP / postal" value={stop.postalCode} onChange={(e) => onChange({ postalCode: e.target.value })} aria-label={`Stop ${index + 1} postal code`} />
        <select className="select" value={stop.country} onChange={(e) => onChange({ country: e.target.value })} aria-label={`Stop ${index + 1} country`}>
          {COUNTRIES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-[160px_1fr_1fr] gap-2 items-end">
        <div>
          <label className="label">Time</label>
          <select className="select" value={stop.appointment ? "appt" : "window"} onChange={(e) => onChange({ appointment: e.target.value === "appt" })} aria-label={`Stop ${index + 1} time kind`}>
            <option value="window">Window (FCFS)</option>
            <option value="appt">Appointment</option>
          </select>
        </div>
        <div>
          <label className="label">{stop.appointment ? "Appointment" : "From"}</label>
          <input type="datetime-local" className="input" value={stop.windowStart} onChange={(e) => onChange({ windowStart: e.target.value })} aria-label={`Stop ${index + 1} from`} />
        </div>
        <div>
          <label className="label">{stop.appointment ? "Until (optional)" : "To"}</label>
          <input type="datetime-local" className="input" value={stop.windowEnd} onChange={(e) => onChange({ windowEnd: e.target.value })} aria-label={`Stop ${index + 1} to`} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input className="input" placeholder={stop.type === "pickup" ? "Pickup # / PO at this stop" : stop.type === "delivery" ? "Delivery # / PO at this stop" : "Reference at this stop"} value={stop.ref} onChange={(e) => onChange({ ref: e.target.value })} aria-label={`Stop ${index + 1} reference`} />
        <input className="input" placeholder="Contact · phone" value={stop.contact} onChange={(e) => onChange({ contact: e.target.value })} aria-label={`Stop ${index + 1} contact`} />
        <input className="input" placeholder="Instructions for the driver" value={stop.notes} onChange={(e) => onChange({ notes: e.target.value })} aria-label={`Stop ${index + 1} instructions`} />
      </div>
      {!stop.locationId && stop.name.trim() && (
        <label className="flex items-center gap-2 text-[12.5px] cursor-pointer text-muted">
          <input type="checkbox" className="accent-teal" checked={stop.saveLocation} onChange={(e) => onChange({ saveLocation: e.target.checked })} /> Save &ldquo;{stop.name.trim()}&rdquo; as a location for next time
        </label>
      )}
    </div>
  );
}

/** What the server needs from a draft stop. */
export function stopPayload(st: StopDraft) {
  return { type: st.type, locationId: st.locationId, name: st.name.trim(), line1: st.line1.trim(), city: st.city.trim(), state: st.state.trim(), postalCode: st.postalCode.trim(), country: st.country, appointment: st.appointment, windowStart: st.windowStart ? new Date(st.windowStart).toISOString() : "", windowEnd: st.windowEnd ? new Date(st.windowEnd).toISOString() : "", ref: st.ref.trim(), contact: st.contact.trim(), notes: st.notes.trim(), saveLocation: st.saveLocation };
}
export type StopPayload = ReturnType<typeof stopPayload>;
