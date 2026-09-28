import Link from "next/link";
import { shortDate } from "@/lib/time";
import { requireCtx } from "@/lib/auth";
import { listPayments, openItems } from "@/domain/cash";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { formatCents } from "@/data/fields";
import { formatTotals, sumByCurrency } from "@/domain/fx-rules";
import { BillingNav } from "../nav";
import { ApplyPaymentButton, UseOnAccount } from "./apply";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

export default async function PaymentsPage({ searchParams }: PageProps<"/billing/payments">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const customerId = typeof sp.customer === "string" ? sp.customer : undefined;
  const [pays, customers, company] = await Promise.all([listPayments(ctx, { customerId }), list(ctx, "customer", { limit: 2000 }), import("@/domain/company").then((m) => m.getCompany(ctx))]);
  const today = (await import("@/lib/time")).zonedDate(new Date(), company.timeZone);
  const canBill = ["owner", "billing"].includes(ctx.role);
  // for money still on account: the customer's open invoices to use it on
  const withMoney = [...new Set(pays.filter((p) => p.unappliedCents > 0).map((p) => p.customerId))];
  const open = new Map(await Promise.all(withMoney.map(async (c) => [c, (await openItems(ctx, c)).invoices] as const)));
  const onAccount = sumByCurrency(pays, (p) => p.currency, (p) => p.unappliedCents);
  const anyOnAccount = Object.values(onAccount).some((v) => v);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Payments" actions={canBill ? <ApplyPaymentButton customers={customers.map((c) => ({ id: c.id, name: String(c.name) }))} customerId={customerId} role={ctx.role} today={today} /> : undefined}>
        Each check or ACH as it came in, the invoices it paid, and what&rsquo;s left on account. {anyOnAccount ? <b>{formatTotals(onAccount)} on account.</b> : null} A payment is in one currency and only pays invoices in that currency.
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        {pays.length === 0 ? (
          <div className="card py-14 text-center">
            <div className="font-bold">No payments recorded</div>
            <div className="text-muted text-callout mt-1">Record a check or ACH once and split it over the invoices it pays.</div>
          </div>
        ) : (
          <div className="card overflow-auto">
            <table className="table" data-testid="payments-table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>From</th>
                  <th>Method</th>
                  <th>Amount</th>
                  <th>Paid</th>
                  <th>On account</th>
                </tr>
              </thead>
              <tbody>
                {pays.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap">{shortDate(p.receivedAt)}</td>
                    <td>
                      <Link href={`/billing/payments?customer=${p.customerId}`} className="font-semibold hover:text-teal">
                        {p.customer}
                      </Link>
                    </td>
                    <td>
                      {({ ach: "ACH", check: "Check", wire: "Wire", card: "Card", factoring: "Factoring", other: "Other" } as Record<string, string>)[p.method] ?? p.method}
                      {p.currency !== "USD" && p.exchangeRate ? <span className="text-muted text-footnote"> · at {(p.exchangeRate / 10000).toFixed(4)}</span> : null}
                      {p.reference ? <span className="mono text-muted"> · {p.reference}</span> : null}
                    </td>
                    <td className="mono font-semibold">{formatCents(p.amountCents, p.currency)}</td>
                    <td className="text-callout">
                      {p.applications.map((a) => (
                        <div key={a.invoiceId}>
                          <Link href={`/billing/invoices/${a.invoiceId}`} className="mono text-teal">
                            {a.number}
                          </Link>{" "}
                          {formatCents(a.amountCents, p.currency)}
                        </div>
                      ))}
                    </td>
                    <td>
                      {p.unappliedCents > 0 ? (
                        <div className="space-y-1">
                          <div className="mono font-bold text-amber">{formatCents(p.unappliedCents, p.currency)}</div>
                          {canBill && <UseOnAccount paymentId={p.id} unappliedCents={p.unappliedCents} currency={p.currency} invoices={(open.get(p.customerId) ?? []).filter((i) => i.currency === p.currency).map((i) => ({ id: i.id, number: i.number, openCents: i.openCents }))} />}
                        </div>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
