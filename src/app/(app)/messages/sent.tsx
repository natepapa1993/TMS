"use client";

import { useState } from "react";
import { Modal, Pill } from "@/components/ui";

type Sent = { id: string; channel: string; to: string; subject: string | null; body: string; subjectKind: string | null; state: string; error: string | null; attempts: number; sentAt: string | null; createdAt: string };
const KIND: Record<string, string> = { tender: "Tender", packet: "Crossing packet", tracking_link: "Tracking link", driver_link: "Driver app link", invoice: "Invoice", edi: "EDI", digest: "Digest", password_reset: "Password reset", statement: "Statement", reminder: "Reminder", alert: "Dispatch alert", owner_weekly: "Monday numbers", compliance_digest: "Compliance digest" };
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { queued: "amber", sent: "green", delivered: "green", read: "green", failed: "red", logged: "slate" };
const when = (d: string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The sent log: the owner's answer to "did the carrier get the tender?" — with the state the provider reported and the text as it went. */
export function SentBoard({ rows }: { rows: Sent[] }) {
  const [open, setOpen] = useState<Sent | null>(null);
  return (
    <div className="mt-8" data-testid="sent-log">
      <div className="flex items-center justify-between mb-2">
        <div className="h2">Sent</div>
        <div className="text-[12.5px] text-muted">{rows.length === 0 ? "nothing yet" : `last ${rows.length}`} · logged = no sender connected, kept for the record</div>
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
                  <td className="text-muted text-[12.5px] whitespace-nowrap">{when(r.createdAt)}</td>
                  <td className="mono text-[12.5px]">{r.to}</td>
                  <td>
                    <div className="font-semibold text-[13px]">{KIND[r.subjectKind ?? ""] ?? r.subjectKind ?? "Message"}</div>
                    <div className="text-muted text-[12px] truncate max-w-[360px]">{r.subject ?? r.body.slice(0, 80)}</div>
                  </td>
                  <td className="text-[12.5px]">{r.channel}</td>
                  <td>
                    <Pill tone={TONE[r.state] ?? "slate"}>{r.state}</Pill>
                    {r.error && <div className="text-red text-[11.5px] mt-0.5 max-w-[260px] truncate" title={r.error}>{r.error}</div>}
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
            <pre className="whitespace-pre-wrap text-[12.5px] font-sans bg-ground rounded p-3 border border-line max-h-[50vh] overflow-auto" data-testid="sent-body">
              {open.body}
            </pre>
            <div className="text-[12px] text-muted mt-2">
              {open.channel} · {open.state} · {open.attempts} attempt{open.attempts === 1 ? "" : "s"}
              {open.sentAt ? ` · sent ${when(open.sentAt)}` : ""}
              {open.error ? ` · ${open.error}` : ""}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
