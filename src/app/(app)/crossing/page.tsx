import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { crossingBoard, bucketOf, BUCKET_LABEL, crossingStateLabel, type Bucket } from "@/domain/crossing";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { redirect } from "next/navigation";
import { ensureCrossing, backfillCrossings } from "@/domain/crossing";
import { Pill } from "@/components/ui";

export const metadata = { title: "Crossing" };
export const dynamic = "force-dynamic";
// server component: reading the clock is a data fetch, not render logic
const currentTime = async () => Date.now();

const BUCKETS: Bucket[] = ["waiting", "verify", "ready", "crossing", "held", "cleared"];
const tone: Record<Bucket, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { waiting: "slate", verify: "blue", ready: "teal", crossing: "amber", held: "red", cleared: "green" };

export default async function CrossingBoardPage({ searchParams }: PageProps<"/crossing">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (typeof sp.leg === "string") {
    const c = await ensureCrossing(ctx, sp.leg).catch(() => null);
    if (c) redirect(`/crossing/${c.id}`);
  }
  await backfillCrossings(ctx);
  const [rows, customers, trucks, drivers, ports] = await Promise.all([crossingBoard(ctx), list(ctx, "customer", { limit: 2000 }), list(ctx, "truck", { limit: 2000 }), list(ctx, "driver", { limit: 2000 }), list(ctx, "port", { limit: 100 })]);
  const name = (rs: { id: string; [k: string]: unknown }[], k: string) => new Map(rs.map((r) => [r.id, String(r[k])]));
  const cn = name(customers, "name");
  const tn = name(trucks, "unitNumber");
  const dn = name(drivers, "name");
  const pn = name(ports, "name");
  const bucket = (BUCKETS as string[]).includes(String(sp.b)) ? (sp.b as Bucket) : "waiting";
  const now = await currentTime();
  const recent = now - 48 * 3600_000;
  const inBucket = (r: (typeof rows)[number], b: Bucket) => bucketOf(r.c.state) === b && (b !== "cleared" || (r.c.clearedAt && r.c.clearedAt.getTime() > recent));
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((r) => inBucket(r, b)).length]));
  const shown = rows.filter((r) => inBucket(r, bucket)).sort((p, q) => (q.c.arrivedYardAt?.getTime() ?? 0) - (p.c.arrivedYardAt?.getTime() ?? 0) || (p.c.arrivedYardAt ? -1 : 1));
  const hours = (d: Date | null) => (d ? Math.round((now - d.getTime()) / 3600_000) : null);
  return (
    <div>
      <PageHeader eyebrow="Border" title="Crossings">
        One row per crossing leg. Waiting-on tells you the single next thing and who owes it.
      </PageHeader>
      <div className="px-gutter pb-3 flex items-center gap-1.5 flex-wrap">
        {BUCKETS.map((b) => (
          <Link key={b} href={`/crossing?b=${b}`} className="stage-tab" data-active={bucket === b}>
            {BUCKET_LABEL[b]} <span className="count">{counts[b]}</span>
          </Link>
        ))}
      </div>
      <div className="px-gutter pb-10">
        <div className="card overflow-hidden">
          <div className="row text-caption font-bold text-faint border-t-0 cursor-default hover:bg-transparent" style={{ gridTemplateColumns: "150px 110px 1.2fr 1fr 110px 150px" }}>
            <div>Order</div>
            <div>Caja</div>
            <div>Unit · driver</div>
            <div>Waiting on</div>
            <div>At yard</div>
            <div>State</div>
          </div>
          {shown.length === 0 ? (
            <div className="py-16 text-center border-t border-line">
              <div className="font-bold">Nothing here</div>
              <div className="text-muted text-callout mt-1">{bucket === "waiting" ? "Crossings appear as soon as an order with a crossing leg is booked." : ""}</div>
            </div>
          ) : (
            shown.map((r) => {
              const waiting = r.c.requirements.find((x) => x.status === "missing");
              const h = hours(r.c.departedYardAt ? null : r.c.arrivedYardAt);
              return (
                <Link key={r.c.id} href={`/crossing/${r.c.id}`} className="row" style={{ gridTemplateColumns: "150px 110px 1.2fr 1fr 110px 150px" }}>
                  <div>
                    <div className="font-extrabold mono">{r.orderNumber}</div>
                    <div className="text-muted text-callout truncate">{cn.get(r.customerId ?? "") ?? cn.get(r.brokerId ?? "") ?? "—"}</div>
                  </div>
                  <div className="font-semibold mono">{r.c.trailerNumber ?? <span className="text-faint">—</span>}</div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{r.truckId ? `Unit ${tn.get(r.truckId)}` : <span className="text-faint">no truck</span>}</div>
                    <div className="text-muted text-callout truncate">{r.driverId ? dn.get(r.driverId) : r.c.portId ? pn.get(r.c.portId) : ""}</div>
                  </div>
                  <div className="min-w-0 text-callout">
                    {r.c.state === "held" ? (
                      <span className="text-red font-semibold">{r.c.heldReason}</span>
                    ) : waiting ? (
                      <>
                        <span className="font-semibold">{waiting.label}</span>
                        <div className="text-muted text-footnote">from {waiting.providedBy.replace("_", " ")}</div>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div>{h == null ? <span className="text-faint">—</span> : <span className={`font-bold ${h >= 48 ? "text-red" : h >= 24 ? "text-amber" : ""}`}>{h} h</span>}</div>
                  <div>
                    <Pill tone={tone[bucketOf(r.c.state)]}>{crossingStateLabel(r.c.state, r.c)}</Pill>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
