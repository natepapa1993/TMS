import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listInvoices } from "@/domain/billing";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { BillingNav } from "../nav";
import { CloseButton } from "./close";
import { ToFactor } from "./factor";
import { awaitingFactor, listBatches } from "@/domain/invoicing";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "slate", issued: "blue", sent: "teal", partially_paid: "amber", paid: "green", closed: "green", void: "slate", disputed: "red" };

export default async function InvoicesPage({ searchParams }: PageProps<"/billing/invoices">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const state = typeof sp.state === "string" ? sp.state : "";
  const [rows, customers] = await Promise.all([listInvoices(ctx, { states: state ? [state] : undefined }), list(ctx, "customer", { limit: 2000 })]);
  const cn = new Map(customers.map((c) => [c.id, String(c.name)]));
  const canBill = ["owner", "billing"].includes(ctx.role);
  const entities = canBill ? await list(ctx, "billingEntity", { limit: 50 }) : [];
  const factors = entities.filter((e) => e.factorName);
  const [waiting, batches] = factors.length ? await Promise.all([awaitingFactor(ctx), listBatches(ctx)]) : [[], []];
  return (
    <div>
      <PageHeader eyebrow="Billing" title="Invoices" actions={["owner", "billing"].includes(ctx.role) ? <CloseButton /> : null}>
        Numbers come from the billing entity and are never reused. An issued invoice is a locked snapshot.
      </PageHeader>
      <BillingNav />
      <div className="px-7 pb-10">
        {factors.map((e) => (
          <ToFactor
            key={String(e.id)}
            factor={String(e.factorName)}
            rows={waiting.filter((i) => i.entityId === e.id).map((i) => ({ id: i.id, number: i.number ?? "", customer: cn.get(i.customerId) ?? "?", issuedAt: i.issuedAt?.toISOString().slice(0, 10) ?? "", totalCents: i.totalCents - i.creditedCents, currency: i.currency }))}
            schedules={batches.filter((b) => b.kind === "factor_schedule").slice(0, 5).map((b) => ({ id: b.id, number: b.number, count: b.invoiceIds.length, totalCents: b.totalCents, currency: b.currency, sentTo: b.sentTo, at: b.createdAt.toISOString().slice(0, 10) }))}
          />
        ))}
        <div className="flex gap-1 mb-3">
          {["", "draft", "issued", "sent", "partially_paid", "paid", "disputed", "void"].map((s) => (
            <Link key={s} href={`/billing/invoices${s ? `?state=${s}` : ""}`} className="stage-tab h-8 text-[12.5px]" data-active={state === s}>
              {s ? s.replace("_", " ") : "All"}
            </Link>
          ))}
        </div>
        <div className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="py-14 text-center font-bold">No invoices</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Customer</th>
                  <th>Orders</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Total</th>
                  <th>Open</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="font-extrabold mono">
                      <Link href={`/billing/invoices/${i.id}`} className="hover:text-teal">
                        {i.number ?? "draft"}
                      </Link>
                    </td>
                    <td>{cn.get(i.customerId)}</td>
                    <td className="text-muted text-[12.5px]">{i.orderIds.length}</td>
                    <td className="text-[12.5px]">{i.issuedAt ? i.issuedAt.toISOString().slice(0, 10) : "—"}</td>
                    <td className={`text-[12.5px] ${i.dueAt && i.dueAt < new Date() && !["paid", "void"].includes(i.state) ? "text-red font-semibold" : ""}`}>{i.dueAt ? i.dueAt.toISOString().slice(0, 10) : "—"}</td>
                    <td className="mono">{formatCents(i.totalCents, i.currency)}</td>
                    <td className="mono font-semibold">{["paid", "void"].includes(i.state) ? "—" : formatCents(i.totalCents - i.creditedCents - i.paidCents, i.currency)}</td>
                    <td>
                      <Pill tone={TONE[i.state]}>{i.state.replace("_", " ")}</Pill>
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
