import { resolveToken } from "@/lib/tokens";
import { carrierPortalView } from "@/domain/carrier-portal";
import { CarrierPortal } from "./portal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Carrier portal" };

export default async function CarrierPortalPage({ params }: PageProps<"/c/[token]">) {
  const { token } = await params;
  const t = await resolveToken(token, "carrier_portal");
  if (!t)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
        <p className="text-muted mt-1">Ask the dispatcher for a new one. / Pide a despacho un enlace nuevo.</p>
      </div>
    );
  const view = await carrierPortalView(t.ctx.tenantId, t.subjectId).catch(() => null);
  if (!view)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
      </div>
    );
  return <CarrierPortal token={token} data={JSON.parse(JSON.stringify(view))} />;
}
