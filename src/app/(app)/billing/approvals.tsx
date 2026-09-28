"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { approveChargeAction, rejectChargeAction } from "./actions";

type Pending = { id: string; description: string; amountCents: number };

/** Extras waiting for the customer: record who OK'd each one and how, or that they said no. */
export function ApprovalDialog({ orderId, orderNumber, charges, currency, onClose }: { orderId: string; orderNumber: string; charges: Pending[]; currency: string; onClose: () => void }) {
  const router = useRouter();
  const t = useToast();
  const [by, setBy] = useState("");
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");
  const [left, setLeft] = useState(charges);
  const [pending, start] = useTransition();
  const act = (c: Pending, ok: boolean) =>
    start(async () => {
      const r = ok ? await approveChargeAction(orderId, c.id, by, ref) : await rejectChargeAction(orderId, c.id, reason);
      if (!r.ok) return t.err(r.error);
      t.ok(ok ? `${c.description} approved` : `${c.description} rejected`);
      const rest = left.filter((x) => x.id !== c.id);
      setLeft(rest);
      router.refresh();
      if (!rest.length) onClose();
    });
  return (
    <>
      <Modal open onClose={onClose} title={`Extras on ${orderNumber} · customer approval`} wide>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="label" htmlFor="ap-by">
              Approved by (at the customer)
            </label>
            <input id="ap-by" className="input" value={by} onChange={(e) => setBy(e.target.value)} placeholder="Maria at RXO" />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="ap-ref">
              How (email, portal ref, call)
            </label>
            <input id="ap-ref" className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="email 9/26 'Re: detention on 26-00041'" />
          </div>
        </div>
        <table className="table" data-testid="pending-charges">
          <tbody>
            {left.map((c) => (
              <tr key={c.id}>
                <td className="font-semibold">{c.description}</td>
                <td className="mono text-right">{formatCents(c.amountCents, currency)}</td>
                <td className="text-right whitespace-nowrap space-x-1">
                  <button className="btn btn-sm btn-primary" disabled={pending || !by.trim()} onClick={() => act(c, true)}>
                    Approve
                  </button>
                  <button className="btn btn-sm" disabled={pending || !reason.trim()} onClick={() => act(c, false)} title="Type what the customer said below first">
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3">
          <label className="label" htmlFor="ap-reason">
            If they said no — what they said
          </label>
          <input id="ap-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="no detention: appointment missed by 2 h" />
        </div>
        <div className="help mt-2">An approved extra bills with the load (or joins its open draft). Approved after the invoice went out, it waits in the queue for a supplemental invoice. A rejected one stays on the load for the record and never bills.</div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
