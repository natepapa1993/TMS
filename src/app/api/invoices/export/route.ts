import { currentCtx } from "@/lib/auth";
import { listInvoices, invoicesCsv, type InvoiceFilter } from "@/domain/billing";
import { list } from "@/data/records";

export const dynamic = "force-dynamic";

/** The invoice list as CSV, with the same filters as the page. */
export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const u = new URL(req.url).searchParams;
  try {
    const state = u.get("state");
    const [rows, customers] = await Promise.all([listInvoices(ctx, { states: state ? [state] : undefined, q: u.get("q") ?? undefined, customerId: u.get("customer") ?? undefined, view: (u.get("view") ?? "") as InvoiceFilter["view"], from: u.get("from") ?? undefined, to: u.get("to") ?? undefined }), list(ctx, "customer", { limit: 5000 })]);
    const name = new Map(customers.map((c) => [c.id, String(c.name)]));
    return new Response(invoicesCsv(rows, (id) => name.get(id) ?? ""), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="invoices.csv"` } });
  } catch {
    return new Response("not allowed", { status: 403 });
  }
}
