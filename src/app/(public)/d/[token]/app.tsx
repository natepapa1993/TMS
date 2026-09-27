"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { driverStepAction, driverPingAction, disputeSettlementLineAction } from "../../actions";
import { LEG_LABEL } from "@/domain/states";
import type { LegState } from "@/db/schema";

/**
 * The driver app (spec §5.2): one screen, one big button, Spanish under English.
 * Works as a phone web page; asks for location and sends it with every step and every 2 minutes.
 */

type Stop = { id: string; name: string; type: string; country: string; address: { line1?: string; city?: string; state?: string } | null; windowStart: string | null; windowEnd: string | null; contact: string | null; notes: string | null };
type Item = { leg: { id: string; seq: number; type: string; state: LegState }; order: { orderNumber: string; equipment: string; cargoNote: string | null; refs: Record<string, string> }; from: Stop | null; to: Stop | null; truck: { unitNumber: string } | null; next: { to: LegState; label: string; es: string } | null; crossing: { id: string; state: string; trailerNumber: string | null; packetToken: string | null; nextStep: string | null } | null };
const XSTEP: Record<string, { en: string; es: string }> = { departed_yard: { en: "Departed the yard", es: "Salí del patio" }, at_mx_customs: { en: "At Mexican customs", es: "En aduana mexicana" }, in_us_customs: { en: "At US customs", es: "En aduana americana" }, cleared: { en: "Cleared — US side", es: "Liberado — lado americano" } };
const XLABEL: Record<string, string> = { packet_sent: "Packet sent · Paquete enviado", departed_yard: "Departed yard · Salió del patio", at_mx_customs: "MX customs · Aduana MX", in_us_customs: "US customs · Aduana US", cleared: "Cleared · Liberado", held: "Held · Detenido", returned: "Returned · Regresado" };
type Data = { driver: { name: string; driverType: string }; current: Item | null; items: Item[]; own: { label: string; status: string; expiresAt: string | null }[]; pay: PayStub[] };
type PayLine = { id: string; kind: string; orderNumber?: string | null; description: string; amountCents: number; disputed?: string | null; response?: string | null };
type PayStub = { id: string; periodStart: string; periodEnd: string; state: string; currency: string; lines: PayLine[]; grossCents: number; deductionsCents: number; netCents: number; paidAt: string | null };
const money = (c: number, cur = "USD") => `${cur === "MXN" ? "MX$" : "$"}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const PAY_STATE: Record<string, string> = { reviewed: "In review · En revisión", approved: "Approved · Aprobado", paid: "Paid · Pagado" };

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
const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
const mapsHref = (s: Stop | null) => (s ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.name, addr(s)].filter(Boolean).join(", "))}` : "#");

export function DriverApp({ token, data }: { token: string; data: Data }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [gps, setGps] = useState<"unknown" | "on" | "off">("unknown");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [holding, setHolding] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const cur = data.items.find((i) => i.leg.id === sel) ?? data.current;
  const lastPing = useRef(0);

  // location: one fix on open, then every 2 minutes while the page is visible
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const fix = await getFix();
      if (!alive) return;
      setGps(fix ? "on" : "off");
      if (fix && Date.now() - lastPing.current > 90_000) {
        lastPing.current = Date.now();
        driverPingAction(token, fix).catch(() => null);
      }
    };
    ping();
    const id = setInterval(() => document.visibilityState === "visible" && ping(), 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token]);

  const step = (decline = false) =>
    start(async () => {
      setErr(null);
      if (!cur) return;
      const fix = await getFix(6000);
      setGps(fix ? "on" : "off");
      const r = await driverStepAction(token, cur.leg.id, { lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracyM: fix?.accuracyM ?? null, decline, declineReason: decline ? reason : null });
      if (r.ok) {
        setDeclining(false);
        setReason("");
        router.refresh();
      } else setErr(r.error);
    });

  const xstep = (to: string | null, holdWhy?: string) =>
    start(async () => {
      setErr(null);
      if (!cur) return;
      const fix = await getFix(6000);
      setGps(fix ? "on" : "off");
      const r = await driverStepAction(token, cur.leg.id, { lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracyM: fix?.accuracyM ?? null, crossingStep: holdWhy ? null : to, crossingHold: holdWhy ?? null });
      if (r.ok) {
        setHolding(false);
        setHoldReason("");
        router.refresh();
      } else setErr(r.error);
    });
  const x = cur?.crossing;
  const xActive = x && ["packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "held"].includes(x.state);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="eyebrow">Driver · Chofer</div>
          <div className="h1">{data.driver.name}</div>
        </div>
        <span className={`pill ${gps === "on" ? "pill-green" : gps === "off" ? "pill-amber" : "pill-slate"}`}>{gps === "on" ? "GPS on" : gps === "off" ? "GPS off" : "GPS…"}</span>
      </div>

      {!cur ? (
        <div className="card p-6 mt-4 text-center">
          <div className="h2">Nothing assigned right now</div>
          <div className="text-muted mt-1">Nada asignado por ahora. Dispatch will send your next load here.</div>
        </div>
      ) : (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-line flex items-center justify-between">
            <div>
              <div className="font-extrabold mono text-[15px]">{cur.order.orderNumber}</div>
              <div className="text-muted text-[12.5px]">
                {cur.truck ? `Unit ${cur.truck.unitNumber} · ` : ""}
                {cur.order.equipment.replace("_", " ")}
              </div>
            </div>
            <span className="pill pill-teal">{LEG_LABEL[cur.leg.state]}</span>
          </div>
          <div className="px-5 py-4 space-y-4">
            <Place label="Pickup · Recoger" s={cur.from} active={["accepted", "en_route_to_pickup", "at_pickup"].includes(cur.leg.state)} />
            <Place label="Deliver · Entregar" s={cur.to} active={["loaded", "en_route", "at_delivery"].includes(cur.leg.state)} />
            {cur.order.cargoNote && <div className="text-[13px] text-muted">📦 {cur.order.cargoNote}</div>}
          </div>
          <div className="px-5 pb-5">
            {cur.next ? (
              <button className="btn btn-primary w-full justify-center flex-col gap-0" style={{ height: 72, fontSize: 18 }} onClick={() => step(false)} disabled={pending || declining}>
                {pending ? "…" : cur.next.label}
                {!pending && <span className="text-[12.5px] font-semibold opacity-80">{cur.next.es}</span>}
              </button>
            ) : (
              <div className="text-center text-muted">Done · Listo</div>
            )}
            {(cur.leg.state === "dispatched" || cur.leg.state === "accepted") &&
              (declining ? (
                <div className="mt-3 space-y-2">
                  <input className="input" placeholder="Why? / ¿Por qué?" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <div className="flex gap-2">
                    <button className="btn flex-1 justify-center" onClick={() => setDeclining(false)}>
                      Back
                    </button>
                    <button className="btn btn-danger flex-1 justify-center" onClick={() => step(true)} disabled={pending || !reason.trim()}>
                      Can&apos;t take it
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost w-full justify-center mt-2 text-muted" onClick={() => setDeclining(true)}>
                  I can&apos;t take this load · No puedo
                </button>
              ))}
            {err && (
              <div className="error mt-2" role="alert">
                {err}
              </div>
            )}
          </div>
        </div>
      )}

      {cur && xActive && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-line flex items-center justify-between">
            <div>
              <div className="font-extrabold text-[15px]">Border · Frontera</div>
              <div className="text-muted text-[12.5px]">{x!.trailerNumber ? `Caja ${x!.trailerNumber}` : ""}</div>
            </div>
            <span className={`pill ${x!.state === "held" ? "pill-red" : "pill-amber"}`}>{XLABEL[x!.state] ?? x!.state}</span>
          </div>
          <div className="px-5 py-4 space-y-3">
            {x!.packetToken && (
              <a className="btn btn-lg w-full justify-center" href={`/p/${x!.packetToken}`} target="_blank" rel="noreferrer">
                📄 Open packet · Abrir paquete
              </a>
            )}
            {x!.state !== "held" && x!.nextStep && (
              <button className="btn btn-primary w-full justify-center flex-col gap-0" style={{ height: 64, fontSize: 17 }} onClick={() => xstep(x!.nextStep)} disabled={pending || holding}>
                {XSTEP[x!.nextStep]?.en}
                <span className="text-[12.5px] font-semibold opacity-80">{XSTEP[x!.nextStep]?.es}</span>
              </button>
            )}
            {x!.state !== "held" &&
              (holding ? (
                <div className="space-y-2">
                  <input className="input" placeholder="What's wrong? / ¿Qué pasa?" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} autoFocus />
                  <div className="flex gap-2">
                    <button className="btn flex-1 justify-center" onClick={() => setHolding(false)}>
                      Back
                    </button>
                    <button className="btn btn-danger flex-1 justify-center" onClick={() => xstep(null, holdReason)} disabled={pending || !holdReason.trim()}>
                      Report hold
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost w-full justify-center text-red" onClick={() => setHolding(true)}>
                  Stopped / secondary · Detenido
                </button>
              ))}
            {x!.state === "held" && <div className="text-[13px] text-red text-center">Dispatch knows. Wait for instructions. · Despacho ya sabe. Espera instrucciones.</div>}
          </div>
        </div>
      )}

      {data.items.length > 1 && (
        <div className="mt-5">
          <div className="eyebrow mb-2">All your loads · Todas tus cargas</div>
          <div className="card divide-y divide-line">
            {data.items.map((i) => (
              <button key={i.leg.id} className={`w-full text-left px-4 py-3 flex items-center justify-between ${i.leg.id === cur?.leg.id ? "bg-teal-soft" : ""}`} onClick={() => setSel(i.leg.id)}>
                <div>
                  <div className="font-bold mono text-[13.5px]">{i.order.orderNumber}</div>
                  <div className="text-muted text-[12.5px] truncate">
                    {i.from?.name} → {i.to?.name}
                  </div>
                </div>
                <span className="pill pill-slate">{LEG_LABEL[i.leg.state]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {data.own.length > 0 && (
        <div className="card mt-5 p-4">
          <div className="eyebrow mb-1">Your documents · Tus documentos</div>
          <ul className="space-y-1 text-[13px]">
            {data.own.map((i) => (
              <li key={i.label} className="flex justify-between">
                <span>{i.label}</span>
                <span className={i.status === "expired" ? "text-red font-bold" : i.status === "missing" ? "text-amber font-bold" : "text-amber font-semibold"}>
                  {i.status === "expired" ? "EXPIRED · VENCIDO" : i.status === "missing" ? "missing · falta" : `expires ${i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : ""}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="help mt-1">Send a photo of the renewal to dispatch. · Manda foto de la renovación a despacho.</div>
        </div>
      )}
      {data.pay.length > 0 && (
        <div className="card mt-5 p-4">
          <div className="eyebrow mb-1">Your pay · Tu pago</div>
          <div className="space-y-2">
            {data.pay.map((p) => (
              <PayCard key={p.id} token={token} stub={p} onChanged={() => router.refresh()} />
            ))}
          </div>
        </div>
      )}
      <div className="mt-5 text-center text-[12px] text-faint">Keep this page open while driving so dispatch can see you. · Deja esta página abierta.</div>
    </div>
  );
}

function Place({ label, s, active }: { label: string; s: Stop | null; active: boolean }) {
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

function PayCard({ token, stub, onChanged }: { token: string; stub: PayStub; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const d = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="rounded-lg border border-line p-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div>
          <div className="font-extrabold text-[14px]">
            Week of {d(stub.periodStart)} – {d(new Date(new Date(stub.periodEnd).getTime() - 1).toISOString())}
          </div>
          <div className={`text-[12px] font-semibold ${stub.state === "paid" ? "text-teal" : "text-muted"}`}>{PAY_STATE[stub.state] ?? stub.state}</div>
        </div>
        <div className="text-right">
          <div className="font-extrabold text-[16px]">{money(stub.netCents, stub.currency)}</div>
          <div className="text-[11px] text-faint">net · neto</div>
        </div>
      </button>
      {open && (
        <div className="mt-2 border-t border-line pt-2">
          <ul className="space-y-1 text-[13px]">
            {stub.lines.map((l) => (
              <li key={l.id}>
                <div className="flex justify-between gap-2">
                  <span>
                    {l.orderNumber ? <b>{l.orderNumber} · </b> : null}
                    {l.description}
                  </span>
                  <span className={`font-semibold ${l.amountCents < 0 ? "text-red" : ""}`}>{money(l.amountCents, stub.currency)}</span>
                </div>
                {l.disputed ? (
                  <div className="text-[12px] text-amber">
                    Disputed: {l.disputed}
                    {l.response ? ` — ${l.response}` : " (waiting for office · esperando oficina)"}
                  </div>
                ) : stub.state !== "paid" ? (
                  <button type="button" className="text-[12px] text-teal font-semibold" onClick={() => setDisputing(l.id)}>
                    Something wrong? · ¿Algo mal?
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[12px] text-muted flex justify-between">
            <span>Gross · Bruto {money(stub.grossCents, stub.currency)}</span>
            <span>Deductions · Deducciones -{money(stub.deductionsCents, stub.currency)}</span>
          </div>
          {disputing && (
            <div className="mt-2">
              <textarea className="w-full" rows={2} placeholder="What is wrong? · ¿Qué está mal?" value={why} onChange={(e) => setWhy(e.target.value)} />
              {err && <div className="text-red text-[12px]">{err}</div>}
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending || !why.trim()}
                  onClick={() =>
                    start(async () => {
                      setErr(null);
                      const r = await disputeSettlementLineAction(token, stub.id, disputing, why);
                      if (!r.ok) return setErr(r.error);
                      setDisputing(null);
                      setWhy("");
                      onChanged();
                    })
                  }
                >
                  Send · Enviar
                </button>
                <button type="button" className="btn" onClick={() => setDisputing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
