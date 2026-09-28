import { resolveToken } from "@/lib/tokens";
import { carrierDriverView } from "@/domain/carrier-portal";
import { tenantZone } from "@/domain/company";
import { ZoneProvider } from "@/components/zone";
import { CarrierDriverApp } from "./app";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your load" };

/** A partner carrier's driver on one of our legs: the load, one button per step, GPS while open. */
export default async function CarrierDriverPage({ params }: PageProps<"/g/[token]">) {
  const { token } = await params;
  const t = await resolveToken(token, "carrier_driver");
  if (!t)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
        <p className="text-muted mt-1">Ask your dispatcher for a new one. / Pide a tu despachador un enlace nuevo.</p>
      </div>
    );
  const [view, zone] = await Promise.all([carrierDriverView(t.ctx.tenantId, t.subjectId), tenantZone(t.ctx.tenantId)]);
  return (
    <ZoneProvider value={zone}>
      <CarrierDriverApp token={token} data={JSON.parse(JSON.stringify(view))} />
    </ZoneProvider>
  );
}
