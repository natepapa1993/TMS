import type { OrderState, LegState } from "@/db/schema";

/**
 * Spec §2.1 / §2.2. These tables are the single source of truth for what may follow what.
 * Anything not listed is forbidden; the repositories enforce it server-side; the UI hides it.
 */

export const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  draft: ["booked", "cancelled"],
  booked: ["dispatched", "cancelled", "draft"],
  dispatched: ["in_transit", "booked", "exception", "cancelled"],
  in_transit: ["delivered", "exception", "cancelled"],
  exception: ["dispatched", "in_transit", "delivered", "cancelled"],
  delivered: ["ready_to_bill", "in_transit"],
  ready_to_bill: ["invoiced", "delivered"],
  invoiced: ["paid", "ready_to_bill"],
  paid: [],
  cancelled: [],
};

export const LEG_TRANSITIONS: Record<LegState, readonly LegState[]> = {
  unassigned: ["planned", "cancelled"],
  planned: ["dispatched", "unassigned", "cancelled"],
  dispatched: ["accepted", "declined", "planned", "cancelled"],
  accepted: ["en_route_to_pickup", "declined", "planned", "cancelled"],
  en_route_to_pickup: ["at_pickup", "cancelled"],
  at_pickup: ["loaded", "cancelled"],
  loaded: ["en_route", "cancelled"],
  en_route: ["at_delivery", "cancelled"],
  at_delivery: ["completed", "en_route"],
  completed: [],
  declined: ["planned", "unassigned", "cancelled"],
  cancelled: [],
};

/** The forward chain a driver walks; used for the app's single "next action" button. */
export const LEG_FORWARD: readonly LegState[] = ["accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"];

export const STAGE_OF_LEG: Record<LegState, "pending" | "planned" | "dispatched" | "delivered" | "closed"> = {
  unassigned: "pending",
  declined: "pending",
  planned: "planned",
  dispatched: "dispatched",
  accepted: "dispatched",
  en_route_to_pickup: "dispatched",
  at_pickup: "dispatched",
  loaded: "dispatched",
  en_route: "dispatched",
  at_delivery: "dispatched",
  completed: "delivered",
  cancelled: "closed",
};

export class TransitionError extends Error {
  constructor(public entity: "order" | "leg", public from: string, public to: string, public reason?: string) {
    super(`${entity}: ${from} → ${to} is not allowed${reason ? `: ${reason}` : ""}`);
    this.name = "TransitionError";
  }
}

export function canOrderTransition(from: OrderState, to: OrderState) {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canLegTransition(from: LegState, to: LegState) {
  return LEG_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertOrderTransition(from: OrderState, to: OrderState) {
  if (!canOrderTransition(from, to)) throw new TransitionError("order", from, to);
}

export function assertLegTransition(from: LegState, to: LegState) {
  if (!canLegTransition(from, to)) throw new TransitionError("leg", from, to);
}

export function nextLegState(from: LegState): LegState | null {
  const i = LEG_FORWARD.indexOf(from);
  if (from === "dispatched") return "accepted";
  if (i < 0 || i === LEG_FORWARD.length - 1) return null;
  return LEG_FORWARD[i + 1];
}

/** Plain-English labels for the board (spec: office words on rows, codes in popups). */
export const LEG_LABEL: Record<LegState, string> = {
  unassigned: "Pending",
  planned: "Planned",
  dispatched: "Sent",
  accepted: "Accepted",
  en_route_to_pickup: "To pickup",
  at_pickup: "At pickup",
  loaded: "Loaded",
  en_route: "En route",
  at_delivery: "At delivery",
  completed: "Delivered",
  declined: "Declined",
  cancelled: "Cancelled",
};
