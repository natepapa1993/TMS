import { pgTable, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tenantId, audit } from "./core";

/** Order = the customer's job (one rate con, one invoice). Legs = who moves it. Spec §2. */

export const ORDER_STATES = [
  "draft",
  "booked",
  "dispatched",
  "in_transit",
  "exception",
  "delivered",
  "ready_to_bill",
  "invoiced",
  "paid",
  "cancelled",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const LEG_TYPES = ["mx", "ca", "crossing", "us", "domestic", "equipment_move"] as const;
export type LegType = (typeof LEG_TYPES)[number];

export const LEG_STATES = [
  "unassigned",
  "planned",
  "dispatched",
  "accepted",
  "en_route_to_pickup",
  "at_pickup",
  "loaded",
  "en_route",
  "at_delivery",
  "completed",
  "declined",
  "cancelled",
] as const;
export type LegState = (typeof LEG_STATES)[number];

export const ORDER_KINDS = ["order", "trip", "shipment"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const STOP_TYPES = ["pickup", "delivery", "yard", "border_yard", "transload", "customs", "terminal"] as const;
export type StopType = (typeof STOP_TYPES)[number];

export const orders = pgTable(
  "orders",
  {
    id: id(),
    tenantId: tenantId(),
    orderNumber: text("order_number").notNull(),
    customerId: text("customer_id"),
    brokerId: text("broker_id"),
    billingEntityId: text("billing_entity_id"),
    portId: text("port_id"),
    state: text("state").$type<OrderState>().notNull().default("draft"),
    previousState: text("previous_state").$type<OrderState>(),
    kind: text("kind").$type<OrderKind>().notNull().default("order"), // order | trip (tailgate: carries shipments) | shipment (rides on a trip)
    tripId: text("trip_id"), // shipment → its trip
    pickupStopId: text("pickup_stop_id"), // shipment → the trip's stops it gets on / off at
    deliveryStopId: text("delivery_stop_id"),
    loadSeq: integer("load_seq"), // shipment: position in the trailer (1 = nose, loaded first)
    pieces: integer("pieces"),
    weightLbs: integer("weight_lbs"),
    linearFt: integer("linear_ft"),
    cubeFt: integer("cube_ft"),
    stackable: boolean("stackable").notNull().default(true),
    hazmat: boolean("hazmat").notNull().default(false),
    equipment: text("equipment").notNull().default("53_dry"),
    refs: jsonb("refs").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`), // rate_con, po, asn, shipment, sylectus_load ...
    rateCents: integer("rate_cents"),
    currency: text("currency").notNull().default("USD"),
    rateTbd: boolean("rate_tbd").notNull().default(false),
    fuelRule: text("fuel_rule").notNull().default("included"),
    fuelPct: integer("fuel_pct"), // whole percent of line haul when fuelRule is pct
    tollsFeesCents: integer("tolls_fees_cents"), // known extra cost for the P&L
    freight: jsonb("freight").$type<FreightLine[]>().notNull().default(sql`'[]'::jsonb`),
    cargoNote: text("cargo_note"),
    legTemplate: text("leg_template"),
    source: text("source").notNull().default("manual"), // manual | email | edi | sylectus | portal | duplicate
    sourceRef: text("source_ref"),
    holdReason: text("hold_reason"),
    cancelReason: text("cancel_reason"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    priority: text("priority").notNull().default("none"), // none | low | medium | high
    rateType: text("rate_type").notNull().default("flat"), // flat | per_mile | per_cwt | per_unit — how the line haul is figured
    rateUnitCents: integer("rate_unit_cents"), // per mile / per 100 lb / per unit
    rateQty: integer("rate_qty"), // miles, hundredweight or units the unit rate is multiplied by
    salesAgentId: text("sales_agent_id"),
    csrId: text("csr_id"),
    dispatcherId: text("dispatcher_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    tonu: boolean("tonu").notNull().default(false), // truck ordered, not used: cancelled by the customer, billed the TONU fee
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [uniqueIndex("orders_tenant_number").on(t.tenantId, t.orderNumber), index("orders_tenant_state").on(t.tenantId, t.state), index("orders_trip").on(t.tripId)],
);

export type FreightLine = {
  commodity: string;
  pieces?: number;
  packaging?: string;
  weightLb?: number;
  dims?: string;
  hazmat?: boolean;
  valueCents?: number;
};

export const stops = pgTable(
  "stops",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text("order_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").$type<StopType>().notNull(),
    locationId: text("location_id"),
    name: text("name").notNull(),
    address: jsonb("address").$type<{ line1?: string; city?: string; state?: string; postalCode?: string; country?: string }>(),
    country: text("country").notNull().default("US"), // side of the border for detention clocks
    lat: text("lat"),
    lng: text("lng"),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    appointment: boolean("appointment").notNull().default(false),
    contact: text("contact"),
    refs: jsonb("refs").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    notes: text("notes"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    sealIn: text("seal_in"), // the seal found when the trailer was opened here
    sealOut: text("seal_out"), // the seal applied when it left here; the next stop's seal_in should match
    ...audit(),
  },
  (t) => [index("stops_tenant_order").on(t.tenantId, t.orderId)],
);

export const legs = pgTable(
  "legs",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text("order_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").$type<LegType>().notNull(),
    fromStopId: text("from_stop_id"),
    toStopId: text("to_stop_id"),
    state: text("state").$type<LegState>().notNull().default("unassigned"),
    assigneeKind: text("assignee_kind"), // truck | carrier
    truckId: text("truck_id"),
    trailerId: text("trailer_id"),
    driverId: text("driver_id"),
    coDriverId: text("co_driver_id"),
    carrierId: text("carrier_id"),
    carrierRateCents: integer("carrier_rate_cents"),
    plannedStart: timestamp("planned_start", { withTimezone: true }),
    plannedEnd: timestamp("planned_end", { withTimezone: true }),
    plannedMiles: integer("planned_miles"),
    planReason: text("plan_reason"), // one-line reason from the ranked pick (spec §11.15)
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    holdReason: text("hold_reason"),
    declineReason: text("decline_reason"),
    ...audit(),
  },
  (t) => [index("legs_tenant_order").on(t.tenantId, t.orderId), index("legs_tenant_state").on(t.tenantId, t.state), index("legs_tenant_truck").on(t.tenantId, t.truckId)],
);

export const EVENT_SOURCES = ["driver_app", "gps", "carrier", "dispatcher", "edi", "sylectus", "system"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const legEvents = pgTable(
  "leg_events",
  {
    id: id(),
    tenantId: tenantId(),
    legId: text("leg_id").notNull(),
    orderId: text("order_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(), // transition | position | note | flag | flag_cleared | document | message
    fromState: text("from_state"),
    toState: text("to_state"),
    source: text("source").$type<EventSource>().notNull().default("dispatcher"),
    verified: boolean("verified").notNull().default(false),
    lat: text("lat"),
    lng: text("lng"),
    stopId: text("stop_id"),
    userId: text("user_id"),
    note: text("note"),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [index("leg_events_tenant_leg").on(t.tenantId, t.legId, t.at), index("leg_events_tenant_order").on(t.tenantId, t.orderId)],
);

export const flags = pgTable(
  "flags",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text("order_id").notNull(),
    legId: text("leg_id"),
    code: text("code").notNull(), // dwell | seal_mismatch | no_position | eta_late | stopped | tender_expiring | rate_changed | margin_floor | pod_missing | overlap | eligibility ...
    level: text("level").notNull(), // red | yellow
    title: text("title").notNull(),
    detail: text("detail"),
    owner: text("owner"), // who owes the fix (free text)
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by"),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [index("flags_tenant_open").on(t.tenantId, t.clearedAt), index("flags_tenant_order").on(t.tenantId, t.orderId)],
);

export const notes = pgTable(
  "notes",
  {
    id: id(),
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    body: text("body").notNull(),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notes_tenant_subject").on(t.tenantId, t.subjectKind, t.subjectId)],
);

export const NOTE_KINDS = ["general", "dispatch", "billing", "safety", "customer"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Notes on a load: typed, pinnable, kept with who wrote them. */
export const orderNotes = pgTable(
  "order_notes",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text("order_id").notNull(),
    kind: text("kind").$type<NoteKind>().notNull().default("general"),
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    ...audit(),
  },
  (t) => [index("order_notes_tenant_order").on(t.tenantId, t.orderId)],
);

/** A stop in a template: the time of day, and how many days after the first stop's day. */
export type TemplateStop = { type: StopType; locationId: string | null; name: string; line1?: string; city?: string; state?: string; postalCode?: string; country: string; dayOffset: number; from: string; to: string; appointment: boolean; ref?: string; contact?: string; notes?: string };
export type LoadTemplateData = { customerId: string | null; brokerId: string | null; billingEntityId: string | null; equipment: string; rateCents: number | null; currency: string; refs: Record<string, string>; freight: FreightLine[]; cargoNote: string | null; stops: TemplateStop[] };

/** A lane you run again and again: everything but the dates. */
export const loadTemplates = pgTable(
  "load_templates",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    customerId: text("customer_id"),
    data: jsonb("data").$type<LoadTemplateData>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    timesUsed: integer("times_used").notNull().default(0),
    ...audit(),
  },
  (t) => [index("load_templates_tenant").on(t.tenantId)],
);
