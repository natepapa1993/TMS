import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listIncidents } from "@/domain/compliance";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { IncidentsBoard } from "./board";

export const metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const ctx = await requireCtx();
  const [rows, drivers, trucks, trailers] = await Promise.all([listIncidents(ctx), list(ctx, "driver", { limit: 2000 }), list(ctx, "truck", { limit: 2000 }), list(ctx, "trailer", { limit: 2000 })]);
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
        Accidents, injuries, cargo claims, roadside inspections, citations. DOT-recordable ones are flagged for the register.
      </PageHeader>
      <div className="px-7 pb-10">
        <IncidentsBoard rows={JSON.parse(JSON.stringify(rows))} drivers={drivers.map((d) => ({ id: d.id, name: String(d.name) }))} trucks={trucks.map((t) => ({ id: t.id, name: String(t.unitNumber) }))} trailers={trailers.map((t) => ({ id: t.id, name: String(t.unitNumber) }))} role={ctx.role} />
      </div>
    </div>
  );
}
