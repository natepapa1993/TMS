"use client";

import { useState, useTransition } from "react";
import { localDay } from "@/lib/time";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { NOT_EMAILED, sendOutcome } from "@/domain/delivery-rules";
import { issueInvoiceAction, deliverInvoiceAction, receiptAction, voidInvoiceAction, creditMemoAction, disputeInvoiceAction, promiseToPayAction, rebillAction, resolveDisputeAction, sendCreditMemoAction, sendCorrectedInvoiceAction } from "../../actions";

type Inv = { id: string; state: string; currency: string; openCents: number; paidCents: number; creditedCents: number; billingEmail: string | null; promiseToPayAt: string | null; payWhenPaid: boolean; number: string | null; method: string; portalUrl: string | null; factorName: string | null; factorEmail: string | null; suggestedRate: string; needsCorrected: boolean; hasCreditMemo: boolean };

/** Email a credit memo to the customer (their billing email), like an invoice. */
export function SendCreditMemo({ id, sent }: { id: string; sent: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  return (
    <>
      <button
        className="btn btn-sm"
        disabled={pending}
        data-testid="send-credit-memo"
        onClick={() =>
          start(async () => {
            const r = await sendCreditMemoAction(id);
            if (!r.ok) return t.err(r.error);
            if (r.data.logged) t.err(`Credit memo ${r.data.message}`);
            else t.ok(r.data.message);
            router.refresh();
          })
        }
      >
        {sent ? "Send again" : "Send"}
      </button>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

export function InvoiceActions({ inv, role }: { inv: Inv; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [popup, setPopup] = useState<null | "receipt" | "credit" | "void" | "dispute" | "send" | "issue" | "rebill" | "resolve">(null);
  const fresh = () => ({ amount: "", receivedAt: localDay(), method: "ach", reference: "", note: "", to: inv.billingEmail ?? "", rate: inv.suggestedRate, rxRate: inv.suggestedRate, dmethod: inv.method, ptp: inv.promiseToPayAt?.slice(0, 10) ?? "", outcome: "customer_pays" });
  const [f, setF] = useState(fresh);
  // every dialog starts clean: nothing typed in one carries into another
  const openPopup = (p: NonNullable<typeof popup>) => {
    setF(fresh());
    setPopup(p);
  };
  const canVoid = role === "owner";
  const can = ["owner", "billing"].includes(role);
  const run = <D,>(label: string | ((data: D) => string), fn: () => Promise<{ ok: true; data: D } | { ok: false; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setPopup(null);
      if (r.ok) {
        const msg = typeof label === "function" ? label(r.data) : label;
        // an email that only went to the log is not good news: say it plainly, in amber
        if (msg === NOT_EMAILED) t.err(msg);
        else t.ok(msg);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  if (!can) return null;
  const s = inv.state;
  return (
    <aside className="card p-4 space-y-2 sticky top-5">
      <div className="eyebrow mb-1">Actions</div>
      {s === "paid" && <div className="text-callout text-muted">Paid in full. Nothing left to do here.</div>}
      {s === "void" && <div className="text-callout text-muted">Voided. It stays for the record; nothing can be done to it.</div>}
      {s === "draft" && (
        <button className="btn btn-primary w-full justify-center" disabled={pending} onClick={() => (inv.currency !== "USD" ? openPopup("issue") : run("Issued", () => issueInvoiceAction(inv.id)))}>
          Issue invoice
        </button>
      )}
      {inv.needsCorrected && (
        <button className="btn btn-primary w-full justify-center" data-testid="send-corrected" disabled={pending} title="Charged back: the customer's copy still says to pay the factor" onClick={() => run((d) => sendOutcome(d as never, "Corrected invoice sent — remit to you"), () => sendCorrectedInvoiceAction(inv.id))}>
          Send corrected invoice (remit to us)
        </button>
      )}
      {s === "disputed" && (
        <button className="btn btn-primary w-full justify-center" data-testid="resolve-dispute" onClick={() => openPopup("resolve")}>
          Resolve dispute
        </button>
      )}
      {["issued", "sent", "partially_paid"].includes(s) && (
        <button className={`btn ${inv.needsCorrected ? "" : "btn-primary"} w-full justify-center`} onClick={() => openPopup("send")}>
          {s === "issued" ? "Send invoice" : "Send again"}
        </button>
      )}
      {["issued", "sent", "partially_paid", "disputed"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => openPopup("receipt")}>
          Record receipt
        </button>
      )}
      {canVoid && ["issued", "sent", "partially_paid", "disputed"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => openPopup("credit")}>
          Credit memo
        </button>
      )}
      {["issued", "sent", "partially_paid"].includes(s) && (
        <button className="btn w-full justify-center" onClick={() => openPopup("dispute")}>
          Mark disputed
        </button>
      )}
      {["issued", "sent", "disputed"].includes(s) && !inv.paidCents && !inv.creditedCents && (
        <button className="btn w-full justify-center" onClick={() => openPopup("rebill")} title="Void this one and open a new draft for the same loads, to change it before it goes out again">
          Rebill
        </button>
      )}
      {!canVoid && ["issued", "sent", "partially_paid", "disputed"].includes(s) && <div className="text-footnote text-muted pt-1">Credit memos and voids need the owner.</div>}
      {canVoid && ["issued", "sent", "draft", "disputed"].includes(s) && (
        <button className="btn btn-danger w-full justify-center" onClick={() => openPopup("void")}>
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
      {inv.payWhenPaid && <div className="text-footnote text-amber">Pay-when-paid: carrier bills on these orders wait for this invoice.</div>}

      <Modal open={popup === "receipt"} onClose={() => setPopup(null)} title="Record receipt" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending} onClick={() => run("Receipt recorded", () => receiptAction(inv.id, { ...f, exchangeRate: inv.currency !== "USD" ? f.rxRate : "" }))}>Record</button></>}>
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
              {[["ach", "ACH"], ["check", "Check"], ["wire", "Wire"], ["card", "Card"], ["factoring", "Factoring"], ["other", "Other"]].map(([m, l]) => (
                <option key={m} value={m}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Reference</label>
            <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </div>
          {inv.currency !== "USD" && f.method !== "factoring" && (
            <div className="col-span-2">
              <label className="label">Rate the day it arrived ({inv.currency} per USD)</label>
              <input className="input" inputMode="decimal" value={f.rxRate} onChange={(e) => setF({ ...f, rxRate: e.target.value })} placeholder={inv.currency === "CAD" ? "1.3700" : "18.4500"} data-testid="receipt-rate" />
              <div className="help">Against the invoice&rsquo;s rate this is the exchange gain or loss (reports and the QuickBooks export).</div>
            </div>
          )}
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
            <button className="btn btn-primary" disabled={pending} onClick={() => run((d) => (f.dmethod === "portal" || f.dmethod === "mail" ? "Recorded" : sendOutcome(d as never)), () => deliverInvoiceAction(inv.id, { method: f.dmethod, to: f.dmethod === "email" || f.dmethod === "portal" ? f.to : "", reference: f.reference }))}>
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
      <Modal open={popup === "issue"} onClose={() => setPopup(null)} title={`Issue ${inv.currency} invoice`} footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.rate} onClick={() => run("Issued", () => issueInvoiceAction(inv.id, f.rate))}>Issue</button></>}>
        <label className="label" htmlFor="i-rate">
          Exchange rate at issue: {inv.currency} per 1 USD
        </label>
        <input id="i-rate" className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder={inv.currency === "CAD" ? "1.3700" : "18.4500"} />
        <div className="help mt-2">Stored on the invoice. Reports and the QuickBooks export convert this invoice to USD with it, and it becomes the company&rsquo;s latest {inv.currency} rate for loads not invoiced yet.{inv.suggestedRate ? " Filled in with the last rate used — check it against today’s." : ""}</div>
      </Modal>
      <Modal
        open={popup === "resolve"}
        onClose={() => setPopup(null)}
        title={`Resolve the dispute on ${inv.number ?? ""}`}
        footer={
          <>
            <button className="btn" onClick={() => setPopup(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending || !f.note.trim()} onClick={() => run("Dispute resolved", () => resolveDisputeAction(inv.id, f.outcome, f.note))}>
              Resolve
            </button>
          </>
        }
      >
        <label className="label" htmlFor="r-outcome">
          How it ended
        </label>
        <select id="r-outcome" className="select" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
          <option value="customer_pays">In our favor — the customer will pay</option>
          <option value="credited" disabled={!inv.hasCreditMemo}>
            With a credit memo{inv.hasCreditMemo ? "" : " (issue it first)"}
          </option>
          <option value="paid">The customer paid</option>
          <option value="other">Other</option>
        </select>
        <label className="label mt-3" htmlFor="r-note">
          Note
        </label>
        <input id="r-note" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="what was agreed, with whom" />
        <div className="help mt-2">{inv.openCents > 0 ? `${formatCents(inv.openCents, inv.currency)} is still open: it goes back to ${inv.paidCents ? "partly paid" : "sent"} and reminders pick it up again.` : "Nothing is open: it closes as paid."}</div>
      </Modal>
      <Modal open={popup === "credit"} onClose={() => setPopup(null)} title="Credit memo" footer={<><button className="btn" onClick={() => setPopup(null)}>Cancel</button><button className="btn btn-primary" disabled={pending || !f.amount || !f.note} onClick={() => run("Credit memo issued", () => creditMemoAction(inv.id, f.amount, f.note))}>Issue credit</button></>}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Amount ({inv.currency})</label>
            <input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </div>
          <div>
            <label className="label">Reason</label>
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
        </div>
        <div className="help mt-2">Gets its own credit memo number (PREFIX-CM-…), apart from invoice numbers, and its own PDF you can send the customer. The invoice PDF then shows the credit.</div>
      </Modal>
      <Confirm open={popup === "void"} onClose={() => setPopup(null)} title={`Void ${inv.number ?? "this draft"}`} body="Only possible with no receipts. The number is never reused; the orders go back to Ready to bill." needReason="Reason" confirmLabel="Void" danger onConfirm={(reason) => run("Voided", () => voidInvoiceAction(inv.id, reason))} />
      <Confirm
        open={popup === "rebill"}
        onClose={() => setPopup(null)}
        title={`Rebill ${inv.number ?? ""}`}
        body="This invoice is voided with your reason (its number is never reused) and a new draft for the same loads opens, linked to it. Change what the customer asked for — their PO, a charge, the bill-to — then issue and send it."
        needReason="What the customer asked for"
        confirmLabel="Void & open the new draft"
        onConfirm={(reason) =>
          start(async () => {
            const r = await rebillAction(inv.id, reason);
            setPopup(null);
            if (!r.ok) return t.err(r.error);
            router.push(`/billing/invoices/${r.data.id}`);
          })
        }
      />
      <Confirm open={popup === "dispute"} onClose={() => setPopup(null)} title="Mark disputed" needReason="What the customer disputes" confirmLabel="Disputed" onConfirm={(reason) => run("Marked disputed", () => disputeInvoiceAction(inv.id, reason))} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </aside>
  );
}
