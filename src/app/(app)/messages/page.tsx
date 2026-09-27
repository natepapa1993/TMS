import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { inbox, sentLog } from "@/domain/messaging";
import { SentBoard } from "./sent";
import { PageHeader } from "@/components/page-header";
import { MessagesBoard } from "./board";
import { MailCards } from "./mail";
import { mailInbox } from "@/domain/mail";
import { list } from "@/data/records";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const ctx = await requireCtx();
  const [rows, sent, mail, customers] = await Promise.all([inbox(ctx, { limit: 200 }), sentLog(ctx, { limit: 200 }), mailInbox(ctx, { all: true, limit: 200 }), list(ctx, "customer", { limit: 2000 })]);
  return (
    <div>
      <PageHeader
        eyebrow="Dispatch"
        title="Messages"
        actions={
          <Link href="/settings/integrations" className="btn">
            Mailbox & WhatsApp setup
          </Link>
        }
      >
        Every email to dispatch@ as one card the agent proposes and you tap; what drivers write from their app and what drivers and carriers write to the company WhatsApp number, with a Reply that reaches them; and everything we sent them. Replies from someone on a leg also show on that order&apos;s timeline.
      </PageHeader>
      <div className="px-7 pb-10">
        <MailCards rows={JSON.parse(JSON.stringify(mail))} customers={customers.map((c) => ({ id: c.id, name: String(c.name), kind: String(c.kind) })).sort((p, q) => p.name.localeCompare(q.name))} canAct={["owner", "dispatcher", "billing", "mx_office"].includes(ctx.role)} />
        <div className="h2 mb-2">WhatsApp and the driver app</div>
        <MessagesBoard rows={JSON.parse(JSON.stringify(rows))} />
        <SentBoard rows={JSON.parse(JSON.stringify(sent))} />
      </div>
    </div>
  );
}
