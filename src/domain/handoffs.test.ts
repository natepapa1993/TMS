// Features: F-31.1 F-31.2 F-31.3 F-31.4 F-31.5 F-31.6 F-31.7
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { createOrder, getOrder, updateStop, mergeStopAddress, planLeg, dispatchLeg, acceptLeg, advanceLeg, board, sameCrew } from "./orders";
import { sendTender, respondToTender, expireTenders } from "./tenders";
import * as X from "./crossing";
import { crossingDriverNext, directionRule, runChecksPure } from "./crossing";
import { bucketsOf, urgency, tenderExpired, type RowLike } from "./board-buckets";
import { draftFromStop, stopPatch } from "@/components/stop-fields";
import { stopZone, fmtWhen } from "@/lib/time";
import { tenderLang, TENDER_COPY } from "@/lib/tender-copy";
import { CROSSING_STATES, LEG_STATES } from "@/db/schema";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; loc: string; t211: string; ramiro: string; sofia: string; t212: string; arturo: string; norte: string; puente: string; tr5301: string; tr5302: string };

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Frontera");
  await db.update(s.tenants).set({ timeZone: "America/Chicago" }).where(eq(s.tenants.id, a.tenantId));
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker" });
  const loc = await create(a, "location", { name: "Magna Detroit", kind: "shipper", country: "US", address: { line1: "1 Main St", city: "Detroit", state: "MI", postalCode: "48201" }, lat: "42.331400", lng: "-83.045800" });
  const t211 = await create(a, "truck", { unitNumber: "211", usPlate: "TX211", usPlateExpires: future });
  const t212 = await create(a, "truck", { unitNumber: "212", usPlate: "TX212", mxPlate: "212-FF-2", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future });
  const ramiro = await create(a, "driver", { name: "Ramiro Lozano", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t211.id });
  const sofia = await create(a, "driver", { name: "Sofía Lozano", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t211.id });
  const arturo = await create(a, "driver", { name: "Arturo Garza", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future, currentTruckId: t212.id });
  const norte = await create(a, "carrier", { name: "Transportes del Norte", country: "MX", kind: "mx", caatExpires: future, dispatchEmail: "despacho@norte.test" });
  const puente = await create(a, "carrier", { name: "Puente Transfer", country: "US", mcNumber: "MC123", dotNumber: "DOT123", dispatchEmail: "dispatch@puente.test" });
  const tr5301 = await create(a, "trailer", { unitNumber: "5301" });
  const tr5302 = await create(a, "trailer", { unitNumber: "5302" });
  f = { rxo: rxo.id, loc: loc.id, t211: t211.id, ramiro: ramiro.id, sofia: sofia.id, t212: t212.id, arturo: arturo.id, norte: norte.id, puente: puente.id, tr5301: tr5301.id, tr5302: tr5302.id };
});

const mxStops = [
  { type: "pickup" as const, name: "Magna Ramos", country: "MX", address: { city: "Ramos Arizpe", state: "COAH" }, windowStart: new Date(Date.now() + 86400_000) },
  { type: "border_yard" as const, name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAMPS" } },
  { type: "yard" as const, name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } },
  { type: "delivery" as const, name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(Date.now() + 2 * 86400_000) },
];
const legState = async (id: string) => (await db.select({ state: s.legs.state }).from(s.legs).where(eq(s.legs.id, id)))[0].state;
const pdf = () => Buffer.from("%PDF-1.4 demo");

describe("stop editing keeps what was not edited (F-31.5, dispatch B4)", () => {
  it("saving only a new window on the load page keeps the city, state, coordinates and the stop's clock", async () => {
    const o = await createOrder(a, {
      customerId: f.rxo,
      rateCents: 100000,
      stops: [
        { type: "pickup", name: "Magna Detroit", locationId: f.loc, country: "US", address: { line1: "1 Main St", city: "Detroit", state: "MI", postalCode: "48201" }, windowStart: new Date("2026-10-05T12:00:00Z") },
        { type: "delivery", name: "Linamar", country: "CA", address: { city: "Mississauga", state: "ON" }, windowStart: new Date("2026-10-06T14:00:00Z") },
      ],
    });
    const pickup = o.stops[0];
    expect(pickup.lat).toBe("42.331400");
    // the editor: open the stop, change 08:00 → 09:00 on the stop's own clock, save
    const before = draftFromStop(pickup, "America/Chicago");
    expect(before.windowStart).toBe("2026-10-05T08:00"); // Detroit is Eastern, not the company's Central
    const patch = stopPatch(before, { ...before, windowStart: "2026-10-05T09:00" }, "America/Chicago");
    expect(Object.keys(patch)).toEqual(["windowStart"]);
    await updateStop(a, pickup.id, { windowStart: new Date(patch.windowStart!) });
    const { stops } = await getOrder(a, o.order.id);
    expect(stops[0].address).toEqual({ line1: "1 Main St", city: "Detroit", state: "MI", postalCode: "48201" });
    expect([stops[0].lat, stops[0].lng]).toEqual(["42.331400", "-83.045800"]);
    expect(stopZone(stops[0], "America/Chicago")).toBe("America/Detroit");
    expect(fmtWhen(stops[0].windowStart, stopZone(stops[0], "America/Chicago"))).toBe("Mon Oct 5, 9:00 AM EDT");
  });

  it("an address patch merges: a new street keeps the city and state; a cleared key goes; a new place drops the old fix", async () => {
    expect(mergeStopAddress({ city: "Ramos Arizpe", state: "COAH" }, { line1: "Blvd Isidro López 100" })).toEqual({ city: "Ramos Arizpe", state: "COAH", line1: "Blvd Isidro López 100" });
    expect(mergeStopAddress({ city: "Ramos Arizpe", state: "COAH", postalCode: "25900" }, { postalCode: "" })).toEqual({ city: "Ramos Arizpe", state: "COAH" });
    expect(mergeStopAddress({ city: "Laredo", state: "tx" }, {})).toEqual({ city: "Laredo", state: "TX" });
    expect(mergeStopAddress({ city: "Laredo" }, null)).toBeNull();
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 1, stops: [{ type: "pickup", name: "Magna Detroit", locationId: f.loc, country: "US", address: { city: "Detroit", state: "MI" } }, { type: "delivery", name: "X", country: "US", address: { city: "Dallas", state: "TX" } }] });
    await updateStop(a, o.stops[0].id, { address: { line1: "1 Main St" } });
    let [st] = await db.select().from(s.stops).where(eq(s.stops.id, o.stops[0].id));
    expect(st.address).toEqual({ city: "Detroit", state: "MI", line1: "1 Main St" });
    expect(st.lat).toBe("42.331400"); // same place, tidier
    await updateStop(a, o.stops[0].id, { address: { city: "Toledo", state: "OH" } });
    [st] = await db.select().from(s.stops).where(eq(s.stops.id, o.stops[0].id));
    expect(st.lat).toBeNull(); // another city: the old coordinates would lie
  });

  it("a Mexican stop typed in the builder keeps its CST window when only the notes change", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 1, stops: [{ type: "pickup", name: "Magna Ramos", country: "MX", address: { city: "Ramos Arizpe", state: "COAH" }, windowStart: new Date("2026-09-29T14:00:00Z"), windowEnd: new Date("2026-09-29T18:00:00Z") }, { type: "border_yard", name: "Patio Nuevo Laredo", country: "MX", address: { city: "Nuevo Laredo", state: "TAMS" } }, { type: "delivery", name: "Dallas DC", country: "US", address: { city: "Dallas", state: "TX" } }] });
    const d = draftFromStop(o.stops[0], "America/Chicago");
    expect([d.windowStart, d.windowEnd]).toEqual(["2026-09-29T08:00", "2026-09-29T12:00"]);
    const patch = stopPatch(d, { ...d, notes: "Gate 4" }, "America/Chicago");
    expect(patch).toEqual({ notes: "Gate 4" });
    await updateStop(a, o.stops[0].id, { notes: "Gate 4" });
    const [st] = await db.select().from(s.stops).where(and(eq(s.stops.id, o.stops[0].id), eq(s.stops.tenantId, a.tenantId)));
    expect(st.address).toEqual({ city: "Ramos Arizpe", state: "COAH" });
    expect(st.windowStart?.toISOString()).toBe("2026-09-29T14:00:00.000Z");
    // the border yard is on the US-following clock
    expect(stopZone(o.stops[1], "America/Chicago")).toBe("America/Matamoros");
    // moving the stop to another clock re-reads the typed times there
    const moved = stopPatch(d, { ...d, country: "US", state: "TX", city: "Laredo" }, "America/Chicago");
    expect(moved.windowStart).toBe("2026-09-29T13:00:00.000Z"); // 08:00 CDT
  });
});

describe("expired tenders go back to Needs truck, loudly (F-31.2, dispatch B1, M20)", () => {
  it("the board expires a tender past its deadline on read: Needs truck, red flag, top of the board, on the timeline", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 150000, stops: [mxStops[2], mxStops[3]], book: true });
    const t = await sendTender(a, o.legs[0].id, { carrierId: f.puente, rateCents: 90000, expiresInMinutes: 30 });
    expect(await legState(o.legs[0].id)).toBe("dispatched");
    // the deadline passes between two ticks of the job
    await db.update(s.tenders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.tenders.id, t.tender.id));
    const rows = await board(a);
    const row = rows.find((r) => r.order.id === o.order.id)!;
    expect(row.legs[0].state).toBe("unassigned");
    expect(row.legs[0].carrierId).toBeNull();
    expect(row.openFlags.map((x) => x.code)).toEqual(["tender_expired"]);
    const [tt] = await db.select().from(s.tenders).where(eq(s.tenders.id, t.tender.id));
    expect(tt.state).toBe("expired");
    // on the load's timeline
    const ev = await db.select().from(s.legEvents).where(and(eq(s.legEvents.orderId, o.order.id), eq(s.legEvents.kind, "tender")));
    expect(ev.map((e) => (e.data as { state: string }).state).sort()).toEqual(["expired", "sent"]);
    // the job ticking afterwards finds nothing left
    expect((await expireTenders(new Date())).expired).toBe(0);
    // a new tender answers the flag
    await sendTender(a, o.legs[0].id, { carrierId: f.puente, rateCents: 95000, expiresInMinutes: 30 });
    expect((await db.select().from(s.flags).where(and(eq(s.flags.orderId, o.order.id), eq(s.flags.code, "tender_expired"))))[0].clearedAt).not.toBeNull();
  });

  it("an expired tender sorts above a late load and sits in Needs truck", () => {
    const base = (id: string, flags: { code: string }[], late: boolean): RowLike => ({ order: { state: "booked" }, stage: "pending", tenders: [], openFlags: flags, legs: [{ id, state: "unassigned", truckId: null, fromStopId: "s1", toStopId: "s2" }], stops: [{ id: "s1", seq: 1, type: "pickup", windowStart: new Date(Date.now() + (late ? -3600_000 : 5 * 3600_000)).toISOString(), windowEnd: null, arrivedAt: null }, { id: "s2", seq: 2, type: "delivery", windowStart: null, windowEnd: null, arrivedAt: null }] });
    const expired = base("a", [{ code: "tender_expired" }], false);
    const late = base("b", [], true);
    expect(tenderExpired(expired)).toBe(true);
    expect(bucketsOf(expired).has("needs")).toBe(true);
    expect(urgency(expired, new Set())).toBeLessThan(urgency(late, new Set(["late"])));
  });

  it("withdrawing a tender for a new one is on the timeline too", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 150000, stops: [mxStops[2], mxStops[3]], book: true });
    await sendTender(a, o.legs[0].id, { carrierId: f.puente, rateCents: 90000, expiresInMinutes: 30 });
    await sendTender(a, o.legs[0].id, { carrierId: f.puente, rateCents: 99000, expiresInMinutes: 30 });
    const ev = await db.select().from(s.legEvents).where(and(eq(s.legEvents.orderId, o.order.id), eq(s.legEvents.kind, "tender")));
    expect(ev.map((e) => (e.data as { state: string }).state).sort()).toEqual(["sent", "sent", "withdrawn"]);
  });
});

describe("crossing and legs move together (F-31.3, dispatch B3)", () => {
  it("the driver's flow is one ordered list: leg steps to the caja, then the border — exhaustive over both machines", () => {
    const BEFORE_PICKUP = ["dispatched", "accepted", "en_route_to_pickup", "at_pickup"];
    for (const leg of LEG_STATES)
      for (const x of CROSSING_STATES) {
        const n = crossingDriverNext(leg, x);
        expect(["leg", "border", "wait", "hold", "none"]).toContain(n.kind);
        // no border step before the caja is picked up
        if (BEFORE_PICKUP.includes(leg) || ["unassigned", "planned", "declined"].includes(leg)) expect(n.kind).not.toBe("border");
        if (n.kind === "leg") expect(LEG_STATES).toContain(n.to);
        if (n.kind === "border") expect(["departed_yard", "at_mx_customs", "in_us_customs", "cleared"]).toContain(n.to);
      }
    expect(crossingDriverNext("dispatched", "packet_sent")).toEqual({ kind: "leg", to: "accepted" });
    expect(crossingDriverNext("at_pickup", "ready_to_cross")).toEqual({ kind: "leg", to: "loaded" });
    expect(crossingDriverNext("loaded", "ready_to_cross").kind).toBe("wait"); // no packet yet
    expect(crossingDriverNext("loaded", "packet_sent")).toEqual({ kind: "border", to: "departed_yard" });
    expect(crossingDriverNext("en_route", "departed_yard")).toEqual({ kind: "border", to: "at_mx_customs" });
    expect(crossingDriverNext("en_route", "in_us_customs")).toEqual({ kind: "border", to: "cleared" });
    expect(crossingDriverNext("en_route", "held")).toEqual({ kind: "hold" });
    expect(crossingDriverNext("en_route", "cleared")).toEqual({ kind: "leg", to: "at_delivery" });
    expect(crossingDriverNext("completed", "cleared")).toEqual({ kind: "none" });
  });

  it("the crossing truck picking up the caja closes the MX leg; Cleared delivers the crossing leg and the US leg sees the freight", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 295000, stops: mxStops, book: true });
    const [mx, cross, us] = o.legs;
    // the MX leg is a partner still "en route" to the patio (they never pressed delivered)
    await planLeg(a, mx.id, { kind: "carrier", carrierId: f.norte, carrierRateCents: 48000 });
    await dispatchLeg(a, mx.id);
    await acceptLeg(a, mx.id, "carrier");
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded", "en_route"] as const) await advanceLeg(a, mx.id, st, { source: "carrier" });
    await planLeg(a, cross.id, { kind: "truck", truckId: f.t212, driverId: f.arturo });
    await dispatchLeg(a, cross.id);
    await planLeg(a, us.id, { kind: "truck", truckId: f.t211, driverId: f.ramiro, coDriverId: f.sofia });
    await dispatchLeg(a, us.id);
    const { driverToday } = await import("./tracking");
    expect((await driverToday(a.tenantId, f.ramiro)).items[0].freightReady).toBe(false);
    for (const st of ["accepted", "en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, cross.id, st, { source: "driver_app" });
    expect(await legState(mx.id)).toBe("completed"); // handed off at the patio
    // the packet went out; the border steps drive the leg
    const [c] = await db.select().from(s.crossings).where(eq(s.crossings.legId, cross.id));
    await db.update(s.crossings).set({ state: "packet_sent", packetSentAt: new Date() }).where(eq(s.crossings.id, c.id));
    const today = await driverToday(a.tenantId, f.arturo);
    expect(today.current?.next).toBeNull(); // one button, not two
    expect(today.current?.crossing?.nextStep).toBe("departed_yard");
    for (const st of ["departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as const) await X.step(a, c.id, st, { source: "driver_app" });
    expect(await legState(cross.id)).toBe("completed");
    const r = (await board(a)).find((x) => x.order.id === o.order.id)!;
    expect(r.legs.map((l) => l.state)).toEqual(["completed", "completed", "dispatched"]);
    // the US team sees the freight is at the Laredo yard; the planner stops saying it is on the Mexican side
    expect((await driverToday(a.tenantId, f.ramiro)).items[0].freightReady).toBe(true);
    const { plannerData } = await import("./planner");
    const p = await plannerData(a);
    expect(p.trucks.find((t) => t.unit === "211")?.status).not.toBe("waiting_crossing");
    const ev = await db.select().from(s.legEvents).where(and(eq(s.legEvents.legId, us.id), eq(s.legEvents.kind, "note")));
    expect(ev.some((e) => /cleared customs/.test(e.note ?? ""))).toBe(true);
  });
});

describe("a partner transfer carrier can run the crossing leg (F-31.4, owner blocker 2, M1, M18)", () => {
  it("accepted with driver, unit, plates and caja: eligibility uses them, the caja lands on the crossing, the carta de retiro names the carrier", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 295000, stops: mxStops, book: true });
    const cross = o.legs[1];
    const [c0] = await db.select().from(s.crossings).where(eq(s.crossings.legId, cross.id));
    const t = await sendTender(a, cross.id, { carrierId: f.puente, rateCents: 25000, expiresInMinutes: 60 });
    let c = await X.recompute(a, c0.id);
    expect(c.eligibility?.findings.map((x) => x.code)).toContain("carrier_not_accepted");
    expect(c.eligibility?.findings.map((x) => x.code)).not.toContain("no_truck");
    await respondToTender(t.tender.token, { accept: true, name: "Mike", driverName: "Juan Pérez", driverPhone: "+1 956 555 0100", unitNumber: "P-14", unitPlate: "TX-9981", trailerNumber: "caja-7702" });
    c = await X.recompute(a, c0.id);
    expect(c.trailerNumber).toBe("CAJA-7702");
    expect(c.eligibility?.ok).toBe(true);
    const page = await X.crossingPage(a, c0.id);
    expect(page.partner).toMatchObject({ carrier: "Puente Transfer", driverName: "Juan Pérez", unitNumber: "P-14", unitPlate: "TX-9981" });
    const doc = await X.generateCartaRetiro(a, c0.id, { authorizedBy: "Diego" });
    expect(doc.extracted).toMatchObject({ trailer: { value: "CAJA-7702" }, unit: { value: "P-14" }, driver: { value: "Juan Pérez" }, usPlate: { value: "TX-9981" } });
    // the cross-checks compare the manifest's plates and driver with what the carrier gave
    await X.uploadDocument(a, c0.id, { code: "ace_manifest", fileName: "ace.pdf", mimeType: "application/pdf", bytes: pdf(), fields: { trailer: "CAJA-7702", driver: "Juan Perez", usPlate: "TX-9981" } });
    const checks = await db.select().from(s.crossingChecks).where(eq(s.crossingChecks.crossingId, c0.id));
    expect(checks.find((k) => k.code === "tractor_plates")?.state).toBe("pass");
    expect(checks.find((k) => k.code === "driver")?.state).toBe("pass");
    // the packet goes to the carrier's driver once the leg is accepted
    const ev = await db.select().from(s.legEvents).where(and(eq(s.legEvents.legId, cross.id), eq(s.legEvents.kind, "tender")));
    expect(ev.find((e) => (e.data as { state: string }).state === "accepted")?.note).toContain("TX-9981");
  });

  it("a Mexican carrier reads the offer in Spanish; the others in English; ?lang switches", () => {
    expect(tenderLang("MX")).toBe("es");
    expect(tenderLang("US")).toBe("en");
    expect(tenderLang("MX", "en")).toBe("en");
    expect(TENDER_COPY.es.canYou("Transportes del Norte")).toBe("Transportes del Norte, ¿puede cubrir esta carga?");
    expect(Object.keys(TENDER_COPY.es).sort()).toEqual(Object.keys(TENDER_COPY.en).sort());
  });
});

describe("assign changes keep the leg sent (F-31.6, dispatch M3, M4)", () => {
  it("a new trailer, co-driver or miles keeps it Sent; a new driver re-sends it", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 150000, stops: [mxStops[2], mxStops[3]], book: true });
    const leg = o.legs[0];
    await planLeg(a, leg.id, { kind: "truck", truckId: f.t211, driverId: f.ramiro });
    await dispatchLeg(a, leg.id);
    const r1 = await planLeg(a, leg.id, { kind: "truck", truckId: f.t211, driverId: f.ramiro, coDriverId: f.sofia, trailerId: f.tr5301 }, { plannedMiles: 430 });
    expect(r1.kept).toBe(true);
    const [l1] = await db.select().from(s.legs).where(eq(s.legs.id, leg.id));
    expect([l1.state, l1.trailerId, l1.coDriverId, l1.plannedMiles]).toEqual(["dispatched", f.tr5301, f.sofia, 430]);
    expect(l1.dispatchedAt).not.toBeNull();
    // the change is on the timeline and nothing was re-sent
    const ev = await db.select().from(s.legEvents).where(eq(s.legEvents.legId, leg.id));
    expect(ev.filter((e) => e.kind === "transition" && e.toState === "dispatched").length).toBe(1);
    expect(ev.some((e) => /Changed without re-sending: .*trailer/.test(e.note ?? ""))).toBe(true);
    // a different driver is a new crew: back through Planned
    const r2 = await planLeg(a, leg.id, { kind: "truck", truckId: f.t211, driverId: f.sofia, coDriverId: f.ramiro, trailerId: f.tr5301 });
    expect(r2.kept).toBe(false);
    expect(await legState(leg.id)).toBe("planned");
    expect(sameCrew({ assigneeKind: "carrier", truckId: null, driverId: null, carrierId: f.puente }, { kind: "carrier", carrierId: f.puente, carrierRateCents: 1 })).toBe(true);
    expect(sameCrew({ assigneeKind: "truck", truckId: f.t211, driverId: f.ramiro, carrierId: null }, { kind: "truck", truckId: f.t212, driverId: f.ramiro })).toBe(false);
  });
});

describe("crossing checks tell the truth (F-31.7, dispatch M16, M17)", () => {
  it("the direction decides: northbound needs entry and DTOPS; southbound and Canada need no carta de retiro", () => {
    const nb = { fromCountry: "MX", toCountry: "US" };
    const sb = { fromCountry: "US", toCountry: "MX" };
    const ca = { fromCountry: "US", toCountry: "CA" };
    const caUs = { fromCountry: "CA", toCountry: "US" };
    expect([directionRule("entry", nb), directionRule("dtops", nb), directionRule("carta_retiro", nb)]).toEqual(["required", "required", null]);
    expect(directionRule("carta_retiro", sb)).toBe("skip");
    expect(directionRule("carta_retiro", ca)).toBe("skip");
    expect(directionRule("entry", caUs)).toBe("required");
    expect(directionRule("entry", sb)).toBeNull();
  });

  it("a southbound crossing has no carta de retiro on its list; a northbound one needs the entry", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 100000, stops: [mxStops[2], { ...mxStops[1] }, { ...mxStops[0], type: "delivery" }], book: true });
    const [c] = await db.select().from(s.crossings).where(eq(s.crossings.orderId, o.order.id));
    const cur = await X.recompute(a, c.id);
    expect(cur.requirements.map((r) => r.code)).not.toContain("carta_retiro");
    await expect(X.generateCartaRetiro(a, c.id, {})).rejects.toThrow(/northbound/);
  });

  it("the seal typed on the crossing is compared with the documents'; a partner's unit is not called 'no truck'", () => {
    const docs = { bol: { seal: "S-1" }, doda: { seal: "S-1" } };
    const r = runChecksPure({ now: new Date(), docs, trailerNumber: null, truck: null, driver: null, mxBrokerPatente: null, sealNumber: "S-2" });
    expect(r.find((k) => k.code === "seal")).toMatchObject({ state: "fail" });
    const p = runChecksPure({ now: new Date(), docs: {}, trailerNumber: null, truck: null, driver: null, mxBrokerPatente: null, partner: { carrier: "Puente", unit: "P-14", plates: null } });
    expect(p.find((k) => k.code === "dtops")?.message).toMatch(/Puente's unit is not in our Fleet/);
    expect(p.find((k) => k.code === "tractor_plates")?.message).toMatch(/Puente gave no plates/);
  });
});
