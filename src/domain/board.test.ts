// Features: F-24.1 F-24.2 F-24.3
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { outbox, flags, positions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createOrder, planLeg } from "./orders";
import { bucketsOf, alertsOf, urgency, nextStop, type RowLike } from "./board-buckets";
import { toZoneInput, fromZoneInput, stopZone } from "@/lib/time";
import { addCheckCall, listCheckCalls, lastCheckCalls } from "./check-calls";
import { searchAll } from "./search";
import { orderPnl } from "./billing";

const H = 3600_000;
const now = Date.UTC(2026, 8, 28, 15, 0); // Sep 28 10:00 CDT
const leg = (id: string, state: string, from = "s1", to = "s2", truckId: string | null = null) => ({ id, state, truckId, fromStopId: from, toStopId: to });
const stop = (id: string, seq: number, type: string, windowStart: number | null, arrivedAt: number | null = null) => ({ id, seq, type, windowStart: windowStart ? new Date(windowStart).toISOString() : null, windowEnd: null, arrivedAt: arrivedAt ? new Date(arrivedAt).toISOString() : null, country: "US", address: { state: "TX" } });
const row = (p: Partial<RowLike> & { legs: RowLike["legs"]; stops: RowLike["stops"] }): RowLike => ({ order: { state: "booked" }, stage: "pending", tenders: [], openFlags: [], ...p });
const ctx = (over: Partial<Parameters<typeof alertsOf>[1]> = {}) => ({ now, etas: {}, lastPing: () => null, today: () => "2026-09-28", dayOf: (iso: string) => iso.slice(0, 10), ...over });

describe("trip board buckets and alerts", () => {
  it("a cross-border load rolling on its MX leg with the US leg uncovered is both in transit and needs truck", () => {
    const r = row({ legs: [leg("mx", "en_route"), leg("x", "unassigned", "s2", "s3"), leg("us", "unassigned", "s3", "s4")], stops: [stop("s1", 1, "pickup", now - 30 * H), stop("s2", 2, "border_yard", null), stop("s3", 3, "yard", null), stop("s4", 4, "delivery", now + 24 * H)] });
    expect([...bucketsOf(r)].sort()).toEqual(["all", "needs", "transit"]);
    expect(nextStop(r)?.id).toBe("s2");
  });
  it("a leg out on tender is Tendered, not Needs truck; drafts and delivered stay in their own tabs", () => {
    const r = row({ legs: [leg("a", "unassigned")], stops: [stop("s1", 1, "pickup", now + 5 * H), stop("s2", 2, "delivery", now + 20 * H)], tenders: [{ legId: "a", state: "sent", expiresAt: new Date(now + 20 * 60_000).toISOString() }] });
    expect([...bucketsOf(r)].sort()).toEqual(["all", "tendered"]);
    expect(alertsOf(r, ctx()).has("at_risk")).toBe(true); // tender expires in 20 min
    expect([...bucketsOf({ ...r, order: { state: "draft" } })]).toEqual(["drafts"]);
    expect([...bucketsOf({ ...r, stage: "delivered" })]).toEqual(["delivered"]);
  });
  it("late: ETA past the appointment, or the appointment passed with no arrival; no ping 2h+ while rolling; no truck within 24h", () => {
    const moving = row({ legs: [leg("a", "en_route", "s1", "s2", "t1")], stops: [stop("s1", 1, "pickup", now - 10 * H, now - 9 * H), stop("s2", 2, "delivery", now + 2 * H)] });
    expect(alertsOf(moving, ctx({ etas: { a: { at: new Date(now + 3 * H).toISOString(), late: true } } })).has("late")).toBe(true);
    const ontime = alertsOf(moving, ctx({ etas: { a: { at: new Date(now + 30 * 60_000).toISOString(), late: false } }, lastPing: () => new Date(now - 10 * 60_000).toISOString() }));
    expect(ontime.has("late") || ontime.has("no_ping")).toBe(false);
    expect(alertsOf(moving, ctx({ lastPing: () => new Date(now - 3 * H).toISOString() })).has("no_ping")).toBe(true);
    const missed = row({ legs: [leg("b", "dispatched")], stops: [stop("s1", 1, "pickup", now - H), stop("s2", 2, "delivery", now + 20 * H)] });
    expect(alertsOf(missed, ctx()).has("late")).toBe(true);
    const soon = row({ legs: [leg("c", "unassigned")], stops: [stop("s1", 1, "pickup", now + 5 * H), stop("s2", 2, "delivery", now + 30 * H)] });
    const a = alertsOf(soon, ctx());
    expect(a.has("uncovered_soon") && a.has("picks_today")).toBe(true);
    expect(urgency(missed, alertsOf(missed, ctx()))).toBeLessThan(urgency(soon, a));
  });
});

describe("stop clocks", () => {
  it("8:00 typed for a Laredo stop is 8:00 in Laredo, whatever the browser's zone; Mississauga and Monterrey use theirs", () => {
    const tx = stopZone({ country: "US", address: { state: "TX" } }, "America/Detroit");
    expect(fromZoneInput("2026-09-28T08:00", tx)!.toISOString()).toBe("2026-09-28T13:00:00.000Z");
    expect(toZoneInput("2026-09-28T13:00:00.000Z", tx)).toBe("2026-09-28T08:00");
    expect(stopZone({ country: "CA", address: { state: "ON" } }, "America/Chicago")).toBe("America/Toronto");
    expect(stopZone({ country: "MX", address: { state: "NL" } }, "America/Chicago")).toBe("America/Monterrey");
    expect(stopZone({ country: "US", address: null }, "America/Detroit")).toBe("America/Detroit");
  });
});

let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { cust: string; t1: string; d1: string };
const future = new Date(Date.now() + 365 * 86400_000);
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Board Carrier");
  const cust = await create(a, "customer", { name: "Acme Foods", kind: "customer", contacts: [{ name: "Tracy", email: "tracking@acme.test" }] });
  const t1 = await create(a, "truck", { unitNumber: "101", usPlate: "TX101", usPlateExpires: future });
  const d1 = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id, payType: "per_mile", payRateCents: 60 });
  f = { cust: cust.id, t1: t1.id, d1: d1.id };
});

describe("check calls", () => {
  it("logs where the load is (the last GPS position when blank), emails the customer's tracking contact, and a breakdown raises a flag", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 180000, refs: { po: "PO-77" }, stops: [{ type: "pickup", name: "Laredo", country: "US", address: { state: "TX" } }, { type: "delivery", name: "Dallas DC", country: "US", address: { state: "TX" } }], book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d1 });
    await expect(addCheckCall(a, o.order.id, { status: "on_time" })).rejects.toThrow(/where is it/);
    await db.insert(positions).values({ id: "p1", tenantId: a.tenantId, at: new Date(Date.now() - 20 * 60_000), source: "driver_app", truckId: f.t1, lat: "28.4", lng: "-99.2", place: "I-35 N near Cotulla, TX" });
    const c1 = await addCheckCall(a, o.order.id, { status: "on_time", etaAt: new Date("2026-09-28T19:00:00Z"), note: "rolling fine", sendToCustomer: true });
    expect(c1.location).toBe("I-35 N near Cotulla, TX");
    expect(c1.sentTo).toBe("tracking@acme.test");
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectId, o.order.id));
    expect(mail.body).toContain("PO PO-77");
    expect(mail.body).toContain("ETA at Dallas DC Sep 28, 2:00 PM CDT");
    await addCheckCall(a, o.order.id, { status: "breakdown", location: "mm 56 I-35", note: "blown steer tire" });
    const fl = await db.select().from(flags).where(eq(flags.orderId, o.order.id));
    expect(fl.map((x) => [x.code, x.level])).toEqual([["breakdown", "red"]]);
    const list = await listCheckCalls(a, o.order.id);
    expect(list.map((c) => c.status)).toEqual(["breakdown", "on_time"]);
    expect((await lastCheckCalls(a, [o.order.id])).get(o.order.id)?.status).toBe("breakdown");
    await expect(addCheckCall(a, o.order.id, { status: "on_time", location: "x", tempF: 400 })).rejects.toThrow(/temperature/);
  });
});

describe("global search and the one P&L", () => {
  it("finds a load by any reference, a stop city, a unit, a driver", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 180000, refs: { po: "PO-88123", bol: "BOL-5" }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } }, { type: "delivery", name: "Joliet Crossdock", country: "US", address: { city: "Joliet", state: "IL" } }], book: true });
    for (const q of ["88123", "bol-5", o.order.orderNumber, "joliet", "acme"]) expect((await searchAll(a, q)).some((h) => h.kind === "load" && h.id === o.order.id)).toBe(true);
    expect((await searchAll(a, "101")).some((h) => h.kind === "truck")).toBe(true);
    expect((await searchAll(a, "reyes")).map((h) => h.title)).toContain("Daniel Reyes");
    expect(await searchAll(a, "x")).toEqual([]);
  });
  it("an own-truck load's margin counts estimated driver pay and fuel before any statement", async () => {
    const o = await createOrder(a, { customerId: f.cust, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.d1 }, { plannedMiles: 500 });
    const p = await orderPnl(a, o.order.id);
    expect(p.driverPay).toBe(30000); // 500 mi × $0.60, estimated
    expect(p.driverPayEstimated).toBe(true);
    expect(p.fuel).toBe(500 * 65);
    expect(p.margin).toBe(100000 - 30000 - 32500);
  });
});
