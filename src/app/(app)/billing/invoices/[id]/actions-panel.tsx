"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { issueInvoiceAction, deliverInvoiceAction, receiptAction, voidInvoiceAction, creditMemoAction, disputeInvoiceAction, promiseToPayAction } from "../../actions";

type Inv = { id: string; state: string; currency: string; openCents: number; billingEmail: string | null; promiseToPayAt: string | null; payWhenPaid: boolean; number: string | null; method: string; portalUrl: string | null; factorName: string | null; factorEmail: string | null };

export function InvoiceActions({ inv, role }: { inv: Inv; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [popup, setPopup] = useState<null | "receipt" | "credit" | "void" | "dispute" | "send" | "issue">(null);
  const [f, setF] = useState({ amount: "", receivedAt: new Date().toISOString().slice(0, 10), method: "ach", reference: "", note: "", to: inv.billingEmail ?? "", rate: "", dmethod: inv.method, ptp: inv.promiseToPayAt?.slice(0, 10) ?? "" });
  const can = ["owner", "billing"].includes(role);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setPopup(null);
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  if (!can) return null;
  const s = inv.state;
  return (
    <aside className="card p-4 space-y-2 sticky top-5">
      <div className="eyebrow mb-1">Actions</div>
      {s === "paid" && <div className="text-[13px] text-muted">Paid in full. Nothing left to do here.</div>}
      {s === "void" && <div className="text-[13px] text-muted">Voided. It stays for the record; nothing can be done to it.</div>}
      {s === "draft" && (
        <button className="btn btn-primary w-full justify-center" disabled={pending} onClick={() => (inv.currency === "MXN" ? setPopup("issue") : run("Issued", () => issueInvoiceAction(inv.id)))}>
          Issue invoice
        </button>
      )}
      {["issued", "sent", "partially_paid"].includes(s) && (
        <button className="btn btn-primary w-full justify-center" onClick={() => setPopup("send")}>
          {s === "issued" ? "Send invoice" : "Send again"}
        </button>
      )}
      {["issued", "sent", "partially_paid", "disputed"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => setPopup("receipt")}>
          Record receipt
        </button>
      )}
      {["issued", "sent", "partially_paid", "disputed"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => setPopup("credit")}>
          Credit memo
        </button>
      )}
      {["issued", "sent", "partially_paid"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => setPopup("dispute")}>
          Mark disputed
        </button>
      )}
      {["issued", "sent", "draft", "disputed"].includes(s) && (
        <button className="btn btn-danger w-full justify-center" onClick={() => setPopup("void")}>
          Void
        </button>
      )}
      {["sent", "partially_paid", "disputed", "issued"].includes(s) && (
        <div className="pt-2 border-t border-line">
          <label className="label">Promise to pay</label>
          <div className="flex gap-2">
            <input type="date" className="input" value={f.ptp} onChange={(e) => setF({ ...f, ptp: e.target.value })} />
            <button className="btn btn-sm" onClick={() => run("Noted", () => promiseToPayAction(inv.id, f.ptp))}>
              Save
            </button>
          </div>
        </div>
      )}
      {inv.payWhenPaid && <div className="text-[12px] text-amber">Pay-when-paid: carrier bills on these orders wait for this invoice.</div>}

      <Modal open={popup === "receipt"} onClose={() => setPopup(null)} title="Record receipt" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending} onClick={() => run("Receipt recorded", () => receiptAction(inv.id, f))}>Record</button></>}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Amount ({inv.currency}) · open {formatCents(inv.openCents, inv.currency)}</label>
            <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
          </div>
          <div>
            <label className="label">Received</label>
            <input type="date" className="input" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} />
          </div>
          <div>
            <label className="label">Method</label>
            <select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {["ach", "check", "wire", "card", "factoring", "other"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Reference</label>
            <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Note</label>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="one check for two invoices: record the rest on the other one" />
          </div>
        </div>
        <div className="help mt-2">Partial receipts are fine. Over-payment is refused.</div>
      </Modal>
      <Modal
        open={popup === "send"}
        onClose={() => setPopup(null)}
        title="Send invoice"
        footer={
          <>
            <button className="btn" onClick={() => setPopup(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending} onClick={() => run(f.dmethod === "portal" || f.dmethod === "mail" ? "Recorded" : "Sent", () => deliverInvoiceAction(inv.id, { method: f.dmethod, to: f.dmethod === "email" || f.dmethod === "portal" ? f.to : "", reference: f.reference }))}>
              {f.dmethod === "portal" || f.dmethod === "mail" ? "Record" : "Send"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="d-method">
              Send by
            </label>
            <select id="d-method" className="select" value={f.dmethod} onChange={(e) => setF({ ...f, dmethod: e.target.value, to: e.target.value === "portal" ? inv.portalUrl ?? "" : e.target.value === "email" ? inv.billingEmail ?? "" : f.to })}>
              <option value="email">Email with the documents attached</option>
              <option value="factor" disabled={!inv.factorName}>
                Factoring company{inv.factorName ? ` (${inv.factorName})` : " — none set up"}
              </option>
              <option value="edi">EDI 210</option>
              <option value="portal">Uploaded to their portal</option>
              <option value="mail">Mailed</option>
            </select>
          </div>
          {f.dmethod === "email" && (
            <div>
              <label className="label" htmlFor="d-to">
                To
              </label>
              <input id="d-to" className="input" type="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
              <div className="help">The invoice and its POD / BOL in one PDF, plus a link to download it. The customer&apos;s CC addresses are copied.</div>
            </div>
          )}
          {f.dmethod === "factor" && <div className="help">Goes to {inv.factorEmail ?? "the factor"} on a schedule of accounts with its documents. To send several together, use Invoices → To the factor.</div>}
          {f.dmethod === "edi" && <div className="help">Sends the 210 to the customer&apos;s EDI partner.</div>}
          {(f.dmethod === "portal" || f.dmethod === "mail") && (
            <>
              {f.dmethod === "portal" && (
                <div>
                  <label className="label" htmlFor="d-to">
                    Portal
                  </label>
                  <input id="d-to" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="https://" />
                  {inv.portalUrl && (
                    <a className="help text-teal" href={inv.portalUrl} target="_blank" rel="noreferrer">
                      Open their portal
                    </a>
                  )}
                </div>
              )}
              <div>
                <label className="label" htmlFor="d-ref">
                  {f.dmethod === "portal" ? "Portal confirmation #" : "Tracking # or note"}
                </label>
                <input id="d-ref" className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
              </div>
              <div className="help">Download the packet (invoice + documents) from the top of the page, then record it here.</div>
            </>
          )}
        </div>
      </Modal>
      <Modal open={popup === "issue"} onClose={() => setPopup(null)} title="Issue MXN invoice" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.rate} onClick={() => run("Issued", () => issueInvoiceAction(inv.id, f.rate))}>Issue</button></>}>
        <label className="label">Exchange rate (MXN per USD) at issue</label>
        <input className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="18.4321" />
      </Modal>
      <Modal open={popup === "credit"} onClose={() => setPopup(null)} title="Credit memo" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.amount || !f.note} onClick={() => run("Credit memo issued", () => creditMemoAction(inv.id, f.amount, f.note))}>Issue credit</button></>}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Amount</label>
            <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </div>
          <div>
            <label className="label">Reason</label>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
        </div>
        <div className="help mt-2">Gets its own number in the entity&apos;s sequence. The invoice keeps its number.</div>
      </Modal>
      <Confirm open={popup === "void"} onClose={() => setPopup(null)} title={`Void ${inv.number ?? "this draft"}`} body="Only possible with no receipts. The number is never reused; the orders go back to Ready to bill." needReason="Reason" confirmLabel="Void" danger onConfirm={(reason) => run("Voided", () => voidInvoiceAction(inv.id, reason))} />
      <Confirm open={popup === "dispute"} onClose={() => setPopup(null)} title="Mark disputed" needReason="What the customer disputes" confirmLabel="Disputed" onConfirm={(reason) => run("Marked disputed", () => disputeInvoiceAction(inv.id, reason))} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </aside>
  );
}
