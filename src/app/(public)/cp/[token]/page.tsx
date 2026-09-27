import { resolveToken } from "@/lib/tokens";
import { customerPortalView } from "@/domain/customer-portal";
import { CustomerPortal } from "./portal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer portal" };

export default async function CustomerPortalPage({ params }: PageProps<"/cp/[token]">) {
  const { token } = await params;
  const t = await resolveToken(token, "customer_portal");
  const view = t ? await customerPortalView(t.ctx.tenantId, t.subjectId).catch(() => null) : null;
  if (!view)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
        <p className="text-muted mt-1">Ask your contact at the carrier for a new one.</p>
      </div>
    );
  return <CustomerPortal token={token} data={JSON.parse(JSON.stringify(view))} />;
}
