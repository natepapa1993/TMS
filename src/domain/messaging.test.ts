// Features: F-4.2 WhatsApp Business — outbox delivery through the Cloud API, receipts on the row, driver replies on the leg timeline, tender by WhatsApp
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { integrations, outbox, legEvents, inboundMessages, tenants } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, orderTimeline } from "./orders";
import { sendTender } from "./tenders";
import { integrationByWebhookToken, verifyChallenge, receiveWhatsAppWebhook, inbox } from "./messaging";

const future = new Date(Date.now() + 365 * 86400_000);
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; garza: string; t2104: string; reyes: string };
const sig = (secret: string, raw: string) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, billingEmail: "ap@rxo.test" });
  const garza = await create(a, "carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "d@garza.test", whatsapp: "+52 81 1234 5678", caatExpires: future });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, phone: "+1 956 000 0003", currentTruckId: t2104.id });
  f = { rxo: rxo.id, garza: garza.id, t2104: t2104.id, reyes: reyes.id };
});
afterEach(() => vi.unstubAllGlobals());

async function connect(cfg: Record<string, string>) {
  await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "whatsapp", enabled: true, config: { phoneNumberId: "1234", accessToken: "tok", webhookToken: "hook-1", verifyToken: "verify-1", ...cfg } });
}

describe("WhatsApp through the outbox", () => {
  it("without the integration a WhatsApp message is logged; with it, it is sent through the Cloud API using the tenant's template for its kind", async () => {
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "hi", meta: { kind: "general" } });
    expect(await deliverQueued()).toMatchObject({ logged: 1, sent: 0 });
    await connect({ generalTemplate: "office_message", templateLanguage: "es_MX" });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${bodies.length}` }] }), { status: 200 });
    });
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "Packet ready", meta: { kind: "general", template: { name: "", params: ["Packet ready"] } } });
    expect(await deliverQueued()).toMatchObject({ sent: 1 });
    expect(bodies[0]).toMatchObject({ to: "19560000003", type: "template", template: { name: "office_message", language: { code: "es_MX" } } });
    const [row] = await db.select().from(outbox).where(eq(outbox.state, "sent"));
    expect(row.providerId).toBe("wamid.1");
    // no template for the kind → plain text (works inside the 24 h window)
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "plain", meta: { kind: "tracking" } });
    await deliverQueued();
    expect(bodies[1]).toMatchObject({ type: "text", text: { body: "plain" } });
    // API failure → error on the row, retried later, never crashes the ticker
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "(#131030) not in allowed list" } }), { status: 400 }));
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "x" });
    expect(await deliverQueued()).toMatchObject({ failed: 1 });
    const [bad] = await db.select().from(outbox).where(eq(outbox.body, "x"));
    expect(bad.state).toBe("queued");
    expect(bad.error).toMatch(/131030/);
  });

  it("a company flagged demo never sends: with WhatsApp connected its messages are still only logged", async () => {
    await connect({});
    await db.update(tenants).set({ settings: { demo: true } }).where(eq(tenants.id, a.tenantId));
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (...args: unknown[]) => {
      calls.push(args);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    });
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "demo" });
    await enqueue(a, { channel: "email", to: "ap@rxo.test", subject: "Invoice", body: "demo" });
    expect(await deliverQueued()).toMatchObject({ logged: 2, sent: 0 });
    expect(calls).toHaveLength(0);
    const rows = await db.select().from(outbox);
    expect(rows.every((r) => r.state === "logged" && r.error === "demo company: not sent")).toBe(true);
  });

  it("webhook: verify challenge, signature, delivery + read receipts on the row, failures too; a driver's reply lands on the leg timeline once; unknown numbers stay in the inbox", async () => {
    await connect({ appSecret: "s3cret" });
    const integ = (await integrationByWebhookToken("hook-1"))!;
    expect(integ).toBeTruthy();
    expect(await integrationByWebhookToken("nope")).toBeNull();
    expect(verifyChallenge(integ.config, new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-1", "hub.challenge": "42" }))).toBe("42");
    expect(verifyChallenge(integ.config, new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42" }))).toBeNull();

    // a sent message, then its receipts
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out1" }] }), { status: 200 }));
    await enqueue(a, { channel: "whatsapp", to: "+1 956 000 0003", body: "your loads" });
    await deliverQueued();
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out1", status: "delivered", timestamp: "1790000050" }] } }] }] });
    await expect(receiveWhatsAppWebhook(integ, raw, "sha256=bad")).rejects.toThrow(/signature/);
    expect(await receiveWhatsAppWebhook(integ, raw, sig("s3cret", raw))).toEqual({ statuses: 1, messages: 0, attached: 0 });
    let [row] = await db.select().from(outbox).where(eq(outbox.providerId, "wamid.out1"));
    expect(row.state).toBe("delivered");
    expect(row.deliveredAt).toBeTruthy();
    const raw2 = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.out1", status: "read", timestamp: "1790000090" }] } }] }] });
    await receiveWhatsAppWebhook(integ, raw2, sig("s3cret", raw2));
    [row] = await db.select().from(outbox).where(eq(outbox.providerId, "wamid.out1"));
    expect(row.state).toBe("read");

    // the driver on a moving leg writes back
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 100000, stops: [{ type: "pickup", name: "A", country: "US" }, { type: "delivery", name: "B", country: "US" }], template: "domestic", book: true });
    await planLeg(a, o.legs[0].id, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, o.legs[0].id);
    await acceptLeg(a, o.legs[0].id);
    await advanceLeg(a, o.legs[0].id, "en_route_to_pickup");
    const raw3 = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "19560000003", profile: { name: "Daniel" } }], messages: [{ id: "wamid.in1", from: "19560000003", timestamp: "1790000200", type: "text", text: { body: "loaded, rolling to SA" } }] } }] }] });
    expect(await receiveWhatsAppWebhook(integ, raw3, sig("s3cret", raw3))).toEqual({ statuses: 0, messages: 1, attached: 1 });
    expect(await receiveWhatsAppWebhook(integ, raw3, sig("s3cret", raw3))).toEqual({ statuses: 0, messages: 0, attached: 0 }); // Meta retries: idempotent
    const ev = await db.select().from(legEvents).where(and(eq(legEvents.legId, o.legs[0].id), eq(legEvents.kind, "message")));
    expect(ev).toHaveLength(1);
    expect(ev[0].note).toBe("WhatsApp from Daniel Reyes: loaded, rolling to SA");
    expect((await orderTimeline(a, o.order.id)).events.some((e) => e.note?.includes("loaded, rolling"))).toBe(true);
    // an unknown number: kept, unattached, visible in the inbox
    const raw4 = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.in2", from: "15550001111", timestamp: "1790000300", type: "text", text: { body: "who is this" } }] } }] }] });
    expect(await receiveWhatsAppWebhook(integ, raw4, sig("s3cret", raw4))).toEqual({ statuses: 0, messages: 1, attached: 0 });
    const rows = await inbox(a);
    expect(rows[0].m.body).toBe("who is this");
    expect(rows[0].driverName).toBeNull();
    expect(rows[1].driverName).toBe("Daniel Reyes");
    expect(rows[1].orderNumber).toBe(o.order.orderNumber);
    expect((await db.select().from(inboundMessages)).length).toBe(2);
  });

  it("a tender by WhatsApp goes to the carrier's number with the tender template params; no number → refused", async () => {
    await connect({ tenderTemplate: "load_offer" });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.t1" }] }), { status: 200 });
    });
    const o = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX", address: { city: "Monterrey", state: "NL" } }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }], template: "mx_crossing", book: true });
    const t = await sendTender(a, o.legs[0].id, { carrierId: f.garza, rateCents: 45000, channel: "whatsapp" });
    expect(t.to).toBe("+52 81 1234 5678");
    expect(bodies[0]).toMatchObject({ to: "528112345678", type: "template", template: { name: "load_offer" } });
    const params = (bodies[0].template as { components: { parameters: { text: string }[] }[] }).components[0].parameters.map((p) => p.text);
    expect(params[0]).toBe("Transportes Garza");
    expect(params[1]).toBe("Planta Monterrey, Monterrey NL → Santa Fe");
    expect(params[2]).toBe("USD 450.00");
    expect(params[3]).toBe(t.link);
    const { update } = await import("@/data/records");
    await update(a, "carrier", f.garza, { whatsapp: "" });
    await expect(sendTender(a, o.legs[1].id, { carrierId: f.garza, rateCents: 10000, channel: "whatsapp" })).rejects.toThrow(/no WhatsApp number/);
  });
});
