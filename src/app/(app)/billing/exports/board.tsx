"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { previewExportAction, createExportAction, reopenExportAction } from "../actions";

type Run = { id: string; format: string; fromDate: string; toDate: string; onlyNew: boolean; counts: Record<string, number>; fileName: string; createdAt: string; reopenedAt: string | null };
type Preview = { invoices: number; receipts: number; carrierBills: number; settlements: number; invoicedCents: number; receivedCents: number; billsCents: number };

export function Exports({ runs, defaults, role }: { runs: Run[]; defaults: { from: string; to: string }; role: string }) {
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
  const nothing = preview && preview.invoices + preview.receipts + preview.carrierBills + preview.settlements === 0;
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
          <label className="flex items-center gap-2 text-[13px] h-9 cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={f.onlyNew} onChange={(e) => setF({ ...f, onlyNew: e.target.checked })} /> Only what has not been exported yet
          </label>
          {can && (
            <button className="btn btn-primary" disabled={pending || !preview || !!nothing} onClick={() => start(async () => { const r = await createExportAction(f); if (r.ok) { t.ok(`Export ready — ${r.data.counts.invoices} invoices, ${r.data.counts.receipts} receipts, ${r.data.counts.carrierBills} carrier bills, ${r.data.counts.settlements} settlements`); setTick((x) => x + 1); router.refresh(); } else t.err(r.error); })}>
              Create export
            </button>
          )}
        </div>
        <div className="mt-3 text-[13px]" data-testid="export-preview">
          {err ? (
            <span className="error m-0">{err}</span>
          ) : !preview ? (
            <span className="text-muted">Counting…</span>
          ) : nothing ? (
            <span className="text-muted">Nothing in that period{f.onlyNew ? " that has not been exported" : ""}.</span>
          ) : (
            <span>
              <b>{preview.invoices}</b> invoices ({formatCents(preview.invoicedCents)}) · <b>{preview.receipts}</b> receipts ({formatCents(preview.receivedCents)}) · <b>{preview.carrierBills}</b> carrier bills · <b>{preview.settlements}</b> driver settlements ({formatCents(preview.billsCents)} in bills)
            </span>
          )}
        </div>
        <div className="help mt-1">Invoices by issue date, receipts by received date, carrier bills and settlements by approval date (payments ride along). Creating an export stamps the records so the next “only new” run skips them.</div>
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
                  <td className="text-muted text-[12.5px] whitespace-nowrap">{new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>
                    <Pill tone={r.format === "iif" ? "navy" : "teal"}>{r.format === "iif" ? "Desktop IIF" : "Online CSV"}</Pill>
                    {r.reopenedAt && <Pill tone="amber">reopened</Pill>}
                  </td>
                  <td className="mono text-[12.5px]">
                    {r.fromDate} → {r.toDate}
                    {!r.onlyNew && <span className="text-faint"> (everything)</span>}
                  </td>
                  <td className="text-[12.5px]">
                    {r.counts.invoices} invoices · {r.counts.receipts} receipts · {r.counts.carrierBills} carrier bills · {r.counts.settlements} settlements
                  </td>
                  <td className="space-x-1">
                    {r.format === "iif" ? (
                      <a className="btn btn-sm" href={`/api/accounting/${r.id}?file=0`}>
                        .iif
                      </a>
                    ) : (
                      ["invoices", "bills", "payments"].map((k) => (
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
