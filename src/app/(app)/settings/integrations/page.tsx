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
  const ex = get("extractor");
  const mb = get("mailbox");
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
        <IntegrationCard
          provider="extractor"
          title="AI document reader (Anthropic)"
          blurb="Reads trailer, seal, folio fiscal, pedimento, weights and the rest off each crossing document as it is uploaded, with a confidence per field. A person always confirms before the values count toward the checks. Files are sent to the model for reading only; nothing is stored there."
          enabled={!!ex?.enabled}
          fields={[
            { key: "apiKey", label: "Anthropic API key", secret: true, set: !!ex?.config.apiKey },
            { key: "model", label: "Model", secret: false, set: !!ex?.config.model, value: ex?.config.model ?? "", placeholder: "claude-sonnet-4-5 (default)" },
          ]}
          status={ex ? { lastRunAt: ex.lastRunAt?.toISOString() ?? null, lastError: ex.lastError, lastResult: ex.lastResult } : null}
        />
        <IntegrationCard
          provider="mailbox"
          title="Dispatch mailbox (the inbox agent)"
          blurb="Every email to dispatch@ becomes one card on Messages: what it is (rate con, status question, broker document, detention, payment), what it says, which order it belongs to, and what the agent will do — a draft order, a document on the crossing, a drafted reply, a charge, a receipt. Nothing runs without a tap. Reads through IMAP with an app password (Gmail: 2-step verification → App passwords; Microsoft 365: an app password or IMAP basic auth), or forward the mailbox to the inbound URL below."
          enabled={!!mb?.enabled}
          fields={[
            { key: "host", label: "IMAP host", secret: false, set: !!mb?.config.host, value: mb?.config.host ?? "", placeholder: "imap.gmail.com" },
            { key: "port", label: "Port", secret: false, set: !!mb?.config.port, value: mb?.config.port ?? "", placeholder: "993" },
            { key: "user", label: "Mailbox (full address)", secret: false, set: !!mb?.config.user, value: mb?.config.user ?? "", placeholder: "dispatch@yourdomain.com" },
            { key: "password", label: "App password", secret: true, set: !!mb?.config.password },
            { key: "folder", label: "Folder", secret: false, set: !!mb?.config.folder, value: mb?.config.folder ?? "", placeholder: "INBOX" },
          ]}
          status={mb ? { lastRunAt: mb.lastRunAt?.toISOString() ?? null, lastError: mb.lastError, lastResult: mb.lastResult } : null}
          extra={
            mb?.config.inboundToken ? (
              <div className="mt-3 text-[12.5px]">
                <div className="eyebrow mb-1">Inbound URL (forward dispatch@ here instead of, or as well as, IMAP)</div>
                <div className="mono break-all select-all bg-ground rounded p-2 border border-line" data-testid="inbound-url">{publicUrl(`/api/mail/inbound/${mb.config.inboundToken}`)}</div>
                <div className="mt-1">Cloudflare Email Routing (a Worker that POSTs the raw message), Mailgun routes (&quot;forward to URL&quot;), Postmark or SES inbound all deliver here; the raw message as the body, a multipart field, or JSON <span className="mono">{"{raw}"}</span>. With the AI reader connected above, the model classifies and reads the fields; without it, rules do what rules can.</div>
              </div>
            ) : (
              <div className="help mt-3">Save once to get this company&apos;s inbound URL; the IMAP fields are optional if you forward instead.</div>
            )
          }
        />
        <div className="card p-4 text-[13px] text-muted">Waiting on outside access: Sylectus Virtual Fleet and DAT / Truckstop posting (API access), NAD and Viatpro crossing documents (credentials), native AS2 (the VAN&rsquo;s certificates). The EDI VAN mailbox over SFTP lives on each EDI partner&rsquo;s record.</div>
      </div>
    </div>
  );
}
