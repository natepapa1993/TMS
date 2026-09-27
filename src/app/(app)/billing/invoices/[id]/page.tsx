import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { invoiceById } from "@/domain/billing";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { InvoiceActions } from "./actions-panel";

export const dynamic = "force-dynamic";
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "slate", issued: "blue", sent: "teal", partially_paid: "amber", paid: "green", closed: "green", void: "slate", disputed: "red" };

export default async function InvoicePage({ params }: PageProps<"/billing/invoices/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const d = await invoiceById(ctx, id).catch(() => null);
  if (!d) notFound();
  const { invoice: inv, lines, receipts, creditMemos, entity, customer, orders } = d;
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const snap = inv.snapshot;
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/billing/invoices" className="hover:text-teal">
            Invoices
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <span className="mono">{inv.number ?? "Draft invoice"}</span>
            <Pill tone={TONE[inv.state]}>{inv.state.replace("_", " ")}</Pill>
          </span>
        }
        actions={inv.pdfStorageKey && inv.token ? <a className="btn" href={`/i/${inv.token}`} target="_blank" rel="noreferrer">PDF</a> : null}
      >
        {snap?.billTo.name ?? customer?.name} · from {snap?.entity.legalName ?? entity?.legalName} · {orders.map((o) => o.orderNumber).join(", ")}
        {inv.issuedAt ? ` · issued ${inv.issuedAt.toISOString().slice(0, 10)} · due ${inv.dueAt?.toISOString().slice(0, 10)}` : ""}
        {inv.sentTo ? ` · sent to ${inv.sentTo}` : ""}
      </PageHeader>
      <div className="px-7 pb-10 grid lg:grid-cols-[1fr_340px] gap-5 items-start [&>*]:min-w-0">
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Order</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(snap?.lines ?? lines.map((l) => ({ chargeId: l.id, orderId: l.orderId, orderNumber: orders.find((o) => o.id === l.orderId)?.orderNumber ?? "", kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents }))).map((l, i) => (
                  <tr key={i}>
                    <td className="font-semibold">{l.description}</td>
                    <td className="mono text-muted text-[12.5px]">{l.orderNumber}</td>
                    <td className="text-muted">{l.unit === "flat" ? "" : `${l.unit === "h" ? (l.qty / 100).toFixed(2) : l.qty} ${l.unit}`}</td>
                    <td className="mono text-muted">{l.unit === "flat" ? "" : formatCents(l.rateCents, inv.currency)}</td>
                    <td className="mono font-semibold text-right">{formatCents(l.amountCents, inv.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="text-right text-muted">
                    Subtotal
                  </td>
                  <td className="mono text-right">{formatCents(inv.subtotalCents, inv.currency)}</td>
                </tr>
                {inv.creditedCents > 0 && (
                  <tr>
                    <td colSpan={4} className="text-right text-muted">
                      Credits
                    </td>
                    <td className="mono text-right">-{formatCents(inv.creditedCents, inv.currency)}</td>
                  </tr>
                )}
                {inv.paidCents > 0 && (
                  <tr>
                    <td colSpan={4} className="text-right text-muted">
                      Paid
                    </td>
                    <td className="mono text-right">-{formatCents(inv.paidCents, inv.currency)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={4} className="text-right font-extrabold">
                    {inv.state === "void" ? "Void" : "Open"}
                  </td>
                  <td className="mono font-extrabold text-right text-[15px]">{inv.state === "void" ? "—" : formatCents(open, inv.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {(receipts.length > 0 || creditMemos.length > 0) && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Receipts & credits</div>
              <ul className="space-y-1 text-[13px]">
                {receipts.map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span>
                      {r.receivedAt.toISOString().slice(0, 10)} · {r.method}
                      {r.reference ? ` ${r.reference}` : ""}
                      {r.note ? <span className="text-muted"> — {r.note}</span> : null}
                    </span>
                    <span className="mono font-semibold">{formatCents(r.amountCents, inv.currency)}</span>
                  </li>
                ))}
                {creditMemos.map((m) => (
                  <li key={m.id} className="flex justify-between">
                    <span>
                      {m.issuedAt.toISOString().slice(0, 10)} · <span className="mono">{m.number}</span> — {m.reason}
                    </span>
                    <span className="mono font-semibold text-red">-{formatCents(m.amountCents, inv.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inv.voidReason && <div className="card p-4 text-[13px]">Voided {inv.voidedAt?.toISOString().slice(0, 10)}: {inv.voidReason}</div>}
          {inv.disputeReason && <div className="card p-4 text-[13px] text-red">Disputed: {inv.disputeReason}{inv.disputeExpectedAt ? ` · expected resolution ${inv.disputeExpectedAt.toISOString().slice(0, 10)}` : ""}</div>}
        </div>
        <InvoiceActions inv={JSON.parse(JSON.stringify({ id: inv.id, state: inv.state, currency: inv.currency, openCents: open, billingEmail: customer?.billingEmail ?? null, promiseToPayAt: inv.promiseToPayAt, payWhenPaid: inv.payWhenPaid, number: inv.number }))} role={ctx.role} />
      </div>
    </div>
  );
}
