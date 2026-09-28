// Features: F-1.3
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { autoMap, previewImport, commitImport, csvTemplate, parseCsv } from "./import";
import { coerce, parseAddress, parseDate } from "./fields";
import { list, get } from "./records";

// F-1.3 CSV import: auto-map, preview with row-level problems, de-dup on unique key, commit

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
});

describe("coercion (F-1.2 field rules)", () => {
  it("turns strings into typed values and reports problems by field", () => {
    const r = coerce("truck", { unitNumber: "2117", year: "2019", mxPlateClass: "Brown (border zone)", usPlateExpires: "03/15/2027", note: "" });
    expect(r.ok).toBe(true);
    expect(r.values.year).toBe(2019);
    expect(r.values.mxPlateClass).toBe("brown");
    expect((r.values.usPlateExpires as Date).toISOString()).toMatch(/^2027-03-15/);
    expect("note" in r.values).toBe(false);
    const bad = coerce("truck", { unitNumber: "", year: "abc", mxPlateClass: "purple" });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(["mxPlateClass", "unitNumber", "year"]);
  });
  it("parses money, dates, addresses", () => {
    expect(coerce("carrierRate", { carrierId: "x", originZone: "a", destinationZone: "b", rateCents: "$1,250.50" }).values.rateCents).toBe(125050);
    expect(parseDate("2027-01-31")!.toISOString()).toMatch(/^2027-01-31/);
    expect(parseDate("1/31/27")!.toISOString()).toMatch(/^2027-01-31/);
    expect(parseDate("nope")).toBeNull();
    expect(parseAddress("123 Main St, Laredo, TX 78045, US")).toEqual({ line1: "123 Main St", city: "Laredo", state: "TX", postalCode: "78045", country: "US" });
  });
});

describe("CSV import (F-1.3)", () => {
  const csv = `Unit #,Type,US plate,MX plate,MX plate class,US plate expires
2117,Tractor,RC59022,35ES3A,brown,2027-03-15
2109,Tractor,TX1,MX1,Blue (interior Mexico),2027-03-15
2117,Tractor,RC59022,35ES3A,brown,2027-03-15
,Tractor,TX9,,,
2104,Tractor,TX2,,,`;

  it("auto-maps headers by label, previews with actions, and de-dups within the file", async () => {
    const { headers } = parseCsv(csv);
    const map = autoMap("truck", headers);
    expect(map["Unit #"]).toBe("unitNumber");
    expect(map["MX plate class"]).toBe("mxPlateClass");
    expect(map["Type"]).toBe("equipmentType");
    const p = await previewImport(a, "truck", csv);
    expect(p.summary).toEqual({ total: 5, insert: 3, update: 0, skip: 2 });
    expect(p.rows[2].errors._row).toMatch(/duplicate/);
    expect(p.rows[3].errors.unitNumber).toMatch(/required/);
  });

  it("commits inserts, then a second import of the same file updates instead of duplicating", async () => {
    const r1 = await commitImport(a, "truck", "trucks.csv", csv);
    expect(r1.inserted).toBe(3);
    expect(r1.errors.length).toBe(2);
    expect((await list(a, "truck")).length).toBe(3);
    const csv2 = `Unit #,Make,US plate expires\n2117,Freightliner,2028-01-01\n2200,Volvo,`;
    const p2 = await previewImport(a, "truck", csv2);
    expect(p2.summary.update).toBe(1);
    expect(p2.summary.insert).toBe(1);
    const r2 = await commitImport(a, "truck", "trucks2.csv", csv2);
    expect(r2.updated).toBe(1);
    expect(r2.inserted).toBe(1);
    const all = await list(a, "truck");
    expect(all.length).toBe(4);
    const t2117 = all.find((t) => t.unitNumber === "2117")!;
    expect(t2117.make).toBe("Freightliner");
    expect(t2117.mxPlate).toBe("35ES3A"); // blank columns never wipe existing data
    const again = await get(a, "truck", t2117.id);
    expect((again.usPlateExpires as Date).toISOString()).toMatch(/^2028-01-01/);
  });

  it("drivers import resolves nothing it cannot, and the template round-trips", async () => {
    const tpl = csvTemplate("driver");
    const { headers } = parseCsv(tpl);
    const map = autoMap("driver", headers);
    expect(Object.values(map).filter(Boolean).length).toBe(headers.length);
    const p = await previewImport(a, "driver", "Name,Driver type,Phone\nBenjamín Xochihua,B-1 (Mexican; crossing only),+52 867 111 2222\nMartín Martínez,B1,");
    expect(p.rows[0].action).toBe("insert"); // the label typed with a semicolon still reads as the option
    expect(p.rows[0].values.driverType).toBe("B1");
    expect(p.rows[1].action).toBe("insert");
    expect(p.rows[1].values.driverType).toBe("B1");
  });
});
