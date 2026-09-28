import { redirect } from "next/navigation";
import { currentCtx } from "@/lib/auth";
import { Shell } from "@/components/shell";
import { ZoneProvider } from "@/components/zone";
import { tenantZone } from "@/domain/company";
import { MoneyProvider } from "@/components/money";
import { canSeeMoney } from "@/domain/money-visibility";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await currentCtx();
  if (!ctx) redirect("/login");
  const [zone, showMoney] = await Promise.all([tenantZone(ctx.tenantId), canSeeMoney(ctx)]);
  return (
    <ZoneProvider value={zone}>
      <MoneyProvider value={showMoney}>
        <Shell user={{ name: ctx.name, role: ctx.role, tenantName: ctx.tenantName }}>{children}</Shell>
      </MoneyProvider>
    </ZoneProvider>
  );
}
