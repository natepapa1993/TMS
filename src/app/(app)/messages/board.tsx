"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Empty, Pill, Toast, useToast } from "@/components/ui";
import { markHandledAction } from "./actions";

type Row = { m: { id: string; channel: string; from: string; fromName: string | null; body: string; receivedAt: string; driverId: string | null; carrierId: string | null; legId: string | null; orderId: string | null; handledAt: string | null }; driverName: string | null; carrierName: string | null; orderNumber: string | null };

export function MessagesBoard({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const t = useToast();
  const [showHandled, setShowHandled] = useState(false);
  const [pending, start] = useTransition();
  const shown = rows.filter((r) => showHandled || !r.m.handledAt);
  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <input type="checkbox" className="accent-teal" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} /> Show handled
        </label>
      </div>
      {shown.length === 0 ? (
        <Empty title="No messages waiting" hint="Inbound WhatsApp lands here once the company number is connected under Settings → Integrations." />
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
                  <td className="text-muted text-[12.5px] whitespace-nowrap">{new Date(r.m.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
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
                    <div className="mono text-[12px] text-muted">+{r.m.from}</div>
                  </td>
                  <td className="text-[13px] max-w-md">{r.m.body}</td>
                  <td>
                    {r.orderNumber ? (
                      <Link href={`/orders/${r.m.orderId}`} className="font-bold mono text-teal">
                        {r.orderNumber}
                      </Link>
                    ) : (
                      <span className="text-faint">no active leg</span>
                    )}
                  </td>
                  <td className="text-right">{!r.m.handledAt && <button className="btn btn-sm" disabled={pending} onClick={() => start(async () => { const x = await markHandledAction(r.m.id); if (x.ok) { t.ok("Handled"); router.refresh(); } else t.err(x.error); })}>Handled</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
