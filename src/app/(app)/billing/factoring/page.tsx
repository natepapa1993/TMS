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
  const tile = (label: string, v: number, tone = "", sub?: string) => (
    <div className="card p-4 flex-1 min-w-[160px]">
      <div className="eyebrow">{label}</div>
      <div className={`text-title2 font-extrabold mono ${v ? tone : "text-faint"}`}>{formatCents(v)}</div>
      {sub && <div className="text-footnote text-muted">{sub}</div>}
    </div>
  );
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Factoring">
        Invoices sold to your factor: what&rsquo;s waiting for funding, what was advanced, the fee, the reserve the factor holds, and what could come back as a chargeback. {l.entities.map((e) => `${e.name}: ${e.advanceBp / 100}% advance, ${e.feeBp / 100}% fee, ${e.recourseDays ? `${e.recourseDays}-day recourse` : "non-recourse"}`).join(" · ")}
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        <div className="flex gap-3 flex-wrap mb-4" data-testid="factor-tiles">
          {tile("Waiting for funding", l.totals.toFund, "text-amber")}
          {tile("Reserve held", l.totals.reserveHeld, "")}
          {tile("Recourse exposure", l.totals.exposure, l.totals.atRisk ? "text-red" : "", l.totals.atRisk ? `${l.totals.atRisk} near the recourse limit` : "advances on invoices not yet collected")}
          {tile("Fees this year", l.totals.feesYtd, "")}
        </div>
        <FactorLedger rows={JSON.parse(JSON.stringify(l.rows))} canEdit={["owner", "billing"].includes(ctx.role)} terms={l.entities[0] ? { advanceBp: l.entities[0].advanceBp, feeBp: l.entities[0].feeBp } : null} />
      </div>
    </div>
  );
}
