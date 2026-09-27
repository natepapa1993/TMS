import { describe, it, expect } from "vitest";
import { checkDriver, checkTruck, summarize } from "./eligibility";

const future = new Date(Date.now() + 365 * 86400_000);
const past = new Date(Date.now() - 86400_000);

const b1 = { id: "d1", name: "B. Xochihua", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future };
const cdl = { id: "d2", name: "D. Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future };
const dual = { id: "d3", name: "A. Cruz", driverType: "DUAL", licenseExpires: future, mxLicenseExpires: future, medicalExpires: future, fastExpires: future, i94Until: future };

const brown = { id: "t1", unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future };
const blue = { id: "t2", unitNumber: "2109", usPlate: "TX1", mxPlate: "MX1", mxPlateClass: "blue", usPlateExpires: future, mxPlateExpires: future };
const usOnly = { id: "t3", unitNumber: "2104", usPlate: "TX2", usPlateExpires: future };

describe("driver eligibility (Plan §7, spec §11.7)", () => {
  it("B-1 is blocked on US and domestic legs with no override", () => {
    for (const lt of ["us", "domestic"] as const) {
      const s = summarize(checkDriver(b1, lt));
      expect(s.ok).toBe(false);
      expect(s.hardBlocked).toBe(true);
      expect(s.findings[0].code).toBe("b1_domestic");
    }
  });
  it("B-1 is fine on MX and crossing legs", () => {
    expect(summarize(checkDriver(b1, "mx")).ok).toBe(true);
    expect(summarize(checkDriver(b1, "crossing")).ok).toBe(true);
  });
  it("CDL is fine on US/domestic, blocked (overridable) on interior Mexico", () => {
    expect(summarize(checkDriver(cdl, "us")).ok).toBe(true);
    const s = summarize(checkDriver(cdl, "mx"));
    expect(s.ok).toBe(false);
    expect(s.hardBlocked).toBe(false);
  });
  it("DUAL runs anything", () => {
    for (const lt of ["mx", "crossing", "us", "domestic"] as const) expect(summarize(checkDriver(dual, lt)).ok).toBe(true);
  });
  it("expired legal documents are hard blocks", () => {
    expect(summarize(checkDriver({ ...b1, fastExpires: past }, "crossing")).hardBlocked).toBe(true);
    expect(summarize(checkDriver({ ...b1, i94Until: past }, "mx")).hardBlocked).toBe(true);
    expect(summarize(checkDriver({ ...cdl, medicalExpires: past }, "us")).hardBlocked).toBe(true);
    expect(summarize(checkDriver({ ...cdl, licenseExpires: past }, "domestic")).hardBlocked).toBe(true);
  });
  it("commercial-zone-only drivers cannot leave the zone", () => {
    expect(summarize(checkDriver({ ...dual, commercialZoneOnly: true }, "us")).hardBlocked).toBe(true);
    expect(summarize(checkDriver({ ...dual, commercialZoneOnly: true }, "crossing")).ok).toBe(true);
  });
});

describe("truck eligibility (Plan §7, spec §6.5)", () => {
  it("brown plates cross but cannot run interior Mexico", () => {
    expect(summarize(checkTruck(brown, "crossing")).ok).toBe(true);
    const s = summarize(checkTruck(brown, "mx"));
    expect(s.hardBlocked).toBe(true);
    expect(s.findings[0].code).toBe("brown_interior");
  });
  it("blue plates run interior Mexico and the crossing", () => {
    expect(summarize(checkTruck(blue, "mx")).ok).toBe(true);
    expect(summarize(checkTruck(blue, "crossing")).ok).toBe(true);
  });
  it("a US-only truck cannot cross or run Mexico", () => {
    expect(summarize(checkTruck(usOnly, "crossing")).hardBlocked).toBe(true);
    expect(summarize(checkTruck(usOnly, "mx")).hardBlocked).toBe(true);
    expect(summarize(checkTruck(usOnly, "us")).ok).toBe(true);
  });
  it("out-of-service and expired plates block", () => {
    expect(summarize(checkTruck({ ...blue, status: "oos" }, "us")).hardBlocked).toBe(true);
    expect(summarize(checkTruck({ ...blue, mxPlateExpires: past }, "crossing")).hardBlocked).toBe(true);
  });
  it("an expired inspection is a warning, not a block", () => {
    const s = summarize(checkTruck({ ...usOnly, dotInspectionExpires: past }, "us"));
    expect(s.ok).toBe(true);
    expect(s.findings[0].level).toBe("yellow");
  });
});
