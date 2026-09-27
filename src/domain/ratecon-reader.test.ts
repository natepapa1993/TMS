// Features: F-20.3
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { integrations, documents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { createOrder } from "./orders";
import { readRateConForBuilder, attachDraftRateCon, parseRateConResponse, localIso, buildRateConRequest } from "./ratecon-reader";

let a: Awaited<ReturnType<typeof makeTenant>>;
const pdf = { fileName: "ratecon-7781.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 fake") };
const answer = (input: Record<string, unknown>) => async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_load", input }] }), { status: 200, headers: { "content-type": "application/json" } });
const LOAD = {
  customerName: "ACME LOGISTICS INC",
  rate: 3100,
  currency: "USD",
  equipment: "53_dry",
  loadNumber: "L-7781",
  po: "PO-0042",
  freight: [{ commodity: "Auto parts", pieces: 22, weightLb: 18000 }],
  stops: [
    { type: "pickup", name: "Shipper Canton", city: "Canton", state: "mi", country: "US", windowStart: "2026-10-02T08:00:00-04:00", windowEnd: "2026-10-02T14:00:00-04:00", appointment: false, ref: "PU-1" },
    { type: "pickup", name: "Supplier Toledo", city: "Toledo", state: "OH", country: "US", windowStart: "2026-10-02 16:00", appointment: true },
    { type: "delivery", name: "Consignee Toronto", city: "Toronto", state: "ON", country: "Canada", windowStart: "2026-10-03", ref: "DEL-9" },
  ],
  notes: "Tracking required every 2 h",
};

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Reader Carrier");
});

describe("reading a rate con into the builder", () => {
  it("needs the AI reader connected", async () => {
    await expect(readRateConForBuilder(a, pdf, answer(LOAD))).rejects.toThrow(/connect the AI reader/);
  });

  it("fills customer, rate, refs, freight and every stop; matches the customer and saved locations; keeps the paper", async () => {
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-test" } });
    const cust = await create(a, "customer", { name: "Acme Logistics", kind: "broker" });
    await create(a, "customer", { name: "Globex", kind: "customer" });
    const loc = await create(a, "location", { name: "Supplier Toledo", kind: "shipper", country: "US", address: "1 Main St, Toledo, OH 43604, US" });
    const d = await readRateConForBuilder(a, pdf, answer(LOAD));
    expect(d.customerId).toBe(cust.id);
    expect([d.rate, d.currency, d.equipment]).toEqual(["3100.00", "USD", "53_dry"]);
    expect(d.refs).toEqual({ reference: "L-7781", po: "PO-0042" });
    expect(d.freight).toEqual([{ commodity: "Auto parts", pieces: "22", packaging: "", weightLb: "18000", hazmat: false }]);
    expect(d.stops.map((s) => [s.type, s.name, s.country, s.windowStart, s.appointment])).toEqual([
      ["pickup", "Shipper Canton", "US", "2026-10-02T08:00", false],
      ["pickup", "Supplier Toledo", "US", "2026-10-02T16:00", true],
      ["delivery", "Consignee Toronto", "CA", "2026-10-03T00:00", false],
    ]);
    expect(d.stops[0].state).toBe("MI");
    expect(d.stops[1].locationId).toBe(loc.id);
    expect(d.warnings).toEqual([]);
    const [doc] = await db.select().from(documents).where(eq(documents.id, d.documentId));
    expect([doc.subjectKind, doc.code, doc.fileName]).toEqual(["draft_load", "RATE_CON", "ratecon-7781.pdf"]);

    // the load made from it carries the paper
    const o = await createOrder(a, { customerId: cust.id, rateCents: 310000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "CA" }] });
    await attachDraftRateCon(a, d.documentId, o.order.id);
    const [after] = await db.select().from(documents).where(eq(documents.id, d.documentId));
    expect([after.subjectKind, after.subjectId]).toEqual(["order", o.order.id]);
  });

  it("says so when the customer is not on file or a stop is missing; never picks between two equal matches", async () => {
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-test" } });
    await create(a, "customer", { name: "Acme East", kind: "broker" });
    await create(a, "customer", { name: "Acme West", kind: "broker" });
    const d = await readRateConForBuilder(a, pdf, answer({ ...LOAD, customerName: "Acme", stops: [LOAD.stops[0]] }));
    expect(d.customerId).toBeNull();
    expect(d.warnings.join(" ")).toMatch(/not a customer on file/);
    expect(d.warnings.join(" ")).toMatch(/no delivery/);
  });

  it("refuses what it cannot read", async () => {
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-test" } });
    await expect(readRateConForBuilder(a, { ...pdf, mimeType: "application/zip" }, answer(LOAD))).rejects.toThrow(/PDF, JPG or PNG/);
    const bad = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    await expect(readRateConForBuilder(a, pdf, bad)).rejects.toThrow(/invalid x-api-key/);
  });
});

describe("pure parts", () => {
  it("dates for a datetime-local input", () => {
    expect(localIso("2026-10-02T08:00:00-05:00")).toBe("2026-10-02T08:00");
    expect(localIso("2026-10-02 08:00")).toBe("2026-10-02T08:00");
    expect(localIso("Oct 2")).toBe("");
  });
  it("the request sends the PDF and asks for every stop in order", () => {
    const body = buildRateConRequest({ apiKey: "k" }, pdf) as { messages: { content: { type: string }[] }[]; tool_choice: { name: string } };
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.tool_choice.name).toBe("record_load");
  });
  it("an answer with no tool call is an error", () => {
    expect(() => parseRateConResponse({ content: [] })).toThrow(/nothing/);
  });
});
