import { requireCtx } from "@/lib/auth";
import { listFuel, fscValue, mondayOf } from "@/domain/rates";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { FuelScreen } from "./fuel";
import { zonedDate } from "@/lib/time";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Fuel surcharge" };
export const dynamic = "force-dynamic";

export default async function FuelPage() {
  const ctx = await requireCtx();
  const [{ tables, prices }, [tenant]] = await Promise.all([listFuel(ctx), db.select({ zone: tenants.timeZone }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1)]);
  const today = zonedDate(new Date(), tenant?.zone ?? "America/Detroit");
  const current = prices.find((p) => p.weekOf <= mondayOf(today)) ?? null;
  const def = tables.find((t) => t.isDefault) ?? null;
  const now = def && current ? fscValue(def.bands, current.priceCents) : null;
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Fuel surcharge">
        Fuel surcharge tables (the diesel price bands a customer&apos;s surcharge moves with) and the weekly diesel price. A customer lane rate set to &quot;fuel table&quot; takes its surcharge from the default table at the week&apos;s price when the load is built.
      </PageHeader>
      <BillingNav />
      <div className="px-7 pb-10">
        <FuelScreen
          tables={tables.map((t) => ({ id: t.id, name: t.name, method: t.method, bands: t.bands, isDefault: t.isDefault }))}
          prices={prices.map((p) => ({ weekOf: p.weekOf, priceCents: p.priceCents, source: p.source }))}
          today={today}
          thisWeek={mondayOf(today)}
          current={current ? { weekOf: current.weekOf, priceCents: current.priceCents } : null}
          now={def && now != null ? { table: def.name, method: def.method, value: now } : null}
          canEdit={["owner", "billing"].includes(ctx.role)}
        />
      </div>
    </div>
  );
}
