import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { inbox, sentLog } from "@/domain/messaging";
import { SentBoard } from "./sent";
import { PageHeader } from "@/components/page-header";
import { MessagesBoard } from "./board";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const ctx = await requireCtx();
  const [rows, sent] = await Promise.all([inbox(ctx, { limit: 200 }), sentLog(ctx, { limit: 200 })]);
  return (
    <div>
      <PageHeader
        eyebrow="Dispatch"
        title="Messages"
        actions={
          <Link href="/settings/integrations" className="btn">
            WhatsApp setup
          </Link>
        }
      >
        What drivers write from their app and what drivers and carriers write to the company WhatsApp number, with a Reply that reaches them; and everything we sent them: tenders, packets, tracking links, invoices. Replies from someone on a leg also show on that order&apos;s timeline.
      </PageHeader>
      <div className="px-7 pb-10">
        <MessagesBoard rows={JSON.parse(JSON.stringify(rows))} />
        <SentBoard rows={JSON.parse(JSON.stringify(sent))} />
      </div>
    </div>
  );
}
