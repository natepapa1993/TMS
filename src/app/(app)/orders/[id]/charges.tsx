"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import type { ChargeKind } from "@/db/schema";
import { addChargeAction, removeChargeAction, computeDetentionAction } from "@/app/(app)/billing/actions";
import { UploadDoc } from "@/app/(app)/billing/queue";
import { ApprovalDialog } from "@/app/(app)/billing/approvals";

type Charge = { id: string; kind: string; description: string; qty: number; unit: string; rateCents: number; amountCents: number; currency: string; billable: boolean; source: string; invoiceId: string | null; data: Record<string, unknown> | null; approvalState: string; approvedBy: string | null; approvalRef: string | null; rejectedReason: string | null };
type Doc = { code: string | null; fileName: string; id: string };
const KINDS: [ChargeKind, string][] = [["accessorial", "Accessorial"], ["detention", "Detention"], ["layover", "Layover"], ["tonu", "TONU"], ["lumper", "Lumper"], ["border_fee", "Border fee"], ["crossing_fee", "Crossing fee"], ["storage", "Storage"], ["extra_stop", "Extra stop"], ["fuel", "Fuel"], ["other", "Other"]];

export function Charges({ orderId, orderNumber, charges, docs, requiredDocs, requiredRefs = [], pnl, locked, invoiced, role, currency }: { orderId: string; orderNumber: string; invoiced?: boolean; charges: Charge[]; docs: Doc[]; requiredDocs: string[]; requiredRefs?: { key: string; present: boolean }[]; pnl: { revenue: number; carrierCost: number; driverPay: number; fuel: number; miles: number; extra: number; cost: number; margin: number; marginPct: number } | null; locked: boolean; role: string; currency: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  // each charge type starts with its usual unit: detention and layover by the hour, extra stops per stop, the rest flat
  const DEFAULT_UNIT: Partial<Record<ChargeKind, string>> = { detention: "h", layover: "flat", extra_stop: "stop" };
  const [f, setF] = useState({ kind: "accessorial" as ChargeKind, description: "", qty: "1", unit: "flat", rate: "" });
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const waiting = charges.filter((c) => c.approvalState === "pending" && c.billable && !c.invoiceId);
  const can = ["owner", "billing", "dispatcher"].includes(role) && !locked;
  const total = charges.filter((c) => c.billable && c.approvalState !== "pending" && c.approvalState !== "rejected").reduce((a, c) => a + c.amountCents, 0);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <div className="card p-5" id="charges">
      <div className="flex items-center justify-between mb-3">
        <div className="h2">Charges</div>
        <div className="flex items-center gap-2">
          {requiredDocs.map((code) => {
            const d = docs.find((x) => x.code === code);
            return d ? (
              <a key={code} href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="pill pill-green">
                {code.replace("_", " ")} ✓
              </a>
            ) : (
              <button key={code} className="pill pill-red" onClick={() => setUploadFor(code)}>
                {code.replace("_", " ")} missing
              </button>
            );
          })}
          {requiredRefs.map((r) => (
            <span key={r.key} className={`pill ${r.present ? "pill-green" : "pill-red"}`} title={r.present ? "reference on the order" : "the customer requires this reference before invoicing — add it under References"}>
              {r.key.replace("_", " ")} # {r.present ? "✓" : "missing"}
            </span>
          ))}
        </div>
      </div>
      {waiting.length > 0 && (
        <div className="rounded-lg border border-amber/50 bg-amber-soft/40 px-3 py-2 mb-3 text-callout flex items-center justify-between gap-3" data-testid="charges-waiting">
          <span>
            <b>{waiting.length} extra{waiting.length === 1 ? "" : "s"}</b> ({formatCents(waiting.reduce((a, c) => a + c.amountCents, 0), currency)}) waiting for the customer&rsquo;s approval — {invoiced ? "once approved they go on a supplemental invoice" : "they stay off the invoice until approved"}.
          </span>
          {can && (
            <button className="btn btn-sm" onClick={() => setApproving(true)}>
              Record approval
            </button>
          )}
        </div>
      )}
      {invoiced && !waiting.length && <div className="text-callout text-muted mb-2">Invoiced. A charge added now (detention approved later, a lumper receipt) goes on a supplemental invoice.</div>}
      {charges.length === 0 ? (
        <div className="text-muted text-callout">Line haul appears from the rate when the order delivers.</div>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <td className="font-semibold">
                    {c.description}
                    <span className="text-faint text-footnote"> · {c.source.replace("_", " ")}</span>
                    {!c.billable && c.approvalState !== "rejected" && <Pill tone="slate">not billable</Pill>}
                    {c.approvalState === "pending" && (
                      <span className="ml-1">
                        <Pill tone="amber">waiting for the customer&rsquo;s OK</Pill>
                      </span>
                    )}
                    {c.approvalState === "approved" && <div className="text-footnote text-muted font-normal">approved by {c.approvedBy}{c.approvalRef ? ` · ${c.approvalRef}` : ""}</div>}
                    {c.approvalState === "rejected" && <div className="text-footnote text-red font-normal">rejected: {c.rejectedReason}</div>}
                  </td>
                  <td className="text-muted text-callout">{c.unit === "flat" ? "" : `${c.unit === "h" ? (c.qty / 100).toFixed(2) : c.qty} ${c.unit} × ${formatCents(c.rateCents, c.currency)}`}</td>
                  <td className="mono font-semibold text-right">{formatCents(c.amountCents, c.currency)}</td>
                  <td className="text-right">{can && !c.invoiceId && <button className="btn btn-ghost btn-sm text-red" onClick={() => run("Removed", () => removeChargeAction(orderId, c.id))}>×</button>}{c.invoiceId && <Pill tone="teal">invoiced</Pill>}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="text-right font-extrabold">
                  {waiting.length ? "Billable now" : "Billable total"}
                </td>
                <td className="mono text-right font-extrabold">{formatCents(total, currency)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {can && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-[140px_1fr_70px_80px_110px_auto_auto] gap-2 items-end">
          <div>
            <label className="label">Add</label>
            <select className="select" value={f.kind} onChange={(e) => { const kind = e.target.value as ChargeKind; setF({ ...f, kind, unit: DEFAULT_UNIT[kind] ?? "flat", qty: "1" }); }} aria-label="Charge type">
              {KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="optional" />
          </div>
          <div>
            <label className="label">Qty</label>
            <input className="input" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
          </div>
          <div>
            <label className="label">Unit</label>
            <select className="select" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
              <option value="flat">flat</option>
              <option value="h">hour</option>
              <option value="mi">mile</option>
              <option value="stop">stop</option>
            </select>
          </div>
          <div>
            <label className="label">Rate</label>
            <input className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </div>
          <button className="btn btn-primary" disabled={pending || !f.rate} onClick={() => run("Charge added", async () => { const r = await addChargeAction(orderId, f); if (r.ok) setF({ ...f, description: "", rate: "", qty: "1" }); return r; })}>
            Add
          </button>
          <button className="btn" disabled={pending} title="From the arrival/departure clocks on the stops, with the customer's free time" onClick={() => run("Detention computed from the stop clocks", () => computeDetentionAction(orderId))}>
            Compute detention
          </button>
        </div>
      )}
      {pnl && (
        <div className="mt-4 pt-3 border-t border-line grid grid-cols-6 gap-2 text-callout">
          {[["Revenue", pnl.revenue], ["Carrier cost", pnl.carrierCost], ["Driver pay", pnl.driverPay], [`Fuel est. (${pnl.miles} mi)`, pnl.fuel], ["Tolls & fees", pnl.extra]].map(([l, v]) => (
            <div key={String(l)}>
              <div className="text-muted text-footnote">{l}</div>
              <div className="mono font-semibold">{formatCents(Number(v), currency)}</div>
            </div>
          ))}
          <div>
            <div className="text-muted text-footnote">Margin</div>
            <div className={`mono font-extrabold ${pnl.margin < 0 ? "text-red" : "text-green"}`}>
              {formatCents(pnl.margin, currency)} <span className="text-caption font-semibold">{pnl.marginPct}%</span>
            </div>
          </div>
        </div>
      )}
      {approving && <ApprovalDialog orderId={orderId} orderNumber={orderNumber} charges={waiting.map((c) => ({ id: c.id, description: c.description, amountCents: c.amountCents }))} currency={currency} onClose={() => setApproving(false)} />}
      {uploadFor && <UploadDoc orderId={orderId} code={uploadFor} onClose={() => setUploadFor(null)} onDone={() => { setUploadFor(null); t.ok("Uploaded"); router.refresh(); }} />}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
