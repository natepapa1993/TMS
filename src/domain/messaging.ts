import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, type Ctx } from "@/lib/context";
import { normalizePhone, parseWebhook, verifySignature } from "@/integrations/whatsapp";

/**
 * Two-way messaging (spec §4.2 WhatsApp): delivery receipts land on the outbox row, and what a driver or
 * carrier writes back is attached to them and to the leg they are on, as a note on the timeline.
 */

export async function integrationByWebhookToken(token: string) {
  const rows = await db.select().from(s.integrations).where(and(eq(s.integrations.provider, "whatsapp"), sql`${s.integrations.config}->>'webhookToken' = ${token}`)).limit(1);
  return rows[0] ?? null;
}

/** GET verification from Meta: echo the challenge when the verify token matches. */
export function verifyChallenge(config: Record<string, string>, params: URLSearchParams) {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!config.verifyToken || params.get("hub.verify_token") !== config.verifyToken) return null;
  return params.get("hub.challenge");
}

export type InboundResult = { statuses: number; messages: number; attached: number };

/** POST from Meta: statuses → outbox, messages → inbound table + leg timeline. Signature checked when an app secret is on file. */
export async function receiveWhatsAppWebhook(integration: typeof s.integrations.$inferSelect, rawBody: string, signature: string | null): Promise<InboundResult> {
  if (integration.config.appSecret && !verifySignature(integration.config.appSecret, rawBody, signature)) throw new Error("bad signature");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error("not JSON");
  }
  const parsed = parseWebhook(body);
  const tenantId = integration.tenantId;
  let statuses = 0;
  for (const st of parsed.statuses) {
    const patch: Partial<typeof s.outbox.$inferInsert> = {};
    if (st.status === "delivered") {
      patch.state = "delivered";
      patch.deliveredAt = st.at;
    } else if (st.status === "read") {
      patch.state = "read";
      patch.readAt = st.at;
    } else if (st.status === "failed") {
      patch.state = "failed";
      patch.error = st.error ?? "failed at WhatsApp";
    } else continue; // "sent" we already know
    const r = await db
      .update(s.outbox)
      .set(patch)
      .where(and(eq(s.outbox.tenantId, tenantId), eq(s.outbox.providerId, st.providerId), st.status === "delivered" ? inArray(s.outbox.state, ["sent", "queued"]) : sql`true`))
      .returning({ id: s.outbox.id });
    if (r.length) statuses++;
  }
  let messages = 0;
  let attached = 0;
  for (const m of parsed.messages) {
    const phone = normalizePhone(m.from);
    const [driver] = phone ? await db.select().from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), sql`regexp_replace(coalesce(${s.drivers.whatsapp}, ${s.drivers.phone}, ''), '\\D', '', 'g') in (${phone}, ${phone.replace(/^1/, "")}, ${`1${phone}`})`)).limit(1) : [];
    const [carrier] = !driver && phone ? await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, tenantId), sql`regexp_replace(coalesce(${s.carriers.whatsapp}, ${s.carriers.dispatchPhone}, ''), '\\D', '', 'g') in (${phone}, ${phone.replace(/^1/, "")}, ${`1${phone}`})`)).limit(1) : [];
    // the leg they are on right now (driver: their active leg; carrier: their most recent non-closed leg)
    let leg: typeof s.legs.$inferSelect | undefined;
    if (driver) [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), sql`(${s.legs.driverId} = ${driver.id} or ${s.legs.coDriverId} = ${driver.id})`, inArray(s.legs.state, ["dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"]))).orderBy(desc(s.legs.updatedAt)).limit(1);
    else if (carrier) [leg] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.carrierId, carrier.id), inArray(s.legs.state, ["dispatched", "accepted", "en_route_to_pickup", "at_pickup", "loaded", "en_route", "at_delivery"]))).orderBy(desc(s.legs.updatedAt)).limit(1);
    const inserted = await db
      .insert(s.inboundMessages)
      .values({ id: newId(), tenantId, channel: "whatsapp", from: m.from, fromName: m.name, body: m.text, providerId: m.providerId, receivedAt: m.at, driverId: driver?.id ?? null, carrierId: carrier?.id ?? null, legId: leg?.id ?? null, orderId: leg?.orderId ?? null })
      .onConflictDoNothing()
      .returning({ id: s.inboundMessages.id });
    if (!inserted.length) continue; // Meta retries deliveries; the provider id makes this idempotent
    messages++;
    if (leg) {
      const who = driver?.name ?? carrier?.name ?? m.name ?? m.from;
      await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: leg.id, orderId: leg.orderId, at: m.at, kind: "message", source: driver ? "driver_app" : "carrier", verified: false, note: `WhatsApp from ${who}: ${m.text}`, data: { channel: "whatsapp", from: m.from, providerId: m.providerId } });
      attached++;
    }
  }
  await db.update(s.integrations).set({ lastRunAt: new Date(), lastResult: JSON.stringify({ statuses, messages, attached }), lastError: null }).where(eq(s.integrations.id, integration.id));
  return { statuses, messages, attached };
}

/** Recent inbound messages for the office: unattached ones first (nobody is on a leg for that number). */
export async function inbox(ctx: Ctx, opts: { limit?: number } = {}) {
  assertCtx(ctx);
  return db
    .select({ m: s.inboundMessages, driverName: s.drivers.name, carrierName: s.carriers.name, orderNumber: s.orders.orderNumber })
    .from(s.inboundMessages)
    .leftJoin(s.drivers, eq(s.drivers.id, s.inboundMessages.driverId))
    .leftJoin(s.carriers, eq(s.carriers.id, s.inboundMessages.carrierId))
    .leftJoin(s.orders, eq(s.orders.id, s.inboundMessages.orderId))
    .where(eq(s.inboundMessages.tenantId, ctx.tenantId))
    .orderBy(desc(s.inboundMessages.receivedAt))
    .limit(opts.limit ?? 100);
}

export async function markHandled(ctx: Ctx, id: string) {
  assertCtx(ctx);
  await db.update(s.inboundMessages).set({ handledAt: new Date() }).where(and(eq(s.inboundMessages.tenantId, ctx.tenantId), eq(s.inboundMessages.id, id)));
}
