import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { loadGrid, listViews } from "@/domain/load-grid";
import { LoadBoard } from "./load-board";

export const metadata = { title: "Loads" };
export const dynamic = "force-dynamic";

const RANGES: [number, string][] = [
  [30, "30 days"],
  [60, "60 days"],
  [90, "90 days"],
  [365, "12 months"],
  [0, "All time"],
];

export default async function OrdersPage({ searchParams }: PageProps<"/orders">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const days = RANGES.some(([d]) => String(d) === sp.days) ? Number(sp.days) : 60;
  const [rows, views] = await Promise.all([loadGrid(ctx, { days }), listViews(ctx, "loads")]);
  return (
    <div className="px-5 md:px-8 pt-6 pb-10">
      <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="eyebrow mb-1">Orders</div>
          <h1 className="text-[24px] font-extrabold tracking-tight">Loads</h1>
          <div className="text-muted text-[13px] mt-0.5">
            Every open load, plus everything created in the last{" "}
            <span className="inline-flex gap-1 align-middle">
              {RANGES.map(([d, l]) => (
                <Link key={d} href={`/orders?days=${d}`} className={`px-1.5 rounded ${d === days ? "bg-white border border-line text-ink font-semibold" : "hover:text-ink"}`}>
                  {l}
                </Link>
              ))}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/orders/import" className="btn">
            Import
          </Link>
          <Link href="/orders/templates" className="btn">
            Templates
          </Link>
          <Link href="/trips" className="btn">
            Tailgate trips
          </Link>
          <Link href="/orders/new" className="btn btn-primary">
            + New load
          </Link>
        </div>
      </div>
      <LoadBoard rows={rows} views={views} role={ctx.role} />
    </div>
  );
}
