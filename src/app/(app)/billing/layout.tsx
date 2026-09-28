import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { NoAccess } from "@/components/no-access";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", dispatcher: "Dispatcher", billing: "Billing", compliance: "Safety & compliance", mx_office: "Mexico office" };

/** Every billing screen needs billing.view; a safety or Mexico-office login gets a plain "not your role" card, never a 500. */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  if (!can(ctx, "billing.view")) return <NoAccess area="Billing" role={ROLE_LABEL[ctx.role] ?? ctx.role} />;
  return <>{children}</>;
}
