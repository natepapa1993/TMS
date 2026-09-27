import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { crossingPage, CROSSING_LABEL, CROSSING_ORDER, bucketOf, DOC_FIELDS, CHECK_LABEL, PROVIDED_BY_LABEL, crossingStateLabel, stepLabel } from "@/domain/crossing";
import type { CrossingState } from "@/db/schema";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { CrossingWorkbench } from "./workbench";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
const currentTime = async () => Date.now();

export default async function CrossingPage({ params }: PageProps<"/crossing/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const p = await crossingPage(ctx, id).catch(() => null);
  if (!p) notFound();
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId));
  const bucket = bucketOf(p.crossing.state);
  const tone = { waiting: "slate", verify: "blue", ready: "teal", crossing: "amber", held: "red", cleared: "green" } as const;
  const now = await currentTime();
  const hours = p.crossing.arrivedYardAt && !p.crossing.departedYardAt ? Math.round((now - p.crossing.arrivedYardAt.getTime()) / 3600_000) : null;
  const idx = CROSSING_ORDER.indexOf(p.crossing.state);
  return (
    <div>
      <PageHeader
        eyebrow={
          <span>
            <Link href="/crossing" className="hover:text-teal">
              Crossings
            </Link>
            {" · "}
            <Link href={`/orders/${p.order.id}`} className="hover:text-teal">
              {p.order.orderNumber}
            </Link>
          </span>
        }
        title={
          <span className="flex items-center gap-3 flex-wrap">
            <span className="mono">{p.order.orderNumber}</span>
            <Pill tone={tone[bucket]}>{crossingStateLabel(p.crossing.state, p.crossing)}</Pill>
            {hours != null && <span className={`pill ${hours >= 48 ? "pill-red" : hours >= 24 ? "pill-amber" : "pill-slate"}`}>at yard {hours} h</span>}
            {p.waitingOn && p.crossing.state !== "held" && idx < CROSSING_ORDER.indexOf("packet_sent") && (
              <span className="pill pill-amber" title="The single next missing item and who owes it">
                waiting on {p.waitingOn.label} · {PROVIDED_BY_LABEL[p.waitingOn.providedBy] ?? p.waitingOn.providedBy}
              </span>
            )}
          </span>
        }
      >
        {p.customer?.name ?? "—"}
        {p.port ? ` · ${p.port.name}` : ""}
        {p.truck ? ` · unit ${p.truck.unitNumber} (${p.truck.mxPlateClass ?? "no MX"} plates)` : " · no crossing truck yet"}
        {p.driver ? ` · ${p.driver.name}${p.coDriver ? ` / ${p.coDriver.name}` : ""}` : ""}
      </PageHeader>
      <div className="px-7 pb-10">
        <CrossingWorkbench
          data={JSON.parse(
            JSON.stringify({
              crossing: p.crossing,
              leg: p.leg,
              order: p.order,
              checks: p.checks,
              events: p.events,
              docs: p.docs,
              truck: p.truck,
              driver: p.driver,
              coDriver: p.coDriver,
              customer: p.customer,
              broker: p.broker,
              port: p.port,
              people: Object.fromEntries(people.map((x) => [x.id, x.name])),
              docFields: DOC_FIELDS,
              checkLabel: CHECK_LABEL,
              stateOrder: CROSSING_ORDER,
              stateLabel: Object.fromEntries((Object.keys(CROSSING_LABEL) as CrossingState[]).map((k) => [k, crossingStateLabel(k, p.crossing)])),
              stepLabel: Object.fromEntries((["departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as CrossingState[]).map((k) => [k, stepLabel(k, p.crossing)?.en ?? k])),
              role: ctx.role,
            }),
          )}
        />
      </div>
    </div>
  );
}
