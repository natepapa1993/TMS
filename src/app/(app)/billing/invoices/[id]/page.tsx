import Link from "next/link";
import { fmtWhen } from "@/lib/time";
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
import { NOT_EMAILED, notEmailed } from "@/domain/delivery-rules";
import { formatCents } from "@/data/fields";
import { InvoiceActions, SendCreditMemo } from "./actions-panel";
import { getCompany } from "@/domain/company";

export const dynamic = "force-dynamic";
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "slate", issued: "blue", sent: "teal", partially_paid: "amber", paid: "green", closed: "green", void: "slate", disputed: "red" };

export default async function InvoicePage({ params }: PageProps<"/billing/invoices/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const companyZone = await (await import("@/domain/company")).tenantZone(ctx.tenantId);
  const d = await invoiceById(ctx, id).catch(() => null);
  if (!d) notFound();
  const { invoice: inv, lines, receipts, creditMemos, entity, customer, orders } = d;
  const [rebilled] = inv.rebillOf ? await db.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.id, inv.rebillOf))).limit(1) : [];
  const [supplementOf] = inv.supplementOf ? await db.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.id, inv.supplementOf))).limit(1) : [];
  const company = await getCompany(ctx);
  // invoice dates are the company's calendar day (an evening invoice in Texas is not tomorrow's)
  const localDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: company.timeZone }) : "—");
  const suggestedRate = inv.currency !== "USD" ? (company.settings.fx[inv.currency]?.rateE4 ?? null) : null;
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
            {notEmailed(inv) && (
              <Pill tone="amber" title={NOT_EMAILED}>
                Not emailed — connect email in Settings → Integrations
              </Pill>
            )}
            {inv.factored && <Pill tone="navy">Factored</Pill>}
            {orders.length > 1 && <Pill tone="blue">Summary · {orders.length} loads</Pill>}
            {inv.kind === "supplemental" && (inv.supplementOf ? (
              <Link href={`/billing/invoices/${inv.supplementOf}`} className="pill pill-blue">
                supplemental to {supplementOf?.number ?? "the load's invoice"}
              </Link>
            ) : <Pill tone="blue">Supplemental</Pill>)}
            {inv.currency !== "USD" && <Pill tone="blue">{inv.currency}{inv.exchangeRate ? ` · ${(inv.exchangeRate / 10000).toFixed(4)} per USD` : ""}</Pill>}
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
        {snap?.billTo.name ?? customer?.name} · from {snap?.entity.legalName ?? entity?.legalName} ·{" "}
        {orders.map((o, i) => (
          <span key={o.id}>
            {i > 0 && ", "}
            <Link href={`/orders/${o.id}`} className="text-teal font-semibold hover:underline">
              {o.orderNumber}
            </Link>
          </span>
        ))}
        {inv.issuedAt ? ` · issued ${localDate(inv.issuedAt)} · due ${localDate(inv.dueAt)}` : ""}
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
              <div className="eyebrow mb-2">{inv.deliveries.every((d) => d.logged) ? "Not emailed yet" : "Sent"}</div>
              <ul className="space-y-1 text-callout">
                {inv.deliveries.map((d, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>
                      <span className="font-semibold">{DELIVERY_LABEL[d.method as keyof typeof DELIVERY_LABEL] ?? d.method}</span>
                      {d.logged ? <span className="text-amber font-semibold"> · logged, not emailed</span> : null}
                      {d.to ? ` · ${d.to}` : ""}
                      {d.reference ? <span className="text-muted"> — {d.reference}</span> : null}
                    </span>
                    <span className="text-muted whitespace-nowrap">{fmtWhen(d.at, companyZone, { style: "short" })}</span>
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
                  <li key={m.id} className="flex justify-between items-center gap-2" data-testid="credit-memo">
                    <span>
                      {shortDate(m.issuedAt)} ·{" "}
                      <a className="mono text-teal font-semibold" href={`/api/credit-memos/${m.id}`} target="_blank" rel="noreferrer">
                        {m.number}
                      </a>{" "}
                      — {m.reason}
                      <span className="text-muted">{m.sentAt ? ` · sent to ${m.sentTo}` : " · not sent yet"}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {["owner", "billing"].includes(ctx.role) && <SendCreditMemo id={m.id} sent={!!m.sentAt} />}
                      <span className="mono font-semibold text-red">-{formatCents(m.amountCents, inv.currency)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inv.state === "draft" && customer && !(customer.billingAddress?.line1 && customer.billingAddress?.city) && (
            <div className="card p-4 text-callout text-amber font-semibold" data-testid="no-bill-to">
              {customer.name} has no bill-to address: the invoice prints only their name.{" "}
              <Link href={`/settings/customers/${customer.id}`} className="text-teal">
                Add it on the customer
              </Link>{" "}
              before you issue — many AP departments reject an invoice without one.
            </div>
          )}
          {inv.voidReason && <div className="card p-4 text-callout">Voided {shortDate(inv.voidedAt)}: {inv.voidReason}</div>}
          {inv.disputeReason && inv.state === "disputed" && <div className="card p-4 text-callout text-red">Disputed: {inv.disputeReason}{inv.disputeExpectedAt ? ` · expected resolution ${shortDate(inv.disputeExpectedAt)}` : ""}</div>}
          {inv.disputeResolution && inv.state !== "disputed" && (
            <div className="card p-4 text-callout" data-testid="dispute-resolution">
              <span className="font-semibold">Dispute resolved:</span> {inv.disputeResolution}
              {inv.disputeReason ? <span className="text-muted"> (was: {inv.disputeReason})</span> : null}
            </div>
          )}
          {snap?.correctedFromFactor && <div className="card p-4 text-callout">Corrected after the chargeback: the customer&rsquo;s copy now says to pay you, not {snap.correctedFromFactor}.</div>}
        </div>
        <InvoiceActions inv={JSON.parse(JSON.stringify({ id: inv.id, state: inv.state, currency: inv.currency, openCents: open, paidCents: inv.paidCents, creditedCents: inv.creditedCents, billingEmail: customer?.billingEmail ?? null, promiseToPayAt: inv.promiseToPayAt, payWhenPaid: inv.payWhenPaid, number: inv.number, method, portalUrl: customer?.portalUrl ?? null, factorName: entity?.factorName ?? null, factorEmail: entity?.factorEmail ?? null, suggestedRate: suggestedRate ? (suggestedRate / 10000).toFixed(4) : "", needsCorrected: !!snap?.factor && !inv.factored && !inv.factorFundedAt && ["issued", "sent", "partially_paid", "disputed"].includes(inv.state), hasCreditMemo: creditMemos.length > 0 }))} role={ctx.role} />
      </div>
    </div>
  );
}
