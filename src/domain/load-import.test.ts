// Features: F-20.8
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { getOrder } from "./orders";
import { readTable, previewLoads, importLoads } from "./load-import";

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Import Carrier");
  await create(a, "customer", { name: "Acme Logistics", kind: "broker" });
});

async function xlsx(rows: (string | number | Date)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Loads");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("importing loads from a sheet", () => {
  it("one row per load (Excel): customer matched, times at each stop's zone, bad rows reported not created", async () => {
    const bytes = await xlsx([
      ["Customer", "Rate", "PO", "Equipment", "Pickup Name", "Pickup City", "Pickup State", "Pickup Date", "Pickup Time", "Delivery Name", "Delivery City", "Delivery State", "Delivery Country", "Delivery Date", "Commodity", "Weight"],
      ["acme logistics", "$1,850.00", "PO-1", "53 dry", "Shipper Canton", "Canton", "MI", new Date(Date.UTC(2026, 10, 2)), "8:00 AM", "Consignee Toronto", "Toronto", "ON", "Canada", "11/03/2026", "Seats", "18,000"],
      ["Globex", "900", "", "", "Plant Toledo", "Toledo", "OH", "2026-11-02", "", "DC Dayton", "Dayton", "OH", "", "2026-11-02", "", ""],
      ["Acme Logistics", "", "", "hovercraft", "", "", "", "someday", "", "DC", "", "", "", "", "", ""],
    ]);
    const t = await readTable({ fileName: "plan.xlsx", bytes });
    const p = await previewLoads(a, t);
    expect(p.layout).toBe("per_load");
    expect(p.loads[0].errors).toEqual([]);
    expect(p.loads[0].customer).toBe("Acme Logistics");
    expect(p.loads[0].stops[0].windowStart?.toISOString()).toBe("2026-11-02T13:00:00.000Z"); // 08:00 EST
    expect(p.loads[0].stops[1].country).toBe("CA");
    expect(p.loads[1].errors).toEqual(['customer "Globex" is not on file']);
    expect(p.loads[2].errors.join("; ")).toMatch(/unknown equipment.*pickup: no location name.*can't read the date "someday"/);
    const r = await importLoads(a, t, { book: true, fileName: "plan.xlsx" });
    expect(r.created.length).toBe(1);
    expect(r.skipped.length).toBe(2);
    const o = await getOrder(a, r.created[0].orderId);
    expect([o.order.state, o.order.rateCents, o.order.refs.po, o.order.source]).toEqual(["booked", 185000, "PO-1", "import"]);
    expect(o.order.freight).toEqual([{ commodity: "Seats", weightLb: 18000 }]);
  });

  it("one row per stop (CSV) groups a multi-stop load by its load number", async () => {
    const csv = ["Load,Customer,Rate,Stop Type,Name,City,State,Country,Date,Time", "L1,Acme Logistics,3100,Pickup,Shipper Canton,Canton,MI,US,2026-11-02,08:00", "L1,,,Pickup,Supplier Toledo,Toledo,OH,US,2026-11-02,13:00", "L1,,,Border yard,Border yard,Nuevo Laredo,TAM,MX,2026-11-04,", "L1,,,Delivery,Planta Monterrey,Monterrey,NL,MX,2026-11-05,09:00", "L2,Acme Logistics,500,Pickup,A,Detroit,MI,US,2026-11-02,"].join("\n");
    const t = await readTable({ fileName: "stops.csv", bytes: Buffer.from(csv) });
    const p = await previewLoads(a, t);
    expect(p.layout).toBe("per_stop");
    expect(p.loads.map((l) => [l.key, l.stops.length, l.errors])).toEqual([
      ["L1", 4, []],
      ["L2", 1, ["no delivery"]],
    ]);
    const r = await importLoads(a, t);
    const o = await getOrder(a, r.created[0].orderId);
    expect(o.stops.map((s) => s.type)).toEqual(["pickup", "pickup", "border_yard", "delivery"]);
    expect(o.legs.map((l) => l.type)).toEqual(["crossing", "mx"]);
    expect(o.stops[3].windowStart?.toISOString()).toBe("2026-11-05T15:00:00.000Z"); // 09:00 Monterrey (UTC-6)
  });

  it("refuses what it cannot read", async () => {
    await expect(readTable({ fileName: "x.pdf", bytes: Buffer.from("x") })).rejects.toThrow(/xlsx or \.csv/);
    const t = await readTable({ fileName: "x.csv", bytes: Buffer.from("Foo,Bar\n1,2") });
    await expect(previewLoads(a, t)).rejects.toThrow(/pickup and delivery columns/);
  });
});
