import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { inbox } from "@/domain/messaging";
import { PageHeader } from "@/components/page-header";
import { MessagesBoard } from "./board";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const ctx = await requireCtx();
  const rows = await inbox(ctx, { limit: 200 });
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
        What drivers and carriers write to the company WhatsApp number. Replies from someone on a leg also show on that order&apos;s timeline.
      </PageHeader>
      <div className="px-7 pb-10">
        <MessagesBoard rows={JSON.parse(JSON.stringify(rows))} />
      </div>
    </div>
  );
}
