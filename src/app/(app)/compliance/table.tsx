"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Toast, useToast } from "@/components/ui";
import type { ComplianceItem } from "@/db/schema";
import type { SubjectKind } from "@/domain/compliance";
import { snoozeAction, overrideDispatchAction, unsnoozeAction, missingDatesBlockAction } from "./actions";

type Row = { id: string; label: string; sub: string; st: { dispatchable: boolean; expired: string[]; expiring: string[]; missing: string[]; items: ComplianceItem[]; ranAt: string } | null; override: { reason: string; expiresAt: string } | null };

const tone: Record<string, string> = { ok: "pill-green", expiring: "pill-amber", expired: "pill-red", missing: "pill-amber", snoozed: "pill-slate", na: "pill-slate" };

export function ComplianceTable({ kind, path, columns, rows, role }: { kind: SubjectKind; path: string; columns: { key: string; label: string; blocks: boolean; sub?: string }[]; rows: Row[]; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [snoozeFor, setSnoozeFor] = useState<{ id: string; key: string; label: string } | null>(null);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [overrideFor, setOverrideFor] = useState<Row | null>(null);
  const canEdit = ["owner", "compliance"].includes(role);
  if (!rows.length) return null;
  return (
    <div className="card overflow-auto">
      <table className="table">
        <thead>
          <tr>
            <th>{kind}</th>
            <th>Status</th>
            {columns.map((c) => (
              <th key={c.key} title={c.blocks ? "blocks dispatch" : ""}>
                {c.label}
                {c.blocks ? " •" : ""}
                {c.sub && <div className="normal-case tracking-normal font-semibold text-caption text-faint">{c.sub}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/settings/${path}/${r.id}#documents`} className="font-bold hover:text-teal whitespace-nowrap">
                  {r.label}
                </Link>
                <div className="text-footnote text-muted">{r.sub}</div>
              </td>
              <td>
                {r.st ? (
                  r.st.dispatchable ? (
                    r.override ? (
                      <span className="pill pill-amber" title={r.override.reason}>
                        override
                      </span>
                    ) : (
                      <span className="pill pill-green">dispatchable</span>
                    )
                  ) : (
                    <div>
                      <span className="pill pill-red">blocked</span>
                      {canEdit && (
                        <button className="btn btn-ghost btn-sm ml-1 text-footnote" onClick={() => setOverrideFor(r)}>
                          24h override
                        </button>
                      )}
                    </div>
                  )
                ) : (
                  <span className="text-faint">not run</span>
                )}
              </td>
              {columns.map((c) => {
                if (c.key === "dq:*") return <td key={c.key}><DqCell id={r.id} items={r.st?.items ?? []} /></td>;
                if (c.key === "da:status") {
                  const hold = r.st?.items.find((i) => i.key === "da:status");
                  return <td key={c.key}>{hold?.status === "expired" ? <span className="pill pill-red" title="Off safety-sensitive work — ask Safety">hold</span> : <span className="text-faint">—</span>}</td>;
                }
                const it = r.st?.items.find((i) => i.key === c.key);
                return (
                  <td key={c.key}>
                    {it ? (
                      <div className="flex items-center gap-1">
                        <Link href={`/settings/${path}/${r.id}#documents`} className={`pill ${tone[it.status]}`} title={it.snoozeReason ?? undefined}>
                          {it.expiresAt ? new Date(it.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : it.status === "na" ? "not on file" : it.status}
                        </Link>
                        {canEdit && it.status === "snoozed" && (
                          <button className="btn btn-ghost btn-sm text-caption px-1" title={`Snoozed until ${it.snoozedUntil?.slice(0, 10)} (${it.snoozeReason ?? ""}) — end the snooze`} onClick={async () => { const res = await unsnoozeAction(kind, r.id, it.key); if (res.ok) { t.ok("Snooze ended"); router.refresh(); } else t.err(res.error); }}>
                            wake
                          </button>
                        )}
                        {canEdit && (it.status === "expiring" || it.status === "missing" || it.status === "expired") && (
                          <button className="btn btn-ghost btn-sm text-caption px-1" title="Snooze this alert" onClick={() => setSnoozeFor({ id: r.id, key: it.key, label: `${r.label} · ${it.label}` })}>
                            zz
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Modal
        open={!!snoozeFor}
        onClose={() => setSnoozeFor(null)}
        title={`Snooze · ${snoozeFor?.label ?? ""}`}
        footer={
          <>
            <button className="btn" onClick={() => setSnoozeFor(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!until || !reason.trim()}
              onClick={async () => {
                const r = await snoozeAction(kind, snoozeFor!.id, snoozeFor!.key, until, reason);
                if (!r.ok) return t.err(r.error); // keep the dialog and what was typed
                setSnoozeFor(null);
                setUntil("");
                setReason("");
                t.ok("Snoozed — the reminder is quiet; a block stays");
                router.refresh();
              }}
            >
              Snooze
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Until</label>
            <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div>
            <label className="label">Reason (required)</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="renewal in progress" />
          </div>
        </div>
        <div className="help mt-2">The reminder goes quiet until then — it does not make anyone dispatchable: an expired or missing item that blocks still blocks. To let a blocked driver or unit run, use a 24-hour override. Up to 90 days.</div>
      </Modal>
      <Confirm open={!!overrideFor} onClose={() => setOverrideFor(null)} title={`Dispatch override · ${overrideFor?.label ?? ""}`} body={<span>Blocked by: {[...(overrideFor?.st?.expired.map((x) => `${x} expired`) ?? []), ...(overrideFor?.st?.missing.map((x) => `${x} missing`) ?? [])].join(", ")}. The override lasts 24 hours and is logged with your name. Expired legal documents cannot be overridden.</span>} needReason="Reason" confirmLabel="Override for 24 h" danger onConfirm={async (reason) => { const row = overrideFor!; setOverrideFor(null); const r = await overrideDispatchAction(kind, row.id, reason); if (r.ok) { t.ok("Override active for 24 h"); router.refresh(); } else t.err(r.error); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

/** The qualification file in one cell: complete, or how many items are missing / overdue / due, linking to the driver's file. */
function DqCell({ id, items }: { id: string; items: ComplianceItem[] }) {
  const dq = items.filter((i) => i.key.startsWith("dq:"));
  if (!dq.length) return <span className="text-faint">—</span>;
  const n = (st: string) => dq.filter((i) => (i.status === "snoozed" ? i.underlying : i.status) === st).length;
  const missing = n("missing");
  const overdue = n("expired");
  const due = n("expiring");
  const text = missing || overdue ? [missing && `${missing} missing`, overdue && `${overdue} overdue`].filter(Boolean).join(", ") : due ? `${due} due soon` : "complete";
  return (
    <Link href={`/compliance/drivers/${id}`} className={`pill ${missing || overdue ? "pill-amber" : due ? "pill-amber" : "pill-green"}`} data-testid="dq-cell">
      {text}
    </Link>
  );
}

/** Safety's switch: blank required dates block dispatch, or not yet. */
export function MissingDatesToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className={`btn btn-sm ${on ? "" : "btn-primary"}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await missingDatesBlockAction(!on);
          setBusy(false);
          if (!r.ok) return t.err(r.error);
          t.ok(on ? "Blank dates no longer block" : `Blank dates now block dispatch — ${r.data.blocked} blocked`);
          router.refresh();
        }}
      >
        {on ? "Stop blocking blank dates" : "Block dispatch on blank dates"}
      </button>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
