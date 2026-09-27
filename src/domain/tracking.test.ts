// Features: F-4 tendering, F-5 tracking (positions, driver app, tracking link, no-position watchdog, appointment-window flags) F-5.9 F-5.10 F-1.7 F-5.11 F-5.14
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { outbox, tenders as tendersTable, flags, legEvents, positions, documents, inboundMessages, stops as stopsTable, legs as legsTable } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder, ValidationError } from "./orders";
import { sendTender, tenderByToken, respondToTender, expireTenders, closeOpenTenderForLeg } from "./tenders";
import { recordPosition, driverToday, driverStep, trackingView, flagStaleTracking, flagWindows, flagDetention, notifyRedFlags, latestTruckPositions, driverUploadPhoto, driverMessage, replyToDriver, driverThread, legEta, orderEtas, flagEta, speedProfile } from "./tracking";
import { issueToken, resolveToken, revokeToken } from "@/lib/tokens";
import { TransitionError } from "./states";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; garza: string; t2117: string; benja: string; lonestar: string };

const stops = [
  { type: "pickup" as const, name: "Planta Monterrey", country: "MX", address: { city: "Apodaca", state: "NL" }, windowStart: new Date(Date.now() + 86400_000) },
  { type: "border_yard" as const, name: "Santa Fe Yard", country: "MX" },
  { type: "yard" as const, name: "Laredo Yard", country: "US" },
  { type: "delivery" as const, name: "GM Arlington", country: "US", address: { city: "Arlington", state: "TX" } },
];

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker" });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "despacho@garza.test", caatExpires: future });
  const lonestar = await create(a, "carrier", { name: "Lone Star", country: "US", kind: "us", mcNumber: "123456" }); // no email
  const t2117 = await create(a, "truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown", usPlateExpires: future, mxPlateExpires: future });
  const benja = await create(a, "driver", { name: "Benjamín Xochihua", driverType: "B1", mxLicenseExpires: future, fastExpires: future, i94Until: future, medicalExpires: future, licenseExpires: future, currentTruckId: t2117.id });
  f = { rxo: rxo.id, garza: garza.id, t2117: t2117.id, benja: benja.id, lonestar: lonestar.id };
});

describe("tendering (F-4)", () => {
  it("send → email queued with the link → carrier accepts on the portal → leg accepted with driver details", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true, cargoNote: "26 pallets" });
    const r = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 60, message: "Team please" });
    expect(r.leg.state).toBe("dispatched");
    expect(r.leg.carrierId).toBe(f.garza);
    expect(r.to).toBe("despacho@garza.test");
    expect(r.subject).toContain(o.order.orderNumber);
    expect(r.body).toContain("USD 450.00");
    expect(r.body).toContain("Team please");
    expect(r.body).toContain(`/t/${r.tender.token}`);
    const mail = await db.select().from(outbox).where(eq(outbox.subjectId, r.tender.id));
    expect(mail.length).toBe(1);
    expect(mail[0].state).toBe("logged"); // no provider key in tests → logged, never lost

    const view = await tenderByToken(r.tender.token);
    expect(view!.tender.state).toBe("sent");
    expect(view!.carrier!.name).toBe("Transportes Garza");
    expect(view!.from!.name).toBe("Planta Monterrey");

    await expect(respondToTender(r.tender.token, { accept: true, name: "Luis" })).rejects.toBeInstanceOf(ValidationError); // driver required
    const res = await respondToTender(r.tender.token, { accept: true, name: "Luis", driverName: "Pedro Ruiz", driverPhone: "+52 81 000", unitNumber: "MX-45", trailerNumber: "10743" });
    expect(res.state).toBe("accepted");
    expect(res.leg.state).toBe("accepted");
    const [t] = await db.select().from(tendersTable).where(eq(tendersTable.id, r.tender.id));
    expect(t.state).toBe("accepted");
    expect(t.driverName).toBe("Pedro Ruiz");
    const notes = await db.select().from(legEvents).where(and(eq(legEvents.legId, o.legs[0].id), eq(legEvents.kind, "note")));
    expect(notes[0].note).toContain("Pedro Ruiz");
    // a second answer is refused
    await expect(respondToTender(r.tender.token, { accept: false, name: "Luis", note: "changed my mind" })).rejects.toBeInstanceOf(TransitionError);
  });

  it("decline sends the leg back to Pending with the carrier's reason", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    const r = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000 });
    await expect(respondToTender(r.tender.token, { accept: false, name: "Luis" })).rejects.toBeInstanceOf(ValidationError); // reason required
    const res = await respondToTender(r.tender.token, { accept: false, name: "Luis", note: "no trucks Monday" });
    expect(res.leg.state).toBe("declined");
    expect(res.leg.declineReason).toContain("no trucks Monday");
    const fl = await db.select().from(flags).where(eq(flags.legId, o.legs[0].id));
    expect(fl[0].code).toBe("declined");
    expect((await getOrder(a, o.order.id)).order.state).toBe("booked");
  });

  it("a new tender withdraws the old open one; a carrier without an email cannot be tendered by email", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    const r1 = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000 });
    await expect(sendTender(a, o.legs[2].id, { carrierId: f.lonestar })).rejects.toThrow(/no dispatch email/);
    // pull it back and offer to the same carrier at a new rate
    await closeOpenTenderForLeg(a, o.legs[0].id, "withdrawn", "rate changed");
    const { unplanLeg } = await import("./orders");
    await unplanLeg(a, o.legs[0].id);
    const r2 = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 48000 });
    const all = await db.select().from(tendersTable).where(eq(tendersTable.legId, o.legs[0].id));
    expect(all.find((t) => t.id === r1.tender.id)!.state).toBe("withdrawn");
    expect(all.find((t) => t.id === r2.tender.id)!.state).toBe("sent");
    await expect(respondToTender(r1.tender.token, { accept: true, name: "x", driverName: "y" })).rejects.toBeInstanceOf(TransitionError);
  });

  it("expiry job: past-deadline tenders expire and the leg returns to Pending with a tender_expired flag", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    const r = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000, expiresInMinutes: 30 });
    expect((await expireTenders(new Date())).expired).toBe(0);
    const later = new Date(Date.now() + 31 * 60_000);
    expect((await tenderByToken(r.tender.token))!.tender.state).toBe("sent");
    expect((await expireTenders(later)).expired).toBe(1);
    expect((await tenderByToken(r.tender.token))!.tender.state).toBe("expired");
    const g = await getOrder(a, o.order.id);
    expect(g.legs[0].state).toBe("declined");
    const fl = await db.select().from(flags).where(eq(flags.legId, o.legs[0].id));
    expect(fl[0].code).toBe("tender_expired");
    await expect(respondToTender(r.tender.token, { accept: true, name: "x", driverName: "y" })).rejects.toThrow(/expired/);
  });

  it("bad expiry and role are refused", async () => {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    await expect(sendTender(a, o.legs[0].id, { carrierId: f.garza, expiresInMinutes: 1 })).rejects.toBeInstanceOf(ValidationError);
    const billing = { ...a, role: "billing" as const };
    await expect(sendTender(billing, o.legs[0].id, { carrierId: f.garza })).rejects.toThrow(/permission/);
  });
});

describe("tracking (F-5)", () => {
  async function crossingLeg() {
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    await planLeg(a, o.legs[1].id, { kind: "truck", truckId: f.t2117, driverId: f.benja });
    await dispatchLeg(a, o.legs[1].id);
    return o;
  }

  it("driver app: today shows the offered leg; each button press advances it and a GPS fix makes it verified", async () => {
    const o = await crossingLeg();
    let today = await driverToday(a.tenantId, f.benja);
    expect(today.driver.name).toBe("Benjamín Xochihua");
    expect(today.current!.leg.id).toBe(o.legs[1].id);
    expect(today.current!.next!.label).toBe("Accept this load");
    expect(today.current!.from!.name).toBe("Santa Fe Yard");
    expect(today.current!.truck!.unitNumber).toBe("2117");

    await driverStep(a.tenantId, f.benja, o.legs[1].id, {});
    today = await driverToday(a.tenantId, f.benja);
    expect(today.current!.leg.state).toBe("accepted");
    expect(today.current!.next!.to).toBe("en_route_to_pickup");
    await driverStep(a.tenantId, f.benja, o.legs[1].id, { lat: 27.48, lng: -99.52, accuracyM: 12 });
    await driverStep(a.tenantId, f.benja, o.legs[1].id, { lat: 27.49, lng: -99.53 });
    const evs = await db.select().from(legEvents).where(and(eq(legEvents.legId, o.legs[1].id), eq(legEvents.kind, "transition")));
    const verified = evs.filter((e) => e.verified);
    expect(verified.length).toBe(2);
    expect(verified[0].source).toBe("driver_app");
    const pos = await db.select().from(positions).where(eq(positions.legId, o.legs[1].id));
    expect(pos.length).toBe(2);
    expect(pos[0].truckId).toBe(f.t2117);
    expect(pos[0].orderId).toBe(o.order.id);
    // the second driver cannot touch a leg that isn't theirs
    const other = await create(a, "driver", { name: "Nobody", driverType: "CDL" });
    await expect(driverStep(a.tenantId, other.id, o.legs[1].id, {})).rejects.toThrow(/not found/);
    // decline from the app
    const o2 = await crossingLeg();
    const d = await driverStep(a.tenantId, f.benja, o2.legs[1].id, { decline: true, declineReason: "sick" });
    expect(d.state).toBe("declined");
  });

  it("driver app photos: a seal photo while loading and a POD at the delivery land on the order as billing's documents; nobody else's leg; not before arriving", async () => {
    const o = await crossingLeg();
    const legId = o.legs[1].id;
    const jpg = Buffer.from("\xff\xd8\xff fixture", "binary");
    // not at a stop yet → the POD has nowhere to go
    await driverStep(a.tenantId, f.benja, legId, {}); // accepted
    await expect(driverUploadPhoto(a.tenantId, f.benja, legId, { code: "POD", fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toThrow(/arrived at the delivery/);
    await driverStep(a.tenantId, f.benja, legId, {}); // en route to pickup
    await driverStep(a.tenantId, f.benja, legId, {}); // at pickup
    let today = await driverToday(a.tenantId, f.benja);
    expect(today.current!.docs).toEqual({ pod: false, seal: false });
    await driverUploadPhoto(a.tenantId, f.benja, legId, { code: "SEAL_PHOTO", fileName: "seal.jpg", mimeType: "image/jpeg", bytes: jpg });
    today = await driverToday(a.tenantId, f.benja);
    expect(today.current!.docs.seal).toBe(true);
    await driverStep(a.tenantId, f.benja, legId, {}); // loaded
    await driverStep(a.tenantId, f.benja, legId, {}); // en route
    await driverStep(a.tenantId, f.benja, legId, {}); // at delivery
    const other = await create(a, "driver", { name: "Nobody", driverType: "CDL" });
    await expect(driverUploadPhoto(a.tenantId, other.id, legId, { code: "POD", fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg })).rejects.toThrow(/not found/);
    const rows = await driverUploadPhoto(a.tenantId, f.benja, legId, { code: "POD", fileName: "pod.jpg", mimeType: "image/jpeg", bytes: jpg });
    expect(rows.length).toBe(1);
    const docs = await db.select().from(documents).where(and(eq(documents.subjectKind, "order"), eq(documents.subjectId, o.order.id)));
    expect(docs.map((d) => [d.code, d.source, d.status])).toEqual(expect.arrayContaining([["SEAL_PHOTO", "driver_app", "present"], ["POD", "driver_app", "present"]]));
    today = await driverToday(a.tenantId, f.benja);
    expect(today.current!.docs.pod).toBe(true);
    const evs = await db.select().from(legEvents).where(and(eq(legEvents.legId, legId), eq(legEvents.kind, "document")));
    expect(evs.map((e) => e.note)).toEqual(["Seal photo from the driver app at Santa Fe Yard", "POD photo from the driver app at Laredo Yard"]);
    // a second POD photo supersedes the first; the newest is what billing sees
    await driverUploadPhoto(a.tenantId, f.benja, legId, { code: "POD", fileName: "pod2.jpg", mimeType: "image/jpeg", bytes: jpg });
    const pods = await db.select().from(documents).where(and(eq(documents.subjectId, o.order.id), eq(documents.code, "POD")));
    expect(pods.map((d) => d.status).sort()).toEqual(["present", "superseded"]);
  });

  it("driver ↔ dispatch: a message from the app lands in Messages on the leg; the reply shows in the app and, with WhatsApp connected, goes there too", async () => {
    const o = await crossingLeg();
    const legId = o.legs[1].id;
    await expect(driverMessage(a.tenantId, f.benja, legId, "  ")).rejects.toThrow(/write something/);
    const m = await driverMessage(a.tenantId, f.benja, legId, "Trailer 10743 has a flat, at the yard");
    expect(m.channel).toBe("driver_app");
    expect(m.orderId).toBe(o.order.id);
    expect(m.fromName).toBe("Benjamín Xochihua");
    // a leg that isn't theirs is ignored, the message still lands
    const other = await create(a, "driver", { name: "Nobody", driverType: "CDL" });
    const m2 = await driverMessage(a.tenantId, other.id, legId, "hola");
    expect(m2.legId).toBeNull();
    const ev = await db.select().from(legEvents).where(and(eq(legEvents.legId, legId), eq(legEvents.kind, "message")));
    expect(ev.length).toBe(1);
    expect(ev[0].note).toContain("flat");
    // dispatch answers; no WhatsApp connected → only the in-app row
    await replyToDriver(a, f.benja, "Stay put, sending the tire guy", o.order.id);
    let out = await db.select().from(outbox).where(eq(outbox.subjectKind, "driver_reply"));
    expect(out.map((r) => [r.channel, r.state])).toEqual([["driver_app", "sent"]]);
    const thread = await driverThread(a.tenantId, f.benja);
    expect(thread.map((x) => [x.who, x.body])).toEqual([["driver", "Trailer 10743 has a flat, at the yard"], ["dispatch", "Stay put, sending the tire guy"]]);
    expect(thread[0].seen).toBe(false);
    await db.update(inboundMessages).set({ handledAt: new Date() }).where(eq(inboundMessages.id, m.id));
    expect((await driverThread(a.tenantId, f.benja))[0].seen).toBe(true);
    // the other driver sees nothing of Benja's thread
    expect((await driverThread(a.tenantId, other.id)).map((x) => x.body)).toEqual(["hola"]);
    // with WhatsApp connected and a phone on file, the reply also goes out on WhatsApp
    const { integrations } = await import("@/db/schema");
    await db.insert(integrations).values({ id: "int-wa", tenantId: a.tenantId, provider: "whatsapp", enabled: true, config: { phoneNumberId: "1", accessToken: "t" } });
    const { update } = await import("@/data/records");
    await update(a, "driver", f.benja, { phone: "+52 81 1234 5678" });
    await replyToDriver(a, f.benja, "Tire guy is 20 min out");
    out = await db.select().from(outbox).where(eq(outbox.subjectKind, "driver_reply"));
    expect(out.filter((r) => r.channel === "whatsapp").length).toBe(1);
    await expect(replyToDriver(a, f.benja, "")).rejects.toThrow(/write something/);
  });

  it("positions: ELD pings attach to the truck's moving leg, duplicates by external id are ignored, latest per truck", async () => {
    const o = await crossingLeg();
    await acceptLeg(a, o.legs[1].id);
    await advanceLeg(a, o.legs[1].id, "en_route_to_pickup");
    const p1 = await recordPosition(a, { source: "eld", truckId: f.t2117, lat: 27.5, lng: -99.5, externalId: "m-1", speedMph: 55, place: "Nuevo Laredo, TAMPS" });
    expect(p1.legId).toBe(o.legs[1].id);
    expect(p1.orderId).toBe(o.order.id);
    const p2 = await recordPosition(a, { source: "eld", truckId: f.t2117, lat: 27.5, lng: -99.5, externalId: "m-1" });
    expect(p2.duplicate).toBe(true);
    await recordPosition(a, { source: "eld", truckId: f.t2117, lat: 27.6, lng: -99.4, externalId: "m-2", at: new Date(Date.now() + 60_000) });
    const latest = await latestTruckPositions(a);
    expect(latest.length).toBe(1);
    expect(latest[0].lat).toBe("27.600000");
    await expect(recordPosition(a, { source: "eld", truckId: f.t2117, lat: 999, lng: 0 })).rejects.toBeInstanceOf(ValidationError);
    const other = await makeTenant("B");
    expect((await latestTruckPositions(other)).length).toBe(0);
  });

  it("tracking link shows progress and last position but no money or phones", async () => {
    const o = await crossingLeg();
    await acceptLeg(a, o.legs[1].id);
    await advanceLeg(a, o.legs[1].id, "en_route_to_pickup", { source: "driver_app", verified: true, lat: "27.5", lng: "-99.5" });
    await recordPosition(a, { source: "driver_app", truckId: f.t2117, lat: 27.5, lng: -99.5, place: "Nuevo Laredo" });
    const v = await trackingView(a.tenantId, o.order.id);
    expect(v.order.orderNumber).toBe(o.order.orderNumber);
    expect(v.stops.map((x) => x.name)).toContain("GM Arlington");
    expect(v.lastPosition!.place).toBe("Nuevo Laredo");
    expect(JSON.stringify(v)).not.toMatch(/rateCents|carrierRate|phone|285000/);
    expect(v.customerCountry).toBe("US"); // the page's default language follows it
    const tok = await issueToken(a, "tracking_link", o.order.id);
    const again = await issueToken(a, "tracking_link", o.order.id);
    expect(again.id).toBe(tok.id); // reused
    const r = await resolveToken(tok.token, "tracking_link");
    expect(r!.subjectId).toBe(o.order.id);
    expect(r!.ctx.tenantId).toBe(a.tenantId);
    expect(await resolveToken(tok.token, "driver_app")).toBeNull();
    await revokeToken(a, tok.id);
    expect(await resolveToken(tok.token)).toBeNull();
    expect(await resolveToken("nope")).toBeNull();
  });

  it("watchdog: a moving truck leg with no ping for 2h gets one yellow flag, cleared when a ping arrives", async () => {
    const o = await crossingLeg();
    await acceptLeg(a, o.legs[1].id);
    await advanceLeg(a, o.legs[1].id, "en_route_to_pickup", { at: new Date(Date.now() - 3 * 3600_000) });
    expect((await flagStaleTracking(new Date())).flagged).toBe(1);
    expect((await flagStaleTracking(new Date())).flagged).toBe(0); // once
    let fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "no_position")));
    expect(fl.length).toBe(1);
    expect(fl[0].clearedAt).toBeNull();
    await recordPosition(a, { source: "eld", truckId: f.t2117, lat: 27.5, lng: -99.5 });
    await flagStaleTracking(new Date());
    fl = await db.select().from(flags).where(and(eq(flags.legId, o.legs[1].id), eq(flags.code, "no_position")));
    expect(fl[0].clearedAt).not.toBeNull();
    // a partner carrier's leg: silent by nature until their driver's phone reports once; after that, silence is a flag
    const o2 = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops, book: true });
    await planLeg(a, o2.legs[0].id, { kind: "carrier", carrierId: f.garza });
    await dispatchLeg(a, o2.legs[0].id);
    await acceptLeg(a, o2.legs[0].id);
    await advanceLeg(a, o2.legs[0].id, "en_route_to_pickup", { at: new Date(Date.now() - 3 * 3600_000), source: "carrier" });
    expect((await flagStaleTracking(new Date())).flagged).toBe(0);
    await recordPosition(a, { source: "phone", legId: o2.legs[0].id, at: new Date(Date.now() - 3 * 3600_000), lat: 25.7, lng: -100.3 });
    expect((await flagStaleTracking(new Date())).flagged).toBe(1);
    const cf = await db.select().from(flags).where(and(eq(flags.legId, o2.legs[0].id), eq(flags.code, "no_position")));
    expect(cf[0].detail).toMatch(/carrier driver's phone/);
  });
});

describe("ETA from the last verified position (F-5.14)", () => {
  it("no coordinates → no ETA; a verified arrival teaches the stop and its location; then miles at the corridor speed give the ETA, late against the window is a flag that clears on arrival", async () => {
    const gm = await create(a, "location", { name: "GM Arlington", country: "US", address: { city: "Arlington", state: "TX" } }); // no coordinates yet
    const mk = () =>
      createOrder(a, {
        customerId: f.rxo,
        rateCents: 100000,
        stops: [
          { type: "pickup", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } },
          { type: "delivery", name: "GM Arlington", country: "US", locationId: gm.id, windowEnd: new Date(Date.now() + 2 * 3600_000) }, // due in two hours
        ],
        template: "domestic",
        book: true,
      });
    const o1 = await mk();
    const leg = o1.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t2117, driverId: f.benja }, { override: true, reason: "test" }).catch(async () => {
      const t2 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
      const d2 = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2.id });
      return planLeg(a, leg, { kind: "truck", truckId: t2.id, driverId: d2.id });
    });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    await advanceLeg(a, leg, "en_route_to_pickup", { source: "driver_app" });
    await advanceLeg(a, leg, "at_pickup", { source: "driver_app", verified: true, lat: "27.5064", lng: "-99.5075" }); // Laredo learned
    await advanceLeg(a, leg, "loaded", { source: "driver_app" });
    await advanceLeg(a, leg, "en_route", { source: "driver_app", verified: true, lat: "27.5064", lng: "-99.5075" });
    expect(await legEta(a.tenantId, leg)).toBeNull(); // Arlington has no coordinates yet
    // the driver arrives with a fix: the stop and the location learn it
    await advanceLeg(a, leg, "at_delivery", { source: "driver_app", verified: true, lat: "32.7357", lng: "-97.1081" });
    const st = await db.select().from(stopsTable).where(eq(stopsTable.orderId, o1.order.id)).orderBy(stopsTable.seq);
    expect(st[1].lat).toBe("32.735700");
    const { get } = await import("@/data/records");
    expect((await get(a, "location", gm.id)).lat).toBe("32.735700");
    await advanceLeg(a, leg, "completed", { source: "driver_app" });
    // the next run to the same plant: stops copy the location's coordinates, the ETA works from the first position
    const o2 = await mk();
    const leg2 = o2.legs[0].id;
    const st2 = await db.select().from(stopsTable).where(eq(stopsTable.orderId, o2.order.id)).orderBy(stopsTable.seq);
    expect(st2[1].lat).toBe("32.735700");
    const plan = await planLeg(a, leg2, { kind: "truck", truckId: (await db.select().from(legsTable).where(eq(legsTable.id, leg)))[0].truckId!, driverId: (await db.select().from(legsTable).where(eq(legsTable.id, leg)))[0].driverId! });
    expect(plan).toBeTruthy();
    await dispatchLeg(a, leg2);
    await acceptLeg(a, leg2);
    for (const s of ["en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, leg2, s, { source: "driver_app" });
    await advanceLeg(a, leg2, "en_route", { source: "driver_app", verified: true, lat: "27.5064", lng: "-99.5075" }); // leaving Laredo, ~400 road miles from Arlington
    const eta = await legEta(a.tenantId, leg2);
    expect(eta).not.toBeNull();
    expect(eta!.stopName).toBe("GM Arlington");
    expect(eta!.miles).toBeGreaterThan(350);
    expect(eta!.miles).toBeLessThan(520); // ~390 straight, ×1.25 corridor factor
    expect(eta!.mph).toBe((await speedProfile(a.tenantId)).US);
    expect(eta!.at.getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000); // hours away
    expect(eta!.late).toBe(true); // the window closes in two hours
    expect(Object.keys(await orderEtas(a.tenantId, o2.order.id))).toEqual([leg2]);
    // the watchdog says so, once, keeps it current, and clears it when the truck arrives
    expect((await flagEta()).flagged).toBe(1);
    expect((await flagEta()).flagged).toBe(0);
    let fl = await db.select().from(flags).where(and(eq(flags.legId, leg2), eq(flags.code, "eta_late")));
    expect(fl.length).toBe(1);
    expect(fl[0].title).toMatch(/ETA at GM Arlington .* past the window/);
    await advanceLeg(a, leg2, "at_delivery", { source: "driver_app" });
    expect((await flagEta()).cleared).toBe(1);
    fl = await db.select().from(flags).where(and(eq(flags.legId, leg2), eq(flags.code, "eta_late")));
    expect(fl[0].clearedAt).not.toBeNull();
  });
});

describe("appointment windows (F-5)", () => {
  it("a pickup opening soon with nobody accepted is at risk; a closed window with no arrival is missed; both clear themselves", async () => {
    const now = new Date("2026-09-27T12:00:00Z");
    const o = await createOrder(a, {
      customerId: f.rxo,
      rateCents: 100000,
      stops: [
        { type: "pickup", name: "Laredo Yard", country: "US", windowStart: new Date("2026-09-27T13:00:00Z"), windowEnd: new Date("2026-09-27T14:00:00Z") },
        { type: "delivery", name: "Toyota", country: "US", windowStart: new Date("2026-09-27T18:00:00Z"), windowEnd: new Date("2026-09-27T19:00:00Z") },
      ],
      template: "domestic",
      book: true,
    });
    const leg = o.legs[0].id;
    // unassigned: nothing to flag yet (there is nobody to be late); planned and unsent: at risk
    expect(await flagWindows(now)).toMatchObject({ missed: 0, atRisk: 0 });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
    await planLeg(a, leg, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    expect(await flagWindows(now)).toMatchObject({ atRisk: 1 });
    const open = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "window_risk")));
    expect(open[0].title).toMatch(/opens in 60 min and nobody has accepted/);
    expect(open[0].level).toBe("yellow");
    expect(await flagWindows(now)).toMatchObject({ atRisk: 0 }); // once
    // accepted → the risk clears
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    expect(await flagWindows(new Date("2026-09-27T12:30:00Z"))).toMatchObject({ cleared: 1 });
    // the pickup window closes with no arrival → missed (red); arriving clears it
    expect(await flagWindows(new Date("2026-09-27T14:01:00Z"))).toMatchObject({ missed: 1 });
    const all = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "window_missed")));
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Missed the pickup window at Laredo Yard");
    expect(all[0].level).toBe("red");
    await advanceLeg(a, leg, "en_route_to_pickup", { at: new Date("2026-09-27T14:05:00Z") });
    await advanceLeg(a, leg, "at_pickup", { at: new Date("2026-09-27T14:30:00Z") });
    expect(await flagWindows(new Date("2026-09-27T14:31:00Z"))).toMatchObject({ cleared: 1, missed: 0 });
    // the delivery window is not judged until the pickup is done; it is, and the delivery is late
    await advanceLeg(a, leg, "loaded", { at: new Date("2026-09-27T15:00:00Z") });
    await advanceLeg(a, leg, "en_route", { at: new Date("2026-09-27T15:01:00Z") });
    expect(await flagWindows(new Date("2026-09-27T18:30:00Z"))).toMatchObject({ missed: 0 });
    expect(await flagWindows(new Date("2026-09-27T19:30:00Z"))).toMatchObject({ missed: 1 });
    const del = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "window_missed")));
    expect(del.map((x) => x.title)).toContain("Missed the delivery window at Toyota");
    // delivered → the leg leaves the open set and takes its flag with it
    await advanceLeg(a, leg, "at_delivery", { at: new Date("2026-09-27T19:40:00Z") });
    await advanceLeg(a, leg, "completed", { at: new Date("2026-09-27T20:00:00Z") });
    expect(await flagWindows(new Date("2026-09-27T20:01:00Z"))).toMatchObject({ cleared: 1 });
    expect((await db.select().from(flags).where(eq(flags.orderId, o.order.id))).every((x) => x.clearedAt)).toBe(true);
  });
});

describe("tracking requirement (F-5)", () => {
  it("a customer who requires a tracking link gets it by email once the order is dispatched, once; others get nothing", async () => {
    const magna = await create(a, "customer", { name: "Magna", kind: "customer", trackingRequirement: "link", billingEmail: "ap@magna.test", contacts: [{ name: "Ana", email: "ana@magna.test" }] });
    const o = await createOrder(a, { customerId: magna.id, rateCents: 100000, refs: { po: "PO-7" }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    expect(await db.select().from(outbox)).toHaveLength(0);
    await dispatchLeg(a, o.legs[0].id);
    const mails = await db.select().from(outbox).where(eq(outbox.subjectKind, "tracking_link"));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("ana@magna.test"); // a contact with an email; never the AP mailbox
    expect(mails[0].subject).toContain("PO-7");
    expect(mails[0].body).toMatch(/\/track\/[A-Za-z0-9_-]{20,}/);
    const token = mails[0].body.match(/\/track\/([A-Za-z0-9_-]+)/)![1];
    expect((await resolveToken(token, "tracking_link"))?.subjectId).toBe(o.order.id);
    // a pull-back and re-send does not mail twice
    await acceptLeg(a, o.legs[0].id);
    expect(await db.select().from(outbox).where(eq(outbox.subjectKind, "tracking_link"))).toHaveLength(1);
    // RXO has no contact with an email: nothing goes out (dispatch can still send the link by hand)
    const r = await createOrder(a, { customerId: f.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    await planLeg(a, r.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    await dispatchLeg(a, r.legs[0].id);
    expect(await db.select().from(outbox).where(eq(outbox.subjectKind, "tracking_link"))).toHaveLength(1);
  });
});

describe("detention running (F-5.9)", () => {
  it("a truck sitting past the customer's free time gets a yellow flag that grows every tick and clears when it leaves", async () => {
    const magna = await create(a, "customer", { name: "Magna", kind: "customer", detentionFreeMinutes: 60 });
    const o = await createOrder(a, { customerId: magna.id, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    const t0 = new Date("2026-09-27T12:00:00Z");
    await advanceLeg(a, leg, "en_route_to_pickup", { at: t0 });
    await advanceLeg(a, leg, "at_pickup", { at: t0 });
    expect(await flagDetention(new Date("2026-09-27T12:59:00Z"))).toMatchObject({ flagged: 0 });
    expect(await flagDetention(new Date("2026-09-27T13:10:00Z"))).toMatchObject({ flagged: 1 });
    let fl = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "detention")));
    expect(fl[0].title).toBe("Detention running at Laredo Yard: 10 min over free time");
    expect(fl[0].level).toBe("yellow");
    expect(await flagDetention(new Date("2026-09-27T13:30:00Z"))).toMatchObject({ flagged: 0, updated: 1 });
    fl = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "detention")));
    expect(fl).toHaveLength(1);
    expect(fl[0].title).toContain("30 min over");
    await advanceLeg(a, leg, "loaded", { at: new Date("2026-09-27T13:40:00Z") });
    expect(await flagDetention(new Date("2026-09-27T13:41:00Z"))).toMatchObject({ cleared: 1 });
    fl = await db.select().from(flags).where(and(eq(flags.orderId, o.order.id), eq(flags.code, "detention")));
    expect(fl[0].clearedAt).toBeTruthy();
  });
});

describe("red flags reach dispatch (F-5.9)", () => {
  it("one email per company per tick to the owner and dispatchers, each flag told once; nothing without a sender", async () => {
    const { integrations } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "Laredo Yard", country: "US", windowEnd: new Date("2026-09-27T10:00:00Z") }, { type: "delivery", name: "Toyota", country: "US" }], template: "domestic", book: true });
    const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
    const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: t2104.id, driverId: reyes.id });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    const now = new Date("2026-09-27T10:05:00Z");
    expect(await flagWindows(now)).toMatchObject({ missed: 1 });
    // no sender: told nobody, but stamped so it is not retried forever
    expect(await notifyRedFlags()).toMatchObject({ emails: 0, flags: 1 }); // opened just now, by the wall clock
    expect(await notifyRedFlags()).toMatchObject({ flags: 0 });
    // with a sender, the next red flag goes out
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "resend", enabled: true, config: { apiKey: "re_test", from: "Dispatch <d@example.com>" } });
    await db.update(flags).set({ data: {} }).where(eq(flags.orderId, o.order.id));
    const r = await notifyRedFlags();
    expect(r).toMatchObject({ emails: 1, flags: 1 }); // the owner
    const mail = (await db.select().from(outbox).where(eq(outbox.subjectKind, "alert")))[0];
    expect(mail.subject).toBe("1 thing needs you on Dispatch");
    expect(mail.body).toContain("Missed the pickup window at Laredo Yard");
    expect(mail.body).toContain(o.order.orderNumber);
    expect(await notifyRedFlags()).toMatchObject({ emails: 0 });
  });
});
