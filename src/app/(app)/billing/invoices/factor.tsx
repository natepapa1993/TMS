"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { factorScheduleAction } from "../actions";

type Row = { id: string; number: string; customer: string; issuedAt: string; totalCents: number; currency: string };
type Sched = { id: string; number: number; count: number; totalCents: number; currency: string; sentTo: string | null; at: string };

/** Factored invoices waiting to go to the factor, sent together on one schedule of accounts. */
export function ToFactor({ factor, rows, schedules }: { factor: string; rows: Row[]; schedules: Sched[] }) {
  const router = useRouter();
  const t = useToast();
  const [sel, setSel] = useState<string[]>(() => rows.map((r) => r.id));
  const [pending, start] = useTransition();
  const total = rows.filter((r) => sel.includes(r.id)).reduce((a, r) => a + r.totalCents, 0);
  return (
    <div className="card p-4 mb-4" data-testid="to-factor">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="font-bold">To the factor · {factor}</div>
          <div className="text-muted text-callout">Issued, factored invoices not yet on a schedule. They go together: the schedule of accounts, then each invoice with its documents.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!sel.length || pending}
          onClick={() =>
            start(async () => {
              const r = await factorScheduleAction(sel);
              if (!r.ok) return t.err(r.error);
              t.ok(`Schedule #${r.data.number} sent to ${factor}`);
              router.refresh();
            })
          }
        >
          Send schedule ({sel.length}) · {formatCents(total, rows[0]?.currency ?? "USD")}
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="text-faint text-callout">Nothing waiting.</div>
      ) : (
        <table className="table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="w-8">
                  <input type="checkbox" className="accent-teal" aria-label={`Include ${r.number}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />
                </td>
                <td className="mono font-semibold">
                  <Link href={`/billing/invoices/${r.id}`} className="hover:text-teal">
                    {r.number}
                  </Link>
                </td>
                <td>{r.customer}</td>
                <td className="text-muted text-callout">{r.issuedAt}</td>
                <td className="mono text-right">{formatCents(r.totalCents, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {schedules.length > 0 && (
        <div className="mt-3 border-t border-line pt-2 text-callout">
          <span className="text-muted">Recent schedules: </span>
          {schedules.map((s, i) => (
            <span key={s.id}>
              {i > 0 && " · "}
              <a className="text-teal font-semibold" href={`/api/invoice-batches/${s.id}`} target="_blank" rel="noreferrer">
                #{s.number}
              </a>{" "}
              {s.at} ({s.count}, {formatCents(s.totalCents, s.currency)})
            </span>
          ))}
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
