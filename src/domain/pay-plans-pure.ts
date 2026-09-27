import type { PayRule, PayRuleKind, SettlementLine } from "@/db/schema";

/** The pay rules themselves, with no database: shared by statements and the plan editor's live preview. */

import { newId } from "@/lib/ids";

export const RULE_LABEL: Record<PayRuleKind, string> = {
  per_loaded_mile: "Per loaded mile",
  per_empty_mile: "Per empty mile",
  per_total_mile: "Per mile (loaded + empty)",
  pct_linehaul: "% of line haul",
  pct_total: "% of everything billed",
  flat_per_load: "Flat per load",
  flat_per_leg: "Flat per leg",
  per_stop: "Per stop",
  per_extra_stop: "Per extra stop (beyond pickup and delivery)",
  hourly: "Per hour",
  crossing: "Crossing pay",
};
export const isPct = (k: PayRuleKind) => k === "pct_linehaul" || k === "pct_total";

/** What a completed leg brings to the rules. */
export type LegPayInput = {
  legId: string;
  orderId: string;
  orderNumber: string;
  seq: number;
  type: string;
  customerId: string | null;
  equipment: string;
  loadedMiles: number | null;
  emptyMiles: number | null;
  stops: number; // pickups and deliveries on the leg
  hours: number | null;
  linehaulCents: number | null;
  billedCents: number | null;
  firstLegOfLoad: boolean;
  team: boolean;
};

const matches = (r: PayRule, l: LegPayInput) => {
  const w = r.when ?? {};
  if (w.legTypes?.length && !w.legTypes.includes(l.type)) return false;
  if (w.customerIds?.length && (!l.customerId || !w.customerIds.includes(l.customerId))) return false;
  if (w.equipment?.length && !w.equipment.includes(l.equipment)) return false;
  const miles = l.loadedMiles ?? 0;
  if (w.minMiles != null && miles < w.minMiles) return false;
  if (w.maxMiles != null && miles > w.maxMiles) return false;
  return true;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Pure: the lines a leg earns under a plan. */
export function legPayLines(plan: { rules: PayRule[]; teamSplit: string }, l: LegPayInput): SettlementLine[] {
  const share = l.team && plan.teamSplit !== "full" ? 0.5 : 1;
  const team = share < 1 ? " (team ½)" : "";
  const out: SettlementLine[] = [];
  const base = { legId: l.legId, orderNumber: l.orderNumber };
  const line = (r: PayRule, qty: number, unit: string, rateCents: number, amount: number, what: string, source: string) =>
    out.push({ id: newId(), kind: r.kind === "crossing" ? "accessorial" : "leg", ...base, description: `${l.orderNumber} leg ${l.seq} · ${r.label || what}${team}`, qty, unit, rateCents, amountCents: Math.round(amount * share), source });
  for (const r of plan.rules) {
    if (!matches(r, l)) continue;
    switch (r.kind) {
      case "per_loaded_mile":
      case "per_empty_mile":
      case "per_total_mile": {
        const mi = r.kind === "per_loaded_mile" ? l.loadedMiles : r.kind === "per_empty_mile" ? l.emptyMiles : l.loadedMiles == null && l.emptyMiles == null ? null : (l.loadedMiles ?? 0) + (l.emptyMiles ?? 0);
        const which = r.kind === "per_loaded_mile" ? "loaded" : r.kind === "per_empty_mile" ? "empty" : "total";
        if (mi == null) {
          if (r.kind !== "per_empty_mile") line(r, 0, "mi", r.amount, 0, `no ${which} miles on the leg`, "missing miles");
          continue;
        }
        if (mi === 0) continue;
        line(r, mi, "mi", r.amount, mi * r.amount, `${mi} ${which} mi × ${money(r.amount)}`, r.kind === "per_empty_mile" ? "empty miles from the last delivery" : "planned miles");
        break;
      }
      case "pct_linehaul":
      case "pct_total": {
        const basis = r.kind === "pct_linehaul" ? l.linehaulCents : (l.billedCents ?? l.linehaulCents);
        if (!basis || !l.firstLegOfLoad) continue; // a percent is paid once per load, on its first leg for this driver
        line(r, r.amount / 100, "pct", basis, (basis * r.amount) / 10000, `${r.amount / 100}% of ${money(basis)}`, r.kind === "pct_linehaul" ? "line haul" : "everything billed");
        break;
      }
      case "flat_per_load":
        if (!l.firstLegOfLoad) continue;
        line(r, 1, "flat", r.amount, r.amount, "flat per load", "plan");
        break;
      case "flat_per_leg":
        line(r, 1, "flat", r.amount, r.amount, "flat per leg", "plan");
        break;
      case "per_stop":
        if (l.stops) line(r, l.stops, "stop", r.amount, l.stops * r.amount, `${l.stops} stops × ${money(r.amount)}`, "stops on the leg");
        break;
      case "per_extra_stop": {
        const extra = Math.max(0, l.stops - 2);
        if (extra) line(r, extra, "stop", r.amount, extra * r.amount, `${extra} extra stop${extra === 1 ? "" : "s"} × ${money(r.amount)}`, "stops beyond pickup and delivery");
        break;
      }
      case "hourly":
        if (l.hours != null && l.hours > 0) line(r, Math.round(l.hours * 100) / 100, "h", r.amount, l.hours * r.amount, `${l.hours.toFixed(2)} h × ${money(r.amount)}`, "accepted → completed");
        break;
      case "crossing":
        if (l.type === "crossing") line(r, 1, "flat", r.amount, r.amount, "border crossing pay", "plan");
        break;
    }
  }
  return out;
}

/** Pure: per diem for the days worked, then a top-up to the plan's minimum. */
export function statementExtras(plan: { perDiemCents: number | null; minimumCents: number | null }, workedDays: number, earnedCents: number): SettlementLine[] {
  const out: SettlementLine[] = [];
  if (plan.perDiemCents && workedDays) out.push({ id: newId(), kind: "reimbursement", description: `Per diem · ${workedDays} day${workedDays === 1 ? "" : "s"} × ${money(plan.perDiemCents)}`, qty: workedDays, unit: "day", rateCents: plan.perDiemCents, amountCents: workedDays * plan.perDiemCents, source: "plan" });
  if (plan.minimumCents && earnedCents < plan.minimumCents) out.push({ id: newId(), kind: "adjustment", description: `Minimum pay top-up to ${money(plan.minimumCents)}`, qty: 1, unit: "flat", rateCents: plan.minimumCents - earnedCents, amountCents: plan.minimumCents - earnedCents, source: "plan minimum" });
  return out;
}

