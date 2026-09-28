"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { saveFuelTableAction, deleteFuelTableAction, setFuelPriceAction } from "../actions";

type Band = { from: number; to: number | null; value: number };
type Table = { id: string; name: string; method: string; bands: Band[]; isDefault: boolean };
type Draft = { id: string | null; name: string; method: string; isDefault: boolean; bands: { from: string; to: string; value: string }[] };

const gal = (c: number) => `$${(c / 100).toFixed(2)}`;
const surcharge = (method: string, v: number) => (method === "per_mile" ? `${v}¢/mi` : `${(v / 100).toFixed(2).replace(/\.00$/, "")}%`);
const toDraft = (t?: Table): Draft =>
  t
    ? { id: t.id, name: t.name, method: t.method, isDefault: t.isDefault, bands: t.bands.map((b) => ({ from: (b.from / 100).toFixed(2), to: b.to != null ? (b.to / 100).toFixed(2) : "", value: t.method === "per_mile" ? String(b.value) : String(b.value / 100) })) }
    : { id: null, name: "", method: "pct", isDefault: false, bands: [{ from: "", to: "", value: "" }] };

/** Next band starts where the last one ended, a nickel up. */
function nextBand(d: Draft) {
  const last = d.bands[d.bands.length - 1];
  const from = last?.to || (last?.from ? (Number(last.from) + 0.05).toFixed(2) : "");
  const to = from ? (Number(from) + 0.05).toFixed(2) : "";
  return { from, to, value: "" };
}

export function FuelScreen({ tables, prices, today, thisWeek, current, now, canEdit }: { tables: Table[]; prices: { weekOf: string; priceCents: number; source: string }[]; today: string; thisWeek: string; current: { weekOf: string; priceCents: number } | null; now: { table: string; method: string; value: number } | null; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [price, setPrice] = useState({ date: today, amount: "" });

  const save = () =>
    draft &&
    start(async () => {
      setErr(null);
      const r = await saveFuelTableAction(draft);
      if (!r.ok) return setErr(r.error);
      setDraft(null);
      t.ok("Table saved");
      router.refresh();
    });
  const savePrice = () =>
    start(async () => {
      const r = await setFuelPriceAction(price.date, price.amount);
      if (!r.ok) return t.err(r.error);
      setPrice({ date: today, amount: "" });
      t.ok(`Diesel price saved for the week of ${r.data.weekOf}`);
      router.refresh();
    });
  const setBand = (i: number, k: "from" | "to" | "value", v: string) => draft && setDraft({ ...draft, bands: draft.bands.map((b, j) => (j === i ? { ...b, [k]: v } : b)) });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px] items-start">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-headline font-bold">Surcharge tables</h2>
          {canEdit && (
            <button className="btn btn-primary" onClick={() => { setErr(null); setDraft(toDraft()); }}>
              + New table
            </button>
          )}
        </div>
        {!tables.length && <div className="card p-6 text-muted text-body">No fuel tables yet. Add the one your customers bill against (most follow the DOE weekly diesel average: a surcharge band for every 5¢ the price moves).</div>}
        {tables.map((tb) => (
          <div key={tb.id} className="card p-5" data-testid="fuel-table">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-bold text-headline flex items-center gap-2">
                  {tb.name} {tb.isDefault && <Pill tone="teal">Default</Pill>}
                </div>
                <div className="text-muted text-callout">{tb.method === "per_mile" ? "Cents per mile" : "Percent of line haul"} · {tb.bands.length} band{tb.bands.length === 1 ? "" : "s"}</div>
              </div>
              {canEdit && (
                <button className="btn btn-sm" onClick={() => { setErr(null); setDraft(toDraft(tb)); }}>
                  Edit
                </button>
              )}
            </div>
            <table className="w-full mt-3 text-callout">
              <thead>
                <tr className="text-left text-faint">
                  <th className="font-semibold py-1">Diesel from</th>
                  <th className="font-semibold py-1">Up to</th>
                  <th className="font-semibold py-1 text-right">Surcharge</th>
                </tr>
              </thead>
              <tbody>
                {tb.bands.map((b, i) => {
                  const hit = current && current.priceCents >= b.from && (b.to == null || current.priceCents < b.to);
                  return (
                    <tr key={i} className={`border-t border-line ${hit ? "bg-teal/10 font-semibold" : ""}`}>
                      <td className="py-1.5">{gal(b.from)}</td>
                      <td className="py-1.5">{b.to != null ? gal(b.to) : "and up"}</td>
                      <td className="py-1.5 text-right tabular-nums">{surcharge(tb.method, b.value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <aside className="card p-5 space-y-4" data-testid="fuel-prices">
        <div>
          <div className="eyebrow">This week ({thisWeek})</div>
          <div className="text-title1 font-extrabold tabular-nums" data-testid="fuel-current">{current ? `${gal(current.priceCents)}/gal` : "No price"}</div>
          <div className="text-muted text-callout">{now ? `${now.table}: ${surcharge(now.method, now.value)} surcharge` : current ? "Set a default table to see the surcharge" : "Enter the week's diesel price below"}</div>
          {current && current.weekOf !== thisWeek && <div className="text-amber-700 text-callout mt-1">Using the week of {current.weekOf} — enter this week&apos;s price.</div>}
        </div>
        {canEdit && (
          <div className="border-t border-line pt-4 space-y-2">
            <div className="font-semibold text-body">Enter a weekly diesel price</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="fp-date">Week of</label>
                <input id="fp-date" type="date" className="input" value={price.date} onChange={(e) => setPrice({ ...price, date: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="fp-price">$ / gallon</label>
                <input id="fp-price" className="input" inputMode="decimal" placeholder="3.85" value={price.amount} onChange={(e) => setPrice({ ...price, amount: e.target.value })} />
              </div>
            </div>
            <button className="btn w-full" disabled={pending} onClick={savePrice}>
              Save price
            </button>
          </div>
        )}
        <div className="border-t border-line pt-3">
          <div className="font-semibold text-body mb-1">History</div>
          {!prices.length && <div className="text-faint text-callout">No prices yet.</div>}
          <ul className="text-callout divide-y divide-line">
            {prices.map((p) => (
              <li key={p.weekOf} className="flex justify-between py-1.5" data-testid="fuel-price-row">
                <span>Week of {p.weekOf}</span>
                <span className="tabular-nums font-semibold">{gal(p.priceCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        wide
        title={draft?.id ? `Edit ${draft.name}` : "New fuel table"}
        footer={
          <>
            {draft?.id && (
              <button
                className="btn btn-danger mr-auto"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await deleteFuelTableAction(draft.id!);
                    if (!r.ok) return setErr(r.error);
                    setDraft(null);
                    router.refresh();
                  })
                }
              >
                Delete
              </button>
            )}
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending} onClick={save}>
              Save table
            </button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            {err && <div className="text-red-700 text-callout" role="alert">{err}</div>}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="ft-name">Name</label>
                <input id="ft-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="DOE national average" />
              </div>
              <div>
                <label className="label" htmlFor="ft-method">Surcharge is</label>
                <select id="ft-method" className="select" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
                  <option value="pct">Percent of line haul</option>
                  <option value="per_mile">Cents per mile</option>
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-callout">
              <input type="checkbox" className="accent-teal w-4 h-4" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default table (used by lane rates set to &quot;fuel table&quot;)
            </label>
            <div>
              <div className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 text-faint text-footnote font-semibold mb-1">
                <span>Diesel from ($/gal)</span>
                <span>Up to ($/gal, blank = and up)</span>
                <span>Surcharge ({draft.method === "per_mile" ? "¢/mi" : "%"})</span>
                <span />
              </div>
              <div className="space-y-2">
                {draft.bands.map((b, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2">
                    <input className="input" inputMode="decimal" aria-label={`Band ${i + 1} from`} value={b.from} onChange={(e) => setBand(i, "from", e.target.value)} />
                    <input className="input" inputMode="decimal" aria-label={`Band ${i + 1} to`} value={b.to} onChange={(e) => setBand(i, "to", e.target.value)} />
                    <input className="input" inputMode="decimal" aria-label={`Band ${i + 1} surcharge`} value={b.value} onChange={(e) => setBand(i, "value", e.target.value)} />
                    <button className="btn btn-sm" aria-label={`Remove band ${i + 1}`} disabled={draft.bands.length === 1} onClick={() => setDraft({ ...draft, bands: draft.bands.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-sm mt-2" onClick={() => setDraft({ ...draft, bands: [...draft.bands, nextBand(draft)] })}>
                + Add band
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
