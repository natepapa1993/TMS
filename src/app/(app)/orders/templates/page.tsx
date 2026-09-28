import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listTemplates } from "@/domain/load-templates";
import { Templates } from "./templates";

export const metadata = { title: "Load templates" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const ctx = await requireCtx();
  const rows = await listTemplates(ctx);
  return (
    <div className="px-5 md:px-8 pt-6 pb-10">
      <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="eyebrow mb-1">
            <Link href="/orders" className="hover:text-teal">
              Loads
            </Link>{" "}
            / Templates
          </div>
          <h1 className="text-title2 font-extrabold tracking-tight">Load templates</h1>
          <div className="text-muted text-callout mt-0.5">Lanes you run again and again. Build one load from the builder, or many at once for a run of dates.</div>
        </div>
        <Link href="/orders/new" className="btn btn-primary">
          + New load
        </Link>
      </div>
      <Templates rows={JSON.parse(JSON.stringify(rows.map((t) => ({ id: t.id, name: t.name, customer: t.customer, stops: t.data.stops.map((x) => ({ type: x.type, name: x.name, city: x.city ?? null, state: x.state ?? null, country: x.country, dayOffset: x.dayOffset, from: x.from })), rateCents: t.data.rateCents, currency: t.data.currency, equipment: t.data.equipment, timesUsed: t.timesUsed, lastUsedAt: t.lastUsedAt })))) } />
    </div>
  );
}
