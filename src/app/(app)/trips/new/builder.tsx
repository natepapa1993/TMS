"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTripAction } from "../actions";
import type { StopType } from "@/db/schema";
import { STOP_TYPES, COUNTRIES } from "@/components/stop-fields";

type StopRow = { type: StopType; name: string; country: string; city: string; state: string };
const TYPES = STOP_TYPES.map(([v, l]) => [v as StopType, l] as const);
const blank = (type: StopType, country = "US"): StopRow => ({ type, name: "", country, city: "", state: "" });

export function TripBuilder() {
  const router = useRouter();
  const [equipment, setEquipment] = useState("53_dry");
  const [stops, setStops] = useState<StopRow[]>([blank("pickup"), blank("delivery")]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (i: number, patch: Partial<StopRow>) => setStops(stops.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= stops.length) return;
    const next = [...stops];
    [next[i], next[j]] = [next[j], next[i]];
    setStops(next);
  };
  return (
    <div className="card p-5">
      <div className="flex items-end gap-3 flex-wrap mb-4">
        <div>
          <label className="label">Equipment</label>
          <select className="select w-44" value={equipment} onChange={(e) => setEquipment(e.target.value)}>
            {["53_dry", "53_reefer", "48_dry", "flatbed", "sprinter", "straight"].map((e) => (
              <option key={e} value={e}>
                {e.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-2">
        {stops.map((s, i) => (
          <div key={i} className="grid grid-cols-[28px_150px_1fr_110px_80px_90px_auto] gap-2 items-center" data-testid="stop-row">
            <div className="mono text-muted text-[12.5px]">{i + 1}</div>
            <select className="select" value={s.type} onChange={(e) => set(i, { type: e.target.value as StopType })} aria-label="Stop type">
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input className="input" placeholder={s.type === "pickup" ? "Shipper name" : s.type === "delivery" ? "Consignee name" : "Location name"} value={s.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`Stop ${i + 1} name`} />
            <input className="input" placeholder="City" value={s.city} onChange={(e) => set(i, { city: e.target.value })} aria-label="City" />
            <input className="input" placeholder="State / prov." value={s.state} onChange={(e) => set(i, { state: e.target.value.toUpperCase() })} aria-label="State" />
            <select className="select" value={s.country} onChange={(e) => set(i, { country: e.target.value })} aria-label="Country">
              {COUNTRIES.map(([v]) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              <button className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} title="Move up" aria-label="Move up">
                ↑
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} title="Move down" aria-label="Move down">
                ↓
              </button>
              <button className="btn btn-ghost btn-sm text-red" onClick={() => setStops(stops.filter((_, k) => k !== i))} disabled={stops.length <= 2} aria-label="Remove stop">
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button className="btn btn-sm" onClick={() => setStops([...stops, blank("delivery", stops[stops.length - 1]?.country ?? "US")])}>
          + Stop
        </button>
        <span className="help m-0">Add the stops in the order the freight moves. A hand-off stop (yard, border yard, transload, terminal) ends a leg. Reorder with the arrows.</span>
      </div>
      <div className="flex items-center justify-end gap-3 mt-5">
        {err && <span className="error m-0">{err}</span>}
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setErr(null);
              if (stops.some((s) => !s.name.trim())) return setErr("every stop needs a name");
              const r = await createTripAction({ equipment, stops: stops.map((s) => ({ type: s.type, name: s.name.trim(), country: s.country, city: s.city.trim(), state: s.state.trim() })) });
              if (r.ok) router.push(`/trips/${r.data.order.id}`);
              else setErr(r.error);
            })
          }
        >
          {pending ? "Creating…" : "Create trip → add shipments"}
        </button>
      </div>
    </div>
  );
}
