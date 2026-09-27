import { requireCtx } from "@/lib/auth";
import { billingQueue } from "@/domain/billing";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "./nav";
import { Queue } from "./queue";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const ctx = await requireCtx();
  const rows = await billingQueue(ctx);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Ready to bill">
        Delivered orders. Green docs and a rate-con match = one click to an invoice. Nothing issues without the required documents.
      </PageHeader>
      <BillingNav counts={{ "/billing": rows.length }} />
      <div className="px-7 pb-10">
        <Queue rows={JSON.parse(JSON.stringify(rows))} role={ctx.role} />
      </div>
    </div>
  );
}
