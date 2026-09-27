import { pgTable, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";
import { id, tenantId, audit } from "./core";

/** EDI trading partners (one per customer) and every message in or out (spec §4.2 "EDI 214", §7 "EDI 210", inbound 204). */

export const EDI_DELIVERY = ["email", "pickup"] as const; // pickup = the partner's VAN/AS2 connector collects it from us (download from the log meanwhile)

export const ediPartners = pgTable(
  "edi_partners",
  {
    id: id(),
    tenantId: tenantId(),
    customerId: text("customer_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    usage: text("usage").notNull().default("T"), // T test | P production
    ourQualifier: text("our_qualifier").notNull().default("02"), // 02 = SCAC
    ourId: text("our_id").notNull(), // ISA06 / GS02
    theirQualifier: text("their_qualifier").notNull().default("ZZ"),
    theirId: text("their_id").notNull(), // ISA08 / GS03
    scac: text("scac").notNull(),
    send214: boolean("send_214").notNull().default(true),
    send210: boolean("send_210").notNull().default(false),
    accept204: boolean("accept_204").notNull().default(true),
    autoCreateOrders: boolean("auto_create_orders").notNull().default(true), // 204 → draft order; else it waits in the EDI inbox
    delivery: text("delivery").$type<(typeof EDI_DELIVERY)[number]>().notNull().default("pickup"),
    deliveryEmail: text("delivery_email"),
    statusMap: jsonb("status_map").$type<Record<string, string>>(), // leg state → AT7 code; blank = defaults
    chargeCodes: jsonb("charge_codes").$type<Record<string, string>>(), // charge kind → L1 code; blank = defaults
    nextControl: integer("next_control").notNull().default(1),
    inboundToken: text("inbound_token")
      .notNull()
      .$defaultFn(() => randomBytes(24).toString("base64url")),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    ...audit(),
  },
  (t) => [uniqueIndex("edi_partners_tenant_customer").on(t.tenantId, t.customerId), uniqueIndex("edi_partners_token").on(t.inboundToken)],
);

export const EDI_MESSAGE_STATES = ["queued", "sent", "logged", "received", "accepted", "rejected", "error"] as const;

export const ediMessages = pgTable(
  "edi_messages",
  {
    id: id(),
    tenantId: tenantId(),
    partnerId: text("partner_id").notNull(),
    direction: text("direction").notNull(), // in | out
    type: text("type").notNull(), // 204 | 214 | 210 | 990 | 997
    controlNumber: text("control_number"),
    functionalId: text("functional_id"),
    orderId: text("order_id"),
    legId: text("leg_id"),
    invoiceId: text("invoice_id"),
    subjectKey: text("subject_key"), // idempotency: `${legId}:${state}` for 214, `inv:${invoiceId}` for 210, `in:${isaControl}` for inbound
    summary: text("summary").notNull(), // one line for the log
    content: text("content").notNull(), // the X12 text
    state: text("state").$type<(typeof EDI_MESSAGE_STATES)[number]>().notNull().default("queued"),
    error: text("error"),
    outboxId: text("outbox_id"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("edi_messages_tenant").on(t.tenantId, t.createdAt), index("edi_messages_partner").on(t.partnerId), uniqueIndex("edi_messages_subject").on(t.tenantId, t.subjectKey)],
);
