import { requireCtx } from "@/lib/auth";
import { listSettlements, payItemLedger } from "@/domain/billing";
import { getCompany } from "@/domain/company";
import { weekOfZoned } from "@/lib/time";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { Settlements } from "./board";

export const metadata = { title: "Driver pay" };
export const dynamic = "force-dynamic";

export default async function SettlementsPage() {
  const ctx = await requireCtx();
  const [rows, drivers, company, ledger] = await Promise.all([listSettlements(ctx), list(ctx, "driver", { limit: 2000 }), getCompany(ctx), payItemLedger(ctx)]);
  const { startDate } = weekOfZoned(new Date(), company.timeZone);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Driver settlements">
        Weekly statements from completed legs at each driver&apos;s pay rule, plus deductions and reimbursements. open → reviewed → approved → paid; drivers see approved and paid in their app. Net pay never goes below $0: deductions come off in order (carried-over amounts, one-off deductions, recurring deductions, advances, escrow last) and what doesn&apos;t fit carries to next week. A week is approved once it has ended.
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        <Settlements rows={JSON.parse(JSON.stringify(rows))} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name), payType: String(d.payType), payRateCents: (d.payRateCents as number | null) ?? null }))} defaultWeek={startDate} role={ctx.role} ledger={JSON.parse(JSON.stringify(ledger))} now={new Date().toISOString()} />
      </div>
    </div>
  );
}
