"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { closePeriodAction } from "../actions";

/**
 * Month-end close. Only the owner closes periods: everyone else sees how far the books are closed and who
 * closes them, instead of a button that can't work for them.
 */
export function CloseButton({ canClose, closedThrough }: { canClose: boolean; closedThrough: string | null }) {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const t = useToast();
  const status = closedThrough ? `Books closed through ${closedThrough.slice(0, 10)}` : "No period closed yet";
  if (!canClose)
    return (
      <span className="text-callout text-muted" data-testid="closed-through" title="Month-end close is the owner's: ask them to close a period">
        {status} · the owner closes periods
      </span>
    );
  return (
    <>
      <span className="text-callout text-muted mr-2" data-testid="closed-through">
        {status}
      </span>
      <button className="btn" onClick={() => { setErr(null); setOpen(true); }}>
        Close period
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Month-end close"
        footer={
          <>
            {err && <span className="error m-0 mr-auto">{err}</span>}
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={!through}
              onClick={async () => {
                setErr(null);
                const r = await closePeriodAction(through);
                if (r.ok) {
                  setOpen(false);
                  t.ok(`Closed through ${through}`);
                  router.refresh();
                } else setErr(r.error);
              }}
            >
              Close
            </button>
          </>
        }
      >
        <div className="text-callout text-muted mb-3">Nothing dated on or before this day can be recorded or changed afterwards: invoices issued, voided or credited, payments and receipts, factor funding, collections and chargebacks, carrier bill payments and driver pay. This cannot be undone from here.</div>
        <label className="label">Close through</label>
        <input type="date" className="input" value={through} onChange={(e) => setThrough(e.target.value)} />
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
