"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Toast, useToast } from "@/components/ui";
import { updateOrderAction, addNoteAction, pinNoteAction, deleteNoteAction } from "../actions";
import { UploadDoc } from "@/app/(app)/billing/queue";

/* ---------- tabs ---------- */

export type TabDef = { id: string; label: string; count?: number; content: ReactNode };

/** Tabs whose panels are all rendered on the server; the one in view follows ?tab= so links and reloads land on it. */
export function LoadTabs({ tabs }: { tabs: TabDef[] }) {
  const sp = useSearchParams();
  const initial = tabs.some((t) => t.id === sp.get("tab")) ? sp.get("tab")! : tabs[0].id;
  const [tab, setTab] = useState(initial);
  const pick = (id: string) => {
    setTab(id);
    const url = new URL(window.location.href);
    if (id === tabs[0].id) url.searchParams.delete("tab");
    else url.searchParams.set("tab", id);
    window.history.replaceState(null, "", url.toString());
  };
  return (
    <>
      <nav className="sticky top-12 lg:top-0 z-20 bg-ground/90 backdrop-blur border-b border-line" aria-label="Load sections">
        <div className="px-5 md:px-8 flex gap-1 overflow-x-auto" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`tab-${t.id}`} onClick={() => pick(t.id)} className={`h-12 px-3.5 shrink-0 border-b-2 text-[13.5px] font-semibold transition-colors ${tab === t.id ? "border-teal text-ink" : "border-transparent text-muted hover:text-ink"}`}>
              {t.label}
              {t.count ? <span className="ml-1.5 text-[11px] text-faint tabular-nums">{t.count}</span> : null}
            </button>
          ))}
        </div>
      </nav>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={tab !== t.id} className="px-5 md:px-8 py-6">
          {t.content}
        </div>
      ))}
    </>
  );
}

/* ---------- money box ---------- */

type MoneyOrder = { id: string; rateCents: number | null; rateTbd: boolean; currency: string; rateType: string; rateUnitCents: number | null; rateQty: number | null; fuelRule: string; fuelPct: number | null; fuelCentsPerMile: number | null; tollsFeesCents: number | null; updatedAt: string };
const RATE_TYPES: [string, string, string][] = [
  ["flat", "Flat", ""],
  ["per_mile", "Per mile", "Miles"],
  ["per_cwt", "Per 100 lb (cwt)", "Hundredweight"],
  ["per_unit", "Per unit (pallet, piece)", "Units"],
];
const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

export function MoneyBox({ order, readOnly, suggestedMiles, weightLb }: { order: MoneyOrder; readOnly: boolean; suggestedMiles: number | null; weightLb: number | null }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ rateType: order.rateType, rate: dollars(order.rateCents), rateTbd: order.rateTbd, rateUnit: dollars(order.rateUnitCents), rateQty: order.rateQty != null ? String(order.rateQty) : "", currency: order.currency, fuelRule: order.fuelRule ?? "included", fuelPct: order.fuelPct != null ? String(order.fuelPct) : "", fuelCpm: order.fuelCentsPerMile != null ? String(order.fuelCentsPerMile) : "", tollsFees: dollars(order.tollsFeesCents) });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const unitType = f.rateType !== "flat";
  const unitNum = Number(f.rateUnit.replace(/[$,\s]/g, ""));
  const qtyNum = Number(f.rateQty.replace(/[,\s]/g, ""));
  const figured = unitType && f.rateUnit.trim() && f.rateQty.trim() && Number.isFinite(unitNum) && Number.isFinite(qtyNum) ? unitNum * qtyNum : null;
  const qtyLabel = RATE_TYPES.find(([v]) => v === f.rateType)?.[2] ?? "Quantity";
  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: f.currency }).format(n);
  const save = () =>
    start(async () => {
      setErr(null);
      const r = await updateOrderAction(order.id, { rateType: f.rateType, rate: f.rate, rateTbd: f.rateTbd, rateUnit: unitType ? f.rateUnit : "", rateQty: unitType ? f.rateQty : "", currency: f.currency, fuelRule: f.fuelRule, fuelPct: f.fuelPct, fuelCpm: f.fuelCpm, tollsFees: f.tollsFees }, order.updatedAt);
      if (r.ok) {
        t.ok("Rate saved");
        router.refresh();
      } else setErr(r.error);
    });
  return (
    <fieldset disabled={readOnly} className="card p-6" data-testid="money-box">
      <div className="flex items-baseline justify-between mb-5">
        <div className="text-[16px] font-extrabold tracking-tight">Line haul</div>
        <div className="text-[13px] text-muted">What the customer pays for the move; extras go in Charges below.</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 form-roomy">
        <div>
          <label className="label" htmlFor="m-type">
            Rate type
          </label>
          <select id="m-type" className="select" value={f.rateType} onChange={(e) => setF({ ...f, rateType: e.target.value, rateQty: e.target.value === "per_mile" && !f.rateQty && suggestedMiles ? String(suggestedMiles) : e.target.value === "per_cwt" && !f.rateQty && weightLb ? String(Math.ceil(weightLb / 100)) : f.rateQty })}>
            {RATE_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {unitType ? (
          <>
            <div>
              <label className="label" htmlFor="m-unit">
                Rate {f.rateType === "per_mile" ? "per mile" : f.rateType === "per_cwt" ? "per 100 lb" : "per unit"}
              </label>
              <input id="m-unit" className="input" inputMode="decimal" value={f.rateUnit} onChange={(e) => setF({ ...f, rateUnit: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="label" htmlFor="m-qty">
                {qtyLabel}
              </label>
              <input id="m-qty" className="input" inputMode="numeric" value={f.rateQty} onChange={(e) => setF({ ...f, rateQty: e.target.value })} />
              {f.rateType === "per_mile" && suggestedMiles != null && <div className="help">Planned miles on the legs: {suggestedMiles.toLocaleString("en-US")}</div>}
            </div>
            <div>
              <div className="label">Line haul</div>
              <div className="h-[42px] flex items-center text-[18px] font-extrabold tabular-nums">{figured != null ? fmt(figured) : <span className="text-faint text-[14px] font-semibold">rate × {qtyLabel.toLowerCase()}</span>}</div>
            </div>
          </>
        ) : (
          <div className="md:col-span-2">
            <label className="label" htmlFor="m-rate">
              Rate
            </label>
            <input id="m-rate" className="input" inputMode="decimal" aria-label="Rate" value={f.rate} disabled={f.rateTbd || readOnly} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="0.00" />
            <label className="flex items-center gap-2 mt-2 text-[13px] cursor-pointer text-muted">
              <input type="checkbox" className="accent-teal w-4 h-4" checked={f.rateTbd} onChange={(e) => setF({ ...f, rateTbd: e.target.checked })} /> Rate TBD
            </label>
          </div>
        )}
        <div>
          <label className="label" htmlFor="m-cur">
            Currency
          </label>
          <select id="m-cur" className="select" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            <option>USD</option>
            <option>MXN</option>
            <option>CAD</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="m-fuel">
            Fuel
          </label>
          <select id="m-fuel" className="select" value={f.fuelRule} onChange={(e) => setF({ ...f, fuelRule: e.target.value })} aria-label="Fuel rule">
            <option value="included">Included in the rate</option>
            <option value="pct">Surcharge % of line haul</option>
            <option value="per_mile">Surcharge ¢ per mile</option>
          </select>
        </div>
        {f.fuelRule === "per_mile" && (
          <div>
            <label className="label" htmlFor="m-fuelcpm">
              Fuel surcharge ¢/mile
            </label>
            <input id="m-fuelcpm" className="input" inputMode="numeric" value={f.fuelCpm} onChange={(e) => setF({ ...f, fuelCpm: e.target.value })} aria-label="Fuel cents per mile" />
          </div>
        )}
        {f.fuelRule === "pct" && (
          <div>
            <label className="label" htmlFor="m-fuelpct">
              Fuel surcharge %
            </label>
            <input id="m-fuelpct" className="input" inputMode="numeric" value={f.fuelPct} onChange={(e) => setF({ ...f, fuelPct: e.target.value })} aria-label="Fuel percent" />
          </div>
        )}
        <div>
          <label className="label" htmlFor="m-tolls">
            Tolls &amp; fees (cost)
          </label>
          <input id="m-tolls" className="input" inputMode="decimal" value={f.tollsFees} onChange={(e) => setF({ ...f, tollsFees: e.target.value })} placeholder="0.00" aria-label="Tolls and fees" />
          <div className="help">Known extra cost for the P&amp;L — not billed.</div>
        </div>
      </div>
      {!readOnly && (
        <div className="flex items-center justify-end gap-3 mt-5">
          {err && <span className="error m-0">{err}</span>}
          <button type="button" className="btn btn-primary" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save rate"}
          </button>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </fieldset>
  );
}

/* ---------- people & priority ---------- */

const PRIORITIES: [string, string][] = [
  ["none", "None"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

export function PeopleCard({ order, people, readOnly }: { order: { id: string; salesAgentId: string | null; csrId: string | null; dispatcherId: string | null; priority: string; updatedAt: string }; people: { id: string; name: string }[]; readOnly: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const set = (k: "salesAgentId" | "csrId" | "dispatcherId" | "priority", v: string) =>
    start(async () => {
      const r = await updateOrderAction(order.id, { [k]: v });
      if (r.ok) {
        t.ok("Saved");
        router.refresh();
      } else t.err(r.error);
    });
  const rows: [("salesAgentId" | "csrId" | "dispatcherId"), string][] = [
    ["salesAgentId", "Sales agent"],
    ["csrId", "Customer service"],
    ["dispatcherId", "Dispatcher"],
  ];
  return (
    <fieldset disabled={readOnly || pending} className="card p-5">
      <div className="text-[14px] font-extrabold mb-3">People &amp; priority</div>
      <div className="space-y-3">
        {rows.map(([k, l]) => (
          <div key={k} className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-3">
            <label className="text-[13px] text-muted" htmlFor={`p-${k}`}>
              {l}
            </label>
            <select id={`p-${k}`} className="select h-9 text-[13px]" value={order[k] ?? ""} onChange={(e) => set(k, e.target.value)}>
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div>
          <span className="text-[13px] text-muted block mb-1.5">Priority</span>
          <div className="flex w-full rounded-lg border border-line bg-ground p-0.5" role="group" aria-label="Priority">
            {PRIORITIES.map(([v, l]) => (
              <button key={v} type="button" aria-pressed={order.priority === v} onClick={() => set("priority", v)} className={`flex-1 min-w-0 px-1.5 h-8 rounded-md text-[12.5px] font-semibold ${order.priority === v ? (v === "high" ? "bg-red text-white" : v === "medium" ? "bg-amber text-white" : "bg-white text-ink shadow-sm") : "text-muted hover:text-ink"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </fieldset>
  );
}

/* ---------- notes ---------- */

type Note = { id: string; kind: string; body: string; pinned: boolean; author: string | null; createdAt: string; createdBy: string | null };
export const NOTE_LABEL: Record<string, string> = { general: "General", dispatch: "Dispatch", billing: "Billing", safety: "Safety", customer: "Customer" };
const NOTE_TONE: Record<string, string> = { general: "slate", dispatch: "blue", billing: "green", safety: "red", customer: "teal" };

export function NotesPanel({ orderId, notes, me, isOwner }: { orderId: string; notes: Note[]; me: string | null; isOwner: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [kind, setKind] = useState("general");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [filter, setFilter] = useState("all");
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, label: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        after?.();
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  const shown = filter === "all" ? notes : notes.filter((n) => n.kind === filter);
  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
      <div className="space-y-3">
        <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Note types">
          {["all", ...Object.keys(NOTE_LABEL)].map((k) => (
            <button key={k} type="button" className="quick-chip" data-active={filter === k} onClick={() => setFilter(k)}>
              {k === "all" ? "All" : NOTE_LABEL[k]}
              <span className="count">{k === "all" ? notes.length : notes.filter((n) => n.kind === k).length}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <div className="card p-10 text-center text-muted text-[13.5px]">No notes{filter !== "all" ? ` of this type` : ""} yet.</div>
        ) : (
          shown.map((n) => (
            <div key={n.id} className={`card p-4 ${n.pinned ? "border-teal" : ""}`} data-testid="note">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`pill pill-${NOTE_TONE[n.kind] ?? "slate"}`}>{NOTE_LABEL[n.kind] ?? n.kind}</span>
                {n.pinned && <span className="text-[11.5px] font-bold text-teal">Pinned</span>}
                <span className="text-[12px] text-muted ml-auto">
                  {n.author ?? "someone"} · {new Date(n.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <div className="text-[14px] whitespace-pre-wrap">{n.body}</div>
              <div className="flex gap-3 mt-2 text-[12px]">
                <button type="button" className="text-muted hover:text-ink font-semibold" disabled={pending} onClick={() => run(() => pinNoteAction(orderId, n.id, !n.pinned), n.pinned ? "Unpinned" : "Pinned")}>
                  {n.pinned ? "Unpin" : "Pin"}
                </button>
                {(n.createdBy === me || isOwner) && (
                  <button type="button" className="text-red font-semibold" disabled={pending} onClick={() => run(() => deleteNoteAction(orderId, n.id), "Note deleted")}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="card p-5 lg:sticky lg:top-16">
        <div className="text-[14px] font-extrabold mb-3">Add a note</div>
        <label className="label" htmlFor="n-kind">
          Type
        </label>
        <select id="n-kind" className="select mb-3" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(NOTE_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <label className="label" htmlFor="n-body">
          Note
        </label>
        <textarea id="n-body" className="textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="flex items-center gap-2 mt-2 text-[13px] cursor-pointer text-muted">
          <input type="checkbox" className="accent-teal w-4 h-4" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top
        </label>
        <button type="button" className="btn btn-primary w-full justify-center mt-4" disabled={pending || !body.trim()} onClick={() => run(() => addNoteAction(orderId, kind, body, pinned), "Note added", () => (setBody(""), setPinned(false)))}>
          Add note
        </button>
      </div>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

/* ---------- documents ---------- */

type Doc = { id: string; code: string | null; fileName: string; status: string; source: string; createdAt: string; author: string | null };
const DOC_CODES: [string, string][] = [
  ["RATE_CON", "Rate confirmation"],
  ["BOL", "Bill of lading"],
  ["POD", "Proof of delivery"],
  ["LUMPER", "Lumper receipt"],
  ["SCALE", "Scale ticket"],
  ["INVOICE", "Customer invoice"],
  ["OTHER", "Other"],
];

export function DocumentsPanel({ orderId, docs, required, canUpload }: { orderId: string; docs: Doc[]; required: string[]; canUpload: boolean }) {
  const router = useRouter();
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [code, setCode] = useState("RATE_CON");
  const label = (c: string | null) => DOC_CODES.find(([v]) => v === c)?.[1] ?? (c ?? "Document").replace(/_/g, " ");
  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
      <div className="card overflow-hidden">
        {docs.length === 0 ? (
          <div className="p-10 text-center text-muted text-[13.5px]">No documents on this load yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>File</th>
                <th>From</th>
                <th>Added</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="font-semibold">{label(d.code)}</td>
                  <td>
                    <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="text-teal font-semibold hover:underline">
                      {d.fileName}
                    </a>
                  </td>
                  <td className="text-muted text-[12.5px]">{d.author ?? d.source.replace(/_/g, " ")}</td>
                  <td className="text-muted text-[12.5px]">{new Date(d.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>
                    <span className={`pill ${d.status === "verified" ? "pill-green" : d.status === "pending" ? "pill-amber" : "pill-slate"}`}>{d.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="space-y-4">
        <div className="card p-5">
          <div className="text-[14px] font-extrabold mb-3">Needed to bill</div>
          <ul className="space-y-2 text-[13px]">
            {required.map((c) => {
              const has = docs.some((d) => d.code === c && d.status !== "pending");
              return (
                <li key={c} className="flex items-center gap-2.5">
                  <span className={`w-5 h-5 rounded-full grid place-items-center text-[11px] font-extrabold ${has ? "bg-teal text-white" : "border-2 border-line"}`}>{has ? "✓" : ""}</span>
                  <span className={has ? "" : "text-muted"}>{label(c)}</span>
                  {!has && canUpload && (
                    <button type="button" className="ml-auto text-teal font-semibold text-[12.5px]" onClick={() => setUploadFor(c)}>
                      Upload
                    </button>
                  )}
                </li>
              );
            })}
            {required.length === 0 && <li className="text-muted">Nothing required.</li>}
          </ul>
        </div>
        {canUpload && (
          <div className="card p-5">
            <div className="text-[14px] font-extrabold mb-3">Add a document</div>
            <select className="select mb-3" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Document type">
              {DOC_CODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <button type="button" className="btn w-full justify-center" onClick={() => setUploadFor(code)}>
              Choose file…
            </button>
          </div>
        )}
      </div>
      {uploadFor && <UploadDoc orderId={orderId} code={uploadFor} onClose={() => setUploadFor(null)} onDone={() => (setUploadFor(null), router.refresh())} />}
    </div>
  );
}
