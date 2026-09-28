"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { localDay } from "@/lib/time";
import type { LedgerRow } from "@/domain/factoring";
import { recordFundingAction, recordCollectionAction, recordChargebackAction, sendCorrectedInvoiceAction } from "../actions";

const STATUS: Record<LedgerRow["status"], [string, "slate" | "teal" | "amber" | "red" | "green"]> = { to_fund: ["waiting for funding", "amber"], funded: ["funded", "teal"], collected: ["collected", "green"], charged_back: ["charged back", "red"] };

export function FactorLedger({ rows, canEdit, terms }: { rows: LedgerRow[]; canEdit: boolean; terms: { advanceBp: number; feeBp: number } | null }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [sel, setSel] = useState<string[]>([]);
  const [fund, setFund] = useState<{ at: string; reference: string; advance: string; fee: string } | null>(null);
  const [act, setAct] = useState<{ row: LedgerRow; kind: "collect" | "chargeback"; at: string; reference: string; note: string } | null>(null);
  const toFund = rows.filter((r) => r.status === "to_fund");
  const selected = toFund.filter((r) => sel.includes(r.invoiceId));
  return (
    <>
      {canEdit && toFund.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <button className="btn btn-primary" disabled={!sel.length} data-testid="record-funding" onClick={() => setFund({ at: localDay(), reference: "", advance: terms ? String(terms.advanceBp / 100) : "97", fee: terms ? String(terms.feeBp / 100) : "3" })}>
            Record funding ({sel.length})
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSel(toFund.map((r) => r.invoiceId))}>
            Select all waiting ({toFund.length})
          </button>
        </div>
      )}
      <div className="card overflow-auto">
        {rows.length === 0 ? (
          <div className="py-14 text-center">
            <div className="font-bold">No factored invoices</div>
            <div className="text-muted text-callout mt-1">Invoices from a billing entity with a factor (Settings → Billing entities → Factoring) show here once issued.</div>
          </div>
        ) : (
          <table className="table" data-testid="factor-ledger">
            <thead>
              <tr>
                {canEdit && <th className="w-8"></th>}
                <th>Invoice</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Advanced</th>
                <th>Fee</th>
                <th>Reserve</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invoiceId}>
                  {canEdit && <td>{r.status === "to_fund" && <input type="checkbox" className="accent-teal" aria-label={`Select ${r.number}`} checked={sel.includes(r.invoiceId)} onChange={(e) => setSel(e.target.checked ? [...sel, r.invoiceId] : sel.filter((x) => x !== r.invoiceId))} />}</td>}
                  <td className="mono font-bold">
                    <Link href={`/billing/invoices/${r.invoiceId}`} className="hover:text-teal">
                      {r.number}
                    </Link>
                    <div className="text-footnote text-muted font-sans">{r.entity}</div>
                  </td>
                  <td>{r.customer}</td>
                  <td className="mono">{formatCents(r.totalCents, r.currency)}</td>
                  <td className="mono">{r.advancedCents ? formatCents(r.advancedCents, r.currency) : "—"}</td>
                  <td className="mono text-muted">{r.feeCents ? formatCents(r.feeCents, r.currency) : "—"}</td>
                  <td className="mono">
                    {r.status === "charged_back" ? (
                      <span className="text-footnote font-sans" title="The reserve was the part of the invoice the factor held back until the customer paid. On a chargeback it isn't paid out: the customer owes it to you again.">
                        {formatCents(r.reserveBackToArCents, r.currency)} back to Receivables
                      </span>
                    ) : r.reserveCents ? (
                      formatCents(r.reserveCents, r.currency)
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <Pill tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Pill>
                    {r.status === "charged_back" && r.repaidCents > 0 && <div className="text-footnote text-muted mt-0.5">repaid {formatCents(r.repaidCents, r.currency)} (advance + fee)</div>}
                    {r.status === "funded" && r.ageDays != null && (
                      <div className={`text-footnote mt-0.5 ${r.atRisk ? "text-red font-semibold" : "text-muted"}`}>
                        {r.ageDays} d{r.recourseDays ? ` of ${r.recourseDays} recourse` : " · non-recourse"}
                      </div>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap space-x-1">
                    {canEdit && r.needsCorrectedInvoice && (
                      <button
                        className="btn btn-sm btn-primary"
                        data-testid="send-corrected"
                        disabled={pending}
                        title="The customer's copy still says to pay the factor: send it again with your own remit-to"
                        onClick={() =>
                          start(async () => {
                            const x = await sendCorrectedInvoiceAction(r.invoiceId);
                            if (!x.ok) return t.err(x.error);
                            t.ok("Corrected invoice sent — remit to you");
                            router.refresh();
                          })
                        }
                      >
                        Send corrected invoice (remit to us)
                      </button>
                    )}
                    {canEdit && r.status === "funded" && (
                      <>
                        <button className="btn btn-sm" onClick={() => setAct({ row: r, kind: "collect", at: localDay(), reference: "", note: "" })}>
                          Collected
                        </button>
                        {r.recourseDays > 0 && (
                          <button className="btn btn-sm btn-ghost text-red" onClick={() => setAct({ row: r, kind: "chargeback", at: localDay(), reference: "", note: "" })}>
                            Charged back
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {fund && (
        <Modal
          open
          onClose={() => setFund(null)}
          title={`The factor funded ${selected.length} invoice${selected.length === 1 ? "" : "s"} · ${[...new Set(selected.map((r) => r.currency))].map((c) => formatCents(selected.filter((r) => r.currency === c).reduce((a, r) => a + r.totalCents, 0), c)).join(" · ")}`}
          footer={
            <>
              <button className="btn" onClick={() => setFund(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await recordFundingAction(sel, fund);
                    if (!r.ok) return t.err(r.error);
                    setFund(null);
                    setSel([]);
                    t.ok(`Funded: ${formatCents(r.data.advancedCents, selected[0]?.currency ?? "USD")} advanced`);
                    router.refresh();
                  })
                }
              >
                Record funding
              </button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="f-at">
                Funded on
              </label>
              <input id="f-at" type="date" className="input" value={fund.at} onChange={(e) => setFund({ ...fund, at: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="f-ref">
                Schedule / wire #
              </label>
              <input id="f-ref" className="input" value={fund.reference} onChange={(e) => setFund({ ...fund, reference: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="f-adv">
                Advance %
              </label>
              <input id="f-adv" className="input" inputMode="decimal" value={fund.advance} onChange={(e) => setFund({ ...fund, advance: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="f-fee">
                Fee %
              </label>
              <input id="f-fee" className="input" inputMode="decimal" value={fund.fee} onChange={(e) => setFund({ ...fund, fee: e.target.value })} />
            </div>
          </div>
          <div className="help mt-2">What&rsquo;s neither advanced nor fee is the reserve the factor holds until the customer pays it. Funded invoices leave your Receivables: the customer owes the factor now.</div>
        </Modal>
      )}
      {act && (
        <Modal
          open
          onClose={() => setAct(null)}
          title={act.kind === "collect" ? `${act.row.number}: the customer paid the factor` : `${act.row.number}: charged back`}
          footer={
            <>
              <button className="btn" onClick={() => setAct(null)}>
                Cancel
              </button>
              <button
                className={`btn ${act.kind === "collect" ? "btn-primary" : "btn-danger"}`}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = act.kind === "collect" ? await recordCollectionAction(act.row.invoiceId, act) : await recordChargebackAction(act.row.invoiceId, act);
                    if (!r.ok) return t.err(r.error);
                    setAct(null);
                    t.ok(act.kind === "collect" ? `Collected${"reserveCents" in r.data && r.data.reserveCents ? ` · ${formatCents(r.data.reserveCents, act.row.currency)} reserve released` : ""}` : "Charged back — the invoice is back in Receivables. Send the customer a corrected invoice.");
                    router.refresh();
                  })
                }
              >
                {act.kind === "collect" ? "Record collection" : "Record chargeback"}
              </button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="c-at">
                Date
              </label>
              <input id="c-at" type="date" className="input" value={act.at} onChange={(e) => setAct({ ...act, at: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="c-ref">
                Factor&rsquo;s reference
              </label>
              <input id="c-ref" className="input" value={act.reference} onChange={(e) => setAct({ ...act, reference: e.target.value })} />
            </div>
          </div>
          <div className="help mt-2">{act.kind === "collect" ? "The invoice is marked paid (by factoring) and the reserve the factor held comes back." : `You repay the ${formatCents(act.row.advancedCents, act.row.currency)} advance plus the ${formatCents(act.row.feeCents, act.row.currency)} fee the factor keeps. The ${formatCents(act.row.reserveCents, act.row.currency)} reserve was never paid to you: it goes back to Receivables with the invoice, which the customer now owes you in full. Then send them a corrected invoice with your remit-to.`}</div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
