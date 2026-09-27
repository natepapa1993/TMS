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
    isDefault: boolean("is_default").notNull().default(false),
    terms: text("terms"),
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
    bridges: jsonb("bridges").$type<{ name: string; cbpPortId?: string; fast?: boolean }[]>().notNull().default(sql`'[]'::jsonb`),
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
    termsDays: integer("terms_days").notNull().default(30),
    payWhenPaid: boolean("pay_when_paid").notNull().default(false),
    trackingRequirement: text("tracking_requirement").notNull().default("link"), // none | link | edi214 | portal
    requiredDocs: jsonb("required_docs").$type<string[]>(), // blank = POD, BOL, RATE_CON; [] = nothing required
    detentionFreeMinutes: integer("detention_free_minutes"), // blank = 120
    detentionRateCents: integer("detention_rate_cents"), // per hour; blank = 75.00
    reminderDays: jsonb("reminder_days").$type<number[]>(), // days past due; blank = [3,10,20]; [] = opted out
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
    dispatchPhone: text("dispatch_phone"),
    whatsapp: text("whatsapp"),
    plateClasses: jsonb("plate_classes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    portIds: jsonb("port_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    fmcsaStatus: jsonb("fmcsa_status").$type<{ authority?: string; insurance?: string; rating?: string; checkedAt?: string }>(),
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
    ownership: text("ownership").notNull().default("company"), // company | owner_op | leased
    usPlate: text("us_plate"),
    usPlateState: text("us_plate_state"),
    usPlateExpires: timestamp("us_plate_expires", { withTimezone: true }),
    mxPlate: text("mx_plate"),
    mxPlateClass: text("mx_plate_class"), // blue | brown
    mxPlateExpires: timestamp("mx_plate_expires", { withTimezone: true }),
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
    homeTerminalId: text("home_terminal_id"),
    eldDriverId: text("eld_driver_id"),
    currentTruckId: text("current_truck_id"),
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
    status: text("status").notNull().default("present"), // present | verified | superseded | rejected
    version: integer("version").notNull().default(1),
    extracted: jsonb("extracted").$type<Record<string, { value: unknown; confidence: number }>>(),
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
