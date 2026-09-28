import { requireCtx } from "@/lib/auth";
import { iftaReport, iftaDetail, quarterOf, previousQuarter } from "@/domain/ifta";
import { IFTA_MEMBERS } from "@/domain/ifta-geo";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { BillingNav } from "../nav";
import { IftaScreen } from "./ifta";
import { zonedDate } from "@/lib/time";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "IFTA" };
export const dynamic = "force-dynamic";

export default async function IftaPage({ searchParams }: PageProps<"/billing/ifta">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const [tenant] = await db.select({ zone: tenants.timeZone }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1);
  const current = quarterOf(zonedDate(new Date(), tenant?.zone ?? "America/Detroit"));
  const quarters = [current];
  for (let i = 0; i < 7; i++) quarters.push(previousQuarter(quarters[quarters.length - 1]));
  const q = typeof sp.q === "string" && /^\d{4}Q[1-4]$/.test(sp.q) ? sp.q : current;
  const [report, detail, trucks] = await Promise.all([iftaReport(ctx, q), iftaDetail(ctx, q), list(ctx, "truck", { limit: 1000 })]);
  const units = new Map(trucks.map((t) => [String(t.id), String(t.unitNumber)]));
  return (
    <div>
      <PageHeader eyebrow="Accounting" title="IFTA">
        The quarterly fuel-tax return: miles by state and province from GPS (ELD or the driver app) or, where a load has none, its route between the stops; fuel from purchases you enter or import from the fuel card. Tax rates come from the IFTA rate matrix each quarter.
      </PageHeader>
      <BillingNav />
      <div className="px-gutter pb-10">
        <IftaScreen
          quarter={q}
          quarters={quarters}
          report={JSON.parse(JSON.stringify(report))}
          fuel={detail.fuel.map((f) => ({ id: f.id, date: f.purchasedAt.toISOString().slice(0, 10), unit: f.truckId ? units.get(f.truckId) ?? "?" : "—", jurisdiction: f.jurisdiction, gallons: f.gallonsMilli / 1000, fuelType: f.fuelType, amountCents: f.amountCents, currency: f.currency, vendor: f.vendor, city: f.city, receipt: f.receiptNumber, source: f.source }))}
          trips={detail.trips.map((t) => ({ id: t.id, date: t.date, unit: units.get(t.truckId) ?? "?", jurisdiction: t.jurisdiction, miles: t.milesTenths / 10, note: t.note }))}
          rates={Object.fromEntries(detail.rates.map((r) => [r.jurisdiction, { rate: String(r.rateE4 / 10000), surcharge: r.surchargeE4 != null ? String(r.surchargeE4 / 10000) : "" }]))}
          members={[...IFTA_MEMBERS].sort()}
          trucks={trucks.map((t) => ({ id: String(t.id), unit: String(t.unitNumber) }))}
          canEdit={["owner", "billing"].includes(ctx.role)}
        />
      </div>
    </div>
  );
}
