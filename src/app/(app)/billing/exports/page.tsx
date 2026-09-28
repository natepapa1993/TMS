import { requireCtx } from "@/lib/auth";
import { listExports } from "@/domain/accounting";
import { getCompany } from "@/domain/company";
import { zonedDate } from "@/lib/time";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { Exports } from "./board";
import Link from "next/link";

export const metadata = { title: "QuickBooks export" };
export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  const ctx = await requireCtx();
  const [runs, company] = await Promise.all([listExports(ctx), getCompany(ctx)]);
  const today = zonedDate(new Date(), company.timeZone);
  const first = `${today.slice(0, 7)}-01`;
  return (
    <div>
      <PageHeader eyebrow="Billing" title="QuickBooks export">
        The ledger lives here; QuickBooks gets files. IIF for QuickBooks Desktop (File → Utilities → Import → IIF), CSV lists for QuickBooks Online. Account names are under{" "}
        <Link href="/settings/company" className="text-teal font-semibold">
          Settings → Company
        </Link>
        ; customer and vendor names on each record.
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        <Exports runs={JSON.parse(JSON.stringify(runs))} defaults={{ from: first, to: today }} role={ctx.role} timeZone={company.timeZone} />
      </div>
    </div>
  );
}
