"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Modal, Pill } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { planBatchAction, runBatchAction } from "./actions";
import type { BatchPlan, BatchResult } from "@/domain/invoicing";

const METHOD: Record<string, string> = { email: "Email + docs", factor: "Factor schedule", edi: "EDI 210", portal: "Portal (record)", mail: "Mail (record)" };

/** A billing run: preview how the picked loads become invoices, then make, issue and send them in one go. */
export function BillingRun({ orderIds, onClose, onDone }: { orderIds: string[]; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [opts, setOpts] = useState({ issue: true, send: true, exchangeRate: "" });
  const [result, setResult] = useState<BatchResult | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    planBatchAction(orderIds).then((r) => live && (r.ok ? setPlan(r.data) : setErr(r.error)));
    return () => {
      live = false;
    };
  }, [orderIds]);
  const mxn = plan?.invoices.some((i) => i.currency === "MXN");
  const totals = new Map<string, number>();
  for (const i of plan?.invoices ?? []) totals.set(i.currency, (totals.get(i.currency) ?? 0) + i.totalCents);
  const go = () =>
    start(async () => {
      setErr(null);
      const r = await runBatchAction(orderIds, opts);
      if (!r.ok) return setErr(r.error);
      setResult(r.data);
    });
  return (
    <Modal
      open
      wide
      onClose={result ? onDone : onClose}
      title={result ? `Billing run #${result.number}` : "Bill the selected loads"}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending || !plan?.invoices.length} onClick={go}>
              {pending ? "Working…" : `${opts.issue ? (opts.send ? "Create, issue & send" : "Create & issue") : "Create drafts"} (${plan?.invoices.length ?? 0})`}
            </button>
          </>
        )
      }
    >
      {err && <div className="error mb-3" role="alert">{err}</div>}
      {!plan && !err && <div className="text-muted">Grouping the loads…</div>}
      {plan && !result && (
        <div className="space-y-4" data-testid="batch-plan">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Loads</th>
                <th>Invoice</th>
                <th>Send by</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {plan.invoices.map((i) => (
                <tr key={i.key} data-testid="batch-invoice">
                  <td className="font-semibold">{i.customerName}</td>
                  <td className="mono text-[12.5px]">{i.orderNumbers.join(", ")}</td>
                  <td>{i.mode === "summary" && i.orderIds.length > 1 ? <Pill tone="blue">Summary · {i.orderIds.length} loads</Pill> : <span className="text-muted text-[12.5px]">Per load</span>}</td>
                  <td className="text-[12.5px]">
                    {METHOD[i.method]}
                    {i.sendTo && <div className="text-faint">{i.sendTo}</div>}
                    {!i.sendTo && (i.method === "email" || i.method === "factor") && <div className="text-red text-[12px]">no address on file</div>}
                  </td>
                  <td className="mono font-semibold text-right">{formatCents(i.totalCents, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-between text-[13px]">
            <span className="text-muted">
              {plan.invoices.length} invoice{plan.invoices.length === 1 ? "" : "s"} from {orderIds.length - plan.skipped.length} load{orderIds.length - plan.skipped.length === 1 ? "" : "s"}
            </span>
            <span className="font-bold">{[...totals].map(([c, v]) => formatCents(v, c)).join(" + ")}</span>
          </div>
          {!!plan.skipped.length && (
            <div className="rounded-md bg-amber/10 p-3 text-[13px]">
              <div className="font-semibold mb-1">Left out</div>
              {plan.skipped.map((x) => (
                <div key={x.orderId}>
                  {x.orderNumber || "an order"} — {x.reason}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-5 text-[13.5px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-teal w-4 h-4" checked={opts.issue} onChange={(e) => setOpts({ ...opts, issue: e.target.checked, send: e.target.checked && opts.send })} /> Issue now (numbers them, locks them)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-teal w-4 h-4" checked={opts.send} disabled={!opts.issue} onChange={(e) => setOpts({ ...opts, send: e.target.checked })} /> Send now
            </label>
            {mxn && opts.issue && (
              <label className="flex items-center gap-2">
                MXN per USD <input className="input w-28" inputMode="decimal" value={opts.exchangeRate} onChange={(e) => setOpts({ ...opts, exchangeRate: e.target.value })} aria-label="Exchange rate" />
              </label>
            )}
          </div>
        </div>
      )}
      {result && (
        <div className="space-y-3" data-testid="batch-result">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Invoice</th>
                <th>State</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i} data-testid="batch-result-row">
                  <td className="font-semibold">{r.customerName}</td>
                  <td className="mono">{r.invoiceId ? <Link href={`/billing/invoices/${r.invoiceId}`} className="hover:text-teal">{r.number ?? "draft"}</Link> : "—"}</td>
                  <td>
                    <Pill tone={!r.ok ? "red" : r.state === "sent" ? "teal" : r.state === "issued" ? "blue" : "slate"}>{r.ok ? r.state : "failed"}</Pill>
                  </td>
                  <td className="text-[12.5px] text-muted">{r.note ?? (r.state === "sent" ? METHOD[r.method] : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.schedule && (
            <div className="text-[13px]">
              Schedule #{result.schedule.number} with {result.schedule.count} invoice{result.schedule.count === 1 ? "" : "s"} sent to the factor.{" "}
              <a className="text-teal font-semibold" href={`/api/invoice-batches/${result.schedule.id}`} target="_blank" rel="noreferrer">
                Open the schedule
              </a>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
