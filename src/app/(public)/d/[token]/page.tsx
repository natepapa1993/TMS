import { resolveToken } from "@/lib/tokens";
import { driverToday } from "@/domain/tracking";
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
  const today = await driverToday(t.ctx.tenantId, t.subjectId);
  return <DriverApp token={token} data={JSON.parse(JSON.stringify({ driver: today.driver, current: today.current, items: today.items }))} />;
}
