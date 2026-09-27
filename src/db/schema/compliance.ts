import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { id, tenantId, audit } from "./core";

/** Compliance (spec §6): the engine stores a result per subject so boards and eligibility read, not recompute. */

export type ComplianceItem = {
  key: string; // documentTypeId or a built-in field key like field:licenseExpires
  label: string;
  status: "ok" | "expiring" | "expired" | "missing" | "snoozed";
  expiresAt: string | null;
  documentId: string | null;
  blocksDispatch: boolean;
  required: boolean;
  alertDays: number;
  snoozedUntil?: string | null;
  snoozeReason?: string | null;
};

export const complianceStatus = pgTable(
  "compliance_status",
  {
    id: id(),
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(), // driver | truck | trailer | carrier
    subjectId: text("subject_id").notNull(),
    dispatchable: boolean("dispatchable").notNull().default(true),
    expired: text("expired").array().notNull().default([]),
    expiring: text("expiring").array().notNull().default([]),
    missing: text("missing").array().notNull().default([]),
    items: jsonb("items").$type<ComplianceItem[]>().notNull().default([]),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("compliance_status_subject").on(t.tenantId, t.subjectKind, t.subjectId), index("compliance_status_tenant").on(t.tenantId, t.dispatchable)],
);

export const complianceSnoozes = pgTable(
  "compliance_snoozes",
  {
    id: id(),
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    itemKey: text("item_key").notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("compliance_snoozes_subject").on(t.tenantId, t.subjectKind, t.subjectId)],
);

/** Time-boxed dispatch override on a blocked subject (spec 6.6: "owner must dispatch today", expires in 24 h). */
export const complianceOverrides = pgTable(
  "compliance_overrides",
  {
    id: id(),
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("compliance_overrides_subject").on(t.tenantId, t.subjectKind, t.subjectId)],
);

/** Accident / incident register (persona review: safety director). */
export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    tenantId: tenantId(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("accident"), // accident | injury | cargo | roadside_inspection | citation | near_miss | other
    driverId: text("driver_id"),
    truckId: text("truck_id"),
    trailerId: text("trailer_id"),
    orderId: text("order_id"),
    location: text("location"),
    description: text("description").notNull(),
    dotRecordable: boolean("dot_recordable").notNull().default(false),
    injuries: boolean("injuries").notNull().default(false),
    towAway: boolean("tow_away").notNull().default(false),
    policeReport: text("police_report"),
    claimNumber: text("claim_number"),
    status: text("status").notNull().default("open"), // open | under_review | closed
    ...audit(),
  },
  (t) => [index("incidents_tenant_at").on(t.tenantId, t.occurredAt)],
);
