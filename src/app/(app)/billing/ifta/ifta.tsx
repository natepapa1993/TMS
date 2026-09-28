"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { RateMatrixImport } from "./rate-matrix";
import { formatCents } from "@/data/fields";
import type { IftaRow } from "@/domain/ifta";
import { computeMilesAction, addFuelPurchaseAction, deleteFuelPurchaseAction, importFuelAction, addTripMilesAction, deleteTripMilesAction, setIftaRatesAction, copyIftaRatesAction } from "../actions";

type Report = { quarter: string; totalMiles: number; iftaMiles: number; totalGallons: number; mpg: number | null; rows: IftaRow[]; taxDueCents: number; missingRates: string[]; perTruck: { truckId: string; unit: string; miles: number; gallons: number; mpg: number | null }[]; warnings: string[]; sources: Record<string, number>; fuelCount: number; defGallons: number };
type Fuel = { id: string; date: string; unit: string; jurisdiction: string; gallons: number; fuelType: string; amountCents: number | null; currency: string; vendor: string | null; city: string | null; receipt: string | null; source: string };
type Trip = { id: string; date: string; unit: string; jurisdiction: string; miles: number; note: string | null };

const TABS = [
  ["return", "Return"],
  ["fuel", "Fuel purchases"],
  ["miles", "Trip sheets"],
  ["trucks", "By truck"],
] as const;
const SOURCE: Record<string, string> = { gps: "GPS", leg_estimate: "Loads (route estimate)", trip_sheet: "Trip sheets", eld: "ELD" };
const n = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function IftaScreen({ quarter, quarters, report, fuel, trips, rates, members, trucks, canEdit }: { quarter: string; quarters: string[]; report: Report; fuel: Fuel[]; trips: Trip[]; rates: Record<string, { rate: string; surcharge: string }>; members: string[]; trucks: { id: string; unit: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("return");
  const [rateDraft, setRateDraft] = useState(rates);
  // rates saved elsewhere (the matrix import) replace the draft, so Save never writes old numbers back
  const ratesKey = JSON.stringify(rates);
  const [ratesSeen, setRatesSeen] = useState(ratesKey);
  if (ratesSeen !== ratesKey) {
    setRatesSeen(ratesKey);
    setRateDraft(rates);
  }
  const [fuelOpen, setFuelOpen] = useState(false);
  const [tripOpen, setTripOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fp, setFp] = useState({ truckId: trucks.length === 1 ? trucks[0].id : "", date: "", jurisdiction: "", country: "", qty: "", unit: "gal" as "gal" | "l", amount: "", vendor: "", city: "", receipt: "", fuelType: "diesel" });
  const [tp, setTp] = useState({ truckId: trucks.length === 1 ? trucks[0].id : "", date: "", jurisdiction: "", miles: "", note: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<{ added: number; skipped: { row: number; reason: string }[] } | null>(null);

  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: (d: T) => string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return t.err(r.error);
      t.ok(ok(r.data));
      router.refresh();
    });
  const rateRows = [...new Set([...report.rows.filter((r) => r.member).map((r) => r.jurisdiction), ...Object.keys(rateDraft)])].sort();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-wrap">
          {quarters.map((q) => (
            <Link key={q} href={`/billing/ifta?q=${q}`} className="stage-tab h-8 text-callout" data-active={q === quarter}>
              {q.replace("Q", " Q")}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {canEdit && (
            <button className="btn btn-primary" disabled={pending} onClick={() => run(() => computeMilesAction(quarter), (d) => `Miles recalculated: ${n(d.gpsMiles)} from GPS, ${n(d.legMiles)} from loads${d.warnings.length ? ` · ${d.warnings.length} to check` : ""}`)}>
              Recalculate miles
            </button>
          )}
          <a className="btn" href={`/api/ifta?quarter=${quarter}`}>
            Export CSV
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="ifta-summary">
        {[
          ["Total miles", n(report.totalMiles)],
          ["IFTA miles", n(report.iftaMiles)],
          ["Gallons", n(report.totalGallons, 1)],
          ["Fleet MPG", report.mpg != null ? report.mpg.toFixed(2) : "—"],
          [report.taxDueCents < 0 ? "Credit" : "Tax due", formatCents(Math.abs(report.taxDueCents), "USD")],
        ].map(([k, v]) => (
          <div key={k} className="card p-4">
            <div className="eyebrow">{k}</div>
            <div className="text-title2 font-extrabold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      {Object.keys(report.sources).length > 0 && (
        <div className="text-muted text-callout">
          Miles from {Object.entries(report.sources).map(([k, v]) => `${SOURCE[k] ?? k} ${n(v)}`).join(" · ")}
          {report.defGallons > 0 && ` · ${n(report.defGallons, 1)} gal DEF not counted`}
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="card p-4 border-amber/40 bg-amber/5 text-callout" data-testid="ifta-warnings">
          {report.warnings.map((w) => (
            <div key={w}>• {w}</div>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        {TABS.map(([k, l]) => (
          <button key={k} className="stage-tab" data-active={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === "return" && (
        <div className="card overflow-hidden">
          {canEdit && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
              <div className="text-callout text-muted">Rates in $ per gallon for {quarter.replace("Q", " Q")} from the IFTA rate matrix. They change every quarter: download the matrix CSV from iftach.org and import it.</div>
              <div className="flex gap-2 flex-wrap justify-end">
                <RateMatrixImport quarter={quarter} onDone={(m) => t.ok(m)} />
                <button className="btn btn-sm" disabled={pending} onClick={() => run(() => copyIftaRatesAction(quarter), (d) => `${d.copied} rate(s) copied from last quarter — check them`)}>
                  Copy last quarter&apos;s rates
                </button>
                <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => setIftaRatesAction(quarter, rateRows.map((j) => ({ jurisdiction: j, rate: rateDraft[j]?.rate ?? "", surcharge: rateDraft[j]?.surcharge ?? "" }))), (d) => `${d.saved} rate(s) saved`)}>
                  Save rates
                </button>
              </div>
            </div>
          )}
          {!report.rows.length ? (
            <div className="py-12 text-center text-muted">No miles or fuel for this quarter yet.</div>
          ) : (
            <table className="table" data-testid="ifta-return">
              <thead>
                <tr>
                  <th>Jurisdiction</th>
                  <th className="text-right">Miles</th>
                  <th className="text-right">Taxable gal</th>
                  <th className="text-right">Tax-paid gal</th>
                  <th className="text-right">Net gal</th>
                  <th>Rate $/gal</th>
                  <th>Surcharge</th>
                  <th className="text-right">Tax (credit)</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.jurisdiction} data-testid="ifta-row" className={r.member ? "" : "text-muted"}>
                    <td className="font-semibold">
                      {r.jurisdiction} {!r.member && <Pill tone="slate">not IFTA</Pill>}
                    </td>
                    <td className="text-right tabular-nums">{n(r.miles)}</td>
                    <td className="text-right tabular-nums">{r.member ? n(r.taxableGallons, 1) : "—"}</td>
                    <td className="text-right tabular-nums">{n(r.paidGallons, 1)}</td>
                    <td className={`text-right tabular-nums ${r.netGallons < 0 ? "text-green-700" : ""}`}>{r.member ? n(r.netGallons, 1) : "—"}</td>
                    <td>
                      {r.member &&
                        (canEdit ? (
                          <input className="input h-8 w-24" inputMode="decimal" aria-label={`${r.jurisdiction} rate`} value={rateDraft[r.jurisdiction]?.rate ?? ""} onChange={(e) => setRateDraft({ ...rateDraft, [r.jurisdiction]: { rate: e.target.value, surcharge: rateDraft[r.jurisdiction]?.surcharge ?? "" } })} placeholder="0.0000" />
                        ) : (
                          (r.rate ?? "—")
                        ))}
                    </td>
                    <td>
                      {r.member &&
                        (canEdit ? (
                          <input className="input h-8 w-20" inputMode="decimal" aria-label={`${r.jurisdiction} surcharge`} value={rateDraft[r.jurisdiction]?.surcharge ?? ""} onChange={(e) => setRateDraft({ ...rateDraft, [r.jurisdiction]: { rate: rateDraft[r.jurisdiction]?.rate ?? "", surcharge: e.target.value } })} />
                        ) : (
                          (r.surcharge ?? "")
                        ))}
                    </td>
                    <td className={`text-right mono font-semibold ${r.taxCents != null && r.taxCents < 0 ? "text-green-700" : ""}`}>{r.taxCents == null ? (r.member ? <span className="text-amber-700 text-footnote">rate?</span> : "—") : r.taxCents < 0 ? `(${formatCents(-r.taxCents, "USD")})` : formatCents(r.taxCents, "USD")}</td>
                  </tr>
                ))}
                <tr>
                  <td className="font-extrabold">Total</td>
                  <td className="text-right font-bold tabular-nums">{n(report.totalMiles)}</td>
                  <td />
                  <td className="text-right font-bold tabular-nums">{n(report.totalGallons, 1)}</td>
                  <td colSpan={3} />
                  <td className="text-right mono font-extrabold" data-testid="ifta-total">{report.taxDueCents < 0 ? `(${formatCents(-report.taxDueCents, "USD")})` : formatCents(report.taxDueCents, "USD")}</td>
                </tr>
              </tbody>
            </table>
          )}
          {canEdit && (
            <details className="px-4 py-3 border-t border-line text-callout">
              <summary className="cursor-pointer text-muted">Add a rate for another jurisdiction</summary>
              <div className="flex gap-2 mt-2">
                <select className="select w-28" aria-label="Jurisdiction for a rate" onChange={(e) => e.target.value && setRateDraft({ ...rateDraft, [e.target.value]: rateDraft[e.target.value] ?? { rate: "", surcharge: "" } })} defaultValue="">
                  <option value="">Pick…</option>
                  {members.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <span className="text-muted self-center">then fill it in the table above and save.</span>
              </div>
            </details>
          )}
        </div>
      )}

      {tab === "fuel" && (
        <div className="card overflow-hidden">
          {canEdit && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
              <div className="text-callout text-muted">Import the fuel card&apos;s transaction export (.xlsx or .csv; EFS, Comdata, WEX, TCS, Love&apos;s, Pilot… columns matched by name) or add a receipt.</div>
              <div className="flex gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  aria-label="Fuel card file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const fd = new FormData();
                    fd.set("file", file);
                    start(async () => {
                      const r = await importFuelAction(fd);
                      e.target.value = "";
                      if (!r.ok) return t.err(r.error);
                      setImported(r.data);
                      router.refresh();
                    });
                  }}
                />
                <button className="btn btn-sm" disabled={pending} onClick={() => fileRef.current?.click()}>
                  Import fuel card
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => { setErr(null); setFuelOpen(true); }}>
                  + Fuel purchase
                </button>
              </div>
            </div>
          )}
          {imported && (
            <div className="px-4 py-3 border-b border-line text-callout" data-testid="fuel-import">
              <span className="font-semibold">{imported.added} purchase{imported.added === 1 ? "" : "s"} imported.</span>
              {imported.skipped.length > 0 && <span className="text-muted"> Skipped: {imported.skipped.map((s) => `row ${s.row} — ${s.reason}`).join(" · ")}</span>}
            </div>
          )}
          {!fuel.length ? (
            <div className="py-12 text-center text-muted">No fuel purchases this quarter.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Truck</th>
                  <th>Where</th>
                  <th className="text-right">Gallons</th>
                  <th>Fuel</th>
                  <th className="text-right">Amount</th>
                  <th>Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fuel.map((f) => (
                  <tr key={f.id} data-testid="fuel-row">
                    <td>{f.date}</td>
                    <td className="mono">{f.unit}</td>
                    <td>
                      <span className="font-semibold">{f.jurisdiction}</span> <span className="text-muted text-callout">{[f.vendor, f.city].filter(Boolean).join(", ")}</span>
                    </td>
                    <td className="text-right tabular-nums">{n(f.gallons, 1)}</td>
                    <td>{f.fuelType === "def" ? <Pill tone="slate">DEF</Pill> : f.fuelType}</td>
                    <td className="text-right mono">{f.amountCents != null ? formatCents(f.amountCents, f.currency) : "—"}</td>
                    <td className="text-muted text-callout">
                      {f.receipt ?? ""} {f.source === "import" && <Pill tone="blue">card</Pill>}
                    </td>
                    <td className="text-right">
                      {canEdit && (
                        <button className="btn btn-sm btn-ghost" aria-label={`Delete fuel ${f.date}`} onClick={() => run(() => deleteFuelPurchaseAction(f.id), () => "Removed")}>
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "miles" && (
        <div className="card overflow-hidden">
          {canEdit && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
              <div className="text-callout text-muted">Miles GPS and the loads can&apos;t see — a run to the shop, a deadhead without the app. They stay when miles are recalculated.</div>
              <button className="btn btn-sm btn-primary" onClick={() => { setErr(null); setTripOpen(true); }}>
                + Trip-sheet miles
              </button>
            </div>
          )}
          {!trips.length ? (
            <div className="py-12 text-center text-muted">No trip-sheet entries this quarter.</div>
          ) : (
            <table className="table">
              <tbody>
                {trips.map((x) => (
                  <tr key={x.id} data-testid="trip-row">
                    <td>{x.date}</td>
                    <td className="mono">{x.unit}</td>
                    <td className="font-semibold">{x.jurisdiction}</td>
                    <td className="text-right tabular-nums">{n(x.miles, 1)} mi</td>
                    <td className="text-muted">{x.note}</td>
                    <td className="text-right">
                      {canEdit && (
                        <button className="btn btn-sm btn-ghost" aria-label={`Delete trip ${x.date}`} onClick={() => run(() => deleteTripMilesAction(x.id), () => "Removed")}>
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "trucks" && (
        <div className="card overflow-hidden">
          {!report.perTruck.length ? (
            <div className="py-12 text-center text-muted">No trucks with miles or fuel this quarter.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Truck</th>
                  <th className="text-right">Miles</th>
                  <th className="text-right">Gallons</th>
                  <th className="text-right">MPG</th>
                </tr>
              </thead>
              <tbody>
                {report.perTruck.map((x) => (
                  <tr key={x.truckId}>
                    <td className="mono font-semibold">{x.unit}</td>
                    <td className="text-right tabular-nums">{n(x.miles)}</td>
                    <td className="text-right tabular-nums">{n(x.gallons, 1)}</td>
                    <td className={`text-right tabular-nums ${x.mpg != null && (x.mpg < 3 || x.mpg > 12) ? "text-red font-semibold" : ""}`}>{x.mpg?.toFixed(2) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Modal
        open={fuelOpen}
        onClose={() => setFuelOpen(false)}
        title="Fuel purchase"
        footer={
          <>
            <button className="btn" onClick={() => setFuelOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await addFuelPurchaseAction(fp);
                  if (!r.ok) return setErr(r.error);
                  setFuelOpen(false);
                  setFp({ ...fp, qty: "", amount: "", receipt: "" });
                  t.ok("Fuel purchase added");
                  router.refresh();
                })
              }
            >
              Add
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          {err && <div className="error col-span-2">{err}</div>}
          <div>
            <label className="label" htmlFor="fp-truck">Truck</label>
            <select id="fp-truck" className="select" value={fp.truckId} onChange={(e) => setFp({ ...fp, truckId: e.target.value })}>
              <option value="">—</option>
              {trucks.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.unit}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fp-date">Date</label>
            <input id="fp-date" type="date" className="input" value={fp.date} onChange={(e) => setFp({ ...fp, date: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fp-j">State / province</label>
            <input id="fp-j" className="input" value={fp.jurisdiction} onChange={(e) => setFp({ ...fp, jurisdiction: e.target.value })} placeholder="TX, ON, or MX" />
          </div>
          <div>
            <label className="label" htmlFor="fp-country">Country</label>
            <select id="fp-country" className="select" value={fp.country} onChange={(e) => setFp({ ...fp, country: e.target.value })}>
              <option value="">US / Canada</option>
              <option value="MX">Mexico</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fp-qty">Quantity</label>
            <div className="flex gap-2">
              <input id="fp-qty" className="input" inputMode="decimal" value={fp.qty} onChange={(e) => setFp({ ...fp, qty: e.target.value })} />
              <select className="select w-24" aria-label="Unit" value={fp.unit} onChange={(e) => setFp({ ...fp, unit: e.target.value as "gal" | "l" })}>
                <option value="gal">gal</option>
                <option value="l">liters</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="fp-type">Fuel</label>
            <select id="fp-type" className="select" value={fp.fuelType} onChange={(e) => setFp({ ...fp, fuelType: e.target.value })}>
              <option value="diesel">Diesel</option>
              <option value="gasoline">Gasoline</option>
              <option value="def">DEF (not taxed)</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fp-amount">Amount</label>
            <input id="fp-amount" className="input" inputMode="decimal" value={fp.amount} onChange={(e) => setFp({ ...fp, amount: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fp-receipt">Receipt #</label>
            <input id="fp-receipt" className="input" value={fp.receipt} onChange={(e) => setFp({ ...fp, receipt: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fp-vendor">Truck stop</label>
            <input id="fp-vendor" className="input" value={fp.vendor} onChange={(e) => setFp({ ...fp, vendor: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fp-city">City</label>
            <input id="fp-city" className="input" value={fp.city} onChange={(e) => setFp({ ...fp, city: e.target.value })} />
          </div>
        </div>
      </Modal>

      <Modal
        open={tripOpen}
        onClose={() => setTripOpen(false)}
        title="Trip-sheet miles"
        footer={
          <>
            <button className="btn" onClick={() => setTripOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await addTripMilesAction(tp);
                  if (!r.ok) return setErr(r.error);
                  setTripOpen(false);
                  setTp({ ...tp, miles: "", note: "" });
                  t.ok("Miles added");
                  router.refresh();
                })
              }
            >
              Add
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          {err && <div className="error col-span-2">{err}</div>}
          <div>
            <label className="label" htmlFor="tp-truck">Truck</label>
            <select id="tp-truck" className="select" value={tp.truckId} onChange={(e) => setTp({ ...tp, truckId: e.target.value })}>
              <option value="">—</option>
              {trucks.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.unit}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tp-date">Date</label>
            <input id="tp-date" type="date" className="input" value={tp.date} onChange={(e) => setTp({ ...tp, date: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="tp-j">State / province</label>
            <input id="tp-j" className="input" value={tp.jurisdiction} onChange={(e) => setTp({ ...tp, jurisdiction: e.target.value })} placeholder="TX" />
          </div>
          <div>
            <label className="label" htmlFor="tp-miles">Miles</label>
            <input id="tp-miles" className="input" inputMode="decimal" value={tp.miles} onChange={(e) => setTp({ ...tp, miles: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="tp-note">Note</label>
            <input id="tp-note" className="input" value={tp.note} onChange={(e) => setTp({ ...tp, note: e.target.value })} placeholder="run to the shop" />
          </div>
        </div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
