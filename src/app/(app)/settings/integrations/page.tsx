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
  const wa = get("whatsapp");
  const { publicUrl } = await import("@/lib/tokens");
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
        <IntegrationCard
          provider="whatsapp"
          title="WhatsApp Business (Meta Cloud API)"
          blurb="Tenders, crossing packets and tracking links go out on WhatsApp; delivery and read receipts come back; what drivers and carriers write lands on the leg timeline. Without it, WhatsApp messages are logged and shown in the app but not delivered."
          enabled={!!wa?.enabled}
          fields={[
            { key: "phoneNumberId", label: "Phone number id", secret: false, set: !!wa?.config.phoneNumberId, value: wa?.config.phoneNumberId ?? "", placeholder: "from Meta → WhatsApp → API setup" },
            { key: "accessToken", label: "Access token (permanent, system user)", secret: true, set: !!wa?.config.accessToken },
            { key: "appSecret", label: "App secret (signs webhooks)", secret: true, set: !!wa?.config.appSecret },
            { key: "templateLanguage", label: "Template language", secret: false, set: !!wa?.config.templateLanguage, value: wa?.config.templateLanguage ?? "", placeholder: "en_US or es_MX" },
            { key: "tenderTemplate", label: "Tender template (4 params: carrier, lane, rate, link)", secret: false, set: !!wa?.config.tenderTemplate, value: wa?.config.tenderTemplate ?? "", placeholder: "load_offer" },
            { key: "packetTemplate", label: "Packet template (3 params: driver, order, link)", secret: false, set: !!wa?.config.packetTemplate, value: wa?.config.packetTemplate ?? "", placeholder: "crossing_packet" },
            { key: "trackingTemplate", label: "Tracking template (3 params: name, order, link)", secret: false, set: !!wa?.config.trackingTemplate, value: wa?.config.trackingTemplate ?? "", placeholder: "tracking_link" },
            { key: "generalTemplate", label: "General template (1 param: text)", secret: false, set: !!wa?.config.generalTemplate, value: wa?.config.generalTemplate ?? "", placeholder: "office_message" },
          ]}
          status={wa ? { lastRunAt: wa.lastRunAt?.toISOString() ?? null, lastError: wa.lastError, lastResult: wa.lastResult } : null}
          extra={
            wa?.config.webhookToken ? (
              <div className="mt-3 text-[12.5px]">
                <div className="eyebrow mb-1">Webhook (paste into Meta → WhatsApp → Configuration)</div>
                <div className="mono break-all select-all bg-ground rounded p-2 border border-line">{publicUrl(`/api/whatsapp/${wa.config.webhookToken}`)}</div>
                <div className="mt-1">
                  Verify token: <span className="mono select-all font-bold">{wa.config.verifyToken}</span> · subscribe to <b>messages</b>. Templates must be approved in Meta with the parameter counts above; outside a 24-hour conversation only templates are delivered.
                </div>
              </div>
            ) : (
              <div className="help mt-3">Save once to get this company&apos;s webhook URL and verify token.</div>
            )
          }
        />
        <div className="card p-4 text-[13px] text-muted">Coming with their milestones: Sylectus Virtual Fleet, DAT / Truckstop posting, NAD and Viatpro crossing documents, EDI VAN / AS2 connector.</div>
      </div>
    </div>
  );
}
