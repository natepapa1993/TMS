"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import type { PayRule, PayRuleKind } from "@/db/schema";
import { legPayLines, statementExtras, RULE_LABEL, isPct } from "@/domain/pay-plans-pure";
import { savePlanAction, deletePlanAction, assignPlanAction, releaseEscrowAction } from "../actions";

type Plan = { id: string; name: string; rules: PayRule[]; teamSplit: string; minimumCents: number | null; perDiemCents: number | null; notes: string | null };
type Driver = { id: string; name: string; payPlanId: string | null; payType: string; payRateCents: number | null };
const LEG_TYPES: [string, string][] = [
  ["domestic", "Domestic"],
  ["us", "US"],
  ["mx", "Mexico"],
  ["ca", "Canada"],
  ["crossing", "Crossing"],
];
const EQUIPMENT: [string, string][] = [
  ["53_dry", "53' dry"],
  ["53_reefer", "53' reefer"],
  ["48_dry", "48' dry"],
  ["flatbed", "Flatbed"],
  ["sprinter", "Sprinter"],
  ["straight", "Straight"],
  ["power_only", "Power only"],
];
const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const amountText = (r: PayRule) => (isPct(r.kind) ? `${r.amount / 100}%` : r.kind.includes("mile") ? `${money(r.amount)} / mi` : r.kind === "hourly" ? `${money(r.amount)} / h` : r.kind.includes("stop") ? `${money(r.amount)} / stop` : money(r.amount));
const whenText = (r: PayRule, customers: { id: string; name: string }[]) => {
  const w = r.when ?? {};
  const parts = [w.legTypes?.length ? w.legTypes.map((t) => LEG_TYPES.find(([v]) => v === t)?.[1] ?? t).join("/") + " legs" : "", w.customerIds?.length ? w.customerIds.map((c) => customers.find((x) => x.id === c)?.name ?? "?").join(", ") : "", w.equipment?.length ? w.equipment.map((e) => EQUIPMENT.find(([v]) => v === e)?.[1] ?? e).join("/") : "", w.minMiles != null ? `≥ ${w.minMiles} mi` : "", w.maxMiles != null ? `≤ ${w.maxMiles} mi` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "every leg";
};

type Draft = { id: string | null; name: string; teamSplit: string; minimum: string; perDiem: string; notes: string; rules: (PayRule & { amountText: string })[] };
const blankRule = (): PayRule & { amountText: string } => ({ id: `r${Math.random().toString(36).slice(2, 8)}`, kind: "per_loaded_mile", amount: 0, amountText: "", when: {} });
const toDraft = (p?: Plan): Draft =>
  p
    ? { id: p.id, name: p.name, teamSplit: p.teamSplit, minimum: p.minimumCents != null ? (p.minimumCents / 100).toFixed(2) : "", perDiem: p.perDiemCents != null ? (p.perDiemCents / 100).toFixed(2) : "", notes: p.notes ?? "", rules: p.rules.map((r) => ({ ...r, amountText: isPct(r.kind) ? String(r.amount / 100) : (r.amount / 100).toFixed(2) })) }
    : { id: null, name: "", teamSplit: "half", minimum: "", perDiem: "", notes: "", rules: [blankRule()] };
const ruleAmount = (r: { kind: PayRuleKind; amountText: string }) => {
  const n = Number(r.amountText.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

type Escrow = { id: string; driver: string; description: string; amountCents: number; targetCents: number | null; balanceCents: number };

export function PayPlans({ plans, drivers, customers, canEdit, escrows = [] }: { plans: Plan[]; drivers: Driver[]; customers: { id: string; name: string }[]; canEdit: boolean; escrows?: Escrow[] }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<Plan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sample, setSample] = useState({ miles: "500", empty: "40", stops: "2", hours: "10", linehaul: "2000", type: "domestic", team: false, days: "5", loads: "4" });

  const preview = useMemo(() => {
    if (!draft) return null;
    const rules = draft.rules.map((r) => ({ ...r, amount: ruleAmount(r) })).filter((r) => Number.isFinite(r.amount));
    const l = { legId: "x", orderId: "x", orderNumber: "Sample", seq: 1, type: sample.type, customerId: null, equipment: "53_dry", loadedMiles: Number(sample.miles) || 0, emptyMiles: Number(sample.empty) || 0, stops: Number(sample.stops) || 2, hours: Number(sample.hours) || 0, linehaulCents: Math.round((Number(sample.linehaul) || 0) * 100), billedCents: null, firstLegOfLoad: true, team: sample.team };
    const lines = legPayLines({ rules, teamSplit: draft.teamSplit }, l);
    const perLoad = lines.reduce((a, x) => a + x.amountCents, 0);
    const week = perLoad * (Number(sample.loads) || 0);
    const extras = statementExtras({ perDiemCents: draft.perDiem ? Math.round(Number(draft.perDiem) * 100) : null, minimumCents: draft.minimum ? Math.round(Number(draft.minimum) * 100) : null }, Number(sample.days) || 0, week);
    return { lines, perLoad, week, extras, total: week + extras.reduce((a, x) => a + x.amountCents, 0) };
  }, [draft, sample]);

  const save = () =>
    draft &&
    start(async () => {
      setErr(null);
      const rules = draft.rules.map((r) => ({ id: r.id, kind: r.kind, amount: ruleAmount(r), label: r.label, when: r.when }));
      if (rules.some((r) => !Number.isFinite(r.amount))) return setErr("every rule needs an amount");
      const res = await savePlanAction({ id: draft.id, name: draft.name, rules, teamSplit: draft.teamSplit, minimumCents: draft.minimum ? Math.round(Number(draft.minimum) * 100) : null, perDiemCents: draft.perDiem ? Math.round(Number(draft.perDiem) * 100) : null, notes: draft.notes });
      if (res.ok) {
        setDraft(null);
        t.ok("Plan saved");
        router.refresh();
      } else setErr(res.error);
    });
  const setRule = (i: number, patch: Partial<PayRule & { amountText: string }>) => setDraft((d) => d && { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const toggle = (arr: string[] | undefined, v: string) => (arr?.includes(v) ? arr.filter((x) => x !== v) : [...(arr ?? []), v]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-muted text-[13px]">
          {plans.length} plan{plans.length === 1 ? "" : "s"} · {drivers.filter((d) => d.payPlanId).length} of {drivers.length} drivers on a plan
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => (setErr(null), setDraft(toDraft()))}>
            + New pay plan
          </button>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="card p-12 text-center text-muted text-[13.5px]">No pay plans yet. Drivers are paid by the pay type on their record until you put them on a plan.</div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {plans.map((p) => {
            const on = drivers.filter((d) => d.payPlanId === p.id);
            return (
              <div key={p.id} className="card p-5" data-testid="pay-plan">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-bold">{p.name}</div>
                    <div className="text-[12.5px] text-muted mt-0.5">
                      Team: {p.teamSplit === "full" ? "each driver full" : "split in half"}
                      {p.perDiemCents ? ` · per diem ${money(p.perDiemCents)}/day` : ""}
                      {p.minimumCents ? ` · minimum ${money(p.minimumCents)}/statement` : ""}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => (setErr(null), setDraft(toDraft(p)))}>
                        Edit
                      </button>
                      <button className="btn btn-sm" onClick={() => (setAssignFor(p), setPicked(new Set(on.map((d) => d.id))))}>
                        Drivers
                      </button>
                    </div>
                  )}
                </div>
                <ul className="mt-3 space-y-1.5">
                  {p.rules.map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-semibold tabular-nums w-28 shrink-0">{amountText(r)}</span>
                      <span>{r.label || RULE_LABEL[r.kind]}</span>
                      <span className="text-muted text-[12px] ml-auto text-right">{whenText(r, customers)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 pt-3 border-t border-line text-[12.5px] text-muted">{on.length ? on.map((d) => d.name).join(", ") : "No drivers on this plan"}</div>
              </div>
            );
          })}
        </div>
      )}

      {escrows.length > 0 && (
        <div className="card overflow-hidden" data-testid="escrows">
          <div className="px-5 pt-4 pb-2 text-[15px] font-bold">Escrow held</div>
          <table className="table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Escrow</th>
                <th>Per statement</th>
                <th>Target</th>
                <th>Held</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {escrows.map((e) => (
                <tr key={e.id}>
                  <td className="font-semibold">{e.driver}</td>
                  <td>{e.description}</td>
                  <td className="tabular-nums">{money(e.amountCents)}</td>
                  <td className="tabular-nums">{e.targetCents != null ? money(e.targetCents) : "—"}</td>
                  <td className="tabular-nums font-semibold">{money(e.balanceCents)}</td>
                  <td className="text-right">
                    {canEdit && e.balanceCents > 0 && (
                      <button
                        className="btn btn-sm"
                        disabled={pending}
                        onClick={() => {
                          const amt = window.prompt(`Release how much of ${money(e.balanceCents)} to ${e.driver}?`, (e.balanceCents / 100).toFixed(2));
                          if (amt)
                            start(async () => {
                              const r = await releaseEscrowAction(e.id, amt, "");
                              if (r.ok) {
                                t.ok("Released — it pays on the next statement");
                                router.refresh();
                              } else t.err(r.error);
                            });
                        }}
                      >
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        wide
        title={draft?.id ? `Edit ${draft.name}` : "New pay plan"}
        footer={
          <>
            {draft?.id && canEdit && (
              <button
                className="btn btn-danger mr-auto"
                disabled={pending}
                onClick={() =>
                  draft?.id &&
                  window.confirm("Delete this plan?") &&
                  start(async () => {
                    const r = await deletePlanAction(draft.id!);
                    if (r.ok) {
                      setDraft(null);
                      t.ok("Plan deleted");
                      router.refresh();
                    } else setErr(r.error);
                  })
                }
              >
                Delete
              </button>
            )}
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save plan"}
            </button>
          </>
        }
      >
        {draft && (
          <div className="grid lg:grid-cols-[1fr_280px] gap-5">
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="col-span-2">
                  <label className="label" htmlFor="pp-name">
                    Name
                  </label>
                  <input id="pp-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Company drivers — solo" />
                </div>
                <div>
                  <label className="label" htmlFor="pp-team">
                    Team legs
                  </label>
                  <select id="pp-team" className="select" value={draft.teamSplit} onChange={(e) => setDraft({ ...draft, teamSplit: e.target.value })}>
                    <option value="half">Split in half</option>
                    <option value="full">Each driver full</option>
                  </select>
                </div>
                <div />
                <div>
                  <label className="label" htmlFor="pp-diem">
                    Per diem per day
                  </label>
                  <input id="pp-diem" className="input" inputMode="decimal" value={draft.perDiem} onChange={(e) => setDraft({ ...draft, perDiem: e.target.value })} placeholder="0.00" />
                </div>
                <div>
                  <label className="label" htmlFor="pp-min">
                    Minimum per statement
                  </label>
                  <input id="pp-min" className="input" inputMode="decimal" value={draft.minimum} onChange={(e) => setDraft({ ...draft, minimum: e.target.value })} placeholder="0.00" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[13px] font-bold">Rules</div>
                  <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, rules: [...draft.rules, blankRule()] })}>
                    + Add rule
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.rules.map((r, i) => (
                    <div key={r.id} className="rounded-lg border border-line p-3" data-testid="pay-rule">
                      <div className="grid grid-cols-[1fr_130px_auto] gap-2 items-end">
                        <div>
                          <label className="label" htmlFor={`rk-${i}`}>
                            Pay
                          </label>
                          <select id={`rk-${i}`} className="select" value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value as PayRuleKind })} aria-label={`Rule ${i + 1} kind`}>
                            {Object.entries(RULE_LABEL).map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`ra-${i}`}>
                            {isPct(r.kind) ? "Percent" : "Amount ($)"}
                          </label>
                          <input id={`ra-${i}`} className="input" inputMode="decimal" value={r.amountText} onChange={(e) => setRule(i, { amountText: e.target.value })} aria-label={`Rule ${i + 1} amount`} placeholder={isPct(r.kind) ? "28" : "0.60"} />
                        </div>
                        <button type="button" className="btn btn-ghost btn-sm text-red mb-1" disabled={draft.rules.length === 1} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })} aria-label={`Remove rule ${i + 1}`}>
                          Remove
                        </button>
                      </div>
                      <details className="mt-2">
                        <summary className="text-[12.5px] text-teal font-semibold cursor-pointer">Only when… · {whenText({ ...r, amount: 0 }, customers)}</summary>
                        <div className="mt-2 space-y-2 text-[12.5px]">
                          <div className="flex flex-wrap gap-1 items-center">
                            <span className="text-muted w-20">Legs</span>
                            {LEG_TYPES.map(([v, l]) => (
                              <button key={v} type="button" aria-pressed={!!r.when?.legTypes?.includes(v)} className={`px-2 h-7 rounded-md border ${r.when?.legTypes?.includes(v) ? "bg-navy text-white border-navy" : "border-line"}`} onClick={() => setRule(i, { when: { ...r.when, legTypes: toggle(r.when?.legTypes, v) } })}>
                                {l}
                              </button>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1 items-center">
                            <span className="text-muted w-20">Equipment</span>
                            {EQUIPMENT.map(([v, l]) => (
                              <button key={v} type="button" aria-pressed={!!r.when?.equipment?.includes(v)} className={`px-2 h-7 rounded-md border ${r.when?.equipment?.includes(v) ? "bg-navy text-white border-navy" : "border-line"}`} onClick={() => setRule(i, { when: { ...r.when, equipment: toggle(r.when?.equipment, v) } })}>
                                {l}
                              </button>
                            ))}
                          </div>
                          {customers.length > 0 && (
                            <div className="flex flex-wrap gap-1 items-center">
                              <span className="text-muted w-20">Customers</span>
                              <select className="select h-8 w-56 text-[12.5px]" value="" onChange={(e) => e.target.value && setRule(i, { when: { ...r.when, customerIds: toggle(r.when?.customerIds, e.target.value) } })} aria-label={`Rule ${i + 1} customer`}>
                                <option value="">Add a customer…</option>
                                {customers.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              {r.when?.customerIds?.map((c) => (
                                <button key={c} type="button" className="pill pill-slate" onClick={() => setRule(i, { when: { ...r.when, customerIds: toggle(r.when?.customerIds, c) } })}>
                                  {customers.find((x) => x.id === c)?.name ?? "?"} ✕
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2 items-center">
                            <span className="text-muted w-20">Miles</span>
                            <input className="input h-8 w-24" inputMode="numeric" placeholder="from" value={r.when?.minMiles ?? ""} onChange={(e) => setRule(i, { when: { ...r.when, minMiles: e.target.value === "" ? null : Number(e.target.value) } })} aria-label={`Rule ${i + 1} min miles`} />
                            <input className="input h-8 w-24" inputMode="numeric" placeholder="to" value={r.when?.maxMiles ?? ""} onChange={(e) => setRule(i, { when: { ...r.when, maxMiles: e.target.value === "" ? null : Number(e.target.value) } })} aria-label={`Rule ${i + 1} max miles`} />
                          </div>
                          <input className="input h-8" placeholder="Label on the statement (optional)" value={r.label ?? ""} onChange={(e) => setRule(i, { label: e.target.value })} aria-label={`Rule ${i + 1} label`} />
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
              {err && (
                <div className="error" role="alert">
                  {err}
                </div>
              )}
            </div>

            <aside className="rounded-lg bg-ground p-4 text-[13px] space-y-3 self-start" data-testid="pay-preview">
              <div className="font-bold">What it pays</div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["miles", "Loaded mi"],
                    ["empty", "Empty mi"],
                    ["stops", "Stops"],
                    ["hours", "Hours"],
                    ["linehaul", "Line haul $"],
                    ["loads", "Loads / week"],
                    ["days", "Days worked"],
                  ] as const
                ).map(([k, l]) => (
                  <label key={k} className="text-[11.5px] text-muted">
                    {l}
                    <input className="input h-8 mt-0.5 text-[13px]" inputMode="decimal" value={sample[k]} onChange={(e) => setSample({ ...sample, [k]: e.target.value })} />
                  </label>
                ))}
                <label className="text-[11.5px] text-muted">
                  Leg
                  <select className="select h-8 mt-0.5 text-[13px]" value={sample.type} onChange={(e) => setSample({ ...sample, type: e.target.value })}>
                    {LEG_TYPES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" className="accent-teal" checked={sample.team} onChange={(e) => setSample({ ...sample, team: e.target.checked })} /> Team leg
              </label>
              {preview && (
                <div className="space-y-1">
                  {preview.lines.map((l) => (
                    <div key={l.id} className="flex justify-between gap-2">
                      <span className="text-muted truncate">{l.description.replace("Sample leg 1 · ", "")}</span>
                      <span className="tabular-nums">{money(l.amountCents)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-semibold border-t border-line pt-1">
                    <span>Per load</span>
                    <span className="tabular-nums">{money(preview.perLoad)}</span>
                  </div>
                  {preview.extras.map((l) => (
                    <div key={l.id} className="flex justify-between gap-2">
                      <span className="text-muted truncate">{l.description}</span>
                      <span className="tabular-nums">{money(l.amountCents)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-bold border-t border-line pt-1" data-testid="pay-week">
                    <span>A week</span>
                    <span className="tabular-nums">{money(preview.total)}</span>
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </Modal>

      <Modal
        open={!!assignFor}
        onClose={() => setAssignFor(null)}
        title={`Drivers on ${assignFor?.name ?? ""}`}
        footer={
          <>
            <button className="btn" onClick={() => setAssignFor(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                assignFor &&
                start(async () => {
                  const was = drivers.filter((d) => d.payPlanId === assignFor.id).map((d) => d.id);
                  const add = [...picked].filter((id) => !was.includes(id));
                  const drop = was.filter((id) => !picked.has(id));
                  const r1 = await assignPlanAction(add, assignFor.id);
                  const r2 = await assignPlanAction(drop, null);
                  if (r1.ok && r2.ok) {
                    setAssignFor(null);
                    t.ok("Drivers updated");
                    router.refresh();
                  } else t.err((!r1.ok && r1.error) || (!r2.ok && r2.error) || "Could not update");
                })
              }
            >
              Save
            </button>
          </>
        }
      >
        <div className="space-y-1 max-h-[50vh] overflow-auto">
          {drivers.map((d) => {
            const other = d.payPlanId && d.payPlanId !== assignFor?.id ? plans.find((p) => p.id === d.payPlanId)?.name : null;
            return (
              <label key={d.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-ground cursor-pointer text-[13.5px]">
                <input type="checkbox" className="accent-teal" checked={picked.has(d.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />
                {d.name}
                {other ? <Pill tone="slate">on {other}</Pill> : !d.payPlanId ? <span className="text-[12px] text-muted">own pay: {d.payType.replace("_", " ")}</span> : null}
              </label>
            );
          })}
          {drivers.length === 0 && <div className="text-muted text-[13px]">No drivers yet.</div>}
        </div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
