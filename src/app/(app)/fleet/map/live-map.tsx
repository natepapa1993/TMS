"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import type { MapUnit } from "@/domain/asset-map";

const COLOR: Record<string, string> = { moving: "#15803d", stopped: "#1d4ed8", stale: "#94a3b8", oos: "#b91c1c", carrier: "#7c3aed" };
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function icon(u: MapUnit) {
  const color = u.kind === "carrier" ? COLOR.carrier : COLOR[u.status];
  const arrow = u.status === "moving" && u.heading != null ? `<span style="position:absolute;left:50%;top:-9px;transform:translateX(-50%) rotate(${u.heading}deg);transform-origin:50% 16px;color:${color};font-size:10px;line-height:1">▲</span>` : "";
  return L.divIcon({
    className: "",
    iconSize: [0, 0],
    html: `<div style="position:relative;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:4px;background:#fff;border:2px solid ${color};border-radius:999px;padding:1px 7px 1px 4px;font:700 11px/16px Manrope,system-ui,sans-serif;color:#0f172a;box-shadow:0 1px 4px rgba(15,23,42,.25);white-space:nowrap">${arrow}<span style="width:8px;height:8px;border-radius:999px;background:${color}"></span>${esc(u.kind === "truck" ? u.label : u.label.slice(0, 18))}</div>`,
  });
}

function Fit({ units, focus }: { units: MapUnit[]; focus: string | null }) {
  const map = useMap();
  useEffect(() => {
    const f = units.find((u) => u.id === focus);
    if (f) {
      map.setView([f.lat, f.lng], Math.max(map.getZoom(), 9), { animate: true });
      return;
    }
    if (units.length === 1) map.setView([units[0].lat, units[0].lng], 8);
    else if (units.length > 1) map.fitBounds(L.latLngBounds(units.map((u) => [u.lat, u.lng] as [number, number])), { padding: [40, 40], maxZoom: 9 });
  }, [units, focus, map]);
  return null;
}

export function LiveMap({ units, focus }: { units: MapUnit[]; focus: string | null }) {
  return (
    <MapContainer center={[31.5, -98.5]} zoom={5} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
      {units.map((u) => (
        <Marker key={u.id} position={[u.lat, u.lng]} icon={icon(u)}>
          <Popup>
            <div style={{ minWidth: 200, font: "13px Manrope, system-ui, sans-serif" }}>
              <div style={{ fontWeight: 800 }}>{u.kind === "truck" ? `Unit ${u.label}` : u.label}</div>
              {u.driver && <div>{u.driver}</div>}
              {u.load && (
                <div style={{ marginTop: 4 }}>
                  <a href={`/orders/${u.load.orderId}`} style={{ color: "#0f766e", fontWeight: 700 }}>
                    {u.load.orderNumber}
                  </a>
                  {u.load.next ? ` → ${u.load.next}` : ""}
                </div>
              )}
              <div style={{ color: "#64748b", marginTop: 4 }}>
                {u.speedMph != null ? `${u.speedMph} mph · ` : ""}
                {u.place ? `${u.place} · ` : ""}
                {new Date(u.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {u.source.replace(/_/g, " ")}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
      <Fit units={units} focus={focus} />
    </MapContainer>
  );
}
