"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { zonedDate } from "@/lib/time";
import type { SettlementLine } from "@/db/schema";
import type { PayItemLedgerRow } from "@/domain/billing";
import { buildSettlementAction, settlementTransitionAction, addSettlementLineAction, addPayItemAction, settlementRunAction, approveSettlementsAction, paySettlementsAction } from "../actions";

type Row = { st: { id: string; driverId: string; periodStart: string; periodEnd: string; state: string; lines: SettlementLine[]; grossCents: number; deductionsCents: number; netCents: number; method: string | null; reference: string | null }; driverName: string };
type Driver = { id: string; name: string; payType: string; payRateCents: number | null };
const TONE: Record<string, "slate" | "teal" | "amber" | "green"> = { open: "slate", reviewed: "amber", approved: "teal", paid: "green" };

export function Settlements({ rows, drivers, defaultWeek, role, ledger = [], now, timeZone = "America/Chicago" }: { rows: Row[]; drivers: Driver[]; defaultWeek: string; role: string; ledger?: PayItemLedgerRow[]; now?: string; timeZone?: string }) {
  // the last day of a statement's week, in the company's zone (the week ends at midnight starting the next Sunday)
  const lastDay = (end: string) => zonedDate(new Date(new Date(end).getTime() - 1), timeZone);
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [driverId, setDriverId] = useState(drivers[0]?.id ?? "");
  const [week, setWeek] = useState(defaultWeek);
  const [open, setOpen] = useState<Row | null>(null);
  const [line, setLine] = useState({ kind: "accessorial" as "accessorial" | "deduction" | "reimbursement" | "adjustment", description: "", amount: "" });
  const [item, setItem] = useState<{ open: boolean; kind: "deduction" | "reimbursement" | "advance" | "escrow"; description: string; amount: string; recurring: boolean; remaining: string; target: string }>({ open: false, kind: "deduction", description: "", amount: "", recurring: false, remaining: "", target: "" });
  const [pay, setPay] = useState({ method: "ach", reference: "" });
  const [sel, setSel] = useState<string[]>([]);
  const [batchPay, setBatchPay] = useState<{ method: string; reference: string } | null>(null);
  const [early, setEarly] = useState("");
  const [nowMs] = useState(() => (now ? new Date(now).getTime() : Date.now()));
  const unfinished = (r: Row) => new Date(r.st.periodEnd).getTime() > nowMs;
  const blockers = (r: Row) => r.st.lines.filter((l) => l.blocker).map((l) => l.blocker!);
  const toggle = (id: string, on: boolean) => setSel((x) => (on ? [...x, id] : x.filter((y) => y !== id)));
  const selRows = rows.filter((r) => sel.includes(r.st.id));
  const can = ["owner", "billing"].includes(role);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  const cur = open ? (rows.find((r) => r.st.id === open.st.id) ?? open) : null;
  return (
    <>
      {can && (
        <div className="card p-4 mb-4 flex items-end gap-3">
          <div>
            <label className="label">Driver</label>
            <select className="select w-56" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.payType.replace("_", " ")} {d.payRateCents != null ? (d.payType === "pct" ? `${d.payRateCents / 100}%` : formatCents(d.payRateCents)) : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Week starting (Sunday)</label>
            <input type="date" className="input" value={week} onChange={(e) => setWeek(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={!driverId || !week || pending} onClick={() => run("Statement built", () => buildSettlementAction(driverId, week))}>
            Build statement
          </button>
          <button className="btn" disabled={!driverId} onClick={() => setItem({ ...item, open: true })}>
            + Pay item (deduction, advance, escrow)
          </button>
          <button
            className="btn btn-primary ml-auto"
            disabled={!week || pending}
            data-testid="run-week"
            title="Every driver who ran a leg that week, or has a pay item due"
            onClick={() =>
              start(async () => {
                const r = await settlementRunAction(week);
                if (!r.ok) return t.err(r.error);
                const built = r.data.filter((x) => x.state === "open").length;
                const errs = r.data.filter((x) => x.state === "error");
                const skipped = r.data.filter((x) => x.state === "skipped");
                const done = r.data.length - built - errs.length - skipped.length;
                const kept = r.data.filter((x) => x.keptManual);
                t.ok(r.data.length ? `${built} statement${built === 1 ? "" : "s"} built${done ? `, ${done} already approved or paid` : ""}${kept.length ? ` · kept the lines added by hand: ${kept.map((x) => `${x.driver} (${x.keptManual})`).join(", ")}` : ""}${skipped.length ? ` · no pay this week (deductions wait): ${skipped.map((x) => x.driver).join(", ")}` : ""}${errs.length ? ` · ${errs.length} failed: ${errs.map((x) => `${x.driver} (${x.note})`).join("; ")}` : ""}` : "Nobody ran a leg that week");
                router.refresh();
              })
            }
          >
            Run the week for all drivers
          </button>
        </div>
      )}
      {can && sel.length > 0 && (
        <div className="flex items-center gap-2 mb-3" data-testid="settlement-bulk">
          <span className="text-callout font-semibold">
            {sel.length} selected · net {formatCents(selRows.reduce((a, r) => a + r.st.netCents, 0))}
          </span>
          <button className="btn btn-sm" disabled={pending || !selRows.some((r) => r.st.state === "open" || r.st.state === "reviewed")} onClick={() => start(async () => { const r = await approveSettlementsAction(sel); if (!r.ok) return t.err(r.error); t.ok(`${r.data.approved} approved${r.data.skipped.length ? ` · ${r.data.skipped.length} skipped (${r.data.skipped.map((x) => x.reason).join("; ")})` : ""}`); setSel([]); router.refresh(); })}>
            Approve selected
          </button>
          <button className="btn btn-sm btn-primary" disabled={pending || !selRows.some((r) => r.st.state === "approved")} onClick={() => setBatchPay({ method: "ach", reference: "" })}>
            Pay selected
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSel([])}>
            Clear
          </button>
        </div>
      )}
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center font-bold">No statements yet</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                {can && (
                  <th className="w-8">
                    <input type="checkbox" className="accent-teal" aria-label="Select all not paid" checked={sel.length > 0 && sel.length === rows.filter((r) => r.st.state !== "paid").length} onChange={(e) => setSel(e.target.checked ? rows.filter((r) => r.st.state !== "paid").map((r) => r.st.id) : [])} />
                  </th>
                )}
                <th>Driver</th>
                <th>Week</th>
                <th>Lines</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.st.id} className="cursor-pointer" onClick={() => setOpen(r)} data-testid="settlement-row">
                  {can && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.st.state !== "paid" && <input type="checkbox" className="accent-teal" aria-label={`Select ${r.driverName}`} checked={sel.includes(r.st.id)} onChange={(e) => toggle(r.st.id, e.target.checked)} />}
                    </td>
                  )}
                  <td className="font-bold">{r.driverName}</td>
                  <td className="text-callout">
                    {zonedDate(new Date(r.st.periodStart), timeZone)}
                    {r.st.state !== "paid" && r.st.state !== "approved" && unfinished(r) && <div className="text-footnote text-muted">week in progress</div>}
                  </td>
                  <td className="text-muted">
                    {r.st.lines.length}
                    {r.st.lines.some((l) => l.disputed) && <Pill tone="red">dispute</Pill>}
                    {blockers(r).length > 0 && r.st.state !== "paid" && (
                      <span title={blockers(r).join("\n")}>
                        <Pill tone="red">no miles</Pill>
                      </span>
                    )}
                    {r.st.lines.some((l) => l.shortCents) && (
                      <span title="Some deductions didn't fit: net pay stays at $0 or more and the rest carries to next week">
                        <Pill tone="amber">carries over</Pill>
                      </span>
                    )}
                  </td>
                  <td className="mono">{formatCents(r.st.grossCents)}</td>
                  <td className="mono text-muted">{r.st.deductionsCents ? `-${formatCents(r.st.deductionsCents)}` : "—"}</td>
                  <td className="mono font-extrabold">{formatCents(r.st.netCents)}</td>
                  <td>
                    <Pill tone={TONE[r.st.state]}>{r.st.state}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cur && (
        <Modal
          open
          onClose={() => setOpen(null)}
          wide
          title={`${cur.driverName} · week of ${zonedDate(new Date(cur.st.periodStart), timeZone)}`}
          footer={
            can ? (
              <>
                <a className="btn mr-auto" href={`/api/settlements/${cur.st.id}/pdf`} target="_blank" rel="noreferrer">
                  PDF
                </a>
                {cur.st.state === "open" && <button className="btn btn-primary" onClick={() => run("Reviewed", () => settlementTransitionAction(cur.st.id, "reviewed"))}>Mark reviewed</button>}
                {cur.st.state === "reviewed" && <button className="btn" onClick={() => run("Back to open", () => settlementTransitionAction(cur.st.id, "open"))}>Back to open</button>}
                {cur.st.state === "reviewed" && !unfinished(cur) && (
                  <button className="btn btn-primary" disabled={blockers(cur).length > 0} title={blockers(cur).join("\n") || undefined} onClick={() => run("Approved — the driver can see it", () => settlementTransitionAction(cur.st.id, "approved"))}>
                    Approve
                  </button>
                )}
                {cur.st.state === "reviewed" && unfinished(cur) && role === "owner" && (
                  <>
                    <input className="input w-56" placeholder="why pay before the week ends" aria-label="Reason to approve early" value={early} onChange={(e) => setEarly(e.target.value)} />
                    <button className="btn btn-primary" disabled={!early.trim() || blockers(cur).length > 0} onClick={() => run("Approved early — the driver can see it", async () => { const r = await settlementTransitionAction(cur.st.id, "approved", undefined, undefined, early); if (r.ok) setEarly(""); return r; })}>
                      Approve early
                    </button>
                  </>
                )}
                {cur.st.state === "approved" && (
                  <>
                    <button className="btn" onClick={() => run("Back to reviewed", () => settlementTransitionAction(cur.st.id, "reviewed"))}>Back to reviewed</button>
                    <select className="select w-28" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                      {["ach", "check", "cash", "other"].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    <input className="input w-36" placeholder="reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                    <button className="btn btn-primary" onClick={() => run("Paid", () => settlementTransitionAction(cur.st.id, "paid", pay.method, pay.reference))}>Mark paid</button>
                  </>
                )}
              </>
            ) : undefined
          }
        >
          {cur.st.state !== "paid" && cur.st.state !== "approved" && (unfinished(cur) || blockers(cur).length > 0) && (
            <div className="rounded-lg bg-amber-soft text-amber px-3 py-2 text-callout font-semibold mb-3" data-testid="settlement-blockers">
              {[...(unfinished(cur) ? [`The week isn't over (its last day is ${lastDay(cur.st.periodEnd)}): approve it after, so a late leg still makes it on.${role === "owner" ? " To pay early (a final check), approve early with a reason." : ""}`] : []), ...blockers(cur)].map((b) => (
                <div key={b}>{b}</div>
              ))}
            </div>
          )}
          <div className="-mx-5 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Source</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {cur.st.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="font-semibold">{l.description}</span>
                      {l.disputed && <div className="text-footnote text-red">Driver disputes: {l.disputed}</div>}
                      {l.blocker && <div className="text-footnote text-red">{l.blocker}</div>}
                      {!!l.shortCents && <div className="text-footnote text-amber">{formatCents(l.shortCents)} didn&rsquo;t fit this week: net pay never goes below $0</div>}
                    </td>
                    <td className="text-muted text-callout">{l.source}</td>
                    <td className={`mono text-right font-semibold ${l.amountCents < 0 ? "text-red" : ""}`}>{formatCents(l.amountCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} className="text-right font-extrabold">
                    Net pay
                  </td>
                  <td className="mono text-right font-extrabold text-headline">{formatCents(cur.st.netCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {can && (cur.st.state === "open" || cur.st.state === "reviewed") && (
            <div className="mt-3 grid grid-cols-[130px_1fr_120px_auto] gap-2 items-end">
              <div>
                <label className="label">Add line</label>
                <select className="select" value={line.kind} onChange={(e) => setLine({ ...line, kind: e.target.value as typeof line.kind })}>
                  <option value="accessorial">Accessorial pay</option>
                  <option value="reimbursement">Reimbursement</option>
                  <option value="deduction">Deduction</option>
                  <option value="adjustment">Adjustment</option>
                </select>
              </div>
              <div>
                <label className="label">Description</label>
                <input className="input" value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} />
              </div>
              <div>
                <label className="label">Amount</label>
                <input className="input" inputMode="decimal" value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} />
              </div>
              <button className="btn" disabled={!line.description || !line.amount} onClick={() => run("Line added", async () => { const r = await addSettlementLineAction(cur.st.id, line.kind, line.description, line.amount); if (r.ok) setLine({ ...line, description: "", amount: "" }); return r; })}>
                Add
              </button>
            </div>
          )}
        </Modal>
      )}
      <Modal open={item.open} onClose={() => setItem({ ...item, open: false })} title={`Pay item · ${drivers.find((d) => d.id === driverId)?.name ?? ""}`} footer={<><button className="btn" onClick={() => setItem({ ...item, open: false })}>Cancel</button><button className="btn btn-primary" disabled={!item.description || !(item.amount || (item.kind === "advance" && item.remaining))} onClick={() => run("Pay item added — it lands on the next statement", async () => { const r = await addPayItemAction(driverId, item); if (r.ok) setItem({ ...item, open: false, description: "", amount: "", remaining: "", target: "" }); return r; })}>Add</button></>}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Kind</label>
            <select className="select" value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value as typeof item.kind })} aria-label="Pay item kind">
              <option value="deduction">Deduction (fuel card, insurance, trailer rent)</option>
              <option value="advance">Advance (taken back from the next statements)</option>
              <option value="escrow">Escrow (held each statement up to a target)</option>
              <option value="reimbursement">Reimbursement (tolls, scale, repairs)</option>
            </select>
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} />
          </div>
          {item.kind === "advance" && (
            <div>
              <label className="label">Amount advanced</label>
              <input className="input" inputMode="decimal" value={item.remaining} onChange={(e) => setItem({ ...item, remaining: e.target.value })} aria-label="Amount advanced" placeholder="e.g. 400.00" />
            </div>
          )}
          <div>
            <label className="label">{item.kind === "advance" ? "Take back per statement" : "Amount per statement"}</label>
            <input className="input" inputMode="decimal" value={item.amount} onChange={(e) => setItem({ ...item, amount: e.target.value })} aria-label="Pay item amount" placeholder={item.kind === "advance" ? "blank = all of it next statement" : undefined} />
          </div>
          {item.kind === "advance" ? (
            <div />
          ) : item.kind === "escrow" ? (
            <div>
              <label className="label">Hold up to</label>
              <input className="input" inputMode="decimal" value={item.target} onChange={(e) => setItem({ ...item, target: e.target.value })} placeholder="e.g. 2500.00" aria-label="Escrow target" />
            </div>
          ) : item.kind === "deduction" ? (
            <div>
              <label className="label">Total to recover</label>
              <input className="input" inputMode="decimal" value={item.remaining} onChange={(e) => setItem({ ...item, remaining: e.target.value })} placeholder="blank = no end" />
            </div>
          ) : (
            <div />
          )}
          {(item.kind === "deduction" || item.kind === "reimbursement") && (
            <label className="col-span-2 flex items-center gap-2 text-callout">
              <input type="checkbox" className="accent-teal" checked={item.recurring} onChange={(e) => setItem({ ...item, recurring: e.target.checked })} /> Recurring every statement
            </label>
          )}
        </div>
      </Modal>
      <PayItems ledger={ledger} />
      {batchPay && (
        <Modal
          open
          onClose={() => setBatchPay(null)}
          title={`Pay ${selRows.filter((r) => r.st.state === "approved").length} approved statement(s)`}
          footer={
            <>
              <button className="btn" onClick={() => setBatchPay(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await paySettlementsAction(sel, batchPay.method, batchPay.reference);
                    if (!r.ok) return t.err(r.error);
                    setBatchPay(null);
                    setSel([]);
                    t.ok(`${r.data.paid} paid · ${formatCents(r.data.totalCents)}`);
                    router.refresh();
                  })
                }
              >
                Mark paid
              </button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="bp-method">
                Paid by
              </label>
              <select id="bp-method" className="select" value={batchPay.method} onChange={(e) => setBatchPay({ ...batchPay, method: e.target.value })}>
                {["ach", "check", "cash", "other"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="bp-ref">
                Batch reference
              </label>
              <input id="bp-ref" className="input" value={batchPay.reference} onChange={(e) => setBatchPay({ ...batchPay, reference: e.target.value })} placeholder="ACH batch 0926" />
            </div>
          </div>
          <div className="help mt-2">Only approved statements are paid. Advances and escrow update, and each driver sees the statement as paid (with its PDF) in the app.</div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

const KIND_LABEL: Record<string, string> = { advance: "Advance", deduction: "Deduction", escrow: "Escrow", reimbursement: "Reimbursement" };

/** Every driver's pay items with balances: what there was, what statements took, what's left, escrow held. */
function PayItems({ ledger }: { ledger: PayItemLedgerRow[] }) {
  if (!ledger.length) return null;
  return (
    <div className="card overflow-hidden mt-5" data-testid="pay-items">
      <div className="px-5 pt-4 pb-2">
        <div className="text-headline font-extrabold">Pay items</div>
        <div className="text-callout text-muted">Advances, deductions and escrow with their balances. Recovered counts paid statements only; a statement not paid yet shows as pending.</div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Driver</th>
            <th>Item</th>
            <th>Each statement</th>
            <th>Original</th>
            <th>Recovered</th>
            <th>Remaining / held</th>
            <th>Weeks</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((r) => (
            <tr key={r.id} data-testid="pay-item-row">
              <td className="font-semibold">{r.driverName}</td>
              <td>
                {r.description}
                <div className="text-footnote text-muted">
                  {KIND_LABEL[r.kind] ?? r.kind}
                  {r.recurring ? " · every statement" : ""}
                  {r.carriedFrom ? " · carried from last week" : ""}
                  {!r.active ? " · done" : ""}
                </div>
              </td>
              <td className="mono">{formatCents(r.perStatementCents)}</td>
              <td className="mono">{r.originalCents != null ? formatCents(r.originalCents) : r.kind === "escrow" && r.targetCents ? `up to ${formatCents(r.targetCents)}` : "—"}</td>
              <td className="mono">{formatCents(r.recoveredCents)}</td>
              <td className="mono font-semibold">{r.kind === "escrow" ? `${formatCents(r.heldCents ?? 0)} held` : r.remainingCents != null ? formatCents(r.remainingCents) : "ongoing"}</td>
              <td className="text-footnote text-muted">
                {r.history.length
                  ? r.history.map((h) => `${h.week}: ${formatCents(h.cents)}${h.state !== "paid" ? ` (${h.state})` : ""}${h.shortCents ? `, ${formatCents(h.shortCents)} short` : ""}`).join(" · ")
                  : "not on a statement yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
