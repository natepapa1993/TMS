import { requireCtx } from "@/lib/auth";
import { list } from "@/data/records";
import { OrderForm } from "./form";
import { listTemplates } from "@/domain/load-templates";
import { getCompany } from "@/domain/company";

export const metadata = { title: "New load" };

export default async function NewOrderPage() {
  const ctx = await requireCtx();
  const [customers, entities, locations, templates] = await Promise.all([list(ctx, "customer", { limit: 2000 }), list(ctx, "billingEntity", { limit: 100 }), list(ctx, "location", { limit: 2000 }), listTemplates(ctx)]);
  const company = await getCompany(ctx);
  return (
    <OrderForm
      zone={company.timeZone}
      templates={templates.map((t) => ({ id: t.id, name: t.name, customer: t.customer }))}
      customers={customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) }))}
      entities={entities.map((e) => ({ id: e.id, name: String(e.legalName) }))}
      locations={locations.map((l) => ({ id: l.id, name: String(l.name), country: String(l.country), kind: String(l.kind), address: (l.address ?? null) as { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } | null }))}
    />
  );
}
