import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Conventions (spec §0):
 * - every tenant-owned table carries tenant_id; the data layer refuses queries without a tenant context
 * - money = integer cents + currency code; dates stored UTC
 * - every record: created_at/by, updated_at/by, archived_at (soft delete)
 * - ids are text (nanoid) so they can be generated client-side and are URL-safe
 */

export const id = (name = "id") => text(name).primaryKey();
export const tenantId = () => text("tenant_id").notNull();
export const audit = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const roleEnum = pgEnum("role", [
  "owner",
  "dispatcher",
  "billing",
  "compliance",
  "mx_office",
  "driver",
  "carrier",
  "customer",
]);

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timeZone: text("time_zone").notNull().default("America/Detroit"),
  country: text("country").notNull().default("US"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantId(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    role: roleEnum("role").notNull().default("dispatcher"),
    phone: text("phone"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...audit(),
  },
  (t) => [uniqueIndex("users_tenant_email").on(t.tenantId, t.email), index("users_tenant").on(t.tenantId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: tenantId(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id"),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(), // create | update | archive | restore | transition | import | override
    changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
    note: text("note"),
  },
  (t) => [index("audit_tenant_entity").on(t.tenantId, t.entity, t.entityId), index("audit_tenant_at").on(t.tenantId, t.at)],
);

export const billingEntities = pgTable(
  "billing_entities",
  {
    id: id(),
    tenantId: tenantId(),
    legalName: text("legal_name").notNull(),
    dba: text("dba"),
    country: text("country").notNull().default("US"),
    taxId: text("tax_id"), // EIN or RFC
    mcNumber: text("mc_number"),
    dotNumber: text("dot_number"),
    scac: text("scac"),
    caat: text("caat"),
    remitTo: jsonb("remit_to").$type<Address>(),
    invoicePrefix: text("invoice_prefix").notNull(),
    nextInvoiceNumber: integer("next_invoice_number").notNull().default(1),
    nextCreditNumber: integer("next_credit_number").notNull().default(1), // credit memos: PREFIX-CM-000001, their own sequence
    isDefault: boolean("is_default").notNull().default(false),
    terms: text("terms"),
    // factoring: invoices assigned to a factor carry its remit-to and the notice of assignment, and go to it
    factorName: text("factor_name"),
    factorEmail: text("factor_email"),
    factorRemitTo: jsonb("factor_remit_to").$type<Address>(),
    factorAll: boolean("factor_all").notNull().default(false), // every customer's invoices go to the factor unless the customer says otherwise
    factorNotice: text("factor_notice"), // the notice-of-assignment wording on the invoice
    factorAdvanceBp: integer("factor_advance_bp"), // advance as basis points of the invoice (9700 = 97%); blank = 97%
    factorFeeBp: integer("factor_fee_bp"), // fee in basis points (300 = 3%); blank = 3%
    factorRecourseDays: integer("factor_recourse_days"), // unpaid after this many days the factor charges it back; blank = 90; 0 = non-recourse
    ...audit(),
  },
  (t) => [index("billing_entities_tenant").on(t.tenantId)],
);

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export const locations = pgTable(
  "locations",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("shipper"), // shipper | consignee | yard | warehouse | border_yard | transload | customs | terminal
    address: jsonb("address").$type<Address>().notNull(),
    country: text("country").notNull(), // US | MX
    lat: text("lat"),
    lng: text("lng"),
    geofenceMeters: integer("geofence_meters").notNull().default(300),
    hours: text("hours"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    notes: text("notes"),
    portId: text("port_id"),
    ...audit(),
  },
  (t) => [index("locations_tenant").on(t.tenantId)],
);

export const ports = pgTable(
  "ports",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    usCity: text("us_city"),
    usState: text("us_state"),
    mxCity: text("mx_city"),
    mxState: text("mx_state"),
    bridges: jsonb("bridges").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // bridge names; the crossing workbench offers them
    notes: text("notes"),
    knowledgeMd: text("knowledge_md"),
    ...audit(),
  },
  (t) => [index("ports_tenant").on(t.tenantId)],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("customer"), // customer | broker
    country: text("country").notNull().default("US"),
    mcNumber: text("mc_number"),
    dotNumber: text("dot_number"),
    billingEntityId: text("billing_entity_id"),
    billingEmail: text("billing_email"),
    billingAddress: jsonb("billing_address").$type<Record<string, string | undefined>>(), // printed under Bill to
    termsDays: integer("terms_days").notNull().default(30),
    payWhenPaid: boolean("pay_when_paid").notNull().default(false),
    accessorialApproval: boolean("accessorial_approval").notNull().default(true), // extra charges (detention, lumper…) wait for the customer's OK before they bill
    trackingRequirement: text("tracking_requirement").notNull().default("link"), // none | link | edi214 | portal
    requiredDocs: jsonb("required_docs").$type<string[]>(), // blank = POD, BOL, RATE_CON; [] = nothing required
    requiredRefs: jsonb("required_refs").$type<string[]>(), // reference keys the invoice needs on the order (po, asn, shipment, reference, rate_con); blank = none
    detentionFreeMinutes: integer("detention_free_minutes"), // blank = 120
    detentionRateCents: integer("detention_rate_cents"), // per hour; blank = 75.00
    reminderDays: jsonb("reminder_days").$type<number[]>(), // days past due; blank = [3,10,20]; [] = opted out
    qbName: text("qb_name"), // QuickBooks customer name; blank = name
    invoiceMode: text("invoice_mode").notNull().default("per_load"), // per_load | summary (one invoice for every load billed together)
    invoiceDelivery: text("invoice_delivery").notNull().default("auto"), // auto | email | factor | edi | portal | mail
    invoiceCc: text("invoice_cc"), // more addresses, comma separated
    invoiceDocs: jsonb("invoice_docs").$type<string[]>(), // documents sent with the invoice; blank = the docs required before invoicing
    portalUrl: text("portal_url"), // where invoices are uploaded, for portal customers
    mxBrokerId: text("mx_broker_id"),
    usBrokerId: text("us_broker_id"),
    knowledgeMd: text("knowledge_md"),
    contacts: jsonb("contacts").$type<Contact[]>().notNull().default(sql`'[]'::jsonb`),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [index("customers_tenant").on(t.tenantId), uniqueIndex("customers_tenant_name_country").on(t.tenantId, t.name, t.country)],
);

export type Contact = { name: string; role?: string; email?: string; phone?: string; whatsapp?: string };

export const customsBrokers = pgTable(
  "customs_brokers",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    country: text("country").notNull(), // MX | US
    patente: text("patente"),
    filerCode: text("filer_code"),
    portalUrl: text("portal_url"),
    contacts: jsonb("contacts").$type<Contact[]>().notNull().default(sql`'[]'::jsonb`),
    ...audit(),
  },
  (t) => [index("customs_brokers_tenant").on(t.tenantId)],
);

export const carriers = pgTable(
  "carriers",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    country: text("country").notNull(), // US | MX
    kind: text("kind").notNull().default("any"), // mx | crossing | us | any
    mcNumber: text("mc_number"),
    dotNumber: text("dot_number"),
    nscNumber: text("nsc_number"), // Canada: National Safety Code / CVOR — the Canadian operating authority
    scac: text("scac"),
    rfc: text("rfc"),
    caat: text("caat"),
    caatExpires: timestamp("caat_expires", { withTimezone: true }),
    sctPermit: text("sct_permit"),
    sctPermitExpires: timestamp("sct_permit_expires", { withTimezone: true }),
    ctpat: boolean("ctpat").notNull().default(false),
    ctpatExpires: timestamp("ctpat_expires", { withTimezone: true }),
    tenderChannel: text("tender_channel").notNull().default("email"), // email | portal | edi | sylectus | whatsapp
    dispatchEmail: text("dispatch_email"),
    quickPayPct: integer("quick_pay_pct"), // whole percent discount when we pay within 7 days of approval
    qbName: text("qb_name"), // QuickBooks vendor name; blank = name
    dispatchPhone: text("dispatch_phone"),
    whatsapp: text("whatsapp"),
    plateClasses: jsonb("plate_classes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    portIds: jsonb("port_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    fmcsaStatus: jsonb("fmcsa_status").$type<{ authority?: string; insurance?: string; rating?: string; checkedAt?: string }>(),
    // insurance on file (certificate of insurance): what a broker-carrier agreement and a crossing need
    autoLiabilityCents: integer("auto_liability_cents"),
    autoLiabilityExpires: timestamp("auto_liability_expires", { withTimezone: true }),
    cargoCoverageCents: integer("cargo_coverage_cents"),
    cargoInsuranceExpires: timestamp("cargo_insurance_expires", { withTimezone: true }),
    insurer: text("insurer"),
    doNotUse: boolean("do_not_use").notNull().default(false),
    doNotUseReason: text("do_not_use_reason"),
    contacts: jsonb("contacts").$type<Contact[]>().notNull().default(sql`'[]'::jsonb`),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [index("carriers_tenant").on(t.tenantId)],
);

export const carrierRates = pgTable(
  "carrier_rates",
  {
    id: id(),
    tenantId: tenantId(),
    carrierId: text("carrier_id").notNull(),
    originLocationId: text("origin_location_id"),
    originZone: text("origin_zone"), // free text "Toluca, MEX" when no location
    destinationLocationId: text("destination_location_id"),
    destinationZone: text("destination_zone"),
    equipment: text("equipment").notNull().default("53_dry"),
    rateCents: integer("rate_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    fuelRule: text("fuel_rule").notNull().default("included"), // included | pct | per_mile
    fuelValue: integer("fuel_value"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    notes: text("notes"),
    ...audit(),
  },
  (t) => [index("carrier_rates_tenant_carrier").on(t.tenantId, t.carrierId)],
);

/** What a customer pays on a lane: flat or per mile, with its fuel rule; applied when a load is built. */
export const customerRates = pgTable(
  "customer_rates",
  {
    id: id(),
    tenantId: tenantId(),
    customerId: text("customer_id").notNull(),
    originZone: text("origin_zone").notNull(),
    destinationZone: text("destination_zone").notNull(),
    equipment: text("equipment"),
    rateType: text("rate_type").notNull().default("flat"), // flat | per_mile
    rateCents: integer("rate_cents").notNull(), // flat amount, or cents per mile
    minimumCents: integer("minimum_cents"), // per-mile lanes: never less than this
    currency: text("currency").notNull().default("USD"),
    fuelRule: text("fuel_rule").notNull().default("included"), // included | pct | per_mile | table
    fuelValue: integer("fuel_value"), // percent or cents per mile
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    notes: text("notes"),
    ...audit(),
  },
  (t) => [index("customer_rates_tenant_customer").on(t.tenantId, t.customerId)],
);

/** A fuel surcharge schedule: by the week's diesel price, a percent of line haul or cents per mile. */
export type FuelBand = { from: number; to: number | null; value: number }; // price in cents per gallon; value: percent × 100 or cents per mile
export const fuelTables = pgTable(
  "fuel_tables",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    method: text("method").notNull().default("pct"), // pct | per_mile
    bands: jsonb("bands").$type<FuelBand[]>().notNull().default(sql`'[]'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    ...audit(),
  },
  (t) => [index("fuel_tables_tenant").on(t.tenantId)],
);

/** The diesel price the fuel tables read, week by week (entered, or from the DOE/EIA feed). */
export const fuelPrices = pgTable(
  "fuel_prices",
  {
    id: id(),
    tenantId: tenantId(),
    weekOf: text("week_of").notNull(), // YYYY-MM-DD, the Monday
    priceCents: integer("price_cents").notNull(), // per gallon
    source: text("source").notNull().default("manual"),
    ...audit(),
  },
  (t) => [uniqueIndex("fuel_prices_tenant_week").on(t.tenantId, t.weekOf)],
);

export const trucks = pgTable(
  "trucks",
  {
    id: id(),
    tenantId: tenantId(),
    unitNumber: text("unit_number").notNull(),
    vin: text("vin"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    equipmentType: text("equipment_type").notNull().default("tractor"), // tractor | sprinter | straight | cargo_van
    cargoLengthFt: integer("cargo_length_ft"), // straight trucks / vans that carry freight themselves
    maxWeightLbs: integer("max_weight_lbs"),
    cubeFt: integer("cube_ft"),
    ownership: text("ownership").notNull().default("company"), // company | owner_op | leased
    usPlate: text("us_plate"),
    usPlateState: text("us_plate_state"),
    usPlateExpires: timestamp("us_plate_expires", { withTimezone: true }),
    mxPlate: text("mx_plate"),
    mxPlateClass: text("mx_plate_class"), // blue | brown
    mxPlateExpires: timestamp("mx_plate_expires", { withTimezone: true }),
    caPlate: text("ca_plate"), // Canadian plate (IRP-apportioned Canadian units run the US on it too)
    caPlateProvince: text("ca_plate_province"),
    caPlateExpires: timestamp("ca_plate_expires", { withTimezone: true }),
    entityId: text("entity_id"), // billing entity or partner CAAT holder the unit runs under
    caat: text("caat"),
    scac: text("scac"),
    eldProvider: text("eld_provider"),
    eldVehicleId: text("eld_vehicle_id"),
    dotInspectionExpires: timestamp("dot_inspection_expires", { withTimezone: true }),
    dtopsYear: integer("dtops_year"),
    dtopsConfirmation: text("dtops_confirmation"),
    status: text("status").notNull().default("active"), // active | oos
    oosReason: text("oos_reason"),
    oosUntil: timestamp("oos_until", { withTimezone: true }),
    note: text("note"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [uniqueIndex("trucks_tenant_unit").on(t.tenantId, t.unitNumber), index("trucks_tenant").on(t.tenantId)],
);

export const trailers = pgTable(
  "trailers",
  {
    id: id(),
    tenantId: tenantId(),
    unitNumber: text("unit_number").notNull(),
    vin: text("vin"),
    kind: text("kind").notNull().default("53_dry"),
    lengthFt: integer("length_ft"),
    maxWeightLbs: integer("max_weight_lbs"), // payload; blank = by kind
    cubeFt: integer("cube_ft"),
    usPlate: text("us_plate"),
    mxPlate: text("mx_plate"),
    inspectionExpires: timestamp("inspection_expires", { withTimezone: true }),
    ownership: text("ownership").notNull().default("company"),
    gpsDeviceId: text("gps_device_id"),
    status: text("status").notNull().default("active"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [uniqueIndex("trailers_tenant_unit").on(t.tenantId, t.unitNumber), index("trailers_tenant").on(t.tenantId)],
);

export const drivers = pgTable(
  "drivers",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    driverType: text("driver_type").notNull().default("CDL"), // B1 | CDL | DUAL
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    userId: text("user_id"),
    licenseNumber: text("license_number"),
    licenseState: text("license_state"),
    licenseClass: text("license_class"),
    licenseExpires: timestamp("license_expires", { withTimezone: true }),
    mxLicenseNumber: text("mx_license_number"),
    mxLicenseExpires: timestamp("mx_license_expires", { withTimezone: true }),
    medicalExpires: timestamp("medical_expires", { withTimezone: true }),
    fastNumber: text("fast_number"),
    fastExpires: timestamp("fast_expires", { withTimezone: true }),
    visaType: text("visa_type"),
    i94Until: timestamp("i94_until", { withTimezone: true }),
    elpAttestedAt: timestamp("elp_attested_at", { withTimezone: true }),
    commercialZoneOnly: boolean("commercial_zone_only").notNull().default(false),
    nonDomiciledCdl: boolean("non_domiciled_cdl").notNull().default(false),
    hireDate: timestamp("hire_date", { withTimezone: true }),
    payType: text("pay_type").notNull().default("per_mile"), // per_mile | pct | flat | hourly
    payRateCents: integer("pay_rate_cents"),
    crossingPayCents: integer("crossing_pay_cents"), // flat per crossing leg on top of the pay type
    qbName: text("qb_name"), // QuickBooks vendor name for settlements; blank = name
    homeTerminalId: text("home_terminal_id"),
    eldDriverId: text("eld_driver_id"),
    currentTruckId: text("current_truck_id"),
    dispatcherUserId: text("dispatcher_user_id"), // the dispatcher who runs this driver
    payPlanId: text("pay_plan_id"), // a pay plan; blank = the pay type and rate on the driver
    hosDriveMin: integer("hos_drive_min"), // hours of service left, from the ELD
    hosShiftMin: integer("hos_shift_min"),
    hosCycleMin: integer("hos_cycle_min"),
    hosAt: timestamp("hos_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [index("drivers_tenant").on(t.tenantId)],
);

export const documentTypes = pgTable(
  "document_types",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    appliesTo: text("applies_to").notNull(), // driver | truck | trailer | carrier | customer | order | load
    tracksExpiry: boolean("tracks_expiry").notNull().default(true),
    alertDays: jsonb("alert_days").$type<number[]>().notNull().default(sql`'[30]'::jsonb`),
    required: boolean("required").notNull().default(false),
    blocksDispatch: boolean("blocks_dispatch").notNull().default(false),
    legScope: text("leg_scope"), // null = all legs; crossing | mx | us
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    ...audit(),
  },
  (t) => [uniqueIndex("document_types_tenant_name_applies").on(t.tenantId, t.name, t.appliesTo)],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    tenantId: tenantId(),
    documentTypeId: text("document_type_id"),
    code: text("code"), // crossing packet code: carta_retiro | carta_porte | doda | entry | ace_manifest | dtops | bol | invoice | packing_list ...
    subjectKind: text("subject_kind").notNull(), // driver | truck | trailer | carrier | customer | order | leg | crossing
    subjectId: text("subject_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    number: text("number"),
    source: text("source").notNull().default("upload"), // upload | nad | viatpro | generated | driver_app | portal | email
    status: text("status").notNull().default("present"), // present | verified | superseded | rejected | pending (from the driver app, counts once safety confirms it)
    version: integer("version").notNull().default(1),
    extracted: jsonb("extracted").$type<Record<string, { value: unknown; confidence: number; source?: "ai" | "human" }>>(),
    extractionAt: timestamp("extraction_at", { withTimezone: true }), // last AI read
    extractionNote: text("extraction_note"), // model + tokens, or the error
    notes: text("notes"),
    ...audit(),
  },
  (t) => [index("documents_tenant_subject").on(t.tenantId, t.subjectKind, t.subjectId)],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    entity: text("entity").notNull(),
    fileName: text("file_name").notNull(),
    mapping: jsonb("mapping").$type<Record<string, string>>().notNull(),
    rowCount: integer("row_count").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    errors: jsonb("errors").$type<{ row: number; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("preview"), // preview | committed | failed
    ...audit(),
  },
  (t) => [index("import_jobs_tenant").on(t.tenantId)],
);

/** A saved grid view: columns, order, widths, filters, sort. Personal, or shared with the company. */
export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    tenantId: tenantId(),
    userId: text("user_id").notNull(),
    page: text("page").notNull(), // loads | …
    name: text("name").notNull(),
    shared: boolean("shared").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...audit(),
  },
  (t) => [index("saved_views_tenant_page").on(t.tenantId, t.page)],
);

export const ASSET_EVENT_KINDS = ["vacation", "home_time", "restart", "sick", "repair", "work_order", "other"] as const;
export type AssetEventKind = (typeof ASSET_EVENT_KINDS)[number];

/** Time a driver, truck or trailer is not available: vacation, home time, a restart, a repair. A hard event blocks assignment; a soft one warns. */
export const assetEvents = pgTable(
  "asset_events",
  {
    id: id(),
    tenantId: tenantId(),
    subjectKind: text("subject_kind").notNull(), // driver | truck | trailer
    subjectId: text("subject_id").notNull(),
    kind: text("kind").$type<AssetEventKind>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    hard: boolean("hard").notNull().default(true),
    note: text("note"),
    ...audit(),
  },
  (t) => [index("asset_events_subject").on(t.tenantId, t.subjectKind, t.subjectId)],
);
