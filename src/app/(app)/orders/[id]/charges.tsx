"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import type { ChargeKind } from "@/db/schema";
import { addChargeAction, removeChargeAction, computeDetentionAction } from "@/app/(app)/billing/actions";
import { UploadDoc } from "@/app/(app)/billing/queue";

type Charge = { id: string; kind: string; description: string; qty: number; unit: string; rateCents: number; amountCents: number; currency: string; billable: boolean; source: string; invoiceId: string | null; data: Record<string, unknown> | null };
type Doc = { code: string | null; fileName: string; id: string };
const KINDS: [ChargeKind, string][] = [["accessorial", "Accessorial"], ["detention", "Detention"], ["layover", "Layover"], ["tonu", "TONU"], ["lumper", "Lumper"], ["border_fee", "Border fee"], ["crossing_fee", "Crossing fee"], ["storage", "Storage"], ["extra_stop", "Extra stop"], ["fuel", "Fuel"], ["other", "Other"]];

export function Charges({ orderId, charges, docs, requiredDocs, pnl, locked, role, currency }: { orderId: string; charges: Charge[]; docs: Doc[]; requiredDocs: string[]; pnl: { revenue: number; carrierCost: number; driverPay: number; fuel: number; miles: number; extra: number; cost: number; margin: number; marginPct: number } | null; locked: boolean; role: string; currency: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [f, setF] = useState({ kind: "accessorial" as ChargeKind, description: "", qty: "1", unit: "flat", rate: "" });
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const can = ["owner", "billing", "dispatcher"].includes(role) && !locked;
  const total = charges.filter((c) => c.billable).reduce((a, c) => a + c.amountCents, 0);
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
        </div>
      </div>
      {charges.length === 0 ? (
        <div className="text-muted text-[13px]">Line haul appears from the rate when the order delivers.</div>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <td className="font-semibold">
                    {c.description}
                    <span className="text-faint text-[12px]"> · {c.source.replace("_", " ")}</span>
                    {!c.billable && <Pill tone="slate">not billable</Pill>}
                  </td>
                  <td className="text-muted text-[12.5px]">{c.unit === "flat" ? "" : `${c.unit === "h" ? (c.qty / 100).toFixed(2) : c.qty} ${c.unit} × ${formatCents(c.rateCents, c.currency)}`}</td>
                  <td className="mono font-semibold text-right">{formatCents(c.amountCents, c.currency)}</td>
                  <td className="text-right">{can && !c.invoiceId && <button className="btn btn-ghost btn-sm text-red" onClick={() => run("Removed", () => removeChargeAction(orderId, c.id))}>×</button>}{c.invoiceId && <Pill tone="teal">invoiced</Pill>}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="text-right font-extrabold">
                  Billable total
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
            <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ChargeKind })}>
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
          <button className="btn btn-primary" disabled={pending || !f.rate} onClick={() => run("Charge added", async () => { const r = await addChargeAction(orderId, f); if (r.ok) setF({ ...f, description: "", rate: "" }); return r; })}>
            Add
          </button>
          <button className="btn" disabled={pending} title="From the arrival/departure clocks on the stops, with the customer's free time" onClick={() => run("Detention computed from the stop clocks", () => computeDetentionAction(orderId))}>
            Compute detention
          </button>
        </div>
      )}
      {pnl && (
        <div className="mt-4 pt-3 border-t border-line grid grid-cols-6 gap-2 text-[13px]">
          {[["Revenue", pnl.revenue], ["Carrier cost", pnl.carrierCost], ["Driver pay", pnl.driverPay], [`Fuel est. (${pnl.miles} mi)`, pnl.fuel], ["Tolls & fees", pnl.extra]].map(([l, v]) => (
            <div key={String(l)}>
              <div className="text-muted text-[11.5px]">{l}</div>
              <div className="mono font-semibold">{formatCents(Number(v), currency)}</div>
            </div>
          ))}
          <div>
            <div className="text-muted text-[11.5px]">Margin</div>
            <div className={`mono font-extrabold ${pnl.margin < 0 ? "text-red" : "text-green"}`}>
              {formatCents(pnl.margin, currency)} <span className="text-[11px] font-semibold">{pnl.marginPct}%</span>
            </div>
          </div>
        </div>
      )}
      {uploadFor && <UploadDoc orderId={orderId} code={uploadFor} onClose={() => setUploadFor(null)} onDone={() => { setUploadFor(null); t.ok("Uploaded"); router.refresh(); }} />}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
