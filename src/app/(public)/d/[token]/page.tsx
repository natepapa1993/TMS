import { resolveToken } from "@/lib/tokens";
import { driverToday, driverThread } from "@/domain/tracking";
import { driverOwnItems } from "@/domain/compliance";
import { driverSettlements } from "@/domain/billing";
import { tenantContact, tenantZone } from "@/domain/company";
import { ZoneProvider } from "@/components/zone";
import { DriverApp } from "./app";

export const dynamic = "force-dynamic";
export const metadata = { title: "Driver" };

export default async function DriverPage({ params }: PageProps<"/d/[token]">) {
  const { token } = await params;
  const t = await resolveToken(token, "driver_app");
  if (!t)
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
        <p className="text-muted mt-1">Ask dispatch to send you a new one. / Pide a despacho un enlace nuevo.</p>
      </div>
    );
  const [today, own, pay, thread, company, zone] = await Promise.all([driverToday(t.ctx.tenantId, t.subjectId), driverOwnItems(t.ctx.tenantId, t.subjectId), driverSettlements(t.ctx.tenantId, t.subjectId), driverThread(t.ctx.tenantId, t.subjectId), tenantContact(t.ctx.tenantId), tenantZone(t.ctx.tenantId)]);
  return (
    <ZoneProvider value={zone}>
      <DriverApp token={token} data={JSON.parse(JSON.stringify({ driver: today.driver, current: today.current, items: today.items, own, pay, thread, company }))} />
    </ZoneProvider>
  );
}
