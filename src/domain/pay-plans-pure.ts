import type { PayRule, PayRuleKind, SettlementLine } from "@/db/schema";

/** The pay rules themselves, with no database: shared by statements and the plan editor's live preview. */

import { newId } from "@/lib/ids";
import { money as fxMoney } from "./fx-rules";

export const RULE_LABEL: Record<PayRuleKind, string> = {
  per_loaded_mile: "Per loaded mile",
  per_empty_mile: "Per empty mile",
  per_total_mile: "Per mile (loaded + empty)",
  pct_linehaul: "% of line haul (in USD)",
  pct_total: "% of everything billed (in USD; approved charges only, no lumpers, border fees or tax)",
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
  /** the loaded miles are estimated from the stops (nobody typed them) */
  loadedMilesEst?: boolean;
  emptyMiles: number | null;
  stops: number; // pickups and deliveries on the leg
  hours: number | null;
  linehaulCents: number | null;
  billedCents: number | null;
  firstLegOfLoad: boolean;
  team: boolean;
  /** this leg's share of the load (see legShare): a percent rule pays on the share, per leg */
  loadShare?: LegShare;
};

// ---------- a leg's share of the load (percent pay on a multi-leg load) ----------

export type ShareLeg = { id: string; type: string; state: string; plannedMiles: number | null; estMiles?: number | null };
/**
 * What part of a load's money a leg carries. "whole": the load has one leg that moves the freight.
 * "miles": every leg that moves the freight has miles (typed or est.) — the leg's miles over the load's.
 * "legs": some leg has no miles — an equal split by the legs that move the freight.
 * "none": an empty move (equipment move) carries no share of the load's revenue.
 * Every leg that moves the freight counts, whoever runs it (our truck, a carrier, a transfer partner):
 * a US leg of a Querétaro → Dearborn load is paid on the US part, not on what the Mexican carrier ran.
 */
export type LegShare = { share: number; basis: "whole" | "miles" | "legs" | "none"; legMiles: number | null; loadMiles: number | null; legs: number; est: boolean };

export function legShare(legId: string, legs: ShareLeg[]): LegShare {
  const me = legs.find((l) => l.id === legId);
  if (me?.type === "equipment_move") return { share: 0, basis: "none", legMiles: null, loadMiles: null, legs: 0, est: false };
  const live = legs.filter((l) => l.state !== "cancelled" && l.type !== "equipment_move");
  const mi = (l: ShareLeg) => l.plannedMiles ?? l.estMiles ?? null;
  if (live.length <= 1 || !me) return { share: 1, basis: "whole", legMiles: me ? mi(me) : null, loadMiles: me ? mi(me) : null, legs: 1, est: false };
  const miles = live.map(mi);
  const est = live.some((l) => l.plannedMiles == null && l.estMiles != null);
  if (miles.every((m) => m != null && m > 0)) {
    const total = miles.reduce((a: number, m) => a + (m ?? 0), 0);
    return { share: mi(me)! / total, basis: "miles", legMiles: mi(me), loadMiles: total, legs: live.length, est };
  }
  return { share: 1 / live.length, basis: "legs", legMiles: mi(me), loadMiles: null, legs: live.length, est: false };
}

const LEG_WORD: Record<string, string> = { us: "US leg", mx: "Mexico leg", ca: "Canada leg", crossing: "crossing leg", domestic: "leg", equipment_move: "empty move" };

/** "US leg share 50.3% (150 of 298 mi est.)" / "leg share 33.3% (1 of 3 legs …)"; "" for a one-leg load. */
export function shareLabel(type: string, s: LegShare) {
  const word = LEG_WORD[type] ?? "leg";
  if (s.basis === "whole") return "";
  if (s.basis === "none") return `${word}: no share of the load`;
  const pct = `${Math.round(s.share * 1000) / 10}%`;
  return s.basis === "miles" ? `${word} share ${pct} (${s.legMiles} of ${s.loadMiles} mi${s.est ? " est." : ""})` : `${word} share ${pct} (1 of ${s.legs} legs — not every leg has miles)`;
}

/**
 * Pure: what a driver on a plain pay type (no pay plan) earns for a leg — per mile on the leg's miles
 * (typed, else the estimate, labelled est.), a percent of the leg's share of the load's line haul in USD,
 * or flat per leg — plus crossing pay on a crossing leg. Statements and the P&L estimate both use it.
 */
export function payTypeLines(
  driver: { payType: string | null; payRateCents: number | null; crossingPayCents?: number | null },
  leg: { id: string; seq: number; type: string; plannedMiles: number | null; estMiles?: number | null; coDriverId?: string | null },
  load: { orderNumber: string; rateCents: number | null; currency: string; linehaulUsdCents: number; share: LegShare },
): SettlementLine[] {
  const rate = driver.payRateCents ?? 0;
  const team = !!leg.coDriverId;
  const half = team ? 0.5 : 1;
  const teamTag = team ? " (team ½)" : "";
  const { orderNumber } = load;
  const out: SettlementLine[] = [];
  if (driver.payType === "per_mile") {
    const miles = leg.plannedMiles ?? leg.estMiles ?? 0;
    const est = leg.plannedMiles == null && leg.estMiles != null;
    out.push({ id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · ${miles} mi${est ? " (est.)" : ""} × ${(rate / 100).toFixed(2)}${teamTag}`, qty: miles, unit: "mi", rateCents: rate, amountCents: Math.round(miles * rate * half), source: leg.plannedMiles ? "planned miles" : est ? "estimated miles" : "no miles on the leg" });
  } else if (driver.payType === "pct") {
    const sh = load.share;
    const base = Math.round(load.linehaulUsdCents * sh.share);
    const orig = load.currency !== "USD" ? fxMoney(load.rateCents ?? 0, load.currency) : "";
    const why = sh.basis === "whole" ? (orig ? ` (${orig})` : "") : ` — ${shareLabel(leg.type, sh)} of the load's ${fxMoney(load.linehaulUsdCents)}${orig ? ` (${orig})` : ""}`;
    out.push({ id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · ${rate / 100}% of ${fxMoney(base)}${why}${teamTag}`, qty: rate, unit: "pct", rateCents: base, amountCents: Math.round(((base * rate) / 10000) * half), source: sh.basis === "whole" ? "order rate" : sh.basis === "none" ? "empty move" : "leg share of the order rate" });
  } else {
    out.push({ id: newId(), kind: "leg", legId: leg.id, orderNumber, description: `${orderNumber} leg ${leg.seq} · flat${teamTag}`, qty: 1, unit: "flat", rateCents: rate, amountCents: Math.round(rate * half), source: "flat per leg" });
  }
  if (leg.type === "crossing" && driver.crossingPayCents) out.push({ id: newId(), kind: "accessorial", legId: leg.id, orderNumber, description: `${orderNumber} border crossing pay`, qty: 1, unit: "flat", rateCents: driver.crossingPayCents, amountCents: driver.crossingPayCents, source: "driver record" });
  return out;
}

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
        const est = r.kind !== "per_empty_mile" && !!l.loadedMilesEst;
        line(r, mi, "mi", r.amount, mi * r.amount, `${mi} ${which} mi${est ? " (est.)" : ""} × ${money(r.amount)}`, r.kind === "per_empty_mile" ? "empty miles from the last delivery" : est ? "estimated miles" : "planned miles");
        break;
      }
      case "pct_linehaul":
      case "pct_total": {
        const whole = r.kind === "pct_linehaul" ? l.linehaulCents : (l.billedCents ?? l.linehaulCents);
        if (!whole) continue;
        const what = r.kind === "pct_linehaul" ? "line haul" : "everything billed";
        const sh = l.loadShare;
        if (!sh || sh.basis === "whole") {
          if (!l.firstLegOfLoad) continue; // one leg moves the whole load: the percent is paid once, on the driver's first leg
          line(r, r.amount / 100, "pct", whole, (whole * r.amount) / 10000, `${r.amount / 100}% of ${money(whole)}`, what);
          break;
        }
        // a multi-leg load: the percent is of this leg's share, every leg on its own
        if (sh.basis === "none") continue;
        const basis = Math.round(whole * sh.share);
        line(r, r.amount / 100, "pct", basis, (basis * r.amount) / 10000, `${r.amount / 100}% of ${money(basis)} — ${shareLabel(l.type, sh)} of the load's ${money(whole)} ${what}`, `leg share of the ${what}`);
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


// ---------- deductions never take net pay below $0 ----------

export type DeductionWant = { key: string; wantCents: number };

/**
 * Pure: take deductions in the order given, never more than the pay left. What doesn't fit is "short":
 * it carries to the next statement (an advance or a limited deduction simply stays owed; escrow waits).
 * The order is the rule the statement states: carried-over amounts first, then one-off deductions,
 * recurring deductions, advance recovery, and escrow last.
 */
export function applyDeductions(availableCents: number, wants: DeductionWant[]): { key: string; takenCents: number; shortCents: number }[] {
  let left = Math.max(0, availableCents);
  return wants.map((w) => {
    const want = Math.max(0, w.wantCents);
    const taken = Math.min(want, left);
    left -= taken;
    return { key: w.key, takenCents: taken, shortCents: want - taken };
  });
}

/** Order in which pay items come off a statement (lower first). */
export function deductionRank(it: { kind: string; recurring: boolean; carriedFrom?: string | null }) {
  if (it.carriedFrom) return 0;
  if (it.kind === "deduction" && !it.recurring) return 1;
  if (it.kind === "deduction") return 2;
  if (it.kind === "advance") return 3;
  return 4; // escrow
}

/** Charges a percent-of-billed pay rule never counts: money collected for someone else (a lumper paid out, a border fee, tax). */
export const PASS_THROUGH_KINDS = ["lumper", "border_fee", "tax"];
