import { redirect } from "next/navigation";
import { currentCtx } from "@/lib/auth";
import { Shell } from "@/components/shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await currentCtx();
  if (!ctx) redirect("/login");
  return (
    <Shell user={{ name: ctx.name, role: ctx.role, tenantName: ctx.tenantName }}>
      {children}
    </Shell>
  );
}
