import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listTrips } from "@/domain/tailgate";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { formatCents } from "@/data/fields";

export const metadata = { title: "Tailgate trips" };
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Delivered", invoiced: "Delivered", paid: "Delivered", cancelled: "Cancelled" };

export default async function TripsPage() {
  const ctx = await requireCtx();
  const rows = await listTrips(ctx);
  return (
    <div>
      <PageHeader
        eyebrow="Orders"
        title="Tailgate trips"
        actions={
          <Link href="/trips/new" className="btn btn-primary">
            + New trip
          </Link>
        }
      >
        Many shipments on one trip. Each shipment keeps its own customer, rate, references, documents, POD and invoice; the trip carries the unit, the stops, the capacity and the crossing.
      </PageHeader>
      <div className="px-gutter pb-10">
        <div className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="py-14 text-center">
              <div className="font-bold">No trips yet</div>
              <div className="text-muted text-callout mt-1">Build one: stops first, then the shipments that ride between them.</div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Trip</th>
                  <th>Route</th>
                  <th>Stops</th>
                  <th>Shipments</th>
                  <th>Weight</th>
                  <th>Revenue</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.trip.id}>
                    <td className="font-extrabold mono">
                      <Link href={`/trips/${r.trip.id}`} className="hover:text-teal">
                        {r.trip.orderNumber}
                      </Link>
                    </td>
                    <td>
                      {r.from} → {r.to}
                    </td>
                    <td className="mono">{r.stops}</td>
                    <td className="mono">{r.shipments}</td>
                    <td className="mono text-muted">{r.weightLbs ? `${r.weightLbs.toLocaleString()} lb` : "—"}</td>
                    <td className="mono font-semibold">{formatCents(r.revenueCents)}</td>
                    <td>
                      <Pill tone={r.trip.state === "cancelled" ? "slate" : r.trip.state === "draft" ? "slate" : r.trip.state === "exception" ? "red" : "teal"}>{LABEL[r.trip.state] ?? r.trip.state}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
