import Link from "next/link";
import { shortDate } from "@/lib/time";
import { db } from "@/db/client";
import { invoices } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { invoiceById } from "@/domain/billing";
import { deliveryForInvoice, DELIVERY_LABEL } from "@/domain/invoicing";
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
  const [rebilled] = inv.rebillOf ? await db.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.id, inv.rebillOf))).limit(1) : [];
  const open = inv.totalCents - inv.creditedCents - inv.paidCents;
  const { method } = await deliveryForInvoice(ctx, inv.customerId, inv.entityId);
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
            {inv.factored && <Pill tone="navy">Factored</Pill>}
            {orders.length > 1 && <Pill tone="blue">Summary · {orders.length} loads</Pill>}
            {inv.kind === "supplemental" && <Pill tone="blue">Supplemental</Pill>}
            {inv.rebillOf && (
              <Link href={`/billing/invoices/${inv.rebillOf}`} className="pill pill-slate">
                rebill of {rebilled?.number ?? "a voided invoice"}
              </Link>
            )}
          </span>
        }
        actions={
          inv.pdfStorageKey && inv.token ? (
            <>
              <a className="btn" href={`/i/${inv.token}`} target="_blank" rel="noreferrer">
                PDF
              </a>
              <a className="btn" href={`/api/invoices/${inv.id}/packet`} target="_blank" rel="noreferrer">
                Packet (invoice + docs)
              </a>
            </>
          ) : null
        }
      >
        {snap?.billTo.name ?? customer?.name} · from {snap?.entity.legalName ?? entity?.legalName} · {orders.map((o) => o.orderNumber).join(", ")}
        {inv.issuedAt ? ` · issued ${shortDate(inv.issuedAt)} · due ${shortDate(inv.dueAt)}` : ""}
        {inv.sentTo ? ` · sent to ${inv.sentTo}` : ""}
      </PageHeader>
      <div className="px-gutter pb-10 grid lg:grid-cols-[1fr_340px] gap-5 items-start [&>*]:min-w-0">
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
                    <td className="mono text-muted text-callout">{l.orderNumber}</td>
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
                  <td className="mono font-extrabold text-right text-headline">{inv.state === "void" ? "—" : formatCents(open, inv.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {snap?.loads && snap.loads.length > 1 && (
            <div className="card overflow-hidden" data-testid="invoice-loads">
              <table className="table">
                <thead>
                  <tr>
                    <th>Load</th>
                    <th>References</th>
                    <th>Lane</th>
                    <th>Delivered</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.loads.map((l) => (
                    <tr key={l.orderNumber}>
                      <td className="mono font-semibold">{l.orderNumber}</td>
                      <td className="text-muted text-callout">{l.refs || "—"}</td>
                      <td className="text-callout">
                        {l.from} → {l.to}
                      </td>
                      <td className="text-callout">{l.delivered ?? "—"}</td>
                      <td className="mono font-semibold text-right">{formatCents(l.amountCents, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {inv.deliveries.length > 0 && (
            <div className="card p-4" data-testid="invoice-deliveries">
              <div className="eyebrow mb-2">Sent</div>
              <ul className="space-y-1 text-callout">
                {inv.deliveries.map((d, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>
                      <span className="font-semibold">{DELIVERY_LABEL[d.method as keyof typeof DELIVERY_LABEL] ?? d.method}</span>
                      {d.to ? ` · ${d.to}` : ""}
                      {d.reference ? <span className="text-muted"> — {d.reference}</span> : null}
                    </span>
                    <span className="text-muted whitespace-nowrap">{d.at.slice(0, 16).replace("T", " ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(receipts.length > 0 || creditMemos.length > 0) && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Receipts & credits</div>
              <ul className="space-y-1 text-callout">
                {receipts.map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span>
                      {shortDate(r.receivedAt)} · {r.method}
                      {r.reference ? ` ${r.reference}` : ""}
                      {r.note ? <span className="text-muted"> — {r.note}</span> : null}
                    </span>
                    <span className="mono font-semibold">{formatCents(r.amountCents, inv.currency)}</span>
                  </li>
                ))}
                {creditMemos.map((m) => (
                  <li key={m.id} className="flex justify-between">
                    <span>
                      {shortDate(m.issuedAt)} · <span className="mono">{m.number}</span> — {m.reason}
                    </span>
                    <span className="mono font-semibold text-red">-{formatCents(m.amountCents, inv.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inv.voidReason && <div className="card p-4 text-callout">Voided {shortDate(inv.voidedAt)}: {inv.voidReason}</div>}
          {inv.disputeReason && <div className="card p-4 text-callout text-red">Disputed: {inv.disputeReason}{inv.disputeExpectedAt ? ` · expected resolution ${shortDate(inv.disputeExpectedAt)}` : ""}</div>}
        </div>
        <InvoiceActions inv={JSON.parse(JSON.stringify({ id: inv.id, state: inv.state, currency: inv.currency, openCents: open, paidCents: inv.paidCents, creditedCents: inv.creditedCents, billingEmail: customer?.billingEmail ?? null, promiseToPayAt: inv.promiseToPayAt, payWhenPaid: inv.payWhenPaid, number: inv.number, method, portalUrl: customer?.portalUrl ?? null, factorName: entity?.factorName ?? null, factorEmail: entity?.factorEmail ?? null }))} role={ctx.role} />
      </div>
    </div>
  );
}
