import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { getCompany } from "@/domain/company";
import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "./form";

export const metadata = { title: "Company" };
export const dynamic = "force-dynamic";

export default async function CompanyPage() {
  const ctx = await requireCtx();
  const c = await getCompany(ctx);
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/settings" className="hover:text-teal">
            Settings
          </Link>
        }
        title="Company"
      >
        Name, time zone and the company-wide numbers the P&amp;L uses. Invoice prefixes and remit-to live on each billing entity.
      </PageHeader>
      <div className="px-7 pb-10 max-w-2xl">
        <CompanyForm initial={{ name: c.name, timeZone: c.timeZone, fuelCostPerMile: (c.settings.fuelCostCentsPerMile / 100).toFixed(2), closedThrough: c.settings.closedThrough, qb: c.settings.qb }} canEdit={ctx.role === "owner"} />
      </div>
    </div>
  );
}
