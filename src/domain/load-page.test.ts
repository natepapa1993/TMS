// Features: F-20.2
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { users, legs as legsT, charges } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, updateOrder, updateStop, addStop, lockOrder, markTonu, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder } from "./orders";
import { addNote, listNotes, pinNote, deleteNote } from "./notes";
import { billingQueue } from "./billing";
import { newId } from "@/lib/ids";

let a: Awaited<ReturnType<typeof makeTenant>>;
let cust: string;
let carrier: string;
const stops = [
  { type: "pickup" as const, name: "Shipper Canton", country: "US" },
  { type: "delivery" as const, name: "DC Columbus", country: "US" },
];
const future = new Date(Date.now() + 365 * 86400_000);

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Load Page Carrier");
  cust = (await create(a, "customer", { name: "Acme Logistics", kind: "broker" })).id;
  carrier = (await create(a, "carrier", { name: "Partner Freight", country: "US", kind: "us", insuranceExpires: future, authorityActive: true })).id;
});

describe("money box", () => {
  it("a per-mile rate figures the line haul from the miles", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateTbd: true });
    const after = await updateOrder(a, o.order.id, { rateType: "per_mile", rateUnitCents: 285, rateQty: 540 });
    expect(after.rateCents).toBe(153900);
    expect(after.rateTbd).toBe(false);
    const flat = await updateOrder(a, o.order.id, { rateType: "flat", rateCents: 160000 });
    expect(flat.rateCents).toBe(160000);
  });
  it("refuses a negative quantity and an unknown rate type", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 1 });
    await expect(updateOrder(a, o.order.id, { rateType: "per_parsec" })).rejects.toThrow(/rate type/);
    await expect(updateOrder(a, o.order.id, { rateType: "per_mile", rateQty: -3 })).rejects.toThrow(/quantity/);
  });
});

describe("people and priority on the load", () => {
  it("sets sales agent, CSR, dispatcher from the company's users; priority from the list", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 1 });
    const after = await updateOrder(a, o.order.id, { salesAgentId: a.userId, dispatcherId: a.userId, priority: "high" });
    expect([after.salesAgentId, after.dispatcherId, after.priority]).toEqual([a.userId, a.userId, "high"]);
    const stranger = newId();
    const other = await makeTenant("Other");
    await db.insert(users).values({ id: stranger, tenantId: other.tenantId, email: `${stranger}@x.test`, name: "Stranger", role: "dispatcher" });
    await expect(updateOrder(a, o.order.id, { csrId: stranger })).rejects.toThrow(/not a user/);
    await expect(updateOrder(a, o.order.id, { priority: "urgent!!" })).rejects.toThrow(/priority/);
  });
});

describe("lock", () => {
  it("a locked load takes no edits to the order or its stops; a dispatcher cannot unlock", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 1 });
    await lockOrder(a, o.order.id, true);
    await expect(updateOrder(a, o.order.id, { cargoNote: "x" })).rejects.toThrow(/locked/);
    await expect(updateStop(a, o.stops[0].id, { notes: "x" })).rejects.toThrow(/locked/);
    await expect(addStop(a, o.order.id, 1, { type: "delivery", name: "X", country: "US" })).rejects.toThrow(/locked/);
    const disp = { ...a, role: "dispatcher" as const };
    await expect(lockOrder(disp, o.order.id, false)).rejects.toThrow(/owner or billing/);
    await lockOrder(a, o.order.id, false);
    expect((await updateOrder(a, o.order.id, { cargoNote: "ok" })).cargoNote).toBe("ok");
  });
});

describe("TONU", () => {
  it("cancels the open legs, bills the fee instead of the line haul, and needs no POD", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 180000, book: true });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "carrier", carrierId: carrier, carrierRateCents: 120000 }, { override: true, reason: "test" });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await advanceLeg(a, leg, "en_route_to_pickup");
    await advanceLeg(a, leg, "at_pickup");
    const after = await markTonu(a, o.order.id, { amountCents: 25000, reason: "shipper cancelled at the dock" });
    expect([after.state, after.tonu, after.rateCents]).toEqual(["delivered", true, 25000]);
    const [l] = await db.select().from(legsT).where(eq(legsT.id, leg));
    expect(l.state).toBe("cancelled");
    const cs = await db.select().from(charges).where(eq(charges.orderId, o.order.id));
    expect(cs.map((c) => [c.kind, c.amountCents])).toEqual([["tonu", 25000]]);
    const q = (await billingQueue(a)).find((r) => r.order.id === o.order.id)!;
    expect(q.requiredDocs.map((d) => d.code)).not.toContain("POD");
    expect(q.chargesCents).toBe(25000);
    expect(q.mismatch).toBe(false);
  });
  it("not once the freight is on the truck, and not without a reason or amount", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 1, book: true });
    await expect(markTonu(a, o.order.id, { amountCents: 25000, reason: " " })).rejects.toThrow(/why/);
    await expect(markTonu(a, o.order.id, { amountCents: 0, reason: "x" })).rejects.toThrow(/amount/);
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "carrier", carrierId: carrier }, { override: true, reason: "test" });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, leg, st);
    await expect(markTonu(a, o.order.id, { amountCents: 25000, reason: "x" })).rejects.toThrow(/freight is already on a truck/);
    const draft = await createOrder(a, { customerId: cust, stops, rateCents: 1 });
    await expect(markTonu(a, draft.order.id, { amountCents: 25000, reason: "x" })).rejects.toThrow(/booked or dispatched/);
    expect((await getOrder(a, o.order.id)).order.tonu).toBe(false);
  });
});

describe("notes", () => {
  it("typed notes, pinned first, author shown; only the author or owner deletes", async () => {
    const o = await createOrder(a, { customerId: cust, stops, rateCents: 1 });
    await addNote(a, o.order.id, { kind: "billing", body: "Customer wants a paper invoice" });
    const { id } = await addNote(a, o.order.id, { kind: "dispatch", body: "Dock closes at 3" });
    await pinNote(a, id, true);
    const notes = await listNotes(a, o.order.id);
    expect(notes.map((n) => [n.kind, n.pinned])).toEqual([["dispatch", true], ["billing", false]]);
    expect(notes[0].author).toBe("owner user");
    await expect(addNote(a, o.order.id, { body: "  " })).rejects.toThrow(/write/);
    const other = { ...a, userId: newId(), role: "dispatcher" as const };
    await expect(deleteNote(other, id)).rejects.toThrow(/wrote it/);
    await deleteNote(a, id);
    expect((await listNotes(a, o.order.id)).length).toBe(1);
  });
});
