// Features: F-8 EDI with customers — 204 in → draft order + 997 + 990, 214 per milestone, 210 at issue, inbox accept/decline, cancellation
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { ediMessages, flags, outbox } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import * as E from "./edi";
import * as B from "./billing";
import { getOrder, bookOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, ValidationError } from "./orders";
import { parse, transactionSets } from "@/integrations/edi/x12";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; partner: string; t2104: string; reyes: string };

const tender = (ref: string, opts: { purpose?: "00" | "01" | "04"; control?: string; isa?: string; stops?: string } = {}) => `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260926*1400*U*00401*${(opts.isa ?? "000000123").padStart(9, "0")}*0*T*>~
GS*SM*RXO*BSTW*20260926*1400*${Number(opts.isa ?? 123)}*X*004010~
ST*204*${opts.control ?? "0001"}~
B2**BSTW**${ref}**PP~
B2A*${opts.purpose ?? "00"}~
L11*${ref}*RC~
L11*4500991*PO~
N1*BT*RXO Expedite*93*RXO1~
N4*Charlotte*NC*28202*US~
N7**TRLR123*********TV****53~
${
  opts.stops ??
  `S5*1*CL*12000*L*10*PLT~
G62*37*20260927*1*0800~
N1*SH*Planta Monterrey~
N3*Av. Industrial 100~
N4*Monterrey*NL*64000*MX~
L5*1*AUTO PARTS~
S5*2*CU*12000*L*10*PLT~
G62*68*20260928*1*1500~
N1*CN*GM Arlington~
N3*2525 E Abram St~
N4*Arlington*TX*76010*US~`
}
L3*12000*G***285000~
SE*20*${opts.control ?? "0001"}~
GE*1*${Number(opts.isa ?? 123)}~
IEA*1*${(opts.isa ?? "000000123").padStart(9, "0")}~`;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", nextInvoiceNumber: 1, isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, billingEmail: "ap@rxo.test", requiredDocs: [] });
  const partner = await create(a, "ediPartner", { customerId: rxo.id, theirId: "RXO", theirQualifier: "ZZ", ourId: "BSTW", ourQualifier: "02", scac: "BSTW", usage: "T", send214: true, send210: true, accept204: true, autoCreateOrders: true, delivery: "pickup", enabled: true });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
  f = { rxo: rxo.id, partner: partner.id, t2104: t2104.id, reyes: reyes.id };
});

const outMessages = (type?: string) => db.select().from(ediMessages).where(type ? and(eq(ediMessages.direction, "out"), eq(ediMessages.type, type)) : eq(ediMessages.direction, "out"));

describe("inbound 204", () => {
  it("a tender becomes a draft cross-border order with the customer's refs, windows and stops as sent; 997 and 990 go back; a repeat is refused", async () => {
    const r = await E.receiveInterchange(f.partner, tender("RC-778812"));
    expect(r.sets).toHaveLength(1);
    expect(r.sets[0].ok).toBe(true);
    expect(r.sets[0].note).toMatch(/draft 26-00001 created/);
    const o = await getOrder(a, r.sets[0].orderId!);
    expect(o.order.state).toBe("draft");
    expect(o.order.source).toBe("edi204");
    expect(o.order.sourceRef).toBe("RC-778812");
    expect(o.order.refs).toMatchObject({ rate_con: "RC-778812", po: "4500991" });
    expect(o.order.rateCents).toBe(285000);
    expect(o.order.legTemplate).toBe("stops");
    expect(o.stops.map((s) => `${s.type}:${s.name}:${s.country}`)).toEqual(["pickup:Planta Monterrey:MX", "delivery:GM Arlington:US"]); // the customer's stops, nothing invented
    expect(o.stops[0].windowStart?.toISOString()).toBe("2026-09-27T14:00:00.000Z"); // 08:00 in Monterrey (UTC-6), not 08:00Z
    expect(o.stops[1].windowStart?.toISOString()).toBe("2026-09-28T20:00:00.000Z"); // 15:00 in Arlington TX (CDT)
    expect(o.stops[0].address).toMatchObject({ line1: "Av. Industrial 100", city: "Monterrey", state: "NL" });
    expect(o.stops[0].notes).toContain("AUTO PARTS");
    expect(o.legs.map((l) => l.type)).toEqual(["crossing"]);
    // 997 immediately
    const ack = (await outMessages("997"))[0];
    expect(ack.content).toContain("AK1*SM*123~");
    expect(ack.content).toContain("AK9*A*1*1*1~");
    expect(ack.content).toContain("ISA*00*          *00*          *02*BSTW           *ZZ*RXO            *");
    expect(ack.state).toBe("logged"); // pickup delivery: waiting for their connector / download
    // 990 accept from the ticker
    expect((await E.send990ForAutoAccepted()).sent).toBe(1);
    expect((await E.send990ForAutoAccepted()).sent).toBe(0);
    const n990 = (await outMessages("990"))[0];
    expect(n990.content).toContain("B1*BSTW*RC-778812*");
    expect(n990.content).toMatch(/B1\*BSTW\*RC-778812\*\d{8}\*A~/);
    expect(n990.orderId).toBe(o.order.id);
    // control numbers advance per partner
    expect(Number(n990.controlNumber)).toBe(Number(ack.controlNumber) + 1);
    // the same interchange again is refused; a new interchange with the same shipment lands in the inbox with a flag
    await expect(E.receiveInterchange(f.partner, tender("RC-778812"))).rejects.toThrow(/already received/);
    const again = await E.receiveInterchange(f.partner, tender("RC-778812", { isa: "000000124" }));
    expect(again.sets[0].note).toMatch(/waits in the EDI inbox/);
    const inbox = await E.ediInbox(a);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].m.summary).toMatch(/^DUPLICATE RC-778812/);
    const fl = await db.select().from(flags).where(eq(flags.orderId, o.order.id));
    expect(fl.map((x) => x.code)).toContain("edi_change");
  });

  it("wrong sender, unreadable text, and a partner without auto-create → inbox where a dispatcher accepts (order + 990 A) or declines with a reason (990 D)", async () => {
    await expect(E.receiveInterchange(f.partner, tender("RC-1").replace("ZZ*RXO            ", "ZZ*SOMEONE        "))).rejects.toThrow(/from SOMEONE/);
    await expect(E.receiveInterchange(f.partner, "not edi at all")).rejects.toThrow(/could not read/);
    const { update } = await import("@/data/records");
    await update(a, "ediPartner", f.partner, { autoCreateOrders: false });
    const r = await E.receiveInterchange(f.partner, tender("RC-2"));
    expect(r.sets[0].note).toMatch(/waits in the EDI inbox/);
    const [m] = await E.ediInbox(a);
    expect(E.tenderView(m.m)?.theirRef).toBe("RC-2");
    await expect(E.respondToTender(a, m.m.id, false)).rejects.toBeInstanceOf(ValidationError);
    const dec = await E.respondToTender(a, m.m.id, false, "no B-1 team available Saturday");
    expect(dec.orderId).toBeNull();
    const d990 = (await outMessages("990"))[0];
    expect(d990.content).toMatch(/\*D~/);
    expect(d990.content).toContain("K1*no B-1 team available Saturday~");
    expect((await E.ediInbox(a)).length).toBe(0);
    // another tender, accepted by hand
    const r2 = await E.receiveInterchange(f.partner, tender("RC-3", { isa: "000000125" }));
    const [m2] = await E.ediInbox(a);
    const acc = await E.respondToTender(a, m2.m.id, true);
    expect(acc.orderId).toBeTruthy();
    expect((await getOrder(a, acc.orderId!)).order.sourceRef).toBe("RC-3");
    expect((await outMessages("990")).length).toBe(2);
    void r2;
  });

  it("a domestic tender is one domestic leg; a cancellation cancels a draft and flags a moving load", async () => {
    const domestic = `S5*1*CL*5000*L*4*PLT~
G62*37*20260927*1*0800~
N1*SH*Laredo Yard~
N4*Laredo*TX*78045*US~
S5*2*CU*5000*L*4*PLT~
N1*CN*Toyota San Antonio~
N4*San Antonio*TX*78264*US~`;
    const r = await E.receiveInterchange(f.partner, tender("RC-9", { stops: domestic }));
    const o = await getOrder(a, r.sets[0].orderId!);
    expect(o.legs.map((l) => l.type)).toEqual(["domestic"]);
    // cancel while a draft → cancelled
    const c = await E.receiveInterchange(f.partner, tender("RC-9", { purpose: "01", isa: "000000200", stops: "" }));
    expect(c.sets[0].note).toMatch(/cancelled 26-00001/);
    expect((await getOrder(a, o.order.id)).order.state).toBe("cancelled");
    // a moving load: the cancel becomes a red flag, never a silent cancel
    const r2 = await E.receiveInterchange(f.partner, tender("RC-10", { isa: "000000201", stops: domestic }));
    const o2 = await getOrder(a, r2.sets[0].orderId!);
    await bookOrder(a, o2.order.id);
    await planLeg(a, o2.legs[0].id, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, o2.legs[0].id);
    await acceptLeg(a, o2.legs[0].id);
    await advanceLeg(a, o2.legs[0].id, "en_route_to_pickup");
    const c2 = await E.receiveInterchange(f.partner, tender("RC-10", { purpose: "01", isa: "000000202", stops: "" }));
    expect(c2.sets[0].note).toMatch(/needs a dispatcher/);
    const fl = await db.select().from(flags).where(eq(flags.orderId, o2.order.id));
    expect(fl.map((x) => x.code)).toContain("edi_cancel_blocked");
    expect((await getOrder(a, o2.order.id)).order.state).not.toBe("cancelled");
  });
});

describe("outbound 214 and 210", () => {
  it("one 214 per milestone with the customer's ref, the stop location and the unit; never twice; 210 at issue with the invoice lines; email delivery goes through the outbox", async () => {
    const r = await E.receiveInterchange(f.partner, tender("RC-5", { stops: `S5*1*CL*5000*L*4*PLT~
N1*SH*Laredo Yard~
N4*Laredo*TX*78045*US~
S5*2*CU*5000*L*4*PLT~
N1*CN*Toyota San Antonio~
N4*San Antonio*TX*78264*US~` }));
    const o = await getOrder(a, r.sets[0].orderId!);
    await bookOrder(a, o.order.id);
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await advanceLeg(a, leg, "en_route_to_pickup");
    await advanceLeg(a, leg, "at_pickup", { at: new Date("2026-09-27T13:00:00Z") });
    await advanceLeg(a, leg, "loaded", { at: new Date("2026-09-27T14:00:00Z") });
    expect((await E.emit214()).sent).toBe(2); // X3 + AF; en_route_to_pickup has no code
    expect((await E.emit214()).sent).toBe(0);
    const m214 = await outMessages("214");
    expect(m214.map((m) => m.summary)).toEqual(["26-00001 · X3 Arrived at pickup", "26-00001 · AF Departed pickup with shipment"]);
    const x3 = m214[0].content;
    expect(x3).toContain("B10*26-00001*RC-5*BSTW~");
    expect(x3).toContain("L11*4500991*PO~");
    expect(x3).toContain("N1*SH*Laredo Yard~");
    expect(x3).toContain("N1*CN*Toyota San Antonio~");
    expect(x3).toContain("AT7*X3****20260927*1300*UT~");
    expect(x3).toContain("MS1*Laredo*TX*US~");
    expect(x3).toContain("MS2*BSTW*2104~");
    expect(x3).toContain("GS*QM*BSTW*RXO*");
    const p = parse(x3);
    expect(transactionSets(p.segments)[0].type).toBe("214");
    // the customer's 997 marks ours acknowledged
    const gsControl = m214[0].controlNumber!;
    const ack = `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260927*1500*U*00401*000000300*0*T*>~
GS*FA*RXO*BSTW*20260927*1500*300*X*004010~
ST*997*0001~
AK1*QM*${gsControl}~
AK2*214*${gsControl.padStart(4, "0")}~
AK5*A~
AK9*A*1*1*1~
SE*6*0001~
GE*1*300~
IEA*1*000000300~`;
    const ackRes = await E.receiveInterchange(f.partner, ack);
    expect(ackRes.sets[0].type).toBe("997");
    expect(ackRes.ackId).toBeNull(); // we never 997 a 997
    const [acked] = await db.select().from(ediMessages).where(eq(ediMessages.id, m214[0].id));
    expect(acked.ackedAt).toBeTruthy();

    // finish, invoice, issue → 210
    for (const st of ["en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
    expect((await E.emit214()).sent).toBe(3);
    const { update } = await import("@/data/records");
    await update(a, "ediPartner", f.partner, { delivery: "email", deliveryEmail: "edi@rxo.test" });
    const inv = await B.createInvoice(a, [o.order.id]);
    const issued = await B.issueInvoice(a, inv.id);
    const [m210] = await outMessages("210");
    expect(m210.invoiceId).toBe(inv.id);
    expect(m210.content).toContain(`B3**${issued.number}*RC-5*PP**`);
    expect(m210.content).toContain("*285000**"); // net due in implied cents
    expect(m210.content).toContain("L1*1**FR*285000****400****Line haul~");
    expect(m210.content).toContain("L3*****285000~");
    expect(m210.content).toContain("N1*BT*RXO~");
    expect(m210.state).toBe("logged"); // no email provider in tests → the outbox logs it
    const [mail] = await db.select().from(outbox).where(eq(outbox.id, m210.outboxId!));
    expect(mail.to).toBe("edi@rxo.test");
    expect(mail.subject).toMatch(/EDI 210 BSTW → RXO #\d+/);
    // the log reads newest first with the order number
    const log = await E.ediLog(a);
    expect(log[0].m.type).toBe("210");
    expect(log.find((l) => l.m.type === "214")?.orderNumber).toBe("26-00001");
  });
});
