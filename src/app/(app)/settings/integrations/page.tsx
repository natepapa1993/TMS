import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/auth";
import { db } from "@/db/client";
import { integrations } from "@/db/schema";
import { PageHeader } from "@/components/page-header";
import { IntegrationCard } from "./card";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const ctx = await requireCtx();
  const rows = await db.select().from(integrations).where(eq(integrations.tenantId, ctx.tenantId));
  const get = (p: string) => rows.find((r) => r.provider === p);
  const motive = get("motive");
  const resend = get("resend");
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/settings" className="hover:text-teal">
            Settings
          </Link>
        }
        title="Integrations"
      >
        Keys are stored per company and never shown back once saved. Leave a secret blank to keep the one on file.
      </PageHeader>
      <div className="px-7 pb-10 grid gap-4 max-w-3xl">
        <IntegrationCard
          provider="motive"
          title="Motive (ELD)"
          blurb="Pulls every unit's position every 2 minutes and pins it to the leg it is running. Match units by the ELD vehicle id on the truck record, or by unit number."
          enabled={!!motive?.enabled}
          fields={[{ key: "apiKey", label: "API key", secret: true, set: !!motive?.config.apiKey }]}
          status={motive ? { lastRunAt: motive.lastRunAt?.toISOString() ?? null, lastError: motive.lastError, lastResult: motive.lastResult } : null}
          testable
        />
        <IntegrationCard
          provider="resend"
          title="Email (Resend)"
          blurb="Tenders and notifications go out through your own sending domain. Without it, messages are logged and shown in the app but not delivered."
          enabled={!!resend?.enabled}
          fields={[
            { key: "apiKey", label: "API key", secret: true, set: !!resend?.config.apiKey },
            { key: "from", label: "From address", secret: false, set: !!resend?.config.from, value: resend?.config.from ?? "", placeholder: "Dispatch <dispatch@yourdomain.com>" },
          ]}
          status={null}
        />
        <div className="card p-4 text-[13px] text-muted">
          Coming with their milestones: Sylectus Virtual Fleet (M5), DAT / Truckstop posting (M5), NAD and Viatpro crossing documents (M2), QuickBooks Online (M4), WhatsApp Business (M1.5).
        </div>
      </div>
    </div>
  );
}
