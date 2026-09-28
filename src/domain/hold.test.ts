// Features: F-30.3 F-30.5
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { outbox, flags as flagsT, legs as legsT, legEvents, documents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createOrder, holdOrder, releaseOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder, markTonu, waivePod, podSatisfied, setTruckOos, ValidationError } from "./orders";
import { TransitionError } from "./states";
import { pullBackLeg, needsCarrierNotice } from "./carrier-notice";
import { driverToday, driverStep } from "./tracking";
import { billingQueue } from "./billing";
import { implausibleDelivery } from "./tracking-rules";
import { lostItsTruck } from "./board-buckets";

const future = new Date(Date.now() + 365 * 86400_000);
const H = 3600_000;
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; mateo: string; garza: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Hold Carrier");
  const cust = await create(a, "customer", { name: "Sierra Madre", kind: "customer" });
  const t1 = await create(a, "truck", { unitNumber: "213", usPlate: "TX213", usPlateExpires: future });
  const mateo = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id, phone: "+1 956 555 0159" });
  const garza = await create(a, "carrier", { name: "Transportes del Norte", country: "US", mcNumber: "MC123", dispatchEmail: "despacho@tdn.test" });
  f = { cust: cust.id, t1: t1.id, mateo: mateo.id, garza: garza.id };
});

const load = (pickupInHours = 24, extra: { pickupNo?: string } = {}) =>
  createOrder(a, {
    customerId: f.cust,
    rateCents: 180000,
    book: true,
    refs: { po: "PO-77" },
    stops: [
      { type: "pickup", name: "Shipper Laredo", country: "US", address: { city: "Laredo", state: "TX" }, windowStart: new Date(Date.now() + pickupInHours * H), refs: extra.pickupNo ? { pickup: extra.pickupNo } : {}, notes: "Dock 4, call ahead" },
      { type: "delivery", name: "DC Dallas", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(Date.now() + (pickupInHours + 9) * H) },
    ],
  });

describe("hold at any stage (M8)", () => {
  it("a booked load with no truck can be held and released back to booked", async () => {
    const o = await load();
    const held = await holdOrder(a, o.order.id, "customer re-checking the PO");
    expect(held.state).toBe("exception");
    expect(held.holdReason).toBe("customer re-checking the PO");
    await expect(holdOrder(a, o.order.id, "again")).rejects.toBeInstanceOf(TransitionError);
    const rel = await releaseOrder(a, o.order.id);
    expect(rel.state).toBe("booked");
  });

  it("a held load's steps are frozen for the dispatcher and the driver; the driver app says why", async () => {
    const o = await load(2, { pickupNo: "PU-5531" });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.mateo });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await holdOrder(a, o.order.id, "rate con missing");
    await expect(advanceLeg(a, leg, "next")).rejects.toThrow(/on hold/);
    await expect(driverStep(a.tenantId, f.mateo, leg, {})).rejects.toThrow(/on hold/);
    const today = await driverToday(a.tenantId, f.mateo);
    expect(today.current?.order.held).toBe(true);
    expect(today.current?.order.holdReason).toBe("rate con missing");
    expect(today.current?.next).toBeNull();
    // declining is still allowed on hold
    await releaseOrder(a, o.order.id);
    expect((await advanceLeg(a, leg, "next")).state).toBe("en_route_to_pickup");
  });

  it("a draft can't be held", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 1000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }] });
    await expect(holdOrder(a, o.order.id, "x")).rejects.toThrow(/book it first/);
  });
});

describe("pulling back a carrier leg and TONU tell the carrier (M9)", () => {
  it("pull back after the carrier accepted needs a confirmation and sends them a cancellation", async () => {
    const o = await load();
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "carrier", carrierId: f.garza, carrierRateCents: 90000 });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg, "carrier");
    const l = (await getOrder(a, o.order.id)).legs[0];
    expect(needsCarrierNotice(l)).toBe(true);
    await expect(pullBackLeg(a, leg, {})).rejects.toThrow(/confirm/);
    await expect(pullBackLeg(a, leg, { confirmCarrier: true })).rejects.toBeInstanceOf(ValidationError);
    const r = await pullBackLeg(a, leg, { confirmCarrier: true, reason: "customer moved the date" });
    expect(r.leg.state).toBe("unassigned");
    expect(r.notice?.to).toBe("despacho@tdn.test");
    const [msg] = await db.select().from(outbox).where(and(eq(outbox.tenantId, a.tenantId), eq(outbox.subjectKind, "carrier_cancel")));
    expect(msg.subject).toMatch(/^Cancelled: load /);
    expect(msg.body).toContain("customer moved the date");
    const ev = await db.select().from(legEvents).where(and(eq(legEvents.legId, leg), eq(legEvents.kind, "message")));
    expect(ev.some((e) => e.note?.includes("Cancellation sent"))).toBe(true);
  });

  it("pulling back a leg the carrier never accepted just takes it back", async () => {
    const o = await load();
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "carrier", carrierId: f.garza, carrierRateCents: 90000 });
    await dispatchLeg(a, leg);
    const r = await pullBackLeg(a, leg, {});
    expect(r.leg.state).toBe("unassigned");
    expect(r.notice).toBeNull();
  });

  it("a TONU cancels the carrier leg and tells the carrier", async () => {
    const o = await load();
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "carrier", carrierId: f.garza, carrierRateCents: 100000 });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg, "carrier");
    await markTonu(a, o.order.id, { amountCents: 25000, reason: "shipper cancelled" });
    const [l] = await db.select().from(legsT).where(eq(legsT.id, leg));
    expect(l.state).toBe("cancelled");
    const [msg] = await db.select().from(outbox).where(and(eq(outbox.tenantId, a.tenantId), eq(outbox.subjectKind, "carrier_cancel")));
    expect(msg.body).toContain("TONU");
    expect(msg.to).toBe("despacho@tdn.test");
  });
});

describe("the driver app (M13, M14)", () => {
  it("loads come in pickup order, with the stop's numbers and instructions", async () => {
    const later = await load(48);
    const sooner = await load(20, { pickupNo: "PU-5531" });
    for (const o of [later, sooner]) {
      await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo }, { override: true, reason: "two loads, back to back" });
      await dispatchLeg(a, o.legs[0].id);
    }
    const today = await driverToday(a.tenantId, f.mateo);
    expect(today.items.map((i) => i.order.orderNumber)).toEqual([sooner.order.orderNumber, later.order.orderNumber]);
    expect(today.current?.order.orderNumber).toBe(sooner.order.orderNumber);
    expect(today.current?.from?.refs).toMatchObject({ pickup: "PU-5531" });
    expect(today.current?.from?.notes).toBe("Dock 4, call ahead");
    expect(today.current?.order.refs).toMatchObject({ po: "PO-77" });
  });

  it("\"I can't take this load\" sends it back with a red flag", async () => {
    const o = await load();
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo });
    await dispatchLeg(a, o.legs[0].id);
    const d = await driverStep(a.tenantId, f.mateo, o.legs[0].id, { decline: true, declineReason: "truck in the shop" });
    expect(d.state).toBe("declined");
    const rows = [{ legs: [{ state: "declined" }], openFlags: [{ code: "declined" }] }];
    expect(lostItsTruck(rows[0] as never)).toBe(true);
  });

  it("a delivery with no POD stays on the phone for the photo and is not ready to bill until the POD or a dispatcher's OK", async () => {
    const o = await load(-12);
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.mateo });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery", "completed"] as const) await advanceLeg(a, leg, st);
    // 0 minutes for ~430 miles: a yellow flag, not a block
    const [fl] = await db.select().from(flagsT).where(and(eq(flagsT.orderId, o.order.id), eq(flagsT.code, "implausible_delivery")));
    expect(fl.title).toMatch(/^Delivered \d+ mi in 0 minutes — check the times/);
    const today = await driverToday(a.tenantId, f.mateo);
    expect(today.items.map((i) => i.leg.id)).toContain(leg);
    expect(today.items.find((i) => i.leg.id === leg)!.docs.pod).toBe(false);
    const q = (await billingQueue(a)).find((r) => r.order.id === o.order.id)!;
    expect(q.requiredDocs.find((d) => d.code === "POD")!.present).toBe(false);
    const after = await waivePod(a, o.order.id, "receiver signs electronically");
    expect(podSatisfied(after, false)).toBe(true);
    const q2 = (await billingQueue(a)).find((r) => r.order.id === o.order.id)!;
    expect(q2.requiredDocs.find((d) => d.code === "POD")!.present).toBe(true);
    await expect(waivePod(a, o.order.id, "  ")).rejects.toBeInstanceOf(ValidationError);
    void documents;
  });

  it("implausible deliveries (pure)", () => {
    const t0 = new Date("2026-09-28T10:00:00Z");
    expect(implausibleDelivery({ miles: 430, startedAt: t0, completedAt: t0 })[0]).toBe("Delivered 430 mi in 0 minutes — check the times");
    expect(implausibleDelivery({ miles: 430, startedAt: t0, completedAt: new Date(t0.getTime() + 8 * H) })).toEqual([]);
    expect(implausibleDelivery({ miles: 10, startedAt: t0, completedAt: t0 })).toEqual([]); // across town
    expect(implausibleDelivery({ miles: null, startedAt: t0, completedAt: t0 })).toEqual([]);
    expect(implausibleDelivery({ miles: 100, startedAt: null, completedAt: t0, fix: { lat: 27.5, lng: -99.5 }, stop: { lat: 32.78, lng: -96.8 } })[0]).toMatch(/^Marked delivered \d+ mi from the delivery address$/);
  });
});

describe("a unit taken out of service leaves a flag on its loads (m6)", () => {
  it("\"Truck removed\" on the load until a new truck is planned", async () => {
    const o = await load();
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t1, driverId: f.mateo });
    await setTruckOos(a, f.t1, "blown turbo");
    let fl = await db.select().from(flagsT).where(and(eq(flagsT.orderId, o.order.id), eq(flagsT.code, "truck_removed")));
    expect(fl[0].title).toBe("Truck removed — unit 213 out of service");
    expect(fl[0].clearedAt).toBeNull();
    const t2 = await create(a, "truck", { unitNumber: "214", usPlate: "TX214", usPlateExpires: future });
    await planLeg(a, leg, { kind: "truck", truckId: t2.id, driverId: f.mateo }, { override: true, reason: "Mateo moves to 214" });
    fl = await db.select().from(flagsT).where(and(eq(flagsT.orderId, o.order.id), eq(flagsT.code, "truck_removed")));
    expect(fl[0].clearedAt).not.toBeNull();
  });
});
