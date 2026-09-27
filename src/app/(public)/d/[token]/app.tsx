"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { driverStepAction, driverPingAction, disputeSettlementLineAction, driverPhotoAction, driverRenewalAction, driverMessageAction } from "../../actions";
import { call } from "@/lib/client-call";
import { LEG_LABEL } from "@/domain/states";
import type { LegState } from "@/db/schema";

/**
 * The driver app (spec §5.2): one screen, one big button, Spanish under English.
 * Works as a phone web page; asks for location and sends it with every step and every 2 minutes.
 * Seal and POD photos at the stop, renewals of their own documents, and a line to dispatch (spec §5.2).
 */

type Stop = { id: string; name: string; type: string; country: string; address: { line1?: string; city?: string; state?: string } | null; windowStart: string | null; windowEnd: string | null; contact: string | null; notes: string | null; arrivedAt?: string | null; departedAt?: string | null; sealIn?: string | null; sealOut?: string | null };
type Item = { leg: { id: string; seq: number; type: string; state: LegState }; order: { orderNumber: string; equipment: string; cargoNote: string | null; refs: Record<string, string> }; from: Stop | null; to: Stop | null; mids?: Stop[]; truck: { unitNumber: string } | null; next: { to: LegState; label: string; es: string } | null; crossing: { id: string; state: string; trailerNumber: string | null; packetToken: string | null; nextStep: string | null } | null; docs: { pod: boolean; seal: boolean }; sealExpected: string | null };
const XSTEP: Record<string, { en: string; es: string }> = { departed_yard: { en: "Departed the yard", es: "Salí del patio" }, at_mx_customs: { en: "At Mexican customs", es: "En aduana mexicana" }, in_us_customs: { en: "At US customs", es: "En aduana americana" }, cleared: { en: "Cleared — US side", es: "Liberado — lado americano" } };
const XLABEL: Record<string, string> = { packet_sent: "Packet sent · Paquete enviado", departed_yard: "Departed yard · Salió del patio", at_mx_customs: "MX customs · Aduana MX", in_us_customs: "US customs · Aduana US", cleared: "Cleared · Liberado", held: "Held · Detenido", returned: "Returned · Regresado" };
type OwnItem = { key: string; label: string; status: string; expiresAt: string | null; documentTypeId: string | null; tracksExpiry: boolean; pending: { fileName: string; at: string } | null; rejected: { reason: string; at: string } | null };
type Msg = { id: string; who: "driver" | "dispatch"; body: string; at: string; seen: boolean };
type Data = { driver: { name: string; driverType: string }; current: Item | null; items: Item[]; own: OwnItem[]; pay: PayStub[]; thread: Msg[]; company: { name: string; dispatchPhone: string | null } };
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
  const [seal, setSeal] = useState("");
  const cur = data.items.find((i) => i.leg.id === sel) ?? data.current;
  // when a seal goes on (leaving a stop loaded) or comes off (opening at a stop), the driver types the number with the step
  const sealAsk: { label: string; es: string } | null = !cur?.next
    ? null
    : cur.next.to === "loaded" || (cur.leg.state === "en_route" && (cur.mids ?? []).some((m) => m.arrivedAt && !m.departedAt))
      ? { label: "Seal applied", es: "Sello puesto" }
      : cur.next.to === "at_delivery" || (cur.leg.state === "en_route" && (cur.mids ?? []).some((m) => !m.arrivedAt))
        ? { label: "Seal found", es: "Sello encontrado" }
        : null;
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
      const r = await driverStepAction(token, cur.leg.id, { lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracyM: fix?.accuracyM ?? null, decline, declineReason: decline ? reason : null, seal: seal.trim() || null });
      if (r.ok) {
        setDeclining(false);
        setReason("");
        setSeal("");
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
            {(cur.mids ?? []).map((m, i) => (
              <Place key={m.id} label={`Stop ${i + 2} · Parada ${i + 2}${m.departedAt ? " · done" : ""}`} s={m} active={cur.leg.state === "en_route" && !m.departedAt && !(cur.mids ?? []).slice(0, i).some((p) => !p.departedAt)} />
            ))}
            <Place label="Deliver · Entregar" s={cur.to} active={["loaded", "at_delivery"].includes(cur.leg.state) || (cur.leg.state === "en_route" && !(cur.mids ?? []).some((m) => !m.departedAt))} />
            {cur.order.cargoNote && <div className="text-[13px] text-muted">📦 {cur.order.cargoNote}</div>}
          </div>
          <div className="px-5 pb-5">
            {cur.leg.state === "at_pickup" && <PhotoButton token={token} legId={cur.leg.id} code="SEAL_PHOTO" done={cur.docs.seal} label="Seal photo · Foto del sello" onDone={() => router.refresh()} />}
            {(cur.leg.state === "at_delivery" || (cur.leg.state === "en_route" && (cur.mids ?? []).some((m) => m.arrivedAt && !m.departedAt))) && <PhotoButton token={token} legId={cur.leg.id} code="POD" done={cur.docs.pod} label="POD photo · Foto del POD" onDone={() => router.refresh()} />}
            {sealAsk && (
              <div className="mb-3" data-testid="seal">
                <input className="input mono" placeholder={`${sealAsk.label} # · ${sealAsk.es}`} value={seal} onChange={(e) => setSeal(e.target.value)} aria-label={sealAsk.label} />
                {sealAsk.label === "Seal found" && cur.sealExpected && <div className="text-[12px] text-muted mt-1">Should be {cur.sealExpected} · Debe ser {cur.sealExpected}</div>}
              </div>
            )}
            {cur.next ? (
              <button className="btn btn-primary w-full justify-center flex-col gap-0" style={{ height: 72, fontSize: 18 }} onClick={() => step(false)} disabled={pending || declining}>
                {pending ? "…" : cur.next.label}
                {!pending && <span className="text-[12.5px] font-semibold opacity-80">{cur.next.es}</span>}
              </button>
            ) : (
              <div className="text-center text-muted">Done · Listo</div>
            )}
            {cur.leg.state === "at_delivery" && !cur.docs.pod && <div className="text-[12.5px] text-amber font-semibold text-center mt-2">No POD photo yet — the office needs it to bill. · Falta la foto del POD.</div>}
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
        <div className="card mt-5 p-4" data-testid="own-docs">
          <div className="eyebrow mb-1">Your documents · Tus documentos</div>
          <ul className="space-y-2 text-[13px]">
            {data.own.map((i) => (
              <OwnDoc key={i.key} token={token} item={i} onDone={() => router.refresh()} />
            ))}
          </ul>
          <div className="help mt-2">Take a photo of the renewal here; the office checks it and it goes on file. · Toma foto de la renovación aquí; la oficina la revisa.</div>
        </div>
      )}
      <Chat token={token} legId={cur?.leg.id ?? null} thread={data.thread} dispatchPhone={data.company.dispatchPhone} onDone={() => router.refresh()} />
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

/** One tap: the camera opens, the photo goes up, a check appears. Never in the way of the milestone button. */
function PhotoButton({ token, legId, code, done, label, onDone }: { token: string; legId: string; code: "POD" | "SEAL_PHOTO"; done: boolean; label: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [just, setJust] = useState(false);
  const ok = done || just;
  return (
    <div className="mb-3" data-testid={`photo-${code}`}>
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
            fd.set("code", code);
            const r = await call(() => driverPhotoAction(token, legId, fd));
            setBusy(false);
            e.target.value = "";
            if (r.ok) {
              setJust(true);
              onDone();
            } else setErr(r.error);
          }}
        />
        {busy ? "Sending… · Enviando…" : ok ? `✓ ${code === "POD" ? "POD" : "Seal · Sello"} on file · tap for another · otra foto` : `📷 ${label}`}
      </label>
      {err && (
        <div className="error mt-1" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

function OwnDoc({ token, item, onDone }: { token: string; item: OwnItem; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const d = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <li>
      <div className="flex justify-between gap-2">
        <span className="font-semibold">{item.label}</span>
        <span className={item.status === "expired" ? "text-red font-bold" : item.status === "missing" ? "text-amber font-bold" : "text-amber font-semibold"}>
          {item.status === "expired" ? "EXPIRED · VENCIDO" : item.status === "missing" ? "missing · falta" : `expires ${item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : ""}`}
        </span>
      </div>
      {item.pending ? (
        <div className="text-[12.5px] text-teal">Sent {d(item.pending.at)} — the office is checking it. · Enviado, la oficina lo revisa.</div>
      ) : (
        <>
          {item.rejected && <div className="text-[12.5px] text-red">The office sent it back: {item.rejected.reason} · Rechazado, manda otra foto.</div>}
          {item.documentTypeId && !open && (
            <button type="button" className="text-[12.5px] text-teal font-semibold" onClick={() => setOpen(true)}>
              📷 Send the new one · Mandar el nuevo
            </button>
          )}
          {open && (
            <form ref={ref} onSubmit={(e) => e.preventDefault()} className="mt-1 space-y-2 rounded-lg border border-line p-2">
              <input type="hidden" name="documentTypeId" value={item.documentTypeId ?? ""} />
              <label className="btn w-full justify-center">
                <input type="file" name="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? null)} />
                {name ? `✓ ${name}` : "📷 Photo · Foto"}
              </label>
              {item.tracksExpiry && (
                <div>
                  <label className="label">Expires · Vence</label>
                  <input type="date" name="expiresAt" className="input" required />
                </div>
              )}
              <input name="number" className="input" placeholder="Number on the card (optional) · Número" />
              {err && <div className="error">{err}</div>}
              <div className="flex gap-2">
                <button type="button" className="btn flex-1 justify-center" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary flex-1 justify-center"
                  disabled={busy || !name}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    const r = await call(() => driverRenewalAction(token, new FormData(ref.current!)));
                    setBusy(false);
                    if (r.ok) {
                      setOpen(false);
                      onDone();
                    } else setErr(r.error);
                  }}
                >
                  {busy ? "…" : "Send · Enviar"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </li>
  );
}

/** A line to dispatch: what the driver wrote and what the office answered. */
function Chat({ token, legId, thread, dispatchPhone, onDone }: { token: string; legId: string | null; thread: Msg[]; dispatchPhone: string | null; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const when = (s: string) => new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await driverMessageAction(token, legId, text);
    setBusy(false);
    if (r.ok) {
      setText("");
      onDone();
    } else setErr(r.error);
  };
  return (
    <div className="card mt-5 p-4" data-testid="chat">
      <div className="flex items-center justify-between mb-1">
        <div className="eyebrow">Dispatch · Despacho</div>
        {dispatchPhone && <DispatchLinks phone={dispatchPhone} />}
      </div>
      {thread.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto mb-2">
          {thread.map((m) => (
            <div key={m.id} className={`text-[13px] rounded-lg px-3 py-1.5 max-w-[85%] ${m.who === "driver" ? "ml-auto bg-teal-soft" : "bg-ground"}`}>
              <div>{m.body}</div>
              <div className="text-[11px] text-faint">
                {m.who === "driver" ? (m.seen ? "seen by dispatch · visto" : "sent · enviado") : "dispatch"} · {when(m.at)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="Message dispatch · Mensaje a despacho" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {err && <div className="error mt-1">{err}</div>}
    </div>
  );
}

/** The fallback when the app is not enough: the company's dispatch number, one tap to call or WhatsApp. */
export function DispatchLinks({ phone }: { phone: string }) {
  const digits = phone.replace(/\D/g, "");
  return (
    <span className="flex gap-1.5" data-testid="dispatch-links">
      <a className="btn btn-sm" href={`tel:+${digits}`}>
        ☎ Call · Llamar
      </a>
      <a className="btn btn-sm" href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer">
        WhatsApp
      </a>
    </span>
  );
}
