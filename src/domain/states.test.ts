// Features: F-2.2
import { describe, it, expect } from "vitest";
import { ORDER_STATES, LEG_STATES } from "@/db/schema";
import { ORDER_TRANSITIONS, LEG_TRANSITIONS, canOrderTransition, canLegTransition, assertLegTransition, nextLegState, TransitionError, STAGE_OF_LEG } from "./states";

// F-2.1 / F-2.2: every allowed and every forbidden transition is tested, not sampled.

describe("order state machine (F-2.1)", () => {
  it("covers every state", () => {
    for (const s of ORDER_STATES) expect(ORDER_TRANSITIONS[s]).toBeDefined();
  });

  const allowed: [string, string][] = [];
  const forbidden: [string, string][] = [];
  for (const from of ORDER_STATES) for (const to of ORDER_STATES) (ORDER_TRANSITIONS[from].includes(to) ? allowed : forbidden).push([from, to]);

  it.each(allowed)("allows %s → %s", (from, to) => {
    expect(canOrderTransition(from as never, to as never)).toBe(true);
  });
  it.each(forbidden)("forbids %s → %s", (from, to) => {
    expect(canOrderTransition(from as never, to as never)).toBe(false);
  });

  it("paid and cancelled are terminal", () => {
    expect(ORDER_TRANSITIONS.paid).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });
  it("cannot cancel after delivery", () => {
    expect(canOrderTransition("delivered", "cancelled")).toBe(false);
    expect(canOrderTransition("invoiced", "cancelled")).toBe(false);
  });
});

describe("leg state machine (F-2.2)", () => {
  it("covers every state", () => {
    for (const s of LEG_STATES) expect(LEG_TRANSITIONS[s]).toBeDefined();
  });

  const allowed: [string, string][] = [];
  const forbidden: [string, string][] = [];
  for (const from of LEG_STATES) for (const to of LEG_STATES) (LEG_TRANSITIONS[from].includes(to) ? allowed : forbidden).push([from, to]);

  it.each(allowed)("allows %s → %s", (from, to) => {
    expect(canLegTransition(from as never, to as never)).toBe(true);
  });
  it.each(forbidden)("forbids %s → %s", (from, to) => {
    expect(canLegTransition(from as never, to as never)).toBe(false);
    expect(() => assertLegTransition(from as never, to as never)).toThrow(TransitionError);
  });

  it("planning is separate from dispatching", () => {
    expect(canLegTransition("unassigned", "dispatched")).toBe(false);
    expect(canLegTransition("unassigned", "planned")).toBe(true);
    expect(canLegTransition("planned", "dispatched")).toBe(true);
  });

  it("cannot skip forward", () => {
    expect(canLegTransition("accepted", "loaded")).toBe(false);
    expect(canLegTransition("at_pickup", "en_route")).toBe(false);
  });

  it("next action walks the forward chain", () => {
    expect(nextLegState("dispatched")).toBe("accepted");
    expect(nextLegState("accepted")).toBe("en_route_to_pickup");
    expect(nextLegState("at_delivery")).toBe("completed");
    expect(nextLegState("completed")).toBeNull();
    expect(nextLegState("unassigned")).toBeNull();
  });

  it("maps every state to a board stage", () => {
    for (const s of LEG_STATES) expect(STAGE_OF_LEG[s]).toBeTruthy();
    expect(STAGE_OF_LEG.unassigned).toBe("pending");
    expect(STAGE_OF_LEG.planned).toBe("planned");
    expect(STAGE_OF_LEG.en_route).toBe("dispatched");
    expect(STAGE_OF_LEG.completed).toBe("delivered");
  });
});
