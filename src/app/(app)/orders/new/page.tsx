import { requireCtx } from "@/lib/auth";
import { list } from "@/data/records";
import { OrderForm } from "./form";

export const metadata = { title: "New load" };

export default async function NewOrderPage() {
  const ctx = await requireCtx();
  const [customers, entities, locations] = await Promise.all([list(ctx, "customer", { limit: 2000 }), list(ctx, "billingEntity", { limit: 100 }), list(ctx, "location", { limit: 2000 })]);
  return (
    <OrderForm
      customers={customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) }))}
      entities={entities.map((e) => ({ id: e.id, name: String(e.legalName) }))}
      locations={locations.map((l) => ({ id: l.id, name: String(l.name), country: String(l.country), kind: String(l.kind), address: (l.address ?? null) as { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } | null }))}
    />
  );
}
