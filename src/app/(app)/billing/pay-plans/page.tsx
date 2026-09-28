import { requireCtx } from "@/lib/auth";
import { listPlans } from "@/domain/pay-plans";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { PayPlans } from "./plans";
import { db } from "@/db/client";
import { payItems } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const metadata = { title: "Pay plans" };
export const dynamic = "force-dynamic";

export default async function PayPlansPage() {
  const ctx = await requireCtx();
  const [{ plans, drivers }, customers, escrows] = await Promise.all([listPlans(ctx), list(ctx, "customer", { limit: 2000 }), db.select().from(payItems).where(and(eq(payItems.tenantId, ctx.tenantId), eq(payItems.kind, "escrow")))]);
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Pay plans">
        How drivers are paid: rules per mile, percent, stop, hour or crossing — each limited to some legs, customers or equipment if you like — plus per diem, a minimum per statement and how teams split a leg. A driver on no plan is paid by the pay type on their record.
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        <PayPlans plans={JSON.parse(JSON.stringify(plans))} drivers={JSON.parse(JSON.stringify(drivers))} customers={customers.map((c) => ({ id: c.id, name: String(c.name) }))} canEdit={["owner", "billing"].includes(ctx.role)} escrows={escrows.map((e) => ({ id: e.id, driver: drivers.find((d) => d.id === e.driverId)?.name ?? "?", description: e.description, amountCents: e.amountCents, targetCents: e.targetCents, balanceCents: e.balanceCents ?? 0 }))} />
      </div>
    </div>
  );
}
