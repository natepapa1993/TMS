import { requireCtx } from "@/lib/auth";
import { factorLedger } from "@/domain/factoring";
import { PageHeader } from "@/components/page-header";
import { formatCents } from "@/data/fields";
import { BillingNav } from "../nav";
import { FactorLedger } from "./ledger";

export const metadata = { title: "Factoring" };
export const dynamic = "force-dynamic";

export default async function FactoringPage() {
  const ctx = await requireCtx();
  const l = await factorLedger(ctx);
  const tile = (label: string, v: number, tone = "", sub?: string, cur = "USD") => (
    <div className="card p-4 flex-1 min-w-[160px]">
      <div className="eyebrow">{label}</div>
      <div className={`text-title2 font-extrabold mono ${v ? tone : "text-faint"}`}>{formatCents(v, cur)}</div>
      {sub && <div className="text-footnote text-muted">{sub}</div>}
    </div>
  );
  const currencies = Object.keys(l.byCurrency).filter((c) => c === "USD" || l.rows.some((r) => r.currency === c));
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Factoring">
        Invoices sold to your factor: what&rsquo;s waiting for funding, what was advanced, the fee, the reserve the factor holds, and what could come back as a chargeback. {l.entities.map((e) => `${e.name}: ${e.advanceBp / 100}% advance, ${e.feeBp / 100}% fee, ${e.recourseDays ? `${e.recourseDays}-day recourse` : "non-recourse"}`).join(" · ")}
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        {currencies.map((cur) => {
          const x = l.byCurrency[cur];
          return (
            <div key={cur} className="mb-4">
              {currencies.length > 1 && <div className="eyebrow mb-1">{cur}</div>}
              <div className="flex gap-3 flex-wrap" data-testid={cur === "USD" ? "factor-tiles" : `factor-tiles-${cur}`}>
                {tile("Waiting for funding", x.toFund, "text-amber", undefined, cur)}
                {tile("Reserve held", x.reserveHeld, "", x.reserveBackToAr ? `${formatCents(x.reserveBackToAr, cur)} more went back to Receivables on chargebacks` : "the factor pays it when the customer pays", cur)}
                {tile("Recourse exposure", x.exposure, x.atRisk ? "text-red" : "", x.atRisk ? `${x.atRisk} near the recourse limit` : "advances on invoices not yet collected", cur)}
                {tile("Fees this year", x.feesYtd, "", undefined, cur)}
              </div>
            </div>
          );
        })}
        <FactorLedger rows={JSON.parse(JSON.stringify(l.rows))} canEdit={["owner", "billing"].includes(ctx.role)} terms={l.entities[0] ? { advanceBp: l.entities[0].advanceBp, feeBp: l.entities[0].feeBp } : null} />
      </div>
    </div>
  );
}
