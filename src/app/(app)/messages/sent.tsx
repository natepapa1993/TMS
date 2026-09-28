"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState } from "react";
import { Modal, Pill } from "@/components/ui";

type Sent = { id: string; channel: string; to: string; subject: string | null; body: string; subjectKind: string | null; state: string; error: string | null; attempts: number; sentAt: string | null; createdAt: string };
const KIND: Record<string, string> = { tender: "Tender", packet: "Crossing packet", tracking_link: "Tracking link", driver_link: "Driver app link", carrier_driver_link: "Carrier driver link", invoice: "Invoice", edi: "EDI", digest: "Digest", password_reset: "Password reset", statement: "Statement", reminder: "Reminder", alert: "Dispatch alert", owner_weekly: "Monday numbers", compliance_digest: "Compliance digest", driver_reply: "Reply to driver", mail_reply: "Email reply" };
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { queued: "amber", sent: "green", delivered: "green", read: "green", failed: "red", logged: "slate" };
/** Messages are not tied to a stop: the company's clock, labelled. */
const when = (d: string, zone: string) => fmtWhen(d, zone, { style: "short" }) ?? "";

/** The sent log: the owner's answer to "did the carrier get the tender?" — with the state the provider reported and the text as it went. */
export function SentBoard({ rows }: { rows: Sent[] }) {
  const zone = useZone();
  const [open, setOpen] = useState<Sent | null>(null);
  return (
    <div className="mt-8" data-testid="sent-log">
      <div className="flex items-center justify-between mb-2">
        <div className="h2">Sent</div>
        <div className="text-callout text-muted">{rows.length === 0 ? "nothing yet" : `last ${rows.length}`} · logged = no sender connected, kept for the record</div>
      </div>
      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>What</th>
                <th>How</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-muted text-callout whitespace-nowrap">{when(r.createdAt, zone)}</td>
                  <td className="mono text-callout">{r.to}</td>
                  <td>
                    <div className="font-semibold text-callout">{KIND[r.subjectKind ?? ""] ?? r.subjectKind ?? "Message"}</div>
                    <div className="text-muted text-footnote truncate max-w-[360px]">{r.subject ?? r.body.slice(0, 80)}</div>
                  </td>
                  <td className="text-callout">{r.channel}</td>
                  <td>
                    <Pill tone={TONE[r.state] ?? "slate"}>{r.state}</Pill>
                    {r.error && <div className="text-red text-footnote mt-0.5 max-w-[260px] truncate" title={r.error}>{r.error}</div>}
                  </td>
                  <td className="text-right">
                    <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${KIND[open.subjectKind ?? ""] ?? "Message"} to ${open.to}` : ""} footer={<button className="btn" onClick={() => setOpen(null)}>Close</button>}>
        {open && (
          <div>
            {open.subject && <div className="font-bold mb-2">{open.subject}</div>}
            <pre className="whitespace-pre-wrap text-callout font-sans bg-ground rounded p-3 border border-line max-h-[50vh] overflow-auto" data-testid="sent-body">
              {open.body}
            </pre>
            <div className="text-footnote text-muted mt-2">
              {open.channel} · {open.state} · {open.attempts} attempt{open.attempts === 1 ? "" : "s"}
              {open.sentAt ? ` · sent ${when(open.sentAt, zone)}` : ""}
              {open.error ? ` · ${open.error}` : ""}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
