"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Toast, useToast } from "@/components/ui";
import type { ComplianceItem } from "@/db/schema";
import type { SubjectKind } from "@/domain/compliance";
import { snoozeAction, overrideDispatchAction } from "./actions";

type Row = { id: string; label: string; sub: string; st: { dispatchable: boolean; expired: string[]; expiring: string[]; missing: string[]; items: ComplianceItem[]; ranAt: string } | null; override: { reason: string; expiresAt: string } | null };

const tone: Record<string, string> = { ok: "pill-green", expiring: "pill-amber", expired: "pill-red", missing: "pill-amber", snoozed: "pill-slate" };

export function ComplianceTable({ kind, path, columns, rows, role }: { kind: SubjectKind; path: string; columns: { key: string; label: string; blocks: boolean }[]; rows: Row[]; role: string }) {
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
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/settings/${path}/${r.id}#documents`} className="font-bold hover:text-teal">
                  {r.label}
                </Link>
                <div className="text-[12px] text-muted">{r.sub}</div>
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
                      {canEdit && role === "owner" && (
                        <button className="btn btn-ghost btn-sm ml-1 text-[11.5px]" onClick={() => setOverrideFor(r)}>
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
                const it = r.st?.items.find((i) => i.key === c.key);
                return (
                  <td key={c.key}>
                    {it ? (
                      <div className="flex items-center gap-1">
                        <Link href={`/settings/${path}/${r.id}#documents`} className={`pill ${tone[it.status]}`} title={it.snoozeReason ?? undefined}>
                          {it.expiresAt ? new Date(it.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : it.status}
                        </Link>
                        {canEdit && (it.status === "expiring" || it.status === "missing") && (
                          <button className="btn btn-ghost btn-sm text-[11px] px-1" title="Snooze this alert" onClick={() => setSnoozeFor({ id: r.id, key: it.key, label: `${r.label} · ${it.label}` })}>
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
                setSnoozeFor(null);
                if (r.ok) {
                  t.ok("Snoozed");
                  router.refresh();
                } else t.err(r.error);
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
            <label className="label">Reason</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="renewal in progress" />
          </div>
        </div>
        <div className="help mt-2">The alert hides until then; the record still shows the real date. Up to 90 days.</div>
      </Modal>
      <Confirm open={!!overrideFor} onClose={() => setOverrideFor(null)} title={`Dispatch override · ${overrideFor?.label ?? ""}`} body={<span>Blocked by: {[...(overrideFor?.st?.expired.map((x) => `${x} expired`) ?? []), ...(overrideFor?.st?.missing.map((x) => `${x} missing`) ?? [])].join(", ")}. The override lasts 24 hours and is logged with your name. Expired legal documents cannot be overridden.</span>} needReason="Reason" confirmLabel="Override for 24 h" danger onConfirm={async (reason) => { const row = overrideFor!; setOverrideFor(null); const r = await overrideDispatchAction(kind, row.id, reason); if (r.ok) { t.ok("Override active for 24 h"); router.refresh(); } else t.err(r.error); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
