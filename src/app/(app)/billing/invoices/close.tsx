"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { closePeriodAction } from "../actions";
import { zonedDate } from "@/lib/time";

/**
 * Month-end close. Only the owner closes periods: everyone else sees how far the books are closed and who
 * closes them, instead of a button that can't work for them.
 */
export function CloseButton({ canClose, closedThrough, today, timeZone = "America/Chicago" }: { canClose: boolean; closedThrough: string | null; /** today in the company's zone */ today?: string; timeZone?: string }) {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const t = useToast();
  const closedDay = closedThrough ? zonedDate(new Date(closedThrough), timeZone) : null;
  const status = closedDay ? `Books closed through ${longDay(closedDay)}` : "No period closed yet";
  // the latest day that can be closed: yesterday in the company's zone (today hasn't ended)
  const yesterday = today ? new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) - 1)).toISOString().slice(0, 10) : undefined;
  const tooLate = !!through && !!today && through >= today;
  const tooEarly = !!through && !!closedDay && through < closedDay;
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
      <button className="btn" onClick={() => { setErr(null); setConfirm(false); setThrough(""); setOpen(true); }}>
        Close period
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Month-end close"
        footer={
          <>
            {err && <span className="error m-0 mr-auto">{err}</span>}
            <button className="btn" onClick={() => (confirm ? setConfirm(false) : setOpen(false))}>
              {confirm ? "Back" : "Cancel"}
            </button>
            {!confirm ? (
              <button className="btn btn-primary" disabled={!through || tooLate || tooEarly} onClick={() => setConfirm(true)}>
                Continue
              </button>
            ) : (
              <button
                className="btn btn-danger"
                data-testid="close-confirm"
                onClick={async () => {
                  setErr(null);
                  const r = await closePeriodAction(through);
                  if (r.ok) {
                    setOpen(false);
                    t.ok(`Books closed through ${longDay(through)}`);
                    router.refresh();
                  } else setErr(r.error);
                }}
              >
                Close through {longDay(through)} for good
              </button>
            )}
          </>
        }
      >
        {!confirm ? (
          <>
            <div className="text-callout text-muted mb-3">Nothing dated on or before this day can be recorded or changed afterwards: invoices issued, voided or credited, payments and receipts, factor funding, collections and chargebacks, carrier bill payments and driver pay. Only a day that has ended can be closed.</div>
            <label className="label" htmlFor="close-through">
              Close through (last day of the period)
            </label>
            <input id="close-through" type="date" className="input" value={through} max={yesterday} min={closedDay ?? undefined} onChange={(e) => setThrough(e.target.value)} />
            {tooLate && <div className="error mt-1">{through === today ? "Today hasn't ended yet" : "That day is in the future"}: close through {yesterday ? longDay(yesterday) : "yesterday"} at the latest.</div>}
            {tooEarly && <div className="error mt-1">The books are already closed through {longDay(closedDay!)}: a close can&rsquo;t move back.</div>}
          </>
        ) : (
          <div className="text-body space-y-2" data-testid="close-summary">
            <p>
              Close the books through <b>{longDay(through)}</b>?
            </p>
            <p className="text-callout">From then on nothing dated {longDay(through)} or earlier can be recorded or changed — not an invoice, a credit memo, a payment, a factoring entry, a carrier bill payment or driver pay.</p>
            <p className="text-callout font-semibold text-red">This can&rsquo;t be reopened.</p>
          </div>
        )}
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

/** "Monday, Aug 31, 2026" for a YYYY-MM-DD day. */
function longDay(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
