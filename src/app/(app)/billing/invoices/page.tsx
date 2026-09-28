import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listInvoices, type InvoiceFilter } from "@/domain/billing";
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
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const state = str("state");
  const f = { q: str("q"), customerId: str("customer"), view: str("view") as InvoiceFilter["view"], from: str("from"), to: str("to") };
  const [rows, customers] = await Promise.all([listInvoices(ctx, { states: state ? [state] : undefined, ...f }), list(ctx, "customer", { limit: 2000 })]);
  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries({ state, q: f.q, customer: f.customerId, view: f.view ?? "", from: f.from, to: f.to, ...patch }).filter(([, v]) => v));
    return p.toString() ? `?${p}` : "";
  };
  const openSum = rows.filter((i) => !["paid", "void", "closed", "draft"].includes(i.state)).reduce((a, i) => a + i.totalCents - i.creditedCents - i.paidCents, 0);
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
        <form className="card p-3 mb-3 flex items-end gap-2 flex-wrap" method="get" data-testid="invoice-filters">
          {state && <input type="hidden" name="state" value={state} />}
          {f.view && <input type="hidden" name="view" value={f.view} />}
          <div className="flex-1 min-w-[200px]">
            <label className="label" htmlFor="inv-q">
              Search
            </label>
            <input id="inv-q" name="q" className="input" defaultValue={f.q} placeholder="invoice #, load #, PO / BOL, customer" />
          </div>
          <div>
            <label className="label" htmlFor="inv-customer">
              Customer
            </label>
            <select id="inv-customer" name="customer" className="select" defaultValue={f.customerId}>
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {String(c.name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="inv-from">
              Issued from
            </label>
            <input id="inv-from" name="from" type="date" className="input" defaultValue={f.from} />
          </div>
          <div>
            <label className="label" htmlFor="inv-to">
              to
            </label>
            <input id="inv-to" name="to" type="date" className="input" defaultValue={f.to} />
          </div>
          <button className="btn btn-primary" type="submit">
            Filter
          </button>
          {(f.q || f.customerId || f.from || f.to) && (
            <Link href={`/billing/invoices${qs({ q: "", customer: "", from: "", to: "" })}`} className="btn btn-ghost">
              Clear
            </Link>
          )}
          <a className="btn" href={`/api/invoices/export${qs({})}`}>
            CSV
          </a>
        </form>
        <div className="flex gap-1 mb-3 flex-wrap items-center">
          {[
            ["", "All"],
            ["open", "Open"],
            ["overdue", "Overdue"],
            ["unsent", "Issued, not sent"],
            ["factored", "Factored"],
          ].map(([v, l]) => (
            <Link key={v} href={`/billing/invoices${qs({ view: v, state: "" })}`} className="stage-tab h-8 text-[12.5px]" data-active={!state && (f.view ?? "") === v}>
              {l}
            </Link>
          ))}
          <span className="mx-2 text-faint">|</span>
          {["draft", "issued", "sent", "partially_paid", "paid", "disputed", "void"].map((st) => (
            <Link key={st} href={`/billing/invoices${qs({ state: state === st ? "" : st, view: "" })}`} className="stage-tab h-8 text-[12.5px]" data-active={state === st}>
              {st.replace("_", " ")}
            </Link>
          ))}
          <span className="ml-auto text-[12.5px] text-muted" data-testid="invoice-count">
            {rows.length} invoice{rows.length === 1 ? "" : "s"}
            {openSum ? ` · ${formatCents(openSum)} open` : ""}
          </span>
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
                      {i.kind !== "standard" && <div className="text-[11px] font-semibold text-muted font-sans">{i.kind}</div>}
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
