"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { fmtWhen } from "@/lib/time";
import { previewExportAction, createExportAction, reopenExportAction } from "../actions";

const n = (c: number, word: string) => `${c} ${word}${c === 1 ? "" : "s"}`;

type Run = { id: string; format: string; fromDate: string; toDate: string; onlyNew: boolean; counts: Record<string, number>; fileName: string; createdAt: string; reopenedAt: string | null };
type Preview = { invoices: number; receipts: number; credits: number; carrierBills: number; settlements: number; invoicedCents: number; receivedCents: number; billsCents: number; carrierBillsCents: number; settlementsCents: number; factorEntries: number; advances: number; advancesCents: number; applications: number; fxCents: number; older: number };

export function Exports({ runs, defaults, role, timeZone = "America/Chicago" }: { runs: Run[]; defaults: { from: string; to: string }; role: string; timeZone?: string }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ format: "iif" as "iif" | "qbo", from: defaults.from, to: defaults.to, onlyNew: true });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [reopen, setReopen] = useState<Run | null>(null);
  const [tick, setTick] = useState(0); // re-count after a run or a reopen
  const can = ["owner", "billing"].includes(role);
  useEffect(() => {
    let alive = true;
    previewExportAction({ from: f.from, to: f.to, onlyNew: f.onlyNew }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setPreview(r.data);
        setErr(null);
      } else {
        setPreview(null);
        setErr(r.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [f.from, f.to, f.onlyNew, tick]);
  const nothing = preview && preview.invoices + preview.receipts + preview.carrierBills + preview.settlements + preview.credits + preview.factorEntries + preview.advances + preview.applications === 0;
  return (
    <>
      <div className="card p-4 mb-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="label">For</label>
            <select className="select w-64" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as "iif" | "qbo" })}>
              <option value="iif">QuickBooks Desktop (.iif)</option>
              <option value="qbo">QuickBooks Online (.csv lists)</option>
            </select>
          </div>
          <div>
            <label className="label">From</label>
            <input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </div>
          <div>
            <label className="label">To</label>
            <input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-callout h-9 cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={f.onlyNew} onChange={(e) => setF({ ...f, onlyNew: e.target.checked })} /> Only what has not been exported yet (any date up to “To”)
          </label>
          {can && (
            <button className="btn btn-primary" disabled={pending || !preview || !!nothing} onClick={() => start(async () => { const r = await createExportAction(f); if (r.ok) { t.ok(`Export ready — ${r.data.counts.invoices} invoices, ${r.data.counts.receipts} receipts, ${r.data.counts.carrierBills} carrier bills, ${r.data.counts.settlements} settlements`); setTick((x) => x + 1); router.refresh(); } else t.err(r.error); })}>
              Create export
            </button>
          )}
        </div>
        <div className="mt-3 text-callout" data-testid="export-preview">
          {err ? (
            <span className="error m-0">{err}</span>
          ) : !preview ? (
            <span className="text-muted">Counting…</span>
          ) : nothing ? (
            <span className="text-muted">Nothing in that period{f.onlyNew ? " that has not been exported" : ""}.</span>
          ) : (
            <span>
              <b>{preview.invoices}</b> invoices ({formatCents(preview.invoicedCents)}) · <b>{preview.receipts}</b> deposits ({formatCents(preview.receivedCents)}) · <b>{preview.credits}</b> credit memos · <b>{preview.applications}</b> credits applied to invoices · <b>{preview.carrierBills}</b> carrier bills ({formatCents(preview.carrierBillsCents)}) · <b>{preview.settlements}</b> driver settlements ({formatCents(preview.settlementsCents)}) · <b>{preview.advances}</b> driver advances paid out ({formatCents(preview.advancesCents)}) · <b>{preview.factorEntries}</b> factoring entries
              {preview.fxCents ? <> · exchange {preview.fxCents > 0 ? "gain" : "loss"} {formatCents(Math.abs(preview.fxCents))}</> : null}
              {preview.older > 0 && (
                <div className="text-amber font-semibold mt-1" data-testid="export-older">
                  Includes {n(preview.older, "record")} dated before {f.from} that never went to QuickBooks.
                </div>
              )}
            </span>
          )}
        </div>
        <div className="help mt-1">Invoices by issue date, payments by received date, carrier bills and settlements by approval date (their payments ride along), factoring and advances by the day they happened. With “only what has not been exported yet”, anything never exported up to the To date goes — however old — so nothing is skipped. Creating an export stamps the records so the next run skips them.</div>
        <ul className="help mt-2 list-disc pl-5 space-y-0.5" data-testid="export-rules">
          <li>All amounts are in US dollars. A MXN or CAD invoice, its payments and credit memos are converted at the rate stored on the invoice; a carrier bill in pesos at the company rate (Settings → Company). The memo keeps the original amount and the rate.</li>
          <li>Each customer payment is one deposit to {"Undeposited Funds"} (set under Settings → Company) with a line per invoice it paid; money left on account stays as the customer&rsquo;s credit.</li>
          <li>Factoring goes as journal entries: the advance to the bank, the fee to Factoring fees, the reserve to Factor reserve and the invoice off Receivables; the reserve released on collection; a chargeback puts the invoice back on Receivables.</li>
          <li>Driver statements are bills: earnings to Driver pay, per diem and reimbursements to Driver reimbursements, advances recovered to Driver advances, escrow to Driver escrow (escrow paid back comes out of it), other deductions to Driver deductions.</li>
          <li>An advance goes out the day it is paid: Driver advances from the bank. The statements that recover it bring Driver advances back to zero.</li>
          <li>Credit memos go out as credit memos, each applied to its invoice; money on account used on a later invoice goes out as that application — so an invoice and its credit never sit open side by side.</li>
          <li>Pesos or Canadian dollars received go to the bank at the rate the day they arrived; the difference from the invoice&rsquo;s rate goes to Exchange gain or loss.</li>
          <li>The Desktop file lists the accounts and items it uses first, so QuickBooks creates any that are missing. It is written in Windows-1252, the encoding QuickBooks Desktop reads, so accented names (Héctor, Cantú) arrive intact.</li>
        </ul>
      </div>
      <div className="card overflow-hidden">
        {runs.length === 0 ? (
          <div className="py-14 text-center font-bold">No exports yet</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Created</th>
                <th>For</th>
                <th>Period</th>
                <th>Contents</th>
                <th>Files</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="text-muted text-callout whitespace-nowrap">{fmtWhen(r.createdAt, timeZone, { style: "short" })}</td>
                  <td>
                    <Pill tone={r.format === "iif" ? "navy" : "teal"}>{r.format === "iif" ? "Desktop IIF" : "Online CSV"}</Pill>
                    {r.reopenedAt && <Pill tone="amber">reopened</Pill>}
                  </td>
                  <td className="mono text-callout">
                    {r.fromDate} → {r.toDate}
                    {!r.onlyNew && <span className="text-faint"> (everything)</span>}
                  </td>
                  <td className="text-callout">
                    {n(r.counts.invoices, "invoice")} · {n(r.counts.receipts, "deposit")} · {n(r.counts.credits ?? 0, "credit memo")} · {n(r.counts.carrierBills, "carrier bill")} · {n(r.counts.settlements, "settlement")}{r.counts.factor ? ` · ${r.counts.factor} factoring ${r.counts.factor === 1 ? "entry" : "entries"}` : ""}{r.counts.advances ? ` · ${n(r.counts.advances, "advance")}` : ""}{r.counts.applications ? ` · ${n(r.counts.applications, "credit applied")}` : ""}
                  </td>
                  <td className="space-x-1">
                    {r.format === "iif" ? (
                      <a className="btn btn-sm" href={`/api/accounting/${r.id}?file=0`}>
                        .iif
                      </a>
                    ) : (
                      ["invoices", "payments", "credits", "applications", "bills", "journal"].map((k) => (
                        <a key={k} className="btn btn-sm" href={`/api/accounting/${r.id}?file=${k}`}>
                          {k}.csv
                        </a>
                      ))
                    )}
                  </td>
                  <td className="text-right">{can && !r.reopenedAt && <button className="btn btn-ghost btn-sm" title="The file never made it into QuickBooks: let these records come out again as new" onClick={() => setReopen(r)}>Reopen</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Confirm open={!!reopen} onClose={() => setReopen(null)} title="Reopen this export?" body="Its invoices, receipts and bills will count as not exported, so the next run includes them again. Do this only if the file never made it into QuickBooks — otherwise you will import them twice." confirmLabel="Reopen" onConfirm={() => { const r = reopen!; setReopen(null); start(async () => { const x = await reopenExportAction(r.id); if (x.ok) { t.ok("Reopened"); setTick((n) => n + 1); router.refresh(); } else t.err(x.error); }); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
