import { zonedDate } from "@/lib/time";
import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { getCompany } from "@/domain/company";
import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "./form";
import { HideMoneyToggle } from "./money-toggle";
import { hideMoneyFromDispatch } from "@/domain/money-visibility";
import { OverrideApprovalSetting } from "./override-approval";
import { overridesNeedOwner } from "@/domain/approvals";

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
      <div className="px-gutter pb-10 max-w-2xl space-y-4">
        <CompanyForm initial={{ name: c.name, timeZone: c.timeZone, fuelCostPerMile: (c.settings.fuelCostCentsPerMile / 100).toFixed(2), closedThrough: c.settings.closedThrough ? zonedDate(new Date(c.settings.closedThrough), c.timeZone) : null, qb: c.settings.qb, dispatchPhone: c.settings.dispatchPhone ?? "", fx: Object.fromEntries(["MXN", "CAD"].map((k) => [k, c.settings.fx[k] ? (c.settings.fx[k]!.rateE4 / 10000).toFixed(4) : ""])), fxAt: Object.fromEntries(["MXN", "CAD"].map((k) => [k, c.settings.fx[k]?.at?.slice(0, 10) ?? ""])) }} canEdit={ctx.role === "owner"} />
        <HideMoneyToggle initial={await hideMoneyFromDispatch(ctx)} canEdit={ctx.role === "owner"} />
        <OverrideApprovalSetting on={await overridesNeedOwner(ctx.tenantId)} canEdit={ctx.role === "owner"} />
      </div>
    </div>
  );
}
