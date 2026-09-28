import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listIncidents } from "@/domain/compliance";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { IncidentsBoard } from "./board";
import { SafetyNav } from "../nav";
import { incidentDuties } from "@/domain/safety";
import { postAccidentDuty } from "@/domain/safety-rules";

export const metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const ctx = await requireCtx();
  const [raw, drivers, trucks, trailers] = await Promise.all([listIncidents(ctx), list(ctx, "driver", { limit: 2000 }), list(ctx, "truck", { limit: 2000 }), list(ctx, "trailer", { limit: 2000 })]);
  const duties = await incidentDuties(ctx, raw.map((i) => i.id));
  const rows = raw.map((i) => ({ ...i, postAccident: postAccidentDuty(i), tests: duties.get(i.id) ?? null }));
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/compliance" className="hover:text-teal">
            Compliance
          </Link>
        }
        title="Accident & incident register"
      >
        Accidents, injuries, cargo claims, citations. DOT-recordable ones (49 CFR 390.15) are flagged for the register; a fatality, or a citation with an injury or a tow-away, calls for post-accident testing. Roadside inspections have their own page.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10">
        <IncidentsBoard rows={JSON.parse(JSON.stringify(rows))} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name) }))} trucks={trucks.map((t) => ({ id: t.id, name: String(t.unitNumber) }))} trailers={trailers.map((t) => ({ id: t.id, name: String(t.unitNumber) }))} role={ctx.role} />
      </div>
    </div>
  );
}
