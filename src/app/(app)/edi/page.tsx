import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { ediInbox, ediLog, tenderView } from "@/domain/edi";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { EdiBoard } from "./board";

export const metadata = { title: "EDI" };
export const dynamic = "force-dynamic";

export default async function EdiPage() {
  const ctx = await requireCtx();
  const [inbox, log, partners, customers] = await Promise.all([ediInbox(ctx), ediLog(ctx, { limit: 300 }), list(ctx, "ediPartner", { limit: 200 }), list(ctx, "customer", { limit: 2000 })]);
  const custName = new Map(customers.map((c) => [c.id, String(c.name)]));
  const inboxRows = inbox.map((r) => ({ ...r, tender: tenderView(r.m), customer: custName.get(r.customerId) ?? r.theirId }));
  return (
    <div>
      <PageHeader
        eyebrow="Dispatch"
        title="EDI"
        actions={
          <Link href="/settings/edi-partners" className="btn">
            Partners
          </Link>
        }
      >
        Tenders (204) arrive here and become draft orders; every milestone goes back as a 214 and every issued invoice as a 210. Nothing leaves without a row in the log.
      </PageHeader>
      <div className="px-gutter pb-10">
        <EdiBoard inbox={JSON.parse(JSON.stringify(inboxRows))} log={JSON.parse(JSON.stringify(log.map((l) => ({ ...l, customer: custName.get(l.customerId) ?? l.theirId }))))} partners={partners.map((p) => ({ id: p.id, label: `${custName.get(String(p.customerId)) ?? "?"} · ${String(p.theirId)}` }))} role={ctx.role} />
      </div>
    </div>
  );
}
