import { requireCtx } from "@/lib/auth";
import { dashboard, breakdown, defaultPeriod, weekPeriod, type Breakdown, type Period } from "@/domain/reports";
import { getCompany } from "@/domain/company";
import { list } from "@/data/records";
import { zonedDate } from "@/lib/time";
import { PageHeader } from "@/components/page-header";
import { ReportsView } from "./view";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const currentTime = async () => new Date();

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const company = await getCompany(ctx);
  const now = await currentTime();
  const tz = company.timeZone;
  const preset = typeof sp.range === "string" ? sp.range : "mtd";
  const today = zonedDate(now, tz);
  let period: Period;
  if (preset === "week") period = weekPeriod(now, tz);
  else if (preset === "last_month") {
    const [y, m] = today.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(y, m - 1, 0));
    period = { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  } else if (preset === "custom" && typeof sp.from === "string" && typeof sp.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) && /^\d{4}-\d{2}-\d{2}$/.test(sp.to)) period = { from: sp.from, to: sp.to };
  else period = defaultPeriod(now, tz);
  const entityId = typeof sp.entity === "string" && sp.entity ? sp.entity : null;
  const by = (typeof sp.by === "string" ? sp.by : "truck") as Breakdown;
  const [dash, rows, entities] = await Promise.all([dashboard(ctx, period, entityId), breakdown(ctx, ["truck", "customer", "lane", "carrier", "driver", "week"].includes(by) ? by : "truck", period, entityId), list(ctx, "billingEntity", { limit: 50 })]);
  return (
    <div>
      <PageHeader eyebrow="Owner" title="Reports">
        The six numbers, from the same loads, charges, bills and pay the operation runs on. Delivered orders by delivered date, in {tz.replace("_", " ")}.
      </PageHeader>
      <div className="px-gutter pb-10">
        <ReportsView dash={JSON.parse(JSON.stringify(dash))} rows={JSON.parse(JSON.stringify(rows))} by={by} preset={preset} period={period} entityId={entityId} entities={entities.map((e) => ({ id: e.id, name: String(e.legalName) }))} />
      </div>
    </div>
  );
}
