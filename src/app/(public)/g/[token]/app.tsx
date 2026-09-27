"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { carrierDriverStepAction, carrierDriverPingAction, carrierDriverPodAction } from "../../actions";
import { call } from "@/lib/client-call";
import { useWhen } from "@/components/zone";
import { DispatchLinks } from "../../d/[token]/app";

/** The partner carrier's driver: one load, one big button, Spanish under English, GPS with every press and every 2 minutes. */

type Stop = { id: string; name: string; type: string; country: string; address: { line1?: string; city?: string; state?: string } | null; windowStart: string | null; windowEnd: string | null; contact: string | null; notes: string | null; arrivedAt: string | null; departedAt: string | null };
type Data = { company: string; dispatchPhone: string | null; carrier: string; driverName: string | null; leg: { id: string; state: string; stateLabel: string; type: string; done: boolean }; order: { orderNumber: string; equipment: string | null; cargoNote: string | null }; from: Stop | null; to: Stop | null; mids: Stop[]; next: { to: string; en: string; es: string } | null; podOnFile: boolean };
type Fix = { lat: number; lng: number; accuracyM: number | null; speedMph: number | null; heading: number | null };

function getFix(timeout = 8000): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy ? Math.round(p.coords.accuracy) : null, speedMph: p.coords.speed != null ? Math.round(p.coords.speed * 2.23694) : null, heading: p.coords.heading != null ? Math.round(p.coords.heading) : null }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}
const addr = (s: Stop | null) => (s ? [s.address?.line1, s.address?.city, s.address?.state].filter(Boolean).join(", ") : "");
const mapsHref = (s: Stop) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.name, addr(s)].filter(Boolean).join(", "))}`;

export function CarrierDriverApp({ token, data }: { token: string; data: Data }) {
  const router = useRouter();
  const when = useWhen({ weekday: "short" });
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [gps, setGps] = useState<"unknown" | "on" | "off">("unknown");
  const lastPing = useRef(0);
  const live = !data.leg.done;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    const ping = async () => {
      const fix = await getFix();
      if (!alive) return;
      setGps(fix ? "on" : "off");
      if (fix && Date.now() - lastPing.current > 90_000) {
        lastPing.current = Date.now();
        carrierDriverPingAction(token, fix).catch(() => null);
      }
    };
    ping();
    const id = setInterval(() => document.visibilityState === "visible" && ping(), 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token, live]);

  const step = () =>
    start(async () => {
      setErr(null);
      const fix = await getFix(6000);
      setGps(fix ? "on" : "off");
      const r = await carrierDriverStepAction(token, { lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracyM: fix?.accuracyM ?? null });
      if (r.ok) router.refresh();
      else setErr(r.error);
    });
  const st = data.leg.state;
  const atDelivery = st === "at_delivery" || (st === "en_route" && data.mids.some((m) => m.arrivedAt && !m.departedAt));

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="eyebrow">
            {data.company} · {data.carrier}
          </div>
          <div className="h1">{data.driverName ?? "Driver · Chofer"}</div>
        </div>
        {live && <span className={`pill ${gps === "on" ? "pill-green" : gps === "off" ? "pill-amber" : "pill-slate"}`}>{gps === "on" ? "GPS on" : gps === "off" ? "GPS off" : "GPS…"}</span>}
      </div>
      <div className="card mt-4 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line flex items-center justify-between">
          <div>
            <div className="font-extrabold mono text-[15px]">{data.order.orderNumber}</div>
            <div className="text-muted text-[12.5px]">
              {data.leg.type} leg{data.order.equipment ? ` · ${data.order.equipment.replace("_", " ")}` : ""}
            </div>
          </div>
          <span className="pill pill-teal">{data.leg.stateLabel}</span>
        </div>
        <div className="px-5 py-4 space-y-4">
          <Place label="Pickup · Recoger" s={data.from} active={["accepted", "en_route_to_pickup", "at_pickup"].includes(st)} when={when} />
          {data.mids.map((m, i) => (
            <Place key={m.id} label={`Stop ${i + 2} · Parada ${i + 2}${m.departedAt ? " · done" : ""}`} s={m} active={st === "en_route" && !m.departedAt && !data.mids.slice(0, i).some((p) => !p.departedAt)} when={when} />
          ))}
          <Place label="Deliver · Entregar" s={data.to} active={["loaded", "at_delivery"].includes(st) || (st === "en_route" && !data.mids.some((m) => !m.departedAt))} when={when} />
          {data.order.cargoNote && <div className="text-[13px] text-muted">📦 {data.order.cargoNote}</div>}
        </div>
        <div className="px-5 pb-5">
          {atDelivery && <PodButton token={token} done={data.podOnFile} onDone={() => router.refresh()} />}
          {data.next ? (
            <button className="btn btn-primary w-full justify-center flex-col gap-0" style={{ height: 72, fontSize: 18 }} onClick={step} disabled={pending}>
              {pending ? "…" : data.next.en}
              {!pending && <span className="text-[12.5px] font-semibold opacity-80">{data.next.es}</span>}
            </button>
          ) : (
            <div className="text-center text-muted">{data.leg.done ? "Done — thank you · Listo, gracias" : "Waiting for dispatch · Esperando a despacho"}</div>
          )}
          {st === "at_delivery" && !data.podOnFile && <div className="text-[12.5px] text-amber font-semibold text-center mt-2">Take the POD photo before you leave. · Toma la foto del POD antes de salir.</div>}
          {err && (
            <div className="error mt-2" role="alert">
              {err}
            </div>
          )}
        </div>
      </div>
      {data.dispatchPhone && (
        <div className="card mt-4 p-4 flex items-center justify-between gap-2">
          <div>
            <div className="eyebrow">{data.company} dispatch · Despacho</div>
            <div className="text-[12.5px] text-muted">Problem at the dock, a hold, anything: one tap. · Cualquier problema, un toque.</div>
          </div>
          <DispatchLinks phone={data.dispatchPhone} />
        </div>
      )}
      {live && <div className="mt-5 text-center text-[12px] text-faint">Keep this page open while driving so {data.company} can see you. · Deja esta página abierta.</div>}
    </div>
  );
}

function Place({ label, s, active, when }: { label: string; s: Stop | null; active: boolean; when: (d: string | Date | null | undefined) => string | null }) {
  return (
    <div className={`rounded-lg border p-3 ${active ? "border-teal bg-teal-soft/40" : "border-line"}`}>
      <div className="text-[11px] font-bold tracking-wider uppercase text-faint">{label}</div>
      <div className="font-extrabold text-[15px] mt-0.5">{s?.name ?? "—"}</div>
      {s && addr(s) && <div className="text-[13px] text-muted">{addr(s)}</div>}
      {s?.windowStart && (
        <div className="text-[13px] font-semibold text-teal">
          {when(s.windowStart)}
          {s.windowEnd ? ` – ${when(s.windowEnd)}` : ""}
        </div>
      )}
      {s?.notes && <div className="text-[13px] mt-1">📝 {s.notes}</div>}
      {s?.contact && <div className="text-[13px] text-muted">☎ {s.contact}</div>}
      {s && (
        <a className="btn btn-sm mt-2" href={mapsHref(s)} target="_blank" rel="noreferrer">
          Navigate · Ir
        </a>
      )}
    </div>
  );
}

function PodButton({ token, done, onDone }: { token: string; done: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [just, setJust] = useState(false);
  const ok = done || just;
  return (
    <div className="mb-3" data-testid="photo-POD">
      <label className={`btn w-full justify-center ${ok ? "btn-ghost text-teal" : ""}`} style={{ height: 48 }}>
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className="hidden"
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setErr(null);
            const fd = new FormData();
            fd.set("file", f);
            const r = await call(() => carrierDriverPodAction(token, fd));
            setBusy(false);
            e.target.value = "";
            if (r.ok) {
              setJust(true);
              onDone();
            } else setErr(r.error);
          }}
        />
        {busy ? "Sending… · Enviando…" : ok ? "✓ POD on file · tap for another · otra foto" : "📷 POD photo · Foto del POD"}
      </label>
      {err && (
        <div className="error mt-1" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
