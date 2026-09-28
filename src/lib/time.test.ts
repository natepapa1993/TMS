// Features: F-31.1
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
    expect(fmtIn(d, "Not/AZone")).toBe("Sep 27, 7:24 AM CDT");
    expect(fmtIn(null, "America/Detroit")).toBeNull();
    expect(zoneAbbrev("America/Detroit", d)).toBe("EDT");
  });
});

describe("one time rule (F-31.1): the stop's own clock, with its zone name, the same on every screen", () => {
  it("prints a stop time in the stop's zone whatever zone the machine is in", async () => {
    const { fmtWhen, fmtWindow } = await import("./time");
    const d = new Date("2026-09-29T14:00:00Z"); // 8:00 in Ramos Arizpe (CST all year)
    expect(fmtWhen(d, "America/Monterrey")).toBe("Tue Sep 29, 8:00 AM CST");
    expect(fmtWhen(d, "America/Monterrey", { style: "short" })).toBe("Sep 29, 8:00 AM CST");
    expect(fmtWhen(d, "America/Monterrey", { style: "time" })).toBe("8:00 AM CST");
    expect(fmtWhen(d, "America/Monterrey", { style: "day" })).toBe("Tue Sep 29");
    expect(fmtWhen(d, "America/Chicago")).toBe("Tue Sep 29, 9:00 AM CDT");
    expect(fmtWhen(d, "America/Detroit")).toBe("Tue Sep 29, 10:00 AM EDT");
    expect(fmtWhen(null, "America/Detroit")).toBeNull();
    expect(fmtWhen("not a date", "America/Detroit")).toBeNull();
    // plain ASCII spaces only: no narrow no-break space from ICU, so server and browser render the same bytes
    expect(fmtWhen(d, "America/Monterrey")).not.toMatch(/[\u202f\u00a0]/);
    expect(fmtWindow(d, new Date("2026-09-29T18:00:00Z"), "America/Monterrey")).toBe("Tue Sep 29, 8:00 AM – 12:00 PM CST");
    expect(fmtWindow(new Date("2026-09-30T04:00:00Z"), new Date("2026-09-30T08:00:00Z"), "America/Monterrey")).toBe("Tue Sep 29, 10:00 PM – Wed Sep 30, 2:00 AM CST");
    expect(fmtWindow(null, d, "America/Monterrey")).toBe("by Tue Sep 29, 8:00 AM CST");
    expect(fmtWindow(null, null, "America/Monterrey")).toBeNull();
  });
  it("says Today / Tomorrow on the zone's own calendar", async () => {
    const { fmtWhen } = await import("./time");
    const now = new Date("2026-09-29T03:30:00Z"); // Mon 11:30 PM in Detroit, Mon 10:30 PM in Laredo
    expect(fmtWhen(new Date("2026-09-29T12:00:00Z"), "America/Detroit", { now })).toBe("Tomorrow 8:00 AM EDT");
    expect(fmtWhen(new Date("2026-09-29T04:00:00Z"), "America/Chicago", { now })).toBe("Today 11:00 PM CDT");
    expect(fmtWhen(new Date("2027-01-05T15:00:00Z"), "America/Chicago", { now })).toBe("Tue Jan 5, 2027, 9:00 AM CST");
  });
  it("names the zone from its offset: DST in the US and Canada, CST all year in Mexico since 2022", async () => {
    const { zoneLabel } = await import("./time");
    const summer = new Date("2026-07-15T15:00:00Z");
    const winter = new Date("2026-01-15T15:00:00Z");
    expect([zoneLabel("America/Detroit", summer), zoneLabel("America/Detroit", winter)]).toEqual(["EDT", "EST"]);
    expect([zoneLabel("America/Toronto", summer), zoneLabel("America/Toronto", winter)]).toEqual(["EDT", "EST"]);
    expect([zoneLabel("America/Monterrey", summer), zoneLabel("America/Monterrey", winter)]).toEqual(["CST", "CST"]);
    expect([zoneLabel("America/Mexico_City", summer), zoneLabel("America/Mexico_City", winter)]).toEqual(["CST", "CST"]);
    // the border strip keeps US daylight time
    expect([zoneLabel("America/Matamoros", summer), zoneLabel("America/Matamoros", winter)]).toEqual(["CDT", "CST"]);
    expect(zoneLabel("America/Hermosillo", summer)).toBe("MST");
    expect(zoneLabel("America/Ciudad_Juarez", summer)).toBe("MDT");
    expect(zoneLabel("America/Regina", summer)).toBe("CST");
    expect(zoneLabel("Not/AZone", summer)).toBe("CDT"); // a bad zone falls back to Central
  });
  it("DST changes: the same wall clock on both sides of the switch", async () => {
    const { fmtWhen, localToInstant } = await import("./time");
    // US fall back is Sun Nov 1 2026; Mexico's interior does not move
    expect(fmtWhen(localToInstant("2026-10-31", "0800", "America/Chicago"), "America/Chicago")).toBe("Sat Oct 31, 8:00 AM CDT");
    expect(fmtWhen(localToInstant("2026-11-02", "0800", "America/Chicago"), "America/Chicago")).toBe("Mon Nov 2, 8:00 AM CST");
    expect(fmtWhen(localToInstant("2026-11-02", "0800", "America/Matamoros"), "America/Matamoros")).toBe("Mon Nov 2, 8:00 AM CST");
    expect(fmtWhen(localToInstant("2026-10-31", "0800", "America/Matamoros"), "America/Matamoros")).toBe("Sat Oct 31, 8:00 AM CDT");
    expect(fmtWhen(localToInstant("2026-10-31", "0800", "America/Monterrey"), "America/Monterrey")).toBe("Sat Oct 31, 8:00 AM CST");
    // spring forward, Sun Mar 8 2026
    expect(fmtWhen(localToInstant("2026-03-09", "0800", "America/Detroit"), "America/Detroit")).toBe("Mon Mar 9, 8:00 AM EDT");
    expect(fmtWhen(localToInstant("2026-03-07", "0800", "America/Detroit"), "America/Detroit")).toBe("Sat Mar 7, 8:00 AM EST");
  });
  it("a stop's zone: Nuevo Laredo follows US daylight time, Monterrey and Ramos Arizpe do not; Ontario; Detroit; El Paso", async () => {
    const { stopZone, zoneFor } = await import("./time");
    expect(stopZone({ country: "MX", address: { state: "TAMS", city: "Nuevo Laredo" } }, "America/Chicago")).toBe("America/Matamoros");
    expect(stopZone({ country: "MX", name: "Patio Nuevo Laredo", address: { state: "TAMS" } }, "America/Chicago")).toBe("America/Matamoros");
    expect(stopZone({ country: "MX", address: { state: "Tamaulipas", city: "Reynosa" } }, "America/Chicago")).toBe("America/Matamoros");
    expect(stopZone({ country: "MX", address: { state: "TAMS", city: "Tampico" } }, "America/Chicago")).toBe("America/Monterrey");
    expect(stopZone({ country: "MX", address: { state: "COAH", city: "Piedras Negras" } }, "America/Chicago")).toBe("America/Matamoros");
    expect(stopZone({ country: "MX", address: { state: "COAH", city: "Ramos Arizpe" } }, "America/Chicago")).toBe("America/Monterrey");
    expect(stopZone({ country: "MX", address: { state: "NL", city: "Apodaca" } }, "America/Chicago")).toBe("America/Monterrey");
    expect(stopZone({ country: "MX", address: { state: "Nuevo León", city: "Monterrey" } }, "America/Chicago")).toBe("America/Monterrey");
    expect(stopZone({ country: "MX", address: { state: "CHIH", city: "Ciudad Juárez" } }, "America/Chicago")).toBe("America/Ciudad_Juarez");
    expect(stopZone({ country: "MX", address: { state: "CHIH", city: "Chihuahua" } }, "America/Chicago")).toBe("America/Chihuahua");
    expect(stopZone({ country: "CA", address: { state: "ON", city: "Mississauga" } }, "America/Chicago")).toBe("America/Toronto");
    expect(stopZone({ country: "US", address: { state: "MI", city: "Detroit" } }, "America/Chicago")).toBe("America/Detroit");
    expect(stopZone({ country: "US", address: { state: "TX", city: "El Paso" } }, "America/Detroit")).toBe("America/Denver");
    expect(stopZone({ country: "US", address: { state: "TX", city: "Laredo" } }, "America/Detroit")).toBe("America/Chicago");
    // an Ontario, California stop is not Canada, and a city without its state proves nothing
    expect(zoneFor({ country: "US", city: "Ontario", state: "CA" }, "America/Detroit")).toBe("America/Los_Angeles");
    expect(zoneFor({ country: "US", city: "El Paso" }, "America/Detroit")).toBe("America/Detroit");
  });
});
