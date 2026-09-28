// Features: F-14 EDI VAN mailbox — SFTP inbox pulled through the 204 path (997 + 990 back), outbox pushed with 214/210, files moved to done/failed, secrets never shown back, one bad partner never stops the rest
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { ediMessages, ediPartners } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { memoryBox } from "@/integrations/edi/mailbox";
import * as M from "./edi-mailbox";
import * as E from "./edi";
import { getOrder, bookOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, ValidationError } from "./orders";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; partner: string; t2104: string; reyes: string };

const tender = (ref: string, isa = "000000123") => `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260926*1400*U*00401*${isa}*0*T*>~
GS*SM*RXO*BSTW*20260926*1400*${Number(isa)}*X*004010~
ST*204*0001~
B2**BSTW**${ref}**PP~
B2A*00~
L11*${ref}*RC~
N1*BT*RXO Expedite*93*RXO1~
N4*Charlotte*NC*28202*US~
S5*1*CL*12000*L*10*PLT~
G62*37*20260927*1*0800~
N1*SH*Planta Monterrey~
N4*Monterrey*NL*64000*MX~
S5*2*CU*12000*L*10*PLT~
G62*68*20260928*1*1500~
N1*CN*GM Arlington~
N4*Arlington*TX*76010*US~
L3*12000*G***285000~
SE*17*0001~
GE*1*${Number(isa)}~
IEA*1*${isa}~`;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: [] });
  const partner = await create(a, "ediPartner", { customerId: rxo.id, theirId: "RXO", theirQualifier: "ZZ", ourId: "BSTW", ourQualifier: "02", scac: "BSTW", usage: "T", send214: true, send210: true, accept204: true, autoCreateOrders: true, delivery: "sftp", enabled: true });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
  f = { rxo: rxo.id, partner: partner.id, t2104: t2104.id, reyes: reyes.id };
});

describe("EDI VAN mailbox", () => {
  it("save keeps secrets server-side; enabling needs host, user, a credential and both folders", async () => {
    await expect(M.saveMailbox(a, f.partner, { enabled: true, host: "van.example.com", username: "bstw", inbox: "/in", outbox: "/out" })).rejects.toThrow(/password or a private key/);
    const pub = await M.saveMailbox(a, f.partner, { enabled: true, host: "van.example.com", port: 2222, username: "bstw", password: "s3cret", inbox: "/in", outbox: "/out" });
    expect(pub).toMatchObject({ enabled: true, host: "van.example.com", port: 2222, hasPassword: true, hasPrivateKey: false });
    expect(JSON.stringify(pub)).not.toContain("s3cret");
    // blank password keeps the stored one; a new host replaces
    const again = await M.saveMailbox(a, f.partner, { enabled: true, host: "van2.example.com", username: "bstw", password: "", inbox: "/in", outbox: "/out" });
    expect(again?.host).toBe("van2.example.com");
    const [row] = await db.select().from(ediPartners).where(eq(ediPartners.id, f.partner));
    expect(row.mailbox?.password).toBe("s3cret");
    // a dispatcher may not touch it
    await expect(M.saveMailbox({ ...a, role: "dispatcher" }, f.partner, { enabled: false })).rejects.toThrow(/permission/);
  });

  it("poll: a 204 in the inbox becomes a draft order, the file moves to done/, the 997 and 990 land in the outbox; a bad file goes to failed/; nothing is read twice; 214s ride the next poll", async () => {
    await M.saveMailbox(a, f.partner, { enabled: true, host: "van", username: "u", password: "p", inbox: "/mailbox/in", outbox: "/mailbox/out" });
    const box = memoryBox({ "/mailbox/in/RXO_204_0001.edi": tender("RC-1"), "/mailbox/in/garbage.txt": "hello", "/mailbox/in/.hidden": "x", "/mailbox/in/receipt.ok": "" });
    const open = async () => box;
    const r1 = await M.pollMailbox(f.partner, open);
    expect(r1).toMatchObject({ pulled: 1, failed: 1, pushed: 1 }); // the 997 goes right back; the 990 is the ticker's (auto-accept)
    expect(r1.errors[0]).toMatch(/garbage\.txt/);
    expect((await E.send990ForAutoAccepted()).sent).toBe(1);
    expect((await M.pollMailbox(f.partner, open)).pushed).toBe(1);
    expect(Object.keys(box.files).sort()).toEqual(["/mailbox/in/.hidden", "/mailbox/in/done/RXO_204_0001.edi", "/mailbox/in/failed/garbage.txt", "/mailbox/in/receipt.ok", "/mailbox/out/990_BSTW_2.edi", "/mailbox/out/997_BSTW_1.edi"]);
    expect(box.files["/mailbox/out/997_BSTW_1.edi"]).toMatch(/^ISA\*/);
    expect(box.files["/mailbox/out/997_BSTW_1.edi"]).toContain("ST*997*");
    expect(box.files["/mailbox/out/990_BSTW_2.edi"]).toContain("ST*990*");
    const inbound = await db.select().from(ediMessages).where(and(eq(ediMessages.direction, "in"), eq(ediMessages.type, "interchange")));
    expect(inbound).toHaveLength(1);
    expect(inbound[0].summary).toMatch(/via sftp/);
    const outs = await db.select().from(ediMessages).where(eq(ediMessages.direction, "out"));
    expect(outs.map((m) => m.state)).toEqual(["sent", "sent"]);
    const orderId = (await db.select().from(ediMessages).where(eq(ediMessages.type, "204")))[0].orderId!;
    expect((await getOrder(a, orderId)).order.state).toBe("draft");
    const [p1] = await db.select().from(ediPartners).where(eq(ediPartners.id, f.partner));
    expect(p1.mailbox).toMatchObject({ lastPulled: 0, lastPushed: 1 }); // the last poll (the 990 push)
    expect(p1.mailbox?.lastError).toBeNull();
    expect(p1.mailbox?.lastPollAt).toBeTruthy();

    // second poll: nothing new, nothing re-read, nothing re-pushed
    const r2 = await M.pollMailbox(f.partner, open);
    expect(r2).toMatchObject({ pulled: 0, failed: 0, pushed: 0, errors: [] });
    // the same interchange dropped again (VAN redelivery) is refused and parked in failed/
    box.files["/mailbox/in/RXO_204_0001_again.edi"] = tender("RC-1");
    const r3 = await M.pollMailbox(f.partner, open);
    expect(r3.failed).toBe(1);
    expect(r3.errors[0]).toMatch(/already received/);
    expect("/mailbox/in/failed/RXO_204_0001_again.edi" in box.files).toBe(true);

    // the load moves: 214s are generated by the ticker and leave on the next poll
    await bookOrder(a, orderId);
    const o = await getOrder(a, orderId);
    const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", caatExpires: future });
    await planLeg(a, o.legs[0].id, { kind: "carrier", carrierId: garza.id, carrierRateCents: 45000 }); // the Mexican leg
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id, "carrier");
    await advanceLeg(a, o.legs[0].id, "en_route_to_pickup", { source: "carrier" });
    await advanceLeg(a, o.legs[0].id, "at_pickup", { source: "carrier" });
    await advanceLeg(a, o.legs[0].id, "loaded", { source: "carrier" });
    expect((await E.emit214()).sent).toBeGreaterThan(0);
    const r4 = await M.pollMailbox(f.partner, open);
    expect(r4.pushed).toBeGreaterThan(0);
    expect(Object.keys(box.files).filter((k) => k.startsWith("/mailbox/out/214_"))).toHaveLength(r4.pushed);
    expect(Object.keys(box.files).some((k) => k.includes(".part"))).toBe(false);
  });

  it("pickup delivery pulls but never pushes; a dead host is recorded on the mailbox and the job carries on with the next partner", async () => {
    await M.saveMailbox(a, f.partner, { enabled: true, host: "van", username: "u", password: "p", inbox: "/in", outbox: "/out" });
    await db.update(ediPartners).set({ delivery: "pickup" }).where(eq(ediPartners.id, f.partner));
    const box = memoryBox({ "/in/t.edi": tender("RC-2", "000000124") });
    const r = await M.pollMailbox(f.partner, async () => box);
    expect(r).toMatchObject({ pulled: 1, pushed: 0 });
    expect(Object.keys(box.files).filter((k) => k.startsWith("/out/"))).toHaveLength(0);
    expect((await db.select().from(ediMessages).where(eq(ediMessages.direction, "out")))[0].state).toBe("logged");

    const b = await makeTenant("B");
    const cust = await create(b, "customer", { name: "AOD", kind: "broker" });
    const pb = await create(b, "ediPartner", { customerId: cust.id, theirId: "AOD", ourId: "BSTW", scac: "BSTW", delivery: "sftp", enabled: true });
    await M.saveMailbox(b, pb.id, { enabled: true, host: "dead", username: "u", password: "p", inbox: "/in", outbox: "/out" });
    const open = async (m: { host: string }) => {
      if (m.host === "dead") throw new Error("ECONNREFUSED");
      return box;
    };
    const all = await M.pollMailboxes(open);
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.partnerId === pb.id)).toMatchObject({ error: "ECONNREFUSED" });
    expect(all.find((x) => x.partnerId === f.partner)).toMatchObject({ pulled: 0 });
    const [dead] = await db.select().from(ediPartners).where(eq(ediPartners.id, pb.id));
    expect(dead.mailbox?.lastError).toMatch(/connect: ECONNREFUSED/);
    await expect(M.testMailbox(b, pb.id, open)).rejects.toThrow(/ECONNREFUSED/);
    expect(await M.testMailbox(a, f.partner, open)).toMatchObject({ ok: true, waiting: 0 });
    await expect(M.pollMailbox(f.partner, open, new Date(), )).resolves.toBeTruthy();
    await M.saveMailbox(a, f.partner, { enabled: false });
    await expect(M.pollMailbox(f.partner, open)).rejects.toBeInstanceOf(ValidationError);
  });
});
