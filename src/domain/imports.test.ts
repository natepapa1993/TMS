// Features: F-30.8
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, update, get, list } from "@/data/records";
import { autoMap, previewImport, commitImport, parseCsv } from "@/data/import";
import { createOrder } from "./orders";
import { readTable, previewLoads, importLoads, loadWarnings } from "./load-import";

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Import Carrier");
});

describe("driver import reads trucking spreadsheets (owner #4, #5)", () => {
  const SHEET = ["Name,Driver type,CDL #,Exp Date,Med Card Exp,Cell,Truck", "Mike Kowalski,US CDL,MI-K200-555-123,2027-06-30,2027-01-15,+1 734 555 0101,101", "Raj Patel,Dual,ON-P1234-56789,2027-03-31,2026-12-01,+1 734 555 0102,102", "Luis Ortega,B-1 (Mexican; crossing only),,,,+52 867 555 0103,V9"].join("\n");

  it("maps CDL # to the licence number (never to the yes/no field) and knows Cell, Truck, Exp Date, Med Card Exp", () => {
    const map = autoMap("driver", parseCsv(SHEET).headers);
    expect(map["CDL #"]).toBe("licenseNumber");
    expect(map["Exp Date"]).toBe("licenseExpires");
    expect(map["Med Card Exp"]).toBe("medicalExpires");
    expect(map["Cell"]).toBe("phone");
    expect(map["Truck"]).toBe("currentTruckId");
    expect(Object.values(map)).not.toContain("nonDomiciledCdl");
  });

  it("puts each driver on the truck the file names, and says which unit it can't find", async () => {
    const t101 = await create(a, "truck", { unitNumber: "101", usPlate: "MI101" });
    const t102 = await create(a, "truck", { unitNumber: "102", usPlate: "MI102" });
    const p = await previewImport(a, "driver", SHEET);
    expect(p.rows[0].values).toMatchObject({ licenseNumber: "MI-K200-555-123", currentTruckId: t101.id, phone: "+1 734 555 0101" });
    expect(p.rows[1].values).toMatchObject({ driverType: "DUAL", currentTruckId: t102.id });
    expect(p.rows[2].action).toBe("skip");
    expect(p.rows[2].errors.currentTruckId).toBe('Current unit: no truck "V9" on file');
    const r = await commitImport(a, "driver", "drivers.csv", SHEET);
    expect(r.inserted).toBe(2);
    const drivers = await list(a, "driver");
    expect(drivers.find((d) => d.name === "Mike Kowalski")!.currentTruckId).toBe(t101.id);
  });

  it("percent and short labels are read as the option (\"28%\", \"Percent\", \"Sprinter van\")", async () => {
    const p = await previewImport(a, "driver", "Name,Driver type,Pay type,Pay rate\nKevin Walsh,CDL,Percent,28%");
    expect(p.rows[0].values).toMatchObject({ payType: "pct", payRateCents: 2800 });
    const t = await previewImport(a, "truck", "Unit #,Equipment\n501,Sprinter van");
    expect(t.rows[0].errors).toEqual({});
  });
});

describe("one phone number per driver (M23)", () => {
  it("refuses a second driver on the same number, on the record, on edit and in an import", async () => {
    const mateo = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", phone: "+1 956 555 0159" });
    await expect(create(a, "driver", { name: "Carlos Benavides", driverType: "CDL", phone: "(956) 555-0159" })).rejects.toThrow(/Mateo Ruiz already has .* each driver needs their own phone number/);
    const carlos = await create(a, "driver", { name: "Carlos Benavides", driverType: "CDL", phone: "+1 956 555 0160" });
    await expect(update(a, "driver", carlos.id, { phone: "956-555-0159" })).rejects.toThrow(/already has/);
    // editing something else keeps working, even for records that shared a number before the rule
    await update(a, "driver", mateo.id, { hireDate: new Date("2024-01-01") });
    expect((await get(a, "driver", mateo.id)).phone).toBe("+1 956 555 0159");
    const p = await previewImport(a, "driver", "Name,Driver type,Phone\nArturo Garza,B1,+1 956 555 0159\nDenise Carter,CDL,+1 956 555 0170\nBeto Cavazos,CDL,956 555 0170");
    expect(p.rows[0].action).toBe("skip");
    expect(p.rows[0].errors.phone).toMatch(/Mateo Ruiz already has/);
    expect(p.rows[1].action).toBe("insert");
    expect(p.rows[2].errors.phone).toMatch(/already on Denise Carter in this file/);
  });
});

describe("load import and bulk book warn (M12)", () => {
  it("a delivery before its pickup and a PO already on another load are flagged, not blocked", async () => {
    const cust = await create(a, "customer", { name: "Summit Parts", kind: "customer" });
    const old = await createOrder(a, { customerId: cust.id, rateCents: 100000, refs: { po: "SUM-9001" }, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    const csv = [
      "Customer,Rate,PO,Pickup Name,Pickup City,Pickup State,Pickup Date,Pickup Time,Delivery Name,Delivery City,Delivery State,Delivery Date,Delivery Time",
      "Summit Parts,1200,SUM-9001,Plant,Laredo,TX,2026-11-03,08:00,DC,Dallas,TX,2026-11-04,08:00",
      "Summit Parts,1300,SUM-7,Plant,Laredo,TX,2026-11-05,08:00,DC,Dallas,TX,2026-11-04,08:00",
      "Summit Parts,1300,SUM-7,Plant,Laredo,TX,2026-11-06,08:00,DC,Dallas,TX,2026-11-07,08:00",
    ].join("\n");
    const t = await readTable({ fileName: "plan.csv", bytes: Buffer.from(csv) });
    const p = await previewLoads(a, t);
    expect(p.loads[0].warnings).toEqual([`PO SUM-9001 is already on ${old.order.orderNumber}`]);
    expect(p.loads[1].warnings.join("; ")).toMatch(/Stop 2 \(DC\) is scheduled before stop 1/);
    expect(p.loads[2].warnings.join("; ")).toMatch(/PO SUM-7 is also on/);
    expect(p.loads.every((l) => l.errors.length === 0)).toBe(true);
    const r = await importLoads(a, t, { fileName: "plan.csv" });
    expect(r.created).toHaveLength(3); // warnings never stop the import
    expect(r.created[0].warnings[0]).toMatch(/already on/);
    // the same check before booking drafts in bulk (the order itself does not count against itself)
    const w = await loadWarnings(a, [{ key: old.order.orderNumber, customerId: cust.id, refs: old.order.refs, stops: old.stops, orderId: old.order.id }]);
    expect(w.get(old.order.orderNumber)?.[0]).toMatch(/SUM-9001 is already on 26-/);
  });
});
