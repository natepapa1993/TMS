// Features: F-8 EDI 204 / 214 / 210 / 990 / 997 — the X12 layer, no database
import { describe, it, expect } from "vitest";
import { wrap, parse, transactionSets, envelopeOf, build997, parse997, type Envelope } from "./x12";
import { build214, build210, build990, parse204, DEFAULT_214_MAP } from "./messages";

const env: Envelope = { senderQualifier: "02", senderId: "BSTW", receiverQualifier: "ZZ", receiverId: "RXO", usage: "T", controlNumber: 42, functionalId: "QM", transactionSet: "214", at: new Date("2026-09-26T21:05:00Z") };

const SAMPLE_204 = `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260926*1400*U*00401*000000123*0*T*>~
GS*SM*RXO*BSTW*20260926*1400*123*X*004010~
ST*204*0001~
B2**BSTW**RC-778812**PP~
B2A*00~
L11*RC-778812*RC~
L11*4500991*PO~
L11*BOL-55*BM~
N1*BT*RXO Expedite*93*RXO1~
N3*11 Broker Way~
N4*Charlotte*NC*28202*US~
N7**TRLR123*********TV****53~
S5*1*CL*12000*L*10*PLT~
G62*37*20260927*1*0800~
G62*38*20260927*1*1200~
N1*SH*Planta Monterrey*93*MTY-1~
N3*Av. Industrial 100~
N4*Monterrey*NL*64000*MX~
L5*1*AUTO PARTS~
NTE*OTH*Ask for Ing. Perez at gate 3~
S5*2*CU*12000*L*10*PLT~
G62*68*20260928*1*1500~
N1*CN*GM Arlington*93*GM-ARL~
N3*2525 E Abram St~
N4*Arlington*TX*76010*US~
L3*12000*G***285000~
SE*25*0001~
GE*1*123~
IEA*1*000000123~`;

describe("x12 codec", () => {
  it("wraps a body in ISA/GS/ST … SE/GE/IEA with padded ids and counts, and parses it back", () => {
    const text = wrap([["B10", "26-00001", "RC-1", "BSTW"], ["LX", "1"]], env);
    expect(text.split("\n")[0]).toBe("ISA*00*          *00*          *02*BSTW           *ZZ*RXO            *260926*2105*U*00401*000000042*0*T*>~");
    expect(text).toContain("GS*QM*BSTW*RXO*20260926*2105*42*X*004010~");
    expect(text).toContain("ST*214*0042~");
    expect(text).toContain("SE*4*0042~"); // ST + 2 body + SE
    const p = parse(text);
    expect(p.delims).toEqual({ element: "*", segment: "~", sub: ">" });
    const sets = transactionSets(p.segments);
    expect(sets).toHaveLength(1);
    expect(sets[0].type).toBe("214");
    expect(sets[0].segments[0]).toEqual(["B10", "26-00001", "RC-1", "BSTW"]);
    expect(envelopeOf(p.segments)).toMatchObject({ senderId: "BSTW", receiverId: "RXO", usage: "T", functionalId: "QM", isaControl: "000000042" });
  });

  it("refuses text that is not an interchange or has unbalanced ST/SE", () => {
    expect(() => parse("hello")).toThrow(/ISA/);
    expect(() => parse("ISA*00*          *00*          *ZZ*A              *ZZ*B              *260926*1400*U*00401*000000001*0*T*>~ST*214*0001~")).toThrow(/ST\/SE/);
  });

  it("997 acknowledges each set and the group", () => {
    const body = build997({ ackFunctionalId: "SM", ackGroupControl: "123", sets: [{ type: "204", control: "0001", ok: true }, { type: "204", control: "0002", ok: false }] });
    expect(body).toEqual([["AK1", "SM", "123"], ["AK2", "204", "0001"], ["AK5", "A"], ["AK2", "204", "0002"], ["AK5", "R", "5"], ["AK9", "P", "2", "2", "1"]]);
    const text = wrap(body, { ...env, functionalId: "FA", transactionSet: "997" });
    const back = parse997(transactionSets(parse(text).segments)[0].segments);
    expect(back.status).toBe("P");
    expect(back.sets.map((s) => s.status)).toEqual(["A", "R"]);
  });
});

describe("214 shipment status", () => {
  it("carries our ref, their ref, SCAC, references, parties, the status with UTC time, the unit and an ETA", () => {
    const body = build214({
      ourRef: "26-00001",
      theirRef: "RC-778812",
      scac: "BSTW",
      refs: [{ qualifier: "PO", value: "4500991" }, { qualifier: "BM", value: "" }],
      shipper: { name: "Planta Monterrey", city: "Monterrey", state: "NL", country: "MX" },
      consignee: { name: "GM Arlington", line1: "2525 E Abram St", city: "Arlington", state: "TX", postalCode: "76010", country: "US" },
      status: { code: DEFAULT_214_MAP.at_delivery.code, at: new Date("2026-09-28T14:35:00Z"), city: "Arlington", state: "TX", country: "US" },
      equipment: { number: "2117" },
      eta: new Date("2026-09-28T15:00:00Z"),
    });
    expect(body.map((s) => s.join("*"))).toEqual([
      "B10*26-00001*RC-778812*BSTW",
      "L11*4500991*PO",
      "N1*SH*Planta Monterrey",
      "N4*Monterrey*NL**MX",
      "N1*CN*GM Arlington",
      "N3*2525 E Abram St",
      "N4*Arlington*TX*76010*US",
      "LX*1",
      "AT7*X1****20260928*1435*UT",
      "MS1*Arlington*TX*US",
      "MS2*BSTW*2117",
      "AT7*X2****20260928*1500*UT",
    ]);
  });
});

describe("210 invoice", () => {
  it("B3 with amounts in implied cents, currency, refs, bill-to, one LX/L5/L1 per charge, L3 total", () => {
    const body = build210({
      invoiceNumber: "247-000001",
      theirRef: "RC-778812",
      scac: "BSTW",
      currency: "USD",
      issuedAt: new Date("2026-09-29T00:00:00Z"),
      deliveredAt: new Date("2026-09-28T00:00:00Z"),
      totalCents: 296250,
      refs: [{ qualifier: "PO", value: "4500991" }],
      billTo: { name: "RXO Expedite", line1: "11 Broker Way", city: "Charlotte", state: "NC", postalCode: "28202", country: "US" },
      lines: [
        { description: "Line haul", kind: "linehaul", qty: 1, unit: "flat", rateCents: 285000, amountCents: 285000 },
        { description: "Detention at pickup 1.50 h", kind: "detention", qty: 150, unit: "h", rateCents: 7500, amountCents: 11250 },
      ],
      weightLbs: 12000,
    });
    const lines = body.map((s) => s.join("*"));
    expect(lines[0]).toBe("B3**247-000001*RC-778812*PP**20260929*296250**20260928**BSTW");
    expect(lines[1]).toBe("C3*USD");
    expect(lines).toContain("N9*PO*4500991");
    expect(lines).toContain("N1*BT*RXO Expedite");
    expect(lines).toContain("L1*1**FR*285000****400****Line haul");
    expect(lines).toContain("L0*2*1.50*HR");
    expect(lines).toContain("L1*2*75.00*PH*11250****DTL****Detention at pickup 1.50 h");
    expect(lines[lines.length - 1]).toBe("L3*12000*G***296250");
  });
});

describe("204 load tender", () => {
  it("reads the RXO-style tender: refs, bill-to, equipment, two stops with windows, parties and notes, weight and rate", () => {
    const p = parse(SAMPLE_204);
    expect(envelopeOf(p.segments)).toMatchObject({ senderId: "RXO", receiverId: "BSTW", functionalId: "SM", gsControl: "123" });
    const set = transactionSets(p.segments)[0];
    expect(set.type).toBe("204");
    const t = parse204(set.segments);
    expect(t.purpose).toBe("original");
    expect(t.theirRef).toBe("RC-778812");
    expect(t.refs).toEqual({ rate_con: "RC-778812", po: "4500991", bol: "BOL-55" });
    expect(t.parties.BT).toMatchObject({ name: "RXO Expedite", city: "Charlotte", state: "NC", postalCode: "28202" });
    expect(t.equipment).toEqual({ code: "TV", number: "TRLR123", length: 53 });
    expect(t.stops).toHaveLength(2);
    expect(t.stops[0]).toMatchObject({ seq: 1, type: "pickup", pieces: 10, weightLbs: 12000, commodity: "AUTO PARTS", appointment: false });
    expect(t.stops[0].party).toMatchObject({ name: "Planta Monterrey", line1: "Av. Industrial 100", city: "Monterrey", state: "NL", country: "MX" });
    expect(t.stops[0].earliest?.toISOString()).toBe("2026-09-27T08:00:00.000Z");
    expect(t.stops[0].latest?.toISOString()).toBe("2026-09-27T12:00:00.000Z");
    expect(t.stops[0].notes).toEqual(["Ask for Ing. Perez at gate 3"]);
    expect(t.stops[1]).toMatchObject({ seq: 2, type: "delivery" });
    expect(t.stops[1].party?.name).toBe("GM Arlington");
    expect(t.stops[1].earliest?.toISOString()).toBe("2026-09-28T15:00:00.000Z");
    expect(t.totalWeightLbs).toBe(12000);
    expect(t.rateCents).toBe(285000);
  });

  it("a cancellation needs only the shipment id; a tender without stops is refused", () => {
    const cancel = parse204([["B2", "", "BSTW", "", "RC-778812", "", "PP"], ["B2A", "01"]]);
    expect(cancel.purpose).toBe("cancel");
    expect(() => parse204([["B2", "", "BSTW", "", "RC-1", "", "PP"], ["B2A", "00"]])).toThrow(/stops/);
    expect(() => parse204([["B2A", "00"]])).toThrow(/B2/);
  });

  it("990 accepts or declines by the customer's shipment id", () => {
    expect(build990({ scac: "BSTW", theirRef: "RC-778812", accept: true, at: new Date("2026-09-26T21:05:00Z"), refs: [{ qualifier: "PO", value: "4500991" }] }).map((s) => s.join("*"))).toEqual(["B1*BSTW*RC-778812*20260926*A", "N9*PO*4500991"]);
    expect(build990({ scac: "BSTW", theirRef: "RC-778812", accept: false, at: new Date("2026-09-26T21:05:00Z"), note: "no B-1 team available" }).map((s) => s.join("*"))).toEqual(["B1*BSTW*RC-778812*20260926*D", "K1*no B-1 team available"]);
  });
});
