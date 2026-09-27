import { describe, it, expect } from "vitest";
import { zonedDate, zonedMidnight, weekOfZoned, zoneFor, localToInstant } from "./time";

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
  it("wall-clock times from a 204 land in the stop's zone: an explicit code, then the state, then the company", () => {
    expect(zoneFor({ code: "ET", state: "TX" }, "America/Detroit")).toBe("America/New_York");
    expect(zoneFor({ state: "TX" }, "America/Detroit")).toBe("America/Chicago");
    expect(zoneFor({ state: "NL", country: "MX" }, "America/Detroit")).toBe("America/Monterrey");
    expect(zoneFor({ state: "QRO", country: "MX" }, "America/Detroit")).toBe("America/Mexico_City");
    expect(zoneFor({ country: "MX" }, "America/Detroit")).toBe("America/Mexico_City");
    expect(zoneFor({}, "America/Detroit")).toBe("America/Detroit");
    expect(localToInstant("2026-09-27", "0800", "America/Monterrey").toISOString()).toBe("2026-09-27T14:00:00.000Z");
    expect(localToInstant("2026-09-28", "1500", "America/Chicago").toISOString()).toBe("2026-09-28T20:00:00.000Z");
  });
});

describe("fmtIn / zoneAbbrev", () => {
  it("formats in the company's zone with its abbreviation and survives a bad zone", async () => {
    const { fmtIn, zoneAbbrev } = await import("./time");
    const d = new Date("2026-09-27T12:24:00Z");
    expect(fmtIn(d, "America/Detroit")).toBe("Sep 27, 8:24 AM EDT");
    expect(fmtIn(d, "America/Monterrey")).toBe("Sep 27, 6:24 AM CST");
    expect(fmtIn(d, "Not/AZone")).toMatch(/Sep 27, 7:24 AM CDT/);
    expect(fmtIn(null, "America/Detroit")).toBeNull();
    expect(zoneAbbrev("America/Detroit", d)).toBe("EDT");
  });
});
