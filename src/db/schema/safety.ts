import { pgTable, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tenantId, audit } from "./core";

/**
 * Safety depth: the driver qualification file (49 CFR 391.51), the drug & alcohol program (Parts 40 / 382),
 * roadside inspections with an SMS-style view of the BASICs, all per driver and unit.
 */

/** One line of a driver's qualification file: an item done on a date (or marked not required, with why). The latest line per item counts. */
export const dqRecords = pgTable(
  "dq_records",
  {
    id: id(),
    tenantId: tenantId(),
    driverId: text("driver_id").notNull(),
    itemKey: text("item_key").notNull(), // application | mvr_hire | prior_employers | road_test | clearinghouse_full | clearinghouse_annual | mvr_annual | annual_review
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notRequired: boolean("not_required").notNull().default(false),
    note: text("note"),
    documentId: text("document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("dq_records_driver").on(t.tenantId, t.driverId, t.itemKey)],
);

export const DA_REASONS = ["pre_employment", "random", "post_accident", "reasonable_suspicion", "return_to_duty", "follow_up"] as const;
export type DaReason = (typeof DA_REASONS)[number];
export const DA_RESULTS = ["selected", "pending", "negative", "negative_dilute", "positive", "refusal", "cancelled"] as const;
export type DaResult = (typeof DA_RESULTS)[number];

/** A DOT drug or alcohol test: selected (random), collected, the result. Confidential (49 CFR 40.321): owner and Safety only. */
export const daTests = pgTable(
  "da_tests",
  {
    id: id(),
    tenantId: tenantId(),
    driverId: text("driver_id").notNull(),
    reason: text("reason").$type<DaReason>().notNull(),
    substance: text("substance").$type<"drug" | "alcohol">().notNull(),
    drawId: text("draw_id"),
    incidentId: text("incident_id"),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    result: text("result").$type<DaResult>().notNull().default("pending"),
    resultAt: timestamp("result_at", { withTimezone: true }),
    specimenId: text("specimen_id"), // CCF number / breath test form
    collector: text("collector"),
    mro: text("mro"),
    followUpPlanned: integer("follow_up_planned"), // on a return-to-duty test: the SAP's number of follow-up tests
    clearinghouseReportedAt: timestamp("clearinghouse_reported_at", { withTimezone: true }),
    note: text("note"),
    ...audit(),
  },
  (t) => [index("da_tests_driver").on(t.tenantId, t.driverId), index("da_tests_tenant").on(t.tenantId, t.selectedAt)],
);

/** A random selection: who was in the pool, the rates, how many were picked. The record an auditor asks for. */
export const daDraws = pgTable(
  "da_draws",
  {
    id: id(),
    tenantId: tenantId(),
    period: text("period").notNull(), // 2026-Q4, 2026-11 …
    drawnAt: timestamp("drawn_at", { withTimezone: true }).notNull().defaultNow(),
    poolSize: integer("pool_size").notNull(),
    poolDriverIds: text("pool_driver_ids").array().notNull().default(sql`'{}'::text[]`),
    drugRate: integer("drug_rate").notNull(), // annual %, e.g. 50
    alcoholRate: integer("alcohol_rate").notNull(), // annual %, e.g. 10
    drawsPerYear: integer("draws_per_year").notNull().default(4),
    drugCount: integer("drug_count").notNull(),
    alcoholCount: integer("alcohol_count").notNull(),
    drawnBy: text("drawn_by"),
  },
  (t) => [uniqueIndex("da_draws_period").on(t.tenantId, t.period)],
);

export type Violation = {
  code: string; // 395.8(e), 393.9 …
  description: string;
  /** null for Canadian and Mexican violations: they go to CVOR / NSC and the SCT, not to SMS */
  basic: "unsafe" | "hos" | "fitness" | "substances" | "vehicle" | "hm" | null;
  severity: number; // 1–10, the SMS severity weight; 0 outside the US
  oos: boolean;
  unit: "driver" | "vehicle";
  on?: "truck" | "trailer"; // a vehicle violation: which unit it was found on (an OOS takes that unit out of service)
  removed?: boolean; // taken off by DataQs / dismissed in court
};

export type RepairSignoff = { by: string; byName: string; at: string; note: string; documentId?: string | null };

/** A roadside inspection (CVSA level, jurisdiction, report #) with its violations. */
export const inspections = pgTable(
  "inspections",
  {
    id: id(),
    tenantId: tenantId(),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull(),
    reportNumber: text("report_number"),
    country: text("country").notNull().default("US"), // US | CA | MX
    jurisdiction: text("jurisdiction"), // TX, ON, NL …
    level: integer("level").notNull().default(1), // CVSA level 1–7
    hazmat: boolean("hazmat").notNull().default(false),
    driverId: text("driver_id"),
    truckId: text("truck_id"),
    trailerId: text("trailer_id"),
    orderId: text("order_id"),
    location: text("location"),
    violations: jsonb("violations").$type<Violation[]>().notNull().default(sql`'[]'::jsonb`),
    dataQs: text("data_qs").notNull().default("none"), // none | filed | accepted | denied
    note: text("note"),
    driverOosUntil: timestamp("driver_oos_until", { withTimezone: true }), // a driver out-of-service order: off until then (10 h, 34 h, 24 h…)
    repair: jsonb("repair").$type<RepairSignoff>(), // vehicle OOS: who certified the repair, when, what was done (396.9(d))
    ...audit(),
  },
  (t) => [index("inspections_tenant_at").on(t.tenantId, t.inspectedAt), index("inspections_driver").on(t.tenantId, t.driverId)],
);
