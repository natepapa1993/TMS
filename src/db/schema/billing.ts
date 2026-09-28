import { pgTable, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, tenantId, audit } from "./core";

/** Billing & settlements (spec §7): our own ledger — charges, invoices, receipts, credit memos, carrier bills, driver settlements. */

export const CHARGE_KINDS = ["linehaul", "fuel", "detention", "layover", "tonu", "lumper", "border_fee", "crossing_fee", "storage", "extra_stop", "accessorial", "tax", "other"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const charges = pgTable(
  "charges",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text("order_id").notNull(),
    legId: text("leg_id"),
    kind: text("kind").$type<ChargeKind>().notNull(),
    description: text("description").notNull(),
    qty: integer("qty").notNull().default(1), // in hundredths for fractional (e.g. 2.5 h = 250) when unit is h
    unit: text("unit").notNull().default("flat"), // flat | mi | h | stop | pct
    rateCents: integer("rate_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    billable: boolean("billable").notNull().default(true),
    source: text("source").notNull().default("manual"), // rate_con | manual | computed | tariff
    data: jsonb("data").$type<Record<string, unknown>>(), // computed-from events, rule version…
    invoiceId: text("invoice_id"),
    /** none = agreed on the rate con or no approval needed; pending / approved / rejected for extras the customer must OK */
    approvalState: text("approval_state").$type<"none" | "pending" | "approved" | "rejected">().notNull().default("none"),
    approvedBy: text("approved_by"), // the customer's person who OK'd it
    approvalRef: text("approval_ref"), // email subject, portal ref, phone call…
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    ...audit(),
  },
  (t) => [index("charges_tenant_order").on(t.tenantId, t.orderId), index("charges_invoice").on(t.invoiceId)],
);

export const INVOICE_STATES = ["draft", "issued", "sent", "partially_paid", "paid", "closed", "void", "disputed"] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export type InvoiceLine = { chargeId: string | null; orderId: string; orderNumber: string; kind: string; description: string; qty: number; unit: string; rateCents: number; amountCents: number };
export type InvoiceSnapshot = {
  entity: { legalName: string; dba: string | null; taxId: string | null; remitTo: Record<string, string | undefined> | null; mc: string | null; dot: string | null };
  billTo: { name: string; email: string | null; kind: string; address?: Record<string, string | undefined> | null };
  /** the load number(s), printed in the header */
  loadNumbers?: string[];
  refs: Record<string, string>;
  stops: { seq: number; type: string; name: string; city: string | null; state: string | null; country: string; departedAt: string | null; arrivedAt: string | null; /** the stop's own calendar day (YYYY-MM-DD) */ departedDate?: string | null; arrivedDate?: string | null }[];
  lines: InvoiceLine[];
  terms: string;
  currency: string;
  exchangeRate: number | null;
  /** a summary invoice: one row per load */
  loads?: { orderNumber: string; refs: string; from: string; to: string; pickedUp: string | null; delivered: string | null; amountCents: number }[];
  /** notice of assignment when the invoice is factored */
  factor?: { name: string; notice: string; remitTo?: Record<string, string | undefined> | null } | null;
  /** a supplemental invoice: the invoice number it adds to */
  supplementOf?: string | null;
  /** a rebill: the voided invoice number it replaces */
  replaces?: string | null;
  /** the company zone the invoice and due dates are printed in */
  timeZone?: string;
  /** after a chargeback: the invoice was re-sent with our own remit-to; the factor notice it carried before */
  correctedFromFactor?: string | null;
};

export type InvoiceDelivery = { at: string; method: string; to: string | null; reference: string | null; by: string | null; batchId?: string | null };

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    tenantId: tenantId(),
    entityId: text("entity_id").notNull(),
    customerId: text("customer_id").notNull(),
    number: text("number"), // assigned at issue, never reused
    state: text("state").$type<InvoiceState>().notNull().default("draft"),
    orderIds: text("order_ids").array().notNull().default([]),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: integer("exchange_rate_e4"), // rate × 10,000, MXN per USD when currency is MXN
    termsDays: integer("terms_days").notNull().default(30),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    creditedCents: integer("credited_cents").notNull().default(0),
    snapshot: jsonb("snapshot").$type<InvoiceSnapshot | null>(),
    pdfStorageKey: text("pdf_storage_key"),
    token: text("token"), // public link for the customer
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: text("sent_to"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    disputeReason: text("dispute_reason"),
    disputeExpectedAt: timestamp("dispute_expected_at", { withTimezone: true }),
    promiseToPayAt: timestamp("promise_to_pay_at", { withTimezone: true }),
    payWhenPaid: boolean("pay_when_paid").notNull().default(false),
    notes: text("notes"),
    exportedAt: timestamp("exported_at", { withTimezone: true }), // last accounting export that carried it
    factored: boolean("factored").notNull().default(false),
    deliveries: jsonb("deliveries").$type<InvoiceDelivery[]>().notNull().default(sql`'[]'::jsonb`),
    batchId: text("batch_id"),
    kind: text("kind").$type<"standard" | "supplemental" | "rebill">().notNull().default("standard"),
    factorFundedAt: timestamp("factor_funded_at", { withTimezone: true }), // the factor advanced on it: the customer now owes the factor
    rebillOf: text("rebill_of"), // the voided invoice this one replaces
    supplementOf: text("supplement_of"), // a supplemental invoice: the invoice it adds to
    disputeResolution: text("dispute_resolution"), // how the last dispute ended, in words
    ...audit(),
  },
  (t) => [index("invoices_tenant_state").on(t.tenantId, t.state), index("invoices_tenant_customer").on(t.tenantId, t.customerId), uniqueIndex("invoices_tenant_number").on(t.tenantId, t.number)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: id(),
    tenantId: tenantId(),
    invoiceId: text("invoice_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    method: text("method").notNull().default("ach"), // ach | check | card | wire | factoring | other
    reference: text("reference"),
    note: text("note"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    paymentId: text("payment_id"), // the check / ACH it came from, when one payment paid several invoices
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("receipts_invoice").on(t.invoiceId), index("receipts_payment").on(t.paymentId)],
);

/** A payment as it arrived (one check, one ACH, one remittance) before and after it is applied to invoices; what's left is on account. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    tenantId: tenantId(),
    customerId: text("customer_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    method: text("method").notNull().default("ach"),
    reference: text("reference"), // check #, ACH trace
    remittance: text("remittance"), // the remittance advice as pasted
    note: text("note"),
    appliedCents: integer("applied_cents").notNull().default(0),
    exportedAt: timestamp("exported_at", { withTimezone: true }), // last accounting export that carried it (one deposit with its applications)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("payments_tenant_customer").on(t.tenantId, t.customerId)],
);

export const creditMemos = pgTable(
  "credit_memos",
  {
    id: id(),
    tenantId: tenantId(),
    invoiceId: text("invoice_id").notNull(),
    number: text("number").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    lines: jsonb("lines").$type<{ description: string; amountCents: number }[]>().notNull().default(sql`'[]'::jsonb`),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    exportedAt: timestamp("exported_at", { withTimezone: true }), // last accounting export that carried it
    pdfStorageKey: text("pdf_storage_key"), // the credit memo PDF
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: text("sent_to"),
    createdBy: text("created_by"),
  },
  (t) => [index("credit_memos_invoice").on(t.invoiceId)],
);

export const CARRIER_BILL_STATES = ["expected", "received", "approved", "scheduled", "paid", "disputed"] as const;

export const carrierBills = pgTable(
  "carrier_bills",
  {
    id: id(),
    tenantId: tenantId(),
    carrierId: text("carrier_id").notNull(),
    orderId: text("order_id").notNull(),
    legId: text("leg_id").notNull(),
    tenderId: text("tender_id"),
    state: text("state").$type<(typeof CARRIER_BILL_STATES)[number]>().notNull().default("expected"),
    currency: text("currency").notNull().default("USD"),
    expectedCents: integer("expected_cents").notNull().default(0), // tender rate + approved accessorials
    accessorialCents: integer("accessorial_cents").notNull().default(0),
    invoicedCents: integer("invoiced_cents"), // what the carrier billed
    approvedCents: integer("approved_cents"), // what we will pay
    carrierInvoiceNumber: text("carrier_invoice_number"),
    carrierInvoiceDocId: text("carrier_invoice_doc_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalNote: text("approval_note"),
    shortPayNote: text("short_pay_note"),
    payDate: timestamp("pay_date", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidCents: integer("paid_cents"),
    method: text("method"),
    reference: text("reference"),
    quickPayPct: integer("quick_pay_pct"), // basis points
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    ...audit(),
  },
  (t) => [uniqueIndex("carrier_bills_leg").on(t.legId), index("carrier_bills_tenant_state").on(t.tenantId, t.state), index("carrier_bills_tenant_carrier").on(t.tenantId, t.carrierId)],
);

export const SETTLEMENT_STATES = ["open", "reviewed", "approved", "paid"] as const;
export type SettlementLine = { id: string; kind: "leg" | "accessorial" | "deduction" | "reimbursement" | "adjustment"; legId?: string | null; orderNumber?: string | null; description: string; qty: number; unit: string; rateCents: number; amountCents: number; source: string; disputed?: string | null; response?: string | null; payItemId?: string | null; /** a deduction: what it wanted to take and couldn't (net never goes below $0); carries to the next statement */ shortCents?: number | null; /** the line can't be paid as is (a load with no miles) */ blocker?: string | null };

export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    tenantId: tenantId(),
    driverId: text("driver_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    state: text("state").$type<(typeof SETTLEMENT_STATES)[number]>().notNull().default("open"),
    currency: text("currency").notNull().default("USD"),
    lines: jsonb("lines").$type<SettlementLine[]>().notNull().default(sql`'[]'::jsonb`),
    grossCents: integer("gross_cents").notNull().default(0),
    deductionsCents: integer("deductions_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    method: text("method"),
    reference: text("reference"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    ...audit(),
  },
  (t) => [uniqueIndex("settlements_driver_period").on(t.tenantId, t.driverId, t.periodStart), index("settlements_tenant_state").on(t.tenantId, t.state)],
);

/** Recurring or one-off driver deductions and reimbursements (advances, escrow, fuel card…). */
export const payItems = pgTable(
  "pay_items",
  {
    id: id(),
    tenantId: tenantId(),
    driverId: text("driver_id").notNull(),
    kind: text("kind").notNull(), // deduction | reimbursement | advance | escrow
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    targetCents: integer("target_cents"), // escrow: stop collecting at this balance
    balanceCents: integer("balance_cents"), // escrow: held for the driver so far
    recurring: boolean("recurring").notNull().default(false),
    remainingCents: integer("remaining_cents"), // for advances paid back over time
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    originalCents: integer("original_cents"), // what there was to recover when it was added (advances, deductions with a total)
    carriedFrom: text("carried_from"), // the statement a shortfall carried over from
    ...audit(),
  },
  (t) => [index("pay_items_driver").on(t.tenantId, t.driverId, t.active)],
);

/** Every accounting export is logged: what went out, in which format, for which period. */
export const accountingExports = pgTable(
  "accounting_exports",
  {
    id: id(),
    tenantId: tenantId(),
    format: text("format").notNull(), // iif | qbo
    fromDate: text("from_date").notNull(), // YYYY-MM-DD in the company zone
    toDate: text("to_date").notNull(),
    onlyNew: boolean("only_new").notNull().default(true),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    recordIds: jsonb("record_ids").$type<{ invoices: string[]; receipts: string[]; bills: string[]; settlements: string[]; credits?: string[]; payments?: string[]; factor?: string[] }>().notNull().default(sql`'{"invoices":[],"receipts":[],"bills":[],"settlements":[]}'::jsonb`),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    fileName: text("file_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("accounting_exports_tenant").on(t.tenantId, t.createdAt)],
);

export const PAY_RULE_KINDS = ["per_loaded_mile", "per_empty_mile", "per_total_mile", "pct_linehaul", "pct_total", "flat_per_load", "flat_per_leg", "per_stop", "per_extra_stop", "hourly", "crossing"] as const;
export type PayRuleKind = (typeof PAY_RULE_KINDS)[number];
/** One way a driver earns: the amount is cents (per mile, per stop, per hour, flat) or basis points for a percent (6200 = 62%). */
export type PayRule = { id: string; kind: PayRuleKind; amount: number; label?: string; when?: { legTypes?: string[]; customerIds?: string[]; equipment?: string[]; minMiles?: number | null; maxMiles?: number | null } };

/** A pay plan: the rules a group of drivers is paid by, plus what applies to the whole statement. */
export const payPlans = pgTable(
  "pay_plans",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    rules: jsonb("rules").$type<PayRule[]>().notNull().default(sql`'[]'::jsonb`),
    teamSplit: text("team_split").notNull().default("half"), // half | full — what each team driver gets of a leg
    minimumCents: integer("minimum_cents"), // per statement: topped up to this
    perDiemCents: integer("per_diem_cents"), // per day worked (a completed leg that day)
    notes: text("notes"),
    ...audit(),
  },
  (t) => [index("pay_plans_tenant").on(t.tenantId)],
);

/** A billing run (many invoices made, issued and sent together) or a schedule of accounts sent to the factor. */
export const invoiceBatches = pgTable(
  "invoice_batches",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull().default("billing"), // billing | factor_schedule
    number: integer("number").notNull(),
    invoiceIds: text("invoice_ids").array().notNull().default([]),
    totalCents: integer("total_cents").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    sentTo: text("sent_to"),
    storageKey: text("storage_key"), // the schedule PDF
    note: text("note"),
    ...audit(),
  },
  (t) => [index("invoice_batches_tenant").on(t.tenantId, t.kind), uniqueIndex("invoice_batches_tenant_kind_number").on(t.tenantId, t.kind, t.number)],
);

/** A fuel purchase for IFTA: where, how much, on which truck. Gallons in thousandths (a liter purchase is converted). */
export const fuelPurchases = pgTable(
  "fuel_purchases",
  {
    id: id(),
    tenantId: tenantId(),
    truckId: text("truck_id"),
    driverId: text("driver_id"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull(),
    jurisdiction: text("jurisdiction").notNull(), // US state / Canadian province code, MX for Mexico
    gallonsMilli: integer("gallons_milli").notNull(),
    fuelType: text("fuel_type").notNull().default("diesel"), // diesel | gasoline | def (DEF is not taxable fuel)
    amountCents: integer("amount_cents"),
    currency: text("currency").notNull().default("USD"),
    vendor: text("vendor"),
    city: text("city"),
    receiptNumber: text("receipt_number"),
    taxPaid: boolean("tax_paid").notNull().default(true), // bought at the pump with fuel tax (bulk untaxed = false)
    source: text("source").notNull().default("manual"), // manual | import | card
    notes: text("notes"),
    ...audit(),
  },
  (t) => [index("fuel_purchases_tenant_at").on(t.tenantId, t.purchasedAt), index("fuel_purchases_tenant_truck").on(t.tenantId, t.truckId)],
);

/** Miles by jurisdiction per truck per day: computed from GPS or the legs, or entered from a trip sheet. Miles in tenths. */
export const iftaMiles = pgTable(
  "ifta_miles",
  {
    id: id(),
    tenantId: tenantId(),
    quarter: text("quarter").notNull(), // 2026Q3
    truckId: text("truck_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD in the company's zone
    jurisdiction: text("jurisdiction").notNull(),
    milesTenths: integer("miles_tenths").notNull(),
    source: text("source").notNull(), // gps | leg_estimate | eld | trip_sheet
    legId: text("leg_id"),
    note: text("note"),
    ...audit(),
  },
  (t) => [index("ifta_miles_tenant_quarter").on(t.tenantId, t.quarter, t.truckId)],
);

/** The quarter's fuel tax rate per jurisdiction (from the IFTA rate matrix), in ten-thousandths of a dollar per gallon. */
export const iftaRates = pgTable(
  "ifta_rates",
  {
    id: id(),
    tenantId: tenantId(),
    quarter: text("quarter").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    rateE4: integer("rate_e4").notNull(), // 0.2000 $/gal = 2000
    surchargeE4: integer("surcharge_e4"), // a surcharge on taxable gallons (some states)
    ...audit(),
  },
  (t) => [uniqueIndex("ifta_rates_tenant_quarter_j").on(t.tenantId, t.quarter, t.jurisdiction)],
);

export const FACTOR_ENTRY_KINDS = ["advance", "fee", "reserve_release", "collected", "chargeback"] as const;

/** The factoring ledger: what the factor advanced on each invoice, its fee, the reserve it holds, collection, chargebacks. */
export const factorEntries = pgTable(
  "factor_entries",
  {
    id: id(),
    tenantId: tenantId(),
    entityId: text("entity_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    kind: text("kind").$type<(typeof FACTOR_ENTRY_KINDS)[number]>().notNull(),
    amountCents: integer("amount_cents").notNull(), // money to us positive (advance, reserve release), cost or repayment negative (fee, chargeback); "collected" is the customer's payment to the factor
    at: timestamp("at", { withTimezone: true }).notNull(),
    reference: text("reference"), // the factor's schedule / wire #
    note: text("note"),
    exportedAt: timestamp("exported_at", { withTimezone: true }), // last accounting export that carried it (as a journal entry)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("factor_entries_invoice").on(t.tenantId, t.invoiceId), index("factor_entries_entity").on(t.tenantId, t.entityId, t.at)],
);
