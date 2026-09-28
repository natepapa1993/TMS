"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Pill, Toast, useToast } from "@/components/ui";
import { useClock } from "@/components/zone";
import { approveOverrideAction, rejectOverrideAction, overrideApprovalSettingAction } from "./actions";

type Row = { id: string; kind: string; kindLabel: string; state: "pending" | "applied"; title: string; reason: string; who: string; at: string; href: string | null; orderNumber: string | null };

/** The owner's approvals (owner #18): overrides others made or asked for, with Approve / Reject. */
export function Approvals({ rows, needOwner }: { rows: Row[]; needOwner: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const t = useToast();
  const [pending, start] = useTransition();
  const [reject, setReject] = useState<Row | null>(null);
  const waiting = rows.filter((r) => r.state === "pending").length;
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <section aria-label="Approvals" data-testid="approvals">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="eyebrow">Approvals{rows.length ? ` · ${rows.length}` : ""}</div>
        <label className="ml-auto flex items-center gap-2 text-footnote text-muted cursor-pointer" title="Off: an override takes effect at once and waits here for your review. On: it is only a request until you approve it.">
          <input type="checkbox" className="accent-teal" checked={needOwner} disabled={pending} onChange={(e) => run(e.target.checked ? "Overrides now wait for you" : "Overrides take effect at once again", () => overrideApprovalSettingAction(e.target.checked))} data-testid="override-approval-setting" />
          Overrides need my approval first
        </label>
      </div>
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-muted text-callout">Nothing to approve. {needOwner ? "When someone overrides a block, it waits here for you." : "Overrides your team makes show up here for you to review."}</div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3 flex items-start gap-3 flex-wrap sm:flex-nowrap" data-testid="approval-row">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Pill tone={r.state === "pending" ? "amber" : "slate"}>{r.state === "pending" ? "Waiting for you" : "Done — review"}</Pill>
                    <Pill tone={r.kind === "paperwork" ? "red" : r.kind === "schedule" ? "amber" : "slate"}>{r.kindLabel}</Pill>
                    {r.href ? (
                      <Link href={r.href} className="font-semibold text-callout hover:text-teal break-words">
                        {r.title}
                      </Link>
                    ) : (
                      <span className="font-semibold text-callout break-words">{r.title}</span>
                    )}
                  </div>
                  <div className="text-footnote text-muted mt-1">
                    {r.who} · {clock.at(r.at, { style: "short" })} · <span className="italic">“{r.reason}”</span>
                  </div>
                </div>
                <div className="flex gap-2 flex-none">
                  <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(r.state === "pending" ? "Approved — done now" : "Reviewed", () => approveOverrideAction(r.id))}>
                    Approve
                  </button>
                  <button className="btn btn-sm" disabled={pending} onClick={() => setReject(r)}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {waiting > 0 && <div className="text-footnote text-muted mt-1.5">{waiting === 1 ? "1 request is" : `${waiting} requests are`} on hold until you decide.</div>}
      <Confirm
        open={!!reject}
        onClose={() => setReject(null)}
        title="Reject this override?"
        body={reject ? (reject.state === "applied" ? `${reject.title}. It is undone: the block or the check is open again, and ${reject.who} gets your note.` : `${reject.title}. Nothing was changed; ${reject.who} gets your note.`) : null}
        needReason="Why (they see this)"
        confirmLabel="Reject"
        danger
        onConfirm={async (note) => {
          const id = reject!.id;
          setReject(null);
          run("Rejected — they've been told", () => rejectOverrideAction(id, note));
        }}
      />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </section>
  );
}
