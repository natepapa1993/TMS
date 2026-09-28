// Features: F-20.8
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { createOrder, getOrder } from "./orders";
import { saveTemplate, listTemplates, deleteTemplate, templateFromOrder, loadsFromTemplate, templateDraft } from "./load-templates";
import type { LoadTemplateData } from "@/db/schema";

let a: Awaited<ReturnType<typeof makeTenant>>;
let cust: string;
const lane = (c: string): LoadTemplateData => ({
  customerId: c,
  brokerId: null,
  billingEntityId: null,
  equipment: "53_dry",
  rateCents: 180000,
  currency: "USD",
  refs: {},
  freight: [{ commodity: "Seats", pieces: 26 }],
  cargoNote: null,
  stops: [
    { type: "pickup", locationId: null, name: "Shipper Canton", city: "Canton", state: "MI", country: "US", dayOffset: 0, from: "08:00", to: "14:00", appointment: false },
    { type: "delivery", locationId: null, name: "Consignee Toronto", city: "Toronto", state: "ON", country: "CA", dayOffset: 1, from: "06:30", to: "", appointment: true },
  ],
});

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Template Carrier");
  cust = (await create(a, "customer", { name: "Acme Logistics", kind: "broker" })).id;
});

describe("load templates", () => {
  it("validates: a name, a pickup and a delivery, HH:MM times, no duplicate names", async () => {
    await expect(saveTemplate(a, { name: " ", data: lane(cust) })).rejects.toThrow(/name/);
    await expect(saveTemplate(a, { name: "x", data: { ...lane(cust), stops: [lane(cust).stops[0]] } })).rejects.toThrow(/pickup and a delivery/);
    await expect(saveTemplate(a, { name: "x", data: { ...lane(cust), stops: [{ ...lane(cust).stops[0], from: "8am" }, lane(cust).stops[1]] } })).rejects.toThrow(/HH:MM/);
    await saveTemplate(a, { name: "Canton → Toronto", data: lane(cust) });
    await expect(saveTemplate(a, { name: "canton → toronto", data: lane(cust) })).rejects.toThrow(/already exists/);
    const list = await listTemplates(a);
    expect(list.map((t) => [t.name, t.customer])).toEqual([["Canton → Toronto", "Acme Logistics"]]);
    await deleteTemplate(a, list[0].id);
    expect(await listTemplates(a)).toEqual([]);
  });

  it("builds loads for several dates, each stop at its local time in its own zone", async () => {
    const { id } = await saveTemplate(a, { name: "Canton → Toronto", data: lane(cust) });
    const r = await loadsFromTemplate(a, id, ["2026-11-03", "2026-11-02", "2026-11-03"], { book: true });
    expect(r.failed).toEqual([]);
    expect(r.created.map((c) => c.date)).toEqual(["2026-11-02", "2026-11-03"]);
    const o = await getOrder(a, r.created[0].orderId);
    expect(o.order.state).toBe("booked");
    expect(o.order.rateCents).toBe(180000);
    // Nov 2, 2026: Detroit is EST (UTC-5) → 08:00 local = 13:00Z; Toronto next day 06:30 EST = 11:30Z
    expect(o.stops[0].windowStart?.toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(o.stops[0].windowEnd?.toISOString()).toBe("2026-11-02T19:00:00.000Z");
    expect(o.stops[1].windowStart?.toISOString()).toBe("2026-11-03T11:30:00.000Z");
    expect(o.stops[1].appointment).toBe(true);
    expect(o.legs.map((l) => l.type)).toEqual(["crossing"]);
    const [t] = await listTemplates(a);
    expect(t.timesUsed).toBe(2);
  });

  it("a load becomes a template: times of day kept at each stop, days counted from the first stop", async () => {
    const o = await createOrder(a, {
      customerId: cust,
      rateCents: 90000,
      stops: [
        { type: "pickup", name: "Plant Toledo", country: "US", address: { city: "Toledo", state: "OH" }, windowStart: new Date("2026-10-05T12:00:00Z") }, // 08:00 EDT
        { type: "delivery", name: "DC Dallas", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date("2026-10-06T19:00:00Z") }, // 14:00 CDT
      ],
    });
    await templateFromOrder(a, o.order.id, "Toledo → Dallas");
    const [t] = await listTemplates(a);
    expect(t.data.stops.map((x) => [x.name, x.dayOffset, x.from])).toEqual([
      ["Plant Toledo", 0, "08:00"],
      ["DC Dallas", 1, "14:00"],
    ]);
    const d = await templateDraft(a, t.id, "2026-12-01"); // EST / CST now
    expect(d.stops[0].windowStart).toBe("2026-12-01T13:00:00.000Z");
    expect(d.stops[1].windowStart).toBe("2026-12-02T20:00:00.000Z");
  });

  it("one bad date does not stop the rest", async () => {
    const { id } = await saveTemplate(a, { name: "Lane", data: lane(cust) });
    const r = await loadsFromTemplate(a, id, ["2026-11-02", "not-a-date"]);
    expect(r.created.length).toBe(1);
    expect(r.failed[0].date).toBe("not-a-date");
  });
});
