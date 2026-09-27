import { pgTable, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tenantId, audit } from "./core";

/** Tendering (spec §4) and tracking (spec §5, §11.9). */

export const TENDER_STATES = ["sent", "accepted", "declined", "expired", "withdrawn"] as const;
export type TenderState = (typeof TENDER_STATES)[number];
export const TENDER_CHANNELS = ["email", "whatsapp", "portal", "sylectus", "edi", "manual"] as const;
export type TenderChannel = (typeof TENDER_CHANNELS)[number];

/** One offer of one leg to one carrier. A leg can have several over time; at most one open. */
export const tenders = pgTable(
  "tenders",
  {
    id: id(),
    tenantId: tenantId(),
    legId: text("leg_id").notNull(),
    orderId: text("order_id").notNull(),
    carrierId: text("carrier_id").notNull(),
    rateCents: integer("rate_cents"),
    currency: text("currency").notNull().default("USD"),
    channel: text("channel").$type<TenderChannel>().notNull().default("email"),
    state: text("state").$type<TenderState>().notNull().default("sent"),
    token: text("token").notNull(), // public accept/decline link
    sentTo: text("sent_to"), // email / phone the tender went to
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    respondedBy: text("responded_by"), // name typed on the portal, or "dispatcher"
    responseNote: text("response_note"),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    unitNumber: text("unit_number"),
    trailerNumber: text("trailer_number"),
    message: text("message"), // what we said in the tender
    ...audit(),
  },
  (t) => [index("tenders_tenant_leg").on(t.tenantId, t.legId), index("tenders_tenant_state").on(t.tenantId, t.state, t.expiresAt), uniqueIndex("tenders_token").on(t.token)],
);

export const POSITION_SOURCES = ["driver_app", "eld", "phone", "carrier", "manual"] as const;
export type PositionSource = (typeof POSITION_SOURCES)[number];

/** Where a truck / leg was, from whichever source. Kept small; one row per ping. */
export const positions = pgTable(
  "positions",
  {
    id: id(),
    tenantId: tenantId(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").$type<PositionSource>().notNull(),
    truckId: text("truck_id"),
    driverId: text("driver_id"),
    legId: text("leg_id"),
    orderId: text("order_id"),
    lat: text("lat").notNull(),
    lng: text("lng").notNull(),
    speedMph: integer("speed_mph"),
    heading: integer("heading"),
    accuracyM: integer("accuracy_m"),
    place: text("place"), // reverse-geocoded or ELD "located at" text
    externalId: text("external_id"), // ELD's own id, for de-dup
  },
  (t) => [index("positions_tenant_truck_at").on(t.tenantId, t.truckId, t.at), index("positions_tenant_leg_at").on(t.tenantId, t.legId, t.at), index("positions_tenant_order").on(t.tenantId, t.orderId)],
);

export const TOKEN_KINDS = ["driver_app", "tracking_link", "carrier_portal", "customer_portal", "password_reset", "carrier_driver"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Login-free links: a driver's app, a customer's tracking page, a carrier's portal, a partner carrier's driver on one leg. Revocable. */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").$type<TokenKind>().notNull(),
    subjectId: text("subject_id").notNull(), // driver id / order id / carrier id
    token: text("token").notNull(),
    label: text("label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [uniqueIndex("access_tokens_token").on(t.token), index("access_tokens_tenant_subject").on(t.tenantId, t.kind, t.subjectId)],
);

export const OUTBOX_STATES = ["queued", "sent", "delivered", "read", "failed", "logged"] as const;

/** Every message we send (email now, WhatsApp/SMS later). Nothing goes out without a row here. */
export type OutboxMeta = { kind?: "tender" | "packet" | "tracking" | "general" | "invoice"; template?: { name: string; language?: string; params: string[] } | null; orderId?: string | null; attachments?: { fileName: string; storageKey: string }[]; cc?: string[] };

/** What people write back to us (WhatsApp today): attached to the driver / carrier by phone, and to the leg they were on. */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: id(),
    tenantId: tenantId(),
    channel: text("channel").notNull(), // whatsapp | sms | email | driver_app
    from: text("from").notNull(),
    fromName: text("from_name"),
    body: text("body").notNull(),
    providerId: text("provider_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    driverId: text("driver_id"),
    carrierId: text("carrier_id"),
    legId: text("leg_id"),
    orderId: text("order_id"),
    handledAt: timestamp("handled_at", { withTimezone: true }),
  },
  (t) => [index("inbound_messages_tenant").on(t.tenantId, t.receivedAt), uniqueIndex("inbound_messages_provider").on(t.tenantId, t.providerId)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    channel: text("channel").notNull(), // email | whatsapp | sms | driver_app (shown in the app, nothing sent)
    to: text("to").notNull(),
    subject: text("subject"),
    body: text("body").notNull(), // plain text
    html: text("html"),
    subjectKind: text("subject_kind"), // tender | order | ...
    subjectId: text("subject_id"),
    meta: jsonb("meta").$type<OutboxMeta>(), // WhatsApp template + params, message kind
    state: text("state").$type<(typeof OUTBOX_STATES)[number]>().notNull().default("queued"),
    providerId: text("provider_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("outbox_tenant_state").on(t.tenantId, t.state), index("outbox_subject").on(t.subjectKind, t.subjectId)],
);

/** Per-tenant integration settings (keys are stored here, never in code). */
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    tenantId: tenantId(),
    provider: text("provider").notNull(), // motive | resend | sylectus | dat | truckstop ...
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastResult: text("last_result"),
    ...audit(),
  },
  (t) => [uniqueIndex("integrations_tenant_provider").on(t.tenantId, t.provider)],
);

// ---------- the inbox agent (spec Module 12) ----------

export const MAIL_KINDS = ["rate_con", "tender", "status_request", "broker_doc", "dispute", "remittance", "carrier_quote", "noise"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
export const MAIL_STATES = ["proposed", "executed", "ignored", "failed"] as const;
export type MailState = (typeof MAIL_STATES)[number];
export type MailAttachment = { documentId: string; fileName: string; mimeType: string; sizeBytes: number };
/** What the agent read off the email, every field with a confidence; a person confirms on the card. */
export type MailExtracted = Record<string, { value: string | number | null; confidence: number }>;
/** What it will do when approved. Nothing runs without the tap. */
export type MailProposal =
  | { action: "create_order"; summary: string; customerId: string | null; customerName: string | null; template: string; stops: { type: string; name: string; city?: string; state?: string; country: string; windowStart?: string | null; windowEnd?: string | null }[]; rateCents: number | null; currency: string; equipment: string | null; refs: Record<string, string>; cargoNote: string | null; attachAs: string | null }
  | { action: "attach_document"; summary: string; orderId: string; orderNumber: string; code: string; crossingId?: string | null }
  | { action: "reply"; summary: string; orderId: string; orderNumber: string; to: string; subject: string; body: string }
  | { action: "detention"; summary: string; orderId: string; orderNumber: string }
  | { action: "receipt"; summary: string; invoiceId: string; invoiceNumber: string; amountCents: number; reference: string | null }
  | { action: "none"; summary: string };

/** Every email dispatch@ receives: what it was, what the agent read, what it proposes, and what a person decided. */
export const mailMessages = pgTable(
  "mail_messages",
  {
    id: id(),
    tenantId: tenantId(),
    messageId: text("message_id").notNull(), // RFC 5322 Message-ID, or a hash of the raw bytes
    source: text("source").notNull().default("http"), // imap | http
    from: text("from").notNull(),
    fromName: text("from_name"),
    to: text("to"),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    text: text("text").notNull().default(""),
    attachments: jsonb("attachments").$type<MailAttachment[]>().notNull().default(sql`'[]'::jsonb`),
    kind: text("kind").$type<MailKind>().notNull().default("noise"),
    confidence: integer("confidence").notNull().default(0), // 0–100
    classifier: text("classifier").notNull().default("rules"), // rules | <model name>
    extracted: jsonb("extracted").$type<MailExtracted>().notNull().default(sql`'{}'::jsonb`),
    orderId: text("order_id"), // the deterministic match, when there was one
    matchReason: text("match_reason"),
    proposal: jsonb("proposal").$type<MailProposal>().notNull().default(sql`'{"action":"none","summary":""}'::jsonb`),
    state: text("state").$type<MailState>().notNull().default("proposed"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    result: text("result"), // what happened on approval, or the error
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mail_messages_tenant").on(t.tenantId, t.receivedAt), uniqueIndex("mail_messages_message").on(t.tenantId, t.messageId), index("mail_messages_order").on(t.orderId)],
);
