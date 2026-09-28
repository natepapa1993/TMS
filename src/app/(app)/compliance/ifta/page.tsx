import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { iftaReport, iftaDetail, quarterOf, previousQuarter } from "@/domain/ifta";
import { IFTA_MEMBERS } from "@/domain/ifta-geo";
import { tenantZone } from "@/domain/company";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { NoAccess } from "@/components/no-access";
import { SafetyNav } from "../nav";
import { IftaScreen } from "../../billing/ifta/ifta";
import { zonedDate } from "@/lib/time";

export const metadata = { title: "IFTA" };
export const dynamic = "force-dynamic";

/** The IFTA return from the Safety side (safety #23): the same screen billing has, without the rest of Billing. */
export default async function SafetyIftaPage({ searchParams }: PageProps<"/compliance/ifta">) {
  const ctx = await requireCtx();
  if (!can(ctx, "ifta.view")) return <NoAccess area="IFTA" role={ctx.role} />;
  const sp = await searchParams;
  const current = quarterOf(zonedDate(new Date(), await tenantZone(ctx.tenantId)));
  const quarters = [current];
  for (let i = 0; i < 7; i++) quarters.push(previousQuarter(quarters[quarters.length - 1]));
  const q = typeof sp.q === "string" && /^\d{4}Q[1-4]$/.test(sp.q) ? sp.q : current;
  const [report, detail, trucks] = await Promise.all([iftaReport(ctx, q), iftaDetail(ctx, q), list(ctx, "truck", { limit: 1000 })]);
  const units = new Map(trucks.map((t) => [String(t.id), String(t.unitNumber)]));
  return (
    <div>
      <PageHeader eyebrow="Safety & compliance" title="IFTA">
        The quarterly fuel-tax return: miles by state and province from GPS or each load&rsquo;s route, fuel from purchases you enter or import from the fuel card, and the quarter&rsquo;s tax rates.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10">
        <IftaScreen
          quarter={q}
          quarters={quarters}
          report={JSON.parse(JSON.stringify(report))}
          fuel={detail.fuel.map((f) => ({ id: f.id, date: f.purchasedAt.toISOString().slice(0, 10), unit: f.truckId ? (units.get(f.truckId) ?? "?") : "—", jurisdiction: f.jurisdiction, gallons: f.gallonsMilli / 1000, fuelType: f.fuelType, amountCents: f.amountCents, currency: f.currency, vendor: f.vendor, city: f.city, receipt: f.receiptNumber, source: f.source }))}
          trips={detail.trips.map((t) => ({ id: t.id, date: t.date, unit: units.get(t.truckId) ?? "?", jurisdiction: t.jurisdiction, miles: t.milesTenths / 10, note: t.note }))}
          rates={Object.fromEntries(detail.rates.map((r) => [r.jurisdiction, { rate: String(r.rateE4 / 10000), surcharge: r.surchargeE4 != null ? String(r.surchargeE4 / 10000) : "" }]))}
          members={[...IFTA_MEMBERS].sort()}
          trucks={trucks.map((t) => ({ id: String(t.id), unit: String(t.unitNumber) }))}
          canEdit={can(ctx, "ifta.edit")}
        />
      </div>
    </div>
  );
}
