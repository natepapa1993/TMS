"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { MapUnit } from "@/domain/asset-map";

const LiveMap = dynamic(() => import("./live-map").then((m) => m.LiveMap), { ssr: false, loading: () => <div className="h-full grid place-items-center text-muted text-[13px]">Loading the map…</div> });

export const STATUS_LABEL: Record<MapUnit["status"], string> = { moving: "Moving", stopped: "Stopped", stale: "No recent position", oos: "Out of service" };
export const STATUS_COLOR: Record<MapUnit["status"], string> = { moving: "#15803d", stopped: "#1d4ed8", stale: "#94a3b8", oos: "#b91c1c" };

export const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export function MapScreen({ data }: { data: { units: MapUnit[]; unplaced: { id: string; label: string; driver: string | null }[] } }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [f, setF] = useState("all");
  const [focus, setFocus] = useState<string | null>(null);
  // positions refresh every minute
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [router]);
  const units = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.units.filter((u) => (f === "all" ? true : f === "carrier" ? u.kind === "carrier" : u.status === f) && (!s || [u.label, u.driver, u.load?.orderNumber, u.place, u.load?.next].some((x) => x?.toLowerCase().includes(s))));
  }, [data.units, q, f]);
  const count = (k: string) => (k === "all" ? data.units.length : k === "carrier" ? data.units.filter((u) => u.kind === "carrier").length : data.units.filter((u) => u.status === k).length);
  return (
    <div className="h-[calc(100vh-48px)] lg:h-screen flex flex-col">
      <div className="px-5 md:px-8 pt-6 pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow mb-1">Fleet</div>
          <h1 className="text-[24px] font-extrabold tracking-tight">Map</h1>
          <div className="text-muted text-[13px] mt-0.5">Last known position of every truck, and partner carriers on your loads while they are tracked. Refreshes every minute.</div>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
          <Link href="/fleet" className="px-3.5 h-8 grid place-items-center rounded-md text-[13px] font-semibold text-muted hover:text-ink">
            Units
          </Link>
          <span className="px-3.5 h-8 grid place-items-center rounded-md text-[13px] font-semibold bg-navy text-white">Map</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 px-5 md:px-8 pb-6 grid lg:grid-cols-[340px_minmax(0,1fr)] gap-4">
        <aside className="card flex flex-col min-h-0 overflow-hidden order-2 lg:order-1">
          <div className="p-3 border-b border-line">
            <input className="input h-8 text-[13px]" placeholder="Search unit, driver, load, place" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search units" />
            <div className="flex gap-1 mt-2 flex-wrap">
              {[
                ["all", "All"],
                ["moving", "Moving"],
                ["stopped", "Stopped"],
                ["stale", "No recent"],
                ["carrier", "Carriers"],
              ].map(([k, l]) => (
                <button key={k} type="button" className="quick-chip" data-active={f === k} onClick={() => setF(k)}>
                  {l}
                  <span className="count">{count(k)}</span>
                </button>
              ))}
            </div>
          </div>
          <ul className="flex-1 overflow-auto" data-testid="map-list">
            {units.map((u) => (
              <li key={u.id}>
                <button type="button" className={`w-full text-left px-3 py-2.5 border-b border-line hover:bg-ground ${focus === u.id ? "bg-teal-soft" : ""}`} onClick={() => setFocus(u.id)} data-testid="map-unit">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: u.kind === "carrier" ? "#7c3aed" : STATUS_COLOR[u.status] }} />
                    <span className="font-bold text-[13.5px] truncate">{u.kind === "truck" ? `Unit ${u.label}` : u.label}</span>
                    <span className="ml-auto text-[11.5px] text-muted whitespace-nowrap">{ago(u.at)}</span>
                  </div>
                  <div className="text-[12.5px] text-muted mt-0.5 truncate">
                    {u.driver ?? (u.kind === "carrier" ? "partner carrier" : "no driver")}
                    {u.load ? ` · ${u.load.orderNumber}${u.load.next ? ` → ${u.load.next}` : ""}` : ""}
                  </div>
                </button>
              </li>
            ))}
            {units.length === 0 && <li className="p-8 text-center text-muted text-[13px]">{data.units.length ? "Nothing matches." : "No positions yet. They come from the ELD, the driver app and verified steps."}</li>}
          </ul>
          {data.unplaced.length > 0 && (
            <div className="border-t border-line px-3 py-2.5 text-[12px] text-muted">
              No position: {data.unplaced.map((u) => u.label).join(", ")}
            </div>
          )}
        </aside>
        <div className="card overflow-hidden min-h-[360px] order-1 lg:order-2" data-testid="map">
          <LiveMap units={units} focus={focus} />
        </div>
      </div>
    </div>
  );
}
