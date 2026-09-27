"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { loadsFromTemplateAction, deleteTemplateAction } from "../actions";

type Row = { id: string; name: string; customer: string | null; stops: { type: string; name: string; city: string | null; state: string | null; country: string; dayOffset: number; from: string }[]; rateCents: number | null; currency: string; equipment: string; timesUsed: number; lastUsedAt: string | null };
const place = (s: Row["stops"][number]) => [[s.city, s.state].filter(Boolean).join(", ") || s.name, s.country !== "US" ? s.country : ""].filter(Boolean).join(" · ");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Dates from a start, for a number of weeks, on the chosen weekdays. */
export function datesFor(start: string, weeks: number, days: number[]) {
  const out: string[] = [];
  const d0 = new Date(`${start}T12:00:00Z`);
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(d0.getTime() + i * 86400_000);
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function Templates({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [bulk, setBulk] = useState<Row | null>(null);
  const [f, setF] = useState(() => ({ start: new Date(Date.now() + 86400_000).toISOString().slice(0, 10), weeks: 1, days: [1, 2, 3, 4, 5], book: true }));
  const dates = useMemo(() => datesFor(f.start, f.weeks, f.days), [f]);
  if (!rows.length)
    return (
      <div className="card p-14 text-center">
        <div className="font-bold">No templates yet</div>
        <div className="text-muted text-[13px] mt-1">
          In the{" "}
          <Link href="/orders/new" className="text-teal font-semibold">
            load builder
          </Link>
          , fill a lane you run often and press <b>Save as a template</b> — or use <b>Save as template</b> on any load.
        </div>
      </div>
    );
  return (
    <>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Customer</th>
              <th>Lane</th>
              <th>Rate</th>
              <th>Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="template-row">
                <td className="font-bold">{r.name}</td>
                <td>{r.customer ?? <span className="text-faint">—</span>}</td>
                <td className="text-[13px]">
                  {place(r.stops[0])} → {place(r.stops[r.stops.length - 1])}
                  <span className="text-muted">
                    {r.stops.length > 2 ? ` · ${r.stops.length} stops` : ""}
                    {r.stops[0].from ? ` · pickup ${r.stops[0].from}` : ""}
                  </span>
                </td>
                <td className="tabular-nums">{r.rateCents == null ? <span className="text-faint">TBD</span> : new Intl.NumberFormat("en-US", { style: "currency", currency: r.currency }).format(r.rateCents / 100)}</td>
                <td className="text-muted text-[12.5px]">{r.timesUsed ? `${r.timesUsed}× · last ${new Date(r.lastUsedAt!).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "never"}</td>
                <td className="text-right whitespace-nowrap">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setBulk(r)}>
                    Create loads
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost text-red"
                    disabled={pending}
                    onClick={() =>
                      window.confirm(`Delete the template "${r.name}"? Loads already made from it stay.`) &&
                      start(async () => {
                        const res = await deleteTemplateAction(r.id);
                        if (res.ok) {
                          t.ok("Template deleted");
                          router.refresh();
                        } else t.err(res.error);
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!bulk}
        onClose={() => setBulk(null)}
        title={`Create loads — ${bulk?.name ?? ""}`}
        footer={
          <>
            <button className="btn" onClick={() => setBulk(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !dates.length}
              onClick={() =>
                bulk &&
                start(async () => {
                  const r = await loadsFromTemplateAction(bulk.id, dates, f.book);
                  if (!r.ok) return t.err(r.error);
                  setBulk(null);
                  router.refresh();
                  if (r.data.failed.length) t.err(`Created ${r.data.created.length}; ${r.data.failed.length} failed: ${r.data.failed[0].date} — ${r.data.failed[0].error}`);
                  else t.ok(`Created ${r.data.created.length} load${r.data.created.length === 1 ? "" : "s"}: ${r.data.created.map((c) => c.orderNumber).join(", ")}`);
                })
              }
            >
              {pending ? "Creating…" : `Create ${dates.length} load${dates.length === 1 ? "" : "s"}`}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="b-start">
              First pickup date
            </label>
            <input id="b-start" type="date" className="input" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="b-weeks">
              For how many weeks
            </label>
            <select id="b-weeks" className="select" value={f.weeks} onChange={(e) => setF({ ...f, weeks: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} week{n === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <div className="label">On</div>
            <div className="flex gap-1" role="group" aria-label="Weekdays">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" aria-pressed={f.days.includes(i)} className={`flex-1 h-9 rounded-md border text-[13px] font-semibold ${f.days.includes(i) ? "bg-navy text-white border-navy" : "bg-white border-line text-muted"}`} onClick={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i] })}>
                  {w}
                </button>
              ))}
            </div>
          </div>
          <label className="col-span-2 flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" className="accent-teal w-4 h-4" checked={f.book} onChange={(e) => setF({ ...f, book: e.target.checked })} /> Book them (unticked: drafts)
          </label>
          <div className="col-span-2 text-[12.5px] text-muted" data-testid="bulk-dates">
            {dates.length ? `${dates.length} load${dates.length === 1 ? "" : "s"}: ${dates.map((d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })).join(", ")}` : "No dates — pick at least one weekday."}
          </div>
        </div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
