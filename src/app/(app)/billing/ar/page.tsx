import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { aging } from "@/domain/billing";
import { PageHeader } from "@/components/page-header";
import { formatCents } from "@/data/fields";
import { BillingNav } from "../nav";

export const metadata = { title: "Receivables" };
export const dynamic = "force-dynamic";

export default async function ArPage() {
  const ctx = await requireCtx();
  const { rows, totals } = await aging(ctx);
  const cols = [["current", "Current"], ["1_30", "1–30"], ["31_60", "31–60"], ["61_90", "61–90"], ["90_plus", "90+"]] as const;
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Receivables">
        Open invoices by customer and age. Reminders go out at +3, +10 and +20 days past due unless a customer opts out.
      </PageHeader>
      <BillingNav />
      <div className="px-7 pb-10">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
          {[["Total open", totals.total, ""], ...cols.map(([k, l]) => [l, totals[k], k === "current" ? "" : k === "1_30" ? "text-amber" : "text-red"])].map(([l, v, cls]) => (
            <div key={String(l)} className="card p-4">
              <div className="eyebrow">{l}</div>
              <div className={`text-[22px] font-extrabold mono ${v ? cls : "text-faint"}`}>{formatCents(Number(v))}</div>
            </div>
          ))}
        </div>
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.customerId}>
                    <td className="font-bold">
                      <Link href={`/billing/invoices?customer=${r.customerId}`} className="hover:text-teal">
                        {r.name}
                      </Link>
                      <div className="text-[12px] text-muted">{r.invoices.length} invoice(s)</div>
                    </td>
                    {cols.map(([k]) => (
                      <td key={k} className={`mono ${r.buckets[k] ? (k === "current" ? "" : k === "1_30" ? "text-amber font-semibold" : "text-red font-semibold") : "text-faint"}`}>
                        {r.buckets[k] ? formatCents(r.buckets[k]) : "—"}
                      </td>
                    ))}
                    <td className="mono font-extrabold">{formatCents(r.total)}</td>
                    <td className="text-right">
                      <a className="btn btn-sm" href={`/api/statement?customer=${r.customerId}`} target="_blank" rel="noreferrer">
                        Statement
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
