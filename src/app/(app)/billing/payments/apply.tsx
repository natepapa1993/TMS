"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { localDay } from "@/lib/time";
import { suggest } from "@/domain/cash-rules";
import { openItemsAction, applyPaymentAction, applyOnAccountAction } from "../actions";

type Inv = { id: string; number: string; state: string; currency: string; dueAt: string | null; totalCents: number; openCents: number; loads: { orderNumber: string; refs: string[] }[] };
type Line = { invoiceId: string; amount: string; shortPay: string; reason: string };
const cents = (v: string) => Math.round(Number(String(v).replace(/[$,\s]/g, "")) * 100) || 0;
const dollars = (c: number) => (c / 100).toFixed(2);

/** One check or ACH over many invoices: who paid, how much, what it pays, what to do with each short pay; the rest goes on account. */
export function ApplyPaymentButton({ customers, customerId, role, label = "Record a payment", today }: { customers: { id: string; name: string }[]; customerId?: string; role: string; label?: string; /** today in the company's zone */ today?: string }) {
  const router = useRouter();
  const t = useToast();
  const [open, setOpen] = useState(false);
  const blank = (day = today ?? localDay()) => ({ customerId: customerId ?? "", amount: "", currency: "USD", exchangeRate: "", receivedAt: day, method: "check", reference: "", remittance: "", note: "" });
  const [f, setF] = useState(blank());
  const [rates, setRates] = useState<Record<string, string>>({});
  const [invs, setInvs] = useState<Inv[]>([]);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [result, setResult] = useState<{ applied: { number: string; appliedCents: number; after: string }[]; onAccountCents: number; autoMatched?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const canWriteOff = role === "owner";

  const load = (cid: string) =>
    start(async () => {
      setInvs([]);
      setLines({});
      if (!cid) return;
      const r = await openItemsAction(cid);
      if (!r.ok) return t.err(r.error);
      setInvs(r.data.invoices);
      setRates(r.data.rates);
      // the payment's currency starts as the one this customer was billed in last; change it if the money came in another
      // (received today in the company's zone, and the company's rate for pesos / Canadian dollars to start with)
      const cur = r.data.latestCurrency ?? r.data.invoices[0]?.currency ?? "USD";
      setF((x) => ({ ...x, currency: cur, exchangeRate: cur === "USD" ? "" : (r.data.rates[cur] ?? ""), receivedAt: x.receivedAt || r.data.today }));
      setLines(Object.fromEntries(r.data.invoices.map((i) => [i.id, { invoiceId: i.id, amount: "", shortPay: "leave_open", reason: "" }])));
    });
  const auto = () => {
    const plan = suggest(invs, cents(f.amount), f.remittance, f.currency);
    setLines(Object.fromEntries(plan.map((p) => [p.invoiceId, { ...(lines[p.invoiceId] ?? { invoiceId: p.invoiceId, shortPay: "leave_open", reason: "" }), amount: p.applyCents ? dollars(p.applyCents) : "" }])));
  };
  // only invoices in the payment's currency can take it: pesos never pay a dollar invoice
  const shown = invs.filter((i) => i.currency === f.currency);
  const hidden = invs.filter((i) => i.currency !== f.currency);
  const applied = shown.reduce((a, i) => a + cents(lines[i.id]?.amount ?? ""), 0);
  const left = cents(f.amount) - applied;
  const cur = f.currency;
  const set = (id: string, patch: Partial<Line>) => setLines({ ...lines, [id]: { ...lines[id], ...patch } });

  return (
    <>
      <button
        className="btn btn-primary"
        data-testid="record-payment"
        onClick={() => {
          setResult(null);
          setF(blank());
          setOpen(true);
          if (customerId) load(customerId);
        }}
      >
        {label}
      </button>
      {open && (
        <Modal
          open
          wide
          onClose={() => setOpen(false)}
          title={result ? "Payment recorded" : "Record a payment"}
          footer={
            result ? (
              <button className="btn btn-primary" onClick={() => setOpen(false)}>
                Done
              </button>
            ) : (
              <>
                <span className={`mr-auto text-callout font-semibold ${left < 0 ? "text-red" : ""}`} data-testid="payment-balance">
                  Applied {formatCents(applied, cur)} of {formatCents(cents(f.amount), cur)}
                  {left > 0 ? ` · ${formatCents(left, cur)} goes on account` : left < 0 ? " · more than received" : ""}
                  {left > 0 && applied === 0 && f.remittance.trim() ? " unless the remittance names an open invoice" : ""}
                  {left > 0 && left > shown.reduce((x, i) => x + i.openCents, 0) && shown.length > 0 ? <span className="text-amber"> · more than everything open in {cur}: is the currency right?</span> : null}
                </span>
                <button className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={pending || !f.customerId || !cents(f.amount) || left < 0}
                  onClick={() =>
                    start(async () => {
                      const r = await applyPaymentAction({ ...f, applications: shown.map((i) => lines[i.id]).filter((l) => l && (cents(l.amount) > 0 || l.shortPay !== "leave_open")) });
                      if (!r.ok) return t.err(r.error);
                      setResult({ applied: r.data.applied, onAccountCents: r.data.onAccountCents, autoMatched: r.data.autoMatched });
                      router.refresh();
                    })
                  }
                >
                  Apply payment
                </button>
              </>
            )
          }
        >
          {result ? (
            <div className="text-body space-y-1" data-testid="payment-result">
              {result.autoMatched && <div className="text-callout text-muted">Applied to what the remittance names.</div>}
              {result.applied.map((a) => (
                <div key={a.number}>
                  <b className="mono">{a.number}</b> {formatCents(a.appliedCents, cur)} — {a.after}
                </div>
              ))}
              {result.onAccountCents > 0 && <div>{formatCents(result.onAccountCents, cur)} on account for the next invoice.</div>}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-5 gap-3">
                <div className="col-span-2">
                  <label className="label" htmlFor="p-customer">
                    From
                  </label>
                  <select
                    id="p-customer"
                    className="select"
                    value={f.customerId}
                    onChange={(e) => {
                      setF({ ...f, customerId: e.target.value });
                      load(e.target.value);
                    }}
                  >
                    <option value="">Customer…</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="p-amount">
                    Amount ({f.currency})
                  </label>
                  <div className="flex gap-1">
                    <input id="p-amount" className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" />
                    <select className="select w-24 shrink-0" aria-label="Payment currency" data-testid="payment-currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value, exchangeRate: e.target.value === "USD" ? "" : (rates[e.target.value] ?? f.exchangeRate) })}>
                      <option>USD</option>
                      <option>MXN</option>
                      <option>CAD</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="p-date">
                    Received
                  </label>
                  <input id="p-date" type="date" className="input" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="p-method">
                    Method
                  </label>
                  <select id="p-method" className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                    <option value="check">Check</option>
                    <option value="ach">ACH</option>
                    <option value="wire">Wire</option>
                    <option value="card">Card</option>
                    <option value="factoring">Factoring</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                {f.currency !== "USD" && (
                  <div className="col-span-2">
                    <label className="label" htmlFor="p-rate">
                      Rate the day it arrived ({f.currency} per USD)
                    </label>
                    <input id="p-rate" className="input" inputMode="decimal" value={f.exchangeRate} onChange={(e) => setF({ ...f, exchangeRate: e.target.value })} placeholder={f.currency === "CAD" ? "1.37" : "18.45"} data-testid="payment-rate" />
                    <div className="help">The bank got dollars at this rate; against the invoice&rsquo;s rate it is the exchange gain or loss.</div>
                  </div>
                )}
                <div className={f.currency !== "USD" ? "col-span-1" : "col-span-2"}>
                  <label className="label" htmlFor="p-ref">
                    Check # / ACH trace
                  </label>
                  <input id="p-ref" className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
                </div>
                <div className="col-span-3">
                  <label className="label" htmlFor="p-remit">
                    Remittance advice (paste it — invoice or load numbers in it are matched)
                  </label>
                  <input id="p-remit" className="input" value={f.remittance} onChange={(e) => setF({ ...f, remittance: e.target.value })} placeholder="INV BC-000123 1,250.00; BC-000124 600.00" />
                </div>
              </div>
              <div className="flex items-center justify-between mt-4 mb-2">
                <div className="eyebrow">
                  Open {f.currency} invoices{shown.length ? ` · ${shown.length}` : ""}
                  {hidden.length > 0 && <span className="normal-case font-normal text-muted"> · {hidden.length} in {[...new Set(hidden.map((i) => i.currency))].join(", ")} not shown — record that money as its own payment in its currency</span>}
                </div>
                <button className="btn btn-sm" disabled={!shown.length || !cents(f.amount)} onClick={auto} data-testid="auto-apply">
                  Match {f.remittance.trim() ? "the remittance" : "oldest first"}
                </button>
              </div>
              {!f.customerId ? (
                <div className="text-muted text-callout">Pick who paid.</div>
              ) : !shown.length ? (
                <div className="text-muted text-callout">{pending ? "Loading…" : `Nothing open in ${f.currency} for this customer — the whole payment goes on account (it can pay a later ${f.currency} invoice).`}</div>
              ) : (
                <div className="max-h-[340px] overflow-auto -mx-5">
                  <table className="table" data-testid="apply-table">
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Loads</th>
                        <th>Due</th>
                        <th>Open</th>
                        <th>Apply</th>
                        <th>If short</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((i) => {
                        const l = lines[i.id];
                        const short = cents(l?.amount ?? "") > 0 && cents(l.amount) < i.openCents;
                        return (
                          <tr key={i.id} data-testid="apply-row">
                            <td className="mono font-bold">{i.number}</td>
                            <td className="text-footnote text-muted">{i.loads.map((x) => x.orderNumber).join(", ")}</td>
                            <td className={`text-callout ${i.dueAt && new Date(i.dueAt) < new Date() ? "text-red font-semibold" : ""}`}>{i.dueAt?.slice(0, 10) ?? "—"}</td>
                            <td className="mono">{formatCents(i.openCents, i.currency)}</td>
                            <td>
                              <input className="input w-28" inputMode="decimal" aria-label={`Apply to ${i.number}`} value={l?.amount ?? ""} onChange={(e) => set(i.id, { amount: e.target.value })} />
                            </td>
                            <td>
                              {short && (
                                <div className="flex gap-1">
                                  <select className="select w-32" aria-label={`Short pay on ${i.number}`} value={l.shortPay} onChange={(e) => set(i.id, { shortPay: e.target.value })}>
                                    <option value="leave_open">Leave open</option>
                                    {canWriteOff && <option value="write_off">Write off</option>}
                                    <option value="dispute">Dispute</option>
                                  </select>
                                  {l.shortPay !== "leave_open" && <input className="input w-40" aria-label={`Short pay reason on ${i.number}`} placeholder="their reason" value={l.reason} onChange={(e) => set(i.id, { reason: e.target.value })} />}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

/** Use money a customer has on account against one of their open invoices. */
export function UseOnAccount({ paymentId, unappliedCents, currency, invoices }: { paymentId: string; unappliedCents: number; currency: string; invoices: { id: string; number: string; openCents: number }[] }) {
  const router = useRouter();
  const t = useToast();
  const [inv, setInv] = useState("");
  const [pending, start] = useTransition();
  if (!invoices.length) return <span className="text-footnote text-muted">no open invoice to use it on</span>;
  return (
    <span className="inline-flex gap-1 items-center">
      <select className="select h-8 text-callout w-40" value={inv} onChange={(e) => setInv(e.target.value)} aria-label="Use on invoice">
        <option value="">Use on…</option>
        {invoices.map((i) => (
          <option key={i.id} value={i.id}>
            {i.number} · {formatCents(i.openCents, currency)}
          </option>
        ))}
      </select>
      <button
        className="btn btn-sm"
        disabled={!inv || pending}
        onClick={() =>
          start(async () => {
            const target = invoices.find((i) => i.id === inv)!;
            const r = await applyOnAccountAction(paymentId, inv, dollars(Math.min(unappliedCents, target.openCents)));
            if (!r.ok) return t.err(r.error);
            t.ok("Applied from money on account");
            router.refresh();
          })
        }
      >
        Apply
      </button>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </span>
  );
}
