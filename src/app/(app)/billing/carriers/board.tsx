"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { receiveBillAction, approveBillAction, payBillAction } from "../actions";

type Row = { bill: { id: string; state: string; currency: string; expectedCents: number; accessorialCents: number; invoicedCents: number | null; approvedCents: number | null; paidCents: number | null; carrierInvoiceNumber: string | null; payDate: string | null; paidAt: string | null; shortPayNote: string | null; approvalNote: string | null; orderId: string }; carrierName: string; orderNumber: string; legSeq: number; legType: string; check: { expected: number; invoiced: number | null; podPresent: boolean; rateMatch: boolean; difference: number | null } };
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { expected: "slate", received: "blue", approved: "teal", scheduled: "amber", paid: "green", disputed: "red" };

export function CarrierBills({ rows, role, totals1099 }: { rows: Row[]; role: string; totals1099: { name: string; country: string; total: number }[] }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [popup, setPopup] = useState<{ kind: "receive" | "approve" | "pay"; row: Row } | null>(null);
  const [f, setF] = useState({ amount: "", number: "", accessorial: "", approved: "", note: "", shortPayNote: "", payDate: "", allowNoPod: false, method: "ach", reference: "" });
  const can = ["owner", "billing"].includes(role);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setPopup(null);
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <>
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center font-bold">No carrier bills yet</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Carrier</th>
                <th>Order · leg</th>
                <th>Expected</th>
                <th>Carrier invoice</th>
                <th>Three-way</th>
                <th>Approved / paid</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bill.id}>
                  <td className="font-bold">{r.carrierName}</td>
                  <td>
                    <Link href={`/orders/${r.bill.orderId}`} className="mono hover:text-teal">
                      {r.orderNumber}
                    </Link>{" "}
                    <span className="text-muted text-[12px]">leg {r.legSeq} {r.legType}</span>
                  </td>
                  <td className="mono">{formatCents(r.check.expected, r.bill.currency)}</td>
                  <td className="mono">
                    {r.bill.invoicedCents != null ? formatCents(r.bill.invoicedCents, r.bill.currency) : <span className="text-faint">—</span>}
                    {r.bill.carrierInvoiceNumber ? <span className="text-muted text-[12px]"> #{r.bill.carrierInvoiceNumber}</span> : null}
                  </td>
                  <td className="space-x-1">
                    {r.bill.invoicedCents != null && (r.check.rateMatch ? <Pill tone="green">rate ✓</Pill> : <Pill tone="red">{(r.check.difference ?? 0) > 0 ? "+" : ""}{formatCents(r.check.difference ?? 0, r.bill.currency)}</Pill>)}
                    {r.check.podPresent ? <Pill tone="green">POD ✓</Pill> : <Pill tone="amber">no POD</Pill>}
                  </td>
                  <td className="mono">
                    {r.bill.paidCents != null ? formatCents(r.bill.paidCents, r.bill.currency) : r.bill.approvedCents != null ? formatCents(r.bill.approvedCents, r.bill.currency) : "—"}
                    {r.bill.shortPayNote && <div className="text-[11.5px] text-amber">short-pay: {r.bill.shortPayNote}</div>}
                    {r.bill.payDate && !r.bill.paidAt && <div className="text-[11.5px] text-muted">pay {r.bill.payDate.slice(0, 10)}</div>}
                  </td>
                  <td>
                    <Pill tone={TONE[r.bill.state]}>{r.bill.state}</Pill>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {can && (r.bill.state === "expected" || r.bill.state === "received") && (
                      <button className="btn btn-sm" onClick={() => { setF({ ...f, amount: r.bill.invoicedCents != null ? (r.bill.invoicedCents / 100).toFixed(2) : "", number: r.bill.carrierInvoiceNumber ?? "" }); setPopup({ kind: "receive", row: r }); }}>
                        {r.bill.state === "expected" ? "Record invoice" : "Edit"}
                      </button>
                    )}
                    {can && r.bill.state === "received" && (
                      <button className="btn btn-sm btn-primary ml-1" onClick={() => { setF({ ...f, approved: ((r.bill.invoicedCents ?? r.check.expected) / 100).toFixed(2), note: "", shortPayNote: "", payDate: "", allowNoPod: false }); setPopup({ kind: "approve", row: r }); }}>
                        Approve
                      </button>
                    )}
                    {can && (r.bill.state === "approved" || r.bill.state === "scheduled") && (
                      <button className="btn btn-sm btn-primary" onClick={() => { setF({ ...f, method: "ach", reference: "", amount: "" }); setPopup({ kind: "pay", row: r }); }}>
                        Pay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {totals1099.length > 0 && (
        <div className="card p-4 mt-4">
          <div className="eyebrow mb-2">Paid this year (1099 / CFDI totals)</div>
          <ul className="grid grid-cols-3 gap-2 text-[13px]">
            {totals1099.map((c) => (
              <li key={c.name} className="flex justify-between">
                <span>
                  {c.name} <span className="text-faint">{c.country}</span>
                </span>
                <span className="mono font-semibold">{formatCents(c.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {popup?.kind === "receive" && (
        <Modal open onClose={() => setPopup(null)} title={`Carrier invoice · ${popup.row.carrierName} · ${popup.row.orderNumber}`} footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.amount} onClick={() => run("Recorded", () => receiveBillAction(popup.row.bill.id, f))}>Save</button></>}>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">Invoice amount</label>
              <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
            </div>
            <div>
              <label className="label">Carrier invoice #</label>
              <input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
            </div>
            <div>
              <label className="label">Approved accessorials</label>
              <input className="input" inputMode="decimal" value={f.accessorial} onChange={(e) => setF({ ...f, accessorial: e.target.value })} placeholder="0.00" />
            </div>
          </div>
          <div className="help mt-2">Expected {formatCents(popup.row.check.expected, popup.row.bill.currency)} from the tender.</div>
        </Modal>
      )}
      {popup?.kind === "approve" && (
        <Modal open onClose={() => setPopup(null)} title="Approve carrier bill" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending} onClick={() => run("Approved", () => approveBillAction(popup.row.bill.id, f))}>Approve</button></>}>
          <div className="text-[13px] mb-3">
            Tender {formatCents(popup.row.check.expected, popup.row.bill.currency)} · carrier billed {formatCents(popup.row.check.invoiced ?? 0, popup.row.bill.currency)} · {popup.row.check.podPresent ? "POD on file" : <span className="text-amber font-semibold">no POD on the order</span>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Amount to pay</label>
              <input className="input" inputMode="decimal" value={f.approved} onChange={(e) => setF({ ...f, approved: e.target.value })} />
            </div>
            <div>
              <label className="label">Pay date (optional)</label>
              <input type="date" className="input" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">Reason for a difference (if paying more than the tender)</label>
              <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">Short-pay note to the carrier (if paying less than billed)</label>
              <input className="input" value={f.shortPayNote} onChange={(e) => setF({ ...f, shortPayNote: e.target.value })} />
            </div>
            {!popup.row.check.podPresent && (
              <label className="col-span-2 flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-teal" checked={f.allowNoPod} onChange={(e) => setF({ ...f, allowNoPod: e.target.checked })} /> Approve without a POD
              </label>
            )}
          </div>
        </Modal>
      )}
      {popup?.kind === "pay" && (
        <Modal open onClose={() => setPopup(null)} title={`Pay ${popup.row.carrierName}`} footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending} onClick={() => run("Paid", () => payBillAction(popup.row.bill.id, f))}>Mark paid</button></>}>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">Method</label>
              <select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                {["ach", "wire", "check", "factoring", "other"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Reference</label>
              <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
            </div>
            <div>
              <label className="label">Amount (blank = approved, quick-pay applied)</label>
              <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </div>
          </div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
