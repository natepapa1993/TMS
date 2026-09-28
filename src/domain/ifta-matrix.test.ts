// Features: F-32.24 IFTA rate matrix import (owner #21): the published CSV, preview, save
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { db } from "@/db/client";
import { iftaRates } from "@/db/schema";
import { parseRateMatrix, matrixJurisdiction, rateNumber } from "./ifta-matrix";
import { previewRateMatrix, importRateMatrix, setRates } from "./ifta";

/** Shaped like the matrix IFTA, Inc. publishes: title lines, a header, a U.S./Gal and a Can./Liter line per jurisdiction, footnote marks, a surcharge line. */
const MATRIX = `IFTA Tax Rate Matrix,,,,,
3rd Quarter 2026,,,,,
Jurisdiction,Rate Type,Gasoline,Special Diesel,Gasohol,Propane
Alabama,U.S./Gal,0.2900,0.3000,0.2900,0.0000
,Can./Liter,0.1049,0.1085,0.1049,0.0000
AR,U.S./Gal,0.2450,0.2850*,0.2450,0.1650
AR,Can./Liter,0.0886,0.1031,0.0886,0.0597
Kentucky,U.S./Gal,0.2600,0.2330,0.2600,0.2600
Kentucky Surcharge,U.S./Gal,0.0000,0.0200,0.0000,0.0000
Kentucky Surcharge,Can./Liter,0.0000,0.0072,0.0000,0.0000
Michigan,U.S./Gal,0.3100,0.3100,0.3100,0.3100
Oklahoma,U.S./Gal,0.2000,$0.1900,0.2000,0.1600
Texas,U.S./Gal,0.2000,0.2000,0.2000,0.0000
Ontario,U.S./Gal,0.3316,0.3995,0.3316,0.1236
Ontario,Can./Liter,0.1200,0.1430,0.1200,0.0430
Quebec,Can./Liter,0.1920,0.2020,0.1920,0.0000
District of Columbia,U.S./Gal,0.3500,0.3500,,
* Rate change effective August 1,,,,,
`;

describe("reading the matrix (pure)", () => {
  it("jurisdiction names, codes and footnote marks", () => {
    expect(matrixJurisdiction("Alabama")).toBe("AL");
    expect(matrixJurisdiction("KY*")).toBe("KY");
    expect(matrixJurisdiction("Kentucky Surcharge")).toBe("KY");
    expect(matrixJurisdiction("British Columbia")).toBe("BC");
    expect(matrixJurisdiction("NL - Newfoundland")).toBe("NL");
    expect(matrixJurisdiction("District of Columbia")).toBeNull();
    expect(matrixJurisdiction("U.S./Gal")).toBeNull();
    expect(rateNumber("$0.2850*")).toBe(0.285);
    expect(rateNumber("")).toBeNull();
    expect(rateNumber("n/a")).toBeNull();
  });

  it("takes Special Diesel in US $ per gallon, adds the surcharge, and says what it skipped", () => {
    const p = parseRateMatrix(MATRIX);
    expect(p.column).toBe("Special Diesel");
    const by = Object.fromEntries(p.rows.map((r) => [r.jurisdiction, r]));
    expect(Object.keys(by)).toEqual(["AL", "AR", "KY", "MI", "OK", "ON", "TX"]);
    expect(by.AL.rate).toBe(0.3); // not the Canadian litre line under it
    expect(by.AR.rate).toBe(0.285);
    expect(by.KY).toMatchObject({ rate: 0.233, surcharge: 0.02 });
    expect(by.OK.rate).toBe(0.19);
    expect(by.ON.rate).toBe(0.3995);
    expect(by.TX.surcharge).toBeNull();
    const reasons = p.skipped.map((s) => s.reason).join(" | ");
    expect(reasons).toMatch(/District of Columbia.*not an IFTA jurisdiction/);
    expect(reasons).toMatch(/QC: only a Canadian \$ per litre line/);
  });

  it("a plain sheet works too: jurisdiction, rate, surcharge", () => {
    const p = parseRateMatrix("Jurisdiction,Rate,Surcharge\nTX,0.20,\nKY,0.233,0.02\nXX,0.1,\n");
    expect(p.rows.map((r) => [r.jurisdiction, r.rate, r.surcharge])).toEqual([
      ["KY", 0.233, 0.02],
      ["TX", 0.2, null],
    ]);
    expect(p.skipped[0].reason).toMatch(/XX/);
  });
});

describe("importing for a quarter", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  beforeEach(async () => {
    await truncateAll();
    a = await makeTenant("IFTA Carrier");
  });

  it("previews against what's on file, saves nothing until asked, then saves every rate", async () => {
    await setRates(a, "2026Q3", [
      { jurisdiction: "TX", rate: 0.2 },
      { jurisdiction: "MI", rate: 0.3 },
      { jurisdiction: "NM", rate: 0.21 },
    ]);
    const prev = await previewRateMatrix(a, "2026Q3", MATRIX);
    const by = Object.fromEntries(prev.rows.map((r) => [r.jurisdiction, r]));
    expect(by.TX.change).toBe("same");
    expect(by.MI).toMatchObject({ change: "changed", currentRate: 0.3, rate: 0.31 });
    expect(by.AL.change).toBe("new");
    expect(prev.missing).toContain("NM");
    expect((await db.select().from(iftaRates).where(eq(iftaRates.tenantId, a.tenantId))).length).toBe(3); // a preview saves nothing

    const r = await importRateMatrix(a, "2026Q3", MATRIX);
    expect(r).toMatchObject({ saved: 7, changed: 1 });
    const [ky] = await db.select().from(iftaRates).where(and(eq(iftaRates.tenantId, a.tenantId), eq(iftaRates.jurisdiction, "KY")));
    expect(ky).toMatchObject({ quarter: "2026Q3", rateE4: 2330, surchargeE4: 200 });
    const [nm] = await db.select().from(iftaRates).where(and(eq(iftaRates.tenantId, a.tenantId), eq(iftaRates.jurisdiction, "NM")));
    expect(nm.rateE4).toBe(2100); // not in the file: kept
  });

  it("a file that isn't the matrix says so; billing permission needed", async () => {
    await expect(previewRateMatrix(a, "2026Q3", "name,phone\nBob,555\n")).rejects.toThrow(/IFTA tax rate matrix/);
    await expect(previewRateMatrix({ ...a, role: "dispatcher" }, "2026Q3", MATRIX)).rejects.toThrow(/permission/);
  });
});
