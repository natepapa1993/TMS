import { requireCtx } from "@/lib/auth";
import { listSettlements } from "@/domain/billing";
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
  const [rows, drivers, company] = await Promise.all([listSettlements(ctx), list(ctx, "driver", { limit: 2000 }), getCompany(ctx)]);
  const { startDate } = weekOfZoned(new Date(), company.timeZone);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Driver settlements">
        Weekly statements from completed legs at each driver&apos;s pay rule, plus deductions and reimbursements. open → reviewed → approved → paid; drivers see approved and paid in their app.
      </PageHeader>
      <BillingNav />
      <div className="px-7 pb-10">
        <Settlements rows={JSON.parse(JSON.stringify(rows))} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name), payType: String(d.payType), payRateCents: (d.payRateCents as number | null) ?? null }))} defaultWeek={startDate} role={ctx.role} />
      </div>
    </div>
  );
}
