import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { tripPage } from "@/domain/tailgate";
import { LEG_LABEL } from "@/domain/states";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { TripView } from "./view";

export const dynamic = "force-dynamic";

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };
const ORDER_LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };

export default async function TripPage({ params }: PageProps<"/trips/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const p = await tripPage(ctx, id).catch(() => null);
  if (!p) notFound();
  const canEdit = ["owner", "dispatcher"].includes(ctx.role);
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/trips" className="hover:text-teal">
            Tailgate trips
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            {p.order.orderNumber}
            <Pill tone={p.order.state === "cancelled" ? "slate" : p.order.state === "draft" ? "slate" : "teal"}>{ORDER_LABEL[p.order.state]}</Pill>
          </span>
        }
        actions={
          <>
            <a className="btn" href={`/api/trips/${id}/manifest`} target="_blank" rel="noreferrer">
              Manifest PDF
            </a>
            <Link href="/dispatch" className="btn">
              Dispatch
            </Link>
          </>
        }
      >
        {p.stops[0]?.name} → {p.stops[p.stops.length - 1]?.name} · {p.order.equipment.replace("_", " ")} · legs: {p.legs.map((l) => `${LEG_TYPE_LABEL[l.type]} (${LEG_LABEL[l.state]})`).join(", ")}
      </PageHeader>
      <div className="px-7 pb-10">
        <TripView
          tripId={id}
          state={p.order.state}
          stops={JSON.parse(JSON.stringify(p.stops))}
          shipments={JSON.parse(JSON.stringify(p.shipments))}
          capacity={JSON.parse(JSON.stringify(p.capacity))}
          customers={p.customers.map((c) => ({ id: c.id, name: c.name }))}
          canEdit={canEdit}
        />
      </div>
    </div>
  );
}
