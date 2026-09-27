import { requireCtx } from "@/lib/auth";
import { carrierBillsList, threeWay, carrier1099 } from "@/domain/billing";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { CarrierBills } from "./board";

export const metadata = { title: "Carrier bills" };
export const dynamic = "force-dynamic";

export default async function CarrierBillsPage() {
  const ctx = await requireCtx();
  const rows = await carrierBillsList(ctx);
  const checks = await Promise.all(rows.map((r) => threeWay(ctx, r.bill.id)));
  const y = await carrier1099(ctx, new Date().getUTCFullYear());
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Carrier bills">
        Every completed carrier leg expects a bill at the accepted tender rate. Three-way check before approval: tender = invoice, POD on file.
      </PageHeader>
      <BillingNav />
      <div className="px-7 pb-10">
        <CarrierBills rows={JSON.parse(JSON.stringify(rows.map((r, i) => ({ ...r, check: checks[i] }))))} role={ctx.role} totals1099={JSON.parse(JSON.stringify(y))} />
      </div>
    </div>
  );
}
