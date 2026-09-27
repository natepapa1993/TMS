"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import type { SettlementLine } from "@/db/schema";
import { buildSettlementAction, settlementTransitionAction, addSettlementLineAction, addPayItemAction } from "../actions";

type Row = { st: { id: string; driverId: string; periodStart: string; periodEnd: string; state: string; lines: SettlementLine[]; grossCents: number; deductionsCents: number; netCents: number; method: string | null; reference: string | null }; driverName: string };
type Driver = { id: string; name: string; payType: string; payRateCents: number | null };
const TONE: Record<string, "slate" | "teal" | "amber" | "green"> = { open: "slate", reviewed: "amber", approved: "teal", paid: "green" };

export function Settlements({ rows, drivers, defaultWeek, role }: { rows: Row[]; drivers: Driver[]; defaultWeek: string; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [driverId, setDriverId] = useState(drivers[0]?.id ?? "");
  const [week, setWeek] = useState(defaultWeek);
  const [open, setOpen] = useState<Row | null>(null);
  const [line, setLine] = useState({ kind: "accessorial" as "accessorial" | "deduction" | "reimbursement" | "adjustment", description: "", amount: "" });
  const [item, setItem] = useState<{ open: boolean; kind: "deduction" | "reimbursement"; description: string; amount: string; recurring: boolean; remaining: string }>({ open: false, kind: "deduction", description: "", amount: "", recurring: false, remaining: "" });
  const [pay, setPay] = useState({ method: "ach", reference: "" });
  const can = ["owner", "billing"].includes(role);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  const cur = open ? (rows.find((r) => r.st.id === open.st.id) ?? open) : null;
  return (
    <>
      {can && (
        <div className="card p-4 mb-4 flex items-end gap-3">
          <div>
            <label className="label">Driver</label>
            <select className="select w-56" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.payType.replace("_", " ")} {d.payRateCents != null ? (d.payType === "pct" ? `${d.payRateCents / 100}%` : formatCents(d.payRateCents)) : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Week starting (Sunday)</label>
            <input type="date" className="input" value={week} onChange={(e) => setWeek(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={!driverId || !week || pending} onClick={() => run("Statement built", () => buildSettlementAction(driverId, week))}>
            Build statement
          </button>
          <button className="btn" disabled={!driverId} onClick={() => setItem({ ...item, open: true })}>
            + Deduction / reimbursement
          </button>
        </div>
      )}
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center font-bold">No statements yet</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Week</th>
                <th>Lines</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.st.id} className="cursor-pointer" onClick={() => setOpen(r)}>
                  <td className="font-bold">{r.driverName}</td>
                  <td className="text-[12.5px]">{r.st.periodStart.slice(0, 10)}</td>
                  <td className="text-muted">
                    {r.st.lines.length}
                    {r.st.lines.some((l) => l.disputed) && <Pill tone="red">dispute</Pill>}
                  </td>
                  <td className="mono">{formatCents(r.st.grossCents)}</td>
                  <td className="mono text-muted">{r.st.deductionsCents ? `-${formatCents(r.st.deductionsCents)}` : "—"}</td>
                  <td className="mono font-extrabold">{formatCents(r.st.netCents)}</td>
                  <td>
                    <Pill tone={TONE[r.st.state]}>{r.st.state}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cur && (
        <Modal
          open
          onClose={() => setOpen(null)}
          wide
          title={`${cur.driverName} · week of ${cur.st.periodStart.slice(0, 10)}`}
          footer={
            can ? (
              <>
                {cur.st.state === "open" && <button className="btn btn-primary" onClick={() => run("Reviewed", () => settlementTransitionAction(cur.st.id, "reviewed"))}>Mark reviewed</button>}
                {cur.st.state === "reviewed" && <button className="btn" onClick={() => run("Back to open", () => settlementTransitionAction(cur.st.id, "open"))}>Back to open</button>}
                {cur.st.state === "reviewed" && <button className="btn btn-primary" onClick={() => run("Approved — the driver can see it", () => settlementTransitionAction(cur.st.id, "approved"))}>Approve</button>}
                {cur.st.state === "approved" && (
                  <>
                    <button className="btn" onClick={() => run("Back to reviewed", () => settlementTransitionAction(cur.st.id, "reviewed"))}>Back to reviewed</button>
                    <select className="select w-28" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                      {["ach", "check", "cash", "other"].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    <input className="input w-36" placeholder="reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                    <button className="btn btn-primary" onClick={() => run("Paid", () => settlementTransitionAction(cur.st.id, "paid", pay.method, pay.reference))}>Mark paid</button>
                  </>
                )}
              </>
            ) : undefined
          }
        >
          <table className="table -mx-5 w-[calc(100%+40px)]">
            <thead>
              <tr>
                <th>Line</th>
                <th>Source</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {cur.st.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="font-semibold">{l.description}</span>
                    {l.disputed && <div className="text-[12px] text-red">Driver disputes: {l.disputed}</div>}
                  </td>
                  <td className="text-muted text-[12.5px]">{l.source}</td>
                  <td className={`mono text-right font-semibold ${l.amountCents < 0 ? "text-red" : ""}`}>{formatCents(l.amountCents)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="text-right font-extrabold">
                  Net pay
                </td>
                <td className="mono text-right font-extrabold text-[15px]">{formatCents(cur.st.netCents)}</td>
              </tr>
            </tbody>
          </table>
          {can && (cur.st.state === "open" || cur.st.state === "reviewed") && (
            <div className="mt-3 grid grid-cols-[130px_1fr_120px_auto] gap-2 items-end">
              <div>
                <label className="label">Add line</label>
                <select className="select" value={line.kind} onChange={(e) => setLine({ ...line, kind: e.target.value as typeof line.kind })}>
                  <option value="accessorial">Accessorial pay</option>
                  <option value="reimbursement">Reimbursement</option>
                  <option value="deduction">Deduction</option>
                  <option value="adjustment">Adjustment</option>
                </select>
              </div>
              <div>
                <label className="label">Description</label>
                <input className="input" value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} />
              </div>
              <div>
                <label className="label">Amount</label>
                <input className="input" inputMode="decimal" value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} />
              </div>
              <button className="btn" disabled={!line.description || !line.amount} onClick={() => run("Line added", async () => { const r = await addSettlementLineAction(cur.st.id, line.kind, line.description, line.amount); if (r.ok) setLine({ ...line, description: "", amount: "" }); return r; })}>
                Add
              </button>
            </div>
          )}
        </Modal>
      )}
      <Modal open={item.open} onClose={() => setItem({ ...item, open: false })} title={`Pay item · ${drivers.find((d) => d.id === driverId)?.name ?? ""}`} footer={<><button className="btn" onClick={() => setItem({ ...item, open: false })}>Cancel</button><button className="btn btn-primary" disabled={!item.description || !item.amount} onClick={() => run("Pay item added — it lands on the next statement", async () => { const r = await addPayItemAction(driverId, item); if (r.ok) setItem({ ...item, open: false, description: "", amount: "", remaining: "" }); return r; })}>Add</button></>}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Kind</label>
            <select className="select" value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value as "deduction" | "reimbursement" })}>
              <option value="deduction">Deduction (advance, escrow, fuel card, insurance)</option>
              <option value="reimbursement">Reimbursement (tolls, scale, repairs)</option>
            </select>
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} />
          </div>
          <div>
            <label className="label">Amount per statement</label>
            <input className="input" inputMode="decimal" value={item.amount} onChange={(e) => setItem({ ...item, amount: e.target.value })} />
          </div>
          <div>
            <label className="label">Total to recover (advances)</label>
            <input className="input" inputMode="decimal" value={item.remaining} onChange={(e) => setItem({ ...item, remaining: e.target.value })} placeholder="blank = not an advance" />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="accent-teal" checked={item.recurring} onChange={(e) => setItem({ ...item, recurring: e.target.checked })} /> Recurring every statement
          </label>
        </div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
