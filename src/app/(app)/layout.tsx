import { redirect } from "next/navigation";
import { currentCtx } from "@/lib/auth";
import { Shell } from "@/components/shell";
import { ZoneProvider } from "@/components/zone";
import { tenantZone } from "@/domain/company";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await currentCtx();
  if (!ctx) redirect("/login");
  const zone = await tenantZone(ctx.tenantId);
  return (
    <ZoneProvider value={zone}>
      <Shell user={{ name: ctx.name, role: ctx.role, tenantName: ctx.tenantName }}>{children}</Shell>
    </ZoneProvider>
  );
}
