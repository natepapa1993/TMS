import { describe, it, expect } from "vitest";
import { zonedDate, zonedMidnight, weekOfZoned } from "./time";

describe("company time zone", () => {
  it("late Saturday night in Detroit is still Saturday, so the week is the one that started last Sunday", () => {
    const t = new Date("2026-09-27T03:05:00Z"); // Sat 23:05 in Detroit (EDT)
    expect(zonedDate(t, "America/Detroit")).toBe("2026-09-26");
    expect(zonedDate(t, "UTC")).toBe("2026-09-27");
    const w = weekOfZoned(t, "America/Detroit");
    expect(w.startDate).toBe("2026-09-20");
    expect(w.start.toISOString()).toBe("2026-09-20T04:00:00.000Z"); // midnight EDT
    expect(w.end.toISOString()).toBe("2026-09-27T04:00:00.000Z");
  });
  it("midnight solves the offset across a DST change", () => {
    expect(zonedMidnight("2026-11-01", "America/Detroit").toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still EDT at midnight
    expect(zonedMidnight("2026-11-02", "America/Detroit").toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST
    expect(zonedMidnight("2026-03-15", "America/Monterrey").toISOString()).toBe("2026-03-15T06:00:00.000Z"); // Mexico has no DST since 2022
  });
});
