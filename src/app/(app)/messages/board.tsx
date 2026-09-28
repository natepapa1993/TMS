"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Empty, Modal, Pill, Toast, useToast } from "@/components/ui";
import { markHandledAction, replyToDriverAction } from "./actions";

type Row = { m: { id: string; channel: string; from: string; fromName: string | null; body: string; receivedAt: string; driverId: string | null; carrierId: string | null; legId: string | null; orderId: string | null; handledAt: string | null }; driverName: string | null; carrierName: string | null; orderNumber: string | null };

export function MessagesBoard({ rows }: { rows: Row[] }) {
  const zone = useZone();
  const router = useRouter();
  const t = useToast();
  const [showHandled, setShowHandled] = useState(false);
  const [pending, start] = useTransition();
  const [reply, setReply] = useState<Row | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const shown = rows.filter((r) => showHandled || !r.m.handledAt);
  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <label className="flex items-center gap-2 text-callout cursor-pointer">
          <input type="checkbox" className="accent-teal" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} /> Show handled
        </label>
      </div>
      {shown.length === 0 ? (
        <Empty title="No messages waiting" hint="What drivers write from their app lands here, and inbound WhatsApp once the company number is connected under Settings → Integrations." />
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>Message</th>
                <th>On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.m.id} className={r.m.handledAt ? "opacity-60" : ""}>
                  <td className="text-muted text-callout whitespace-nowrap">{fmtWhen(r.m.receivedAt, zone, { style: "short" })}</td>
                  <td>
                    {r.driverName ? (
                      <Link href={`/settings/drivers/${r.m.driverId}`} className="font-bold hover:text-teal">
                        {r.driverName}
                      </Link>
                    ) : r.carrierName ? (
                      <Link href={`/settings/carriers/${r.m.carrierId}`} className="font-bold hover:text-teal">
                        {r.carrierName}
                      </Link>
                    ) : (
                      <span>
                        <span className="font-bold">{r.m.fromName ?? "Unknown"}</span> <Pill tone="amber">not on file</Pill>
                      </span>
                    )}
                    <div className="mono text-footnote text-muted">{r.m.channel === "driver_app" ? "driver app" : `+${r.m.from}`}</div>
                  </td>
                  <td className="text-callout max-w-md">{r.m.body}</td>
                  <td>
                    {r.orderNumber ? (
                      <Link href={`/orders/${r.m.orderId}`} className="font-bold mono text-teal">
                        {r.orderNumber}
                      </Link>
                    ) : (
                      <span className="text-faint">no active leg</span>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {r.m.driverId && (
                      <button className="btn btn-sm btn-primary mr-1" disabled={pending} onClick={() => { setReply(r); setText(""); setErr(null); }}>
                        Reply
                      </button>
                    )}
                    {!r.m.handledAt && <button className="btn btn-sm" disabled={pending} onClick={() => start(async () => { const x = await markHandledAction(r.m.id); if (x.ok) { t.ok("Handled"); router.refresh(); } else t.err(x.error); })}>Handled</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={!!reply}
        onClose={() => setReply(null)}
        title={reply ? `Reply to ${reply.driverName ?? reply.m.fromName ?? "driver"}` : ""}
        footer={
          <>
            <button className="btn" onClick={() => setReply(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !text.trim()}
              onClick={() =>
                start(async () => {
                  if (!reply) return;
                  setErr(null);
                  const x = await replyToDriverAction(reply.m.driverId!, text, reply.m.orderId, reply.m.handledAt ? null : reply.m.id);
                  if (x.ok) {
                    setReply(null);
                    t.ok("Sent — the driver sees it in the app");
                    router.refresh();
                  } else setErr(x.error);
                })
              }
            >
              Send
            </button>
          </>
        }
      >
        {reply && (
          <div className="space-y-2">
            <div className="rounded-lg bg-ground px-3 py-2 text-callout">{reply.m.body}</div>
            <textarea className="w-full" rows={3} placeholder="Your answer. It shows in their app; on WhatsApp too when the number is connected." value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Reply" />
            {err && <div className="error">{err}</div>}
          </div>
        )}
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
