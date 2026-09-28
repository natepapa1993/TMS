import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { aging } from "@/domain/billing";
import { PageHeader } from "@/components/page-header";
import { formatCents } from "@/data/fields";
import { BillingNav } from "../nav";
import { onAccountByCustomer } from "@/domain/cash";
import { list } from "@/data/records";
import { ApplyPaymentButton } from "../payments/apply";
import { formatTotals, fxNote } from "@/domain/fx-rules";

export const metadata = { title: "Receivables" };
export const dynamic = "force-dynamic";

export default async function ArPage() {
  const ctx = await requireCtx();
  const [{ rows, totals, withFactor, home }, onAccount, customers] = await Promise.all([aging(ctx), onAccountByCustomer(ctx), list(ctx, "customer", { limit: 2000 })]);
  const canBill = ["owner", "billing"].includes(ctx.role);
  const cols = [["current", "Current"], ["1_30", "1–30"], ["31_60", "31–60"], ["61_90", "61–90"], ["90_plus", "90+"]] as const;
  const currencies = Object.keys(totals);
  const foreign = currencies.some((c) => c !== "USD");
  const factorTotal = Object.values(withFactor).some((v) => v);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Receivables" actions={canBill ? <ApplyPaymentButton customers={customers.map((c) => ({ id: c.id, name: String(c.name) }))} role={ctx.role} /> : undefined}>
        Open invoices by customer and age, each currency on its own. Invoices the factor funded are left out (the customer owes the factor). Reminders go out at +3, +10 and +20 days past due unless a customer opts out.{" "}
        {factorTotal ? (
          <Link href="/billing/factoring" className="text-teal font-semibold">
            {formatTotals(withFactor)} more is with the factor.
          </Link>
        ) : null}
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        {(currencies.length ? currencies : ["USD"]).map((cur) => {
          const t = totals[cur] ?? { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, total: 0 };
          return (
            <div key={cur} className="mb-4" data-testid={`ar-totals-${cur}`}>
              {(foreign || currencies.length > 1) && <div className="eyebrow mb-1">{cur === "USD" ? "US dollars" : cur === "MXN" ? "Mexican pesos" : cur === "CAD" ? "Canadian dollars" : cur} ({cur})</div>}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                {[["Total open", t.total, ""], ...cols.map(([k, l]) => [l, t[k], k === "current" ? "" : k === "1_30" ? "text-amber" : "text-red"])].map(([l, v, cls]) => (
                  <div key={String(l)} className="card p-4">
                    <div className="eyebrow">{l}</div>
                    <div className={`text-title2 font-extrabold mono ${v ? cls : "text-faint"}`}>{formatCents(Number(v), cur)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {foreign && (
          <div className="text-callout text-muted mb-4" data-testid="ar-home">
            All together in US dollars: <b className="text-ink">{formatCents(home.openCents)}</b> open, {formatCents(home.overdueCents)} past due — {fxNote(home.rates)}. Reports use this same figure.
          </div>
        )}
        <div className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="py-14 text-center font-bold">Nothing outstanding</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  {cols.map(([k, l]) => (
                    <th key={k}>{l}</th>
                  ))}
                  <th>Total</th>
                  <th title="Payments received but not applied to an invoice yet">On account</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const oa = onAccount.get(`${r.customerId}|${r.currency}`);
                  return (
                    <tr key={`${r.customerId}|${r.currency}`}>
                      <td className="font-bold">
                        <Link href={`/billing/invoices?customer=${r.customerId}`} className="hover:text-teal">
                          {r.name}
                        </Link>
                        {r.currency !== "USD" && <span className="pill pill-blue ml-2">{r.currency}</span>}
                        <div className="text-footnote text-muted">{r.invoices.length} invoice(s)</div>
                      </td>
                      {cols.map(([k]) => (
                        <td key={k} className={`mono ${r.buckets[k] ? (k === "current" ? "" : k === "1_30" ? "text-amber font-semibold" : "text-red font-semibold") : "text-faint"}`}>
                          {r.buckets[k] ? formatCents(r.buckets[k], r.currency) : "—"}
                        </td>
                      ))}
                      <td className="mono font-extrabold">{formatCents(r.total, r.currency)}</td>
                      <td className={`mono ${oa ? "text-amber font-semibold" : "text-faint"}`}>{oa ? <Link href={`/billing/payments?customer=${r.customerId}`}>{formatCents(oa, r.currency)}</Link> : "—"}</td>
                      <td className="text-right">
                        <a className="btn btn-sm" href={`/api/statement?customer=${r.customerId}`} target="_blank" rel="noreferrer">
                          Statement
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
