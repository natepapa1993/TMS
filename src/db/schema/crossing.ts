import { pgTable, text, timestamp, integer, jsonb, boolean, index, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tenantId, audit } from "./core";

/** Crossing (spec §3): the child of a crossing leg that owns the packet, the checks and the 16-state machine. */

export const CROSSING_STATES = [
  "created",
  "awaiting_mx_arrival",
  "at_border_yard",
  "docs_in_progress",
  "awaiting_doda",
  "docs_complete",
  "docs_verified",
  "eligibility_checked",
  "ready_to_cross",
  "packet_sent",
  "departed_yard",
  "at_mx_customs",
  "in_us_customs",
  "cleared",
  "held",
  "returned",
  "cancelled",
] as const;
export type CrossingState = (typeof CROSSING_STATES)[number];

export const crossings = pgTable(
  "crossings",
  {
    id: id(),
    tenantId: tenantId(),
    legId: text("leg_id").notNull(),
    orderId: text("order_id").notNull(),
    portId: text("port_id"),
    bridge: text("bridge"),
    fromCountry: text("from_country").notNull().default("MX"), // the side the truck leaves
    toCountry: text("to_country").notNull().default("US"), // the side it enters
    state: text("state").$type<CrossingState>().notNull().default("created"),
    previousState: text("previous_state").$type<CrossingState>(),
    trailerNumber: text("trailer_number"), // the caja, as dispatch knows it
    sealNumber: text("seal_number"),
    arrivedYardAt: timestamp("arrived_yard_at", { withTimezone: true }), // dwell clock start
    departedYardAt: timestamp("departed_yard_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    heldReason: text("held_reason"),
    heldAt: timestamp("held_at", { withTimezone: true }),
    returnedReason: text("returned_reason"),
    packetStorageKey: text("packet_storage_key"),
    packetBuiltAt: timestamp("packet_built_at", { withTimezone: true }),
    packetSentAt: timestamp("packet_sent_at", { withTimezone: true }),
    packetAckAt: timestamp("packet_ack_at", { withTimezone: true }),
    packetToken: text("packet_token"),
    requirements: jsonb("requirements").$type<Requirement[]>().notNull().default(sql`'[]'::jsonb`),
    eligibility: jsonb("eligibility").$type<{ ok: boolean; hardBlocked: boolean; findings: { level: string; code: string; message: string; overridable: boolean }[]; at: string } | null>(),
    eligibilityOverride: jsonb("eligibility_override").$type<{ reason: string; by: string | null; at: string } | null>(),
    ...audit(),
  },
  (t) => [uniqueIndex("crossings_leg").on(t.legId), index("crossings_tenant_state").on(t.tenantId, t.state), index("crossings_tenant_order").on(t.tenantId, t.orderId)],
);

/** One checklist row, computed from the rules when the crossing is created or a rule changes. */
export type Requirement = {
  code: string; // carta_retiro | carta_porte | doda | ...
  label: string;
  providedBy: string; // shipper | mx_broker | us_broker | carrier | us
  allowNa: boolean;
  status: "missing" | "present" | "verified" | "na";
  documentId?: string | null;
  naReason?: string | null;
  packetOrder: number;
  lastDocument?: boolean; // the "last document" (DODA) that gates awaiting_doda
};

export const CHECK_STATES = ["pending", "pass", "fail", "overridden", "skipped"] as const;

export const crossingChecks = pgTable(
  "crossing_checks",
  {
    id: id(),
    tenantId: tenantId(),
    crossingId: text("crossing_id").notNull(),
    code: text("code").notNull(), // trailer | tractor_plates | driver | seal | folio_fiscal | pedimento | weight | pieces | patente | scac | plate_class | expiry | dtops | timing
    state: text("state").$type<(typeof CHECK_STATES)[number]>().notNull().default("pending"),
    message: text("message"),
    values: jsonb("values").$type<Record<string, unknown>>(), // what was compared, by source
    overrideReason: text("override_reason"),
    overrideBy: text("override_by"),
    overrideAt: timestamp("override_at", { withTimezone: true }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("crossing_checks_crossing_code").on(t.crossingId, t.code)],
);

/** Rules engine (spec §3 "requirements come from rules, never from code"): base + per port + per customer. */
export const crossingDocRules = pgTable(
  "crossing_doc_rules",
  {
    id: id(),
    tenantId: tenantId(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    providedBy: text("provided_by").notNull().default("mx_broker"),
    requiredWhen: text("required_when").notNull().default("always"), // always | brown_plates | never
    allowNa: boolean("allow_na").notNull().default(false),
    lastDocument: boolean("last_document").notNull().default(false),
    packetOrder: integer("packet_order").notNull().default(50),
    border: text("border").notNull().default("mx"), // mx | ca | any — which border the document belongs to
    direction: text("direction").notNull().default("any"), // any | into_us | into_mx | into_ca
    portId: text("port_id"), // null = every port
    customerId: text("customer_id"), // null = every customer
    enabled: boolean("enabled").notNull().default(true),
    ...audit(),
  },
  (t) => [index("crossing_doc_rules_tenant").on(t.tenantId, t.code)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** File bytes. Small packets (PDF/JPG ≤ 15 MB) live here; object storage can replace it without touching callers. */
export const documentBlobs = pgTable(
  "document_blobs",
  {
    id: id(),
    tenantId: tenantId(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_blobs_tenant_sha").on(t.tenantId, t.sha256)],
);

export const crossingEvents = pgTable(
  "crossing_events",
  {
    id: id(),
    tenantId: tenantId(),
    crossingId: text("crossing_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(), // transition | document | check | packet | note | hold | release
    fromState: text("from_state"),
    toState: text("to_state"),
    source: text("source").notNull().default("dispatcher"), // gps | driver_app | dispatcher | mx_office | carrier | broker | system | portal
    verified: boolean("verified").notNull().default(false),
    userId: text("user_id"),
    note: text("note"),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [index("crossing_events_crossing_at").on(t.crossingId, t.at)],
);
