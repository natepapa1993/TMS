import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listOrders } from "@/domain/orders";
import { list } from "@/data/records";
import { ORDER_STATES, type OrderState } from "@/db/schema";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { formatCents } from "@/data/fields";

export const metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

const TONE: Record<OrderState, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "slate", booked: "blue", dispatched: "amber", in_transit: "teal", exception: "red", delivered: "green", ready_to_bill: "green", invoiced: "green", paid: "green", cancelled: "slate" };
const LABEL: Record<OrderState, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };

export default async function OrdersPage({ searchParams }: PageProps<"/orders">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const state = typeof sp.state === "string" && (ORDER_STATES as readonly string[]).includes(sp.state) ? (sp.state as OrderState) : null;
  const [orders, customers] = await Promise.all([listOrders(ctx, { states: state ? [state] : undefined, limit: 500 }), list(ctx, "customer", { limit: 2000 })]);
  const cname = new Map(customers.map((c) => [c.id, String(c.name)]));
  const q = typeof sp.q === "string" ? sp.q.toLowerCase() : "";
  const rows = q ? orders.filter((o) => [o.orderNumber, cname.get(o.customerId ?? "") ?? "", ...Object.values(o.refs)].some((x) => x.toLowerCase().includes(q))) : orders;
  return (
    <div>
      <PageHeader
        eyebrow="Orders"
        title="All orders"
        actions={
          <>
            <Link href="/trips" className="btn">
              Tailgate trips
            </Link>
            <Link href="/orders/new" className="btn btn-primary">
              + Full order form
            </Link>
          </>
        }
      >
        Every order, any state. For today&apos;s work use Dispatch.
      </PageHeader>
      <div className="px-7 pb-10">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <form className="flex gap-2">
            <input name="q" defaultValue={q} className="input w-64" placeholder="Search order #, customer, reference…" />
            {state && <input type="hidden" name="state" value={state} />}
          </form>
          <div className="flex gap-1 ml-2">
            <Link href="/orders" className="stage-tab h-8 text-[12.5px]" data-active={!state}>
              All
            </Link>
            {(["booked", "dispatched", "in_transit", "exception", "delivered", "cancelled"] as OrderState[]).map((s) => (
              <Link key={s} href={`/orders?state=${s}`} className="stage-tab h-8 text-[12.5px]" data-active={state === s}>
                {LABEL[s]}
              </Link>
            ))}
          </div>
        </div>
        <div className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="py-14 text-center">
              <div className="font-bold">No orders</div>
              <div className="text-muted text-[13px] mt-1">Create one from Dispatch (press n) or with the full form.</div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>References</th>
                  <th>Rate</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="font-extrabold mono">
                      <Link href={o.kind === "trip" ? `/trips/${o.id}` : `/orders/${o.id}`} className="hover:text-teal">
                        {o.orderNumber}
                      </Link>
                      {o.kind === "trip" && <Pill tone="navy">trip</Pill>}
                      {o.kind === "shipment" && (
                        <Link href={`/trips/${o.tripId}`} className="ml-1">
                          <Pill tone="teal">on a trip</Pill>
                        </Link>
                      )}
                    </td>
                    <td>{o.kind === "trip" ? <span className="text-muted">tailgate</span> : (cname.get(o.customerId ?? "") ?? cname.get(o.brokerId ?? "") ?? <span className="text-faint">—</span>)}</td>
                    <td className="text-muted text-[12.5px]">{Object.values(o.refs).join(" · ") || "—"}</td>
                    <td className="mono">{o.rateTbd || o.rateCents == null ? <span className="text-faint">TBD</span> : formatCents(o.rateCents, o.currency)}</td>
                    <td>
                      <Pill tone={TONE[o.state]}>{LABEL[o.state]}</Pill>
                    </td>
                    <td className="text-muted text-[12.5px]">{new Date(o.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
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
