import type { RecordKind } from "./records";
import type { Contact } from "@/db/schema";

/**
 * Field definitions for every master-data record (spec §1.1–1.3). One place drives the list
 * columns, the quick-add popup (the few fields you need to get going), the full record screen
 * (grouped sections, everything editable), CSV import mapping, and value coercion.
 */

export type FieldType = "text" | "number" | "cents" | "date" | "select" | "boolean" | "textarea" | "ref" | "email" | "phone" | "address" | "list" | "password" | "contacts";

export type Field = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  quick?: boolean; // shows in the quick-add popup
  column?: boolean; // shows in the list
  group: string;
  options?: { value: string; label: string }[];
  ref?: RecordKind; // for type=ref
  help?: string;
  placeholder?: string;
  unique?: boolean;
  listOf?: "text" | "number" | "code"; // for type=list: comma-separated values; "none" saves an empty list; code = upper-cased identifiers (POD, RATE_CON); text = as typed
};

const COUNTRY = [
  { value: "US", label: "United States" },
  { value: "MX", label: "Mexico" },
  { value: "CA", label: "Canada" },
];

const EQUIPMENT = [
  { value: "53_dry", label: "53' dry van" },
  { value: "53_reefer", label: "53' reefer" },
  { value: "48_dry", label: "48' dry van" },
  { value: "flatbed", label: "Flatbed" },
  { value: "sprinter", label: "Sprinter" },
  { value: "straight", label: "Straight truck" },
  { value: "power_only", label: "Power only" },
];

export const FIELDS: Record<RecordKind, Field[]> = {
  billingEntity: [
    { name: "legalName", label: "Legal name", type: "text", required: true, quick: true, column: true, group: "Company" },
    { name: "dba", label: "DBA", type: "text", column: true, group: "Company" },
    { name: "country", label: "Country", type: "select", options: COUNTRY, required: true, quick: true, column: true, group: "Company" },
    { name: "taxId", label: "EIN / RFC", type: "text", quick: true, group: "Company", unique: true },
    { name: "invoicePrefix", label: "Invoice prefix", type: "text", required: true, quick: true, column: true, group: "Invoicing", help: "Invoice numbers become PREFIX-000123", placeholder: "247" },
    { name: "nextInvoiceNumber", label: "Next invoice #", type: "number", group: "Invoicing" },
    { name: "terms", label: "Default terms", type: "text", group: "Invoicing", placeholder: "Net 30" },
    { name: "isDefault", label: "Default entity", type: "boolean", group: "Invoicing" },
    { name: "mcNumber", label: "MC #", type: "text", group: "Authority" },
    { name: "dotNumber", label: "DOT #", type: "text", group: "Authority" },
    { name: "nscNumber", label: "NSC / CVOR # (Canada)", type: "text", group: "Authority" },
    { name: "scac", label: "SCAC", type: "text", group: "Authority" },
    { name: "caat", label: "CAAT", type: "text", group: "Authority" },
    { name: "remitTo", label: "Remit-to address", type: "address", group: "Invoicing" },
  ],
  user: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "User" },
    { name: "email", label: "Email", type: "email", required: true, quick: true, column: true, group: "User", unique: true },
    {
      name: "role",
      label: "Role",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "User",
      options: [
        { value: "owner", label: "Owner" },
        { value: "dispatcher", label: "Dispatcher" },
        { value: "billing", label: "Billing" },
        { value: "compliance", label: "Safety & compliance" },
        { value: "mx_office", label: "Mexico office" },
        { value: "driver", label: "Driver" },
        { value: "carrier", label: "Carrier" },
        { value: "customer", label: "Customer" },
      ],
    },
    { name: "phone", label: "Phone", type: "phone", group: "User" },
    { name: "password", label: "Password", type: "password", required: true, quick: true, group: "Sign-in", help: "At least 10 characters. On this screen, leave it blank to keep the current one." },
  ],
  location: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Location", unique: true },
    {
      name: "kind",
      label: "Kind",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "Location",
      options: [
        { value: "shipper", label: "Shipper" },
        { value: "consignee", label: "Consignee" },
        { value: "yard", label: "Yard" },
        { value: "border_yard", label: "Border yard" },
        { value: "warehouse", label: "Warehouse" },
        { value: "transload", label: "Transload" },
        { value: "customs", label: "Customs" },
        { value: "terminal", label: "Terminal" },
      ],
    },
    { name: "country", label: "Country", type: "select", options: COUNTRY, required: true, quick: true, column: true, group: "Location" },
    { name: "address", label: "Address", type: "address", required: true, quick: true, group: "Location" },
    { name: "hours", label: "Hours", type: "text", group: "Details", placeholder: "Mon–Fri 7:00–17:00" },
    { name: "contactName", label: "Contact", type: "text", group: "Details" },
    { name: "contactPhone", label: "Contact phone", type: "phone", group: "Details" },
    { name: "geofenceMeters", label: "Geofence (m)", type: "number", group: "Tracking" },
    { name: "lat", label: "Latitude", type: "text", group: "Tracking" },
    { name: "lng", label: "Longitude", type: "text", group: "Tracking" },
    { name: "portId", label: "Port of entry", type: "ref", ref: "port", group: "Tracking" },
    { name: "notes", label: "Notes", type: "textarea", group: "Details" },
  ],
  port: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Port", unique: true, placeholder: "e.g. the port name" },
    { name: "usCity", label: "US city", type: "text", quick: true, column: true, group: "Port" },
    { name: "usState", label: "US state", type: "text", group: "Port" },
    { name: "mxCity", label: "MX city", type: "text", quick: true, column: true, group: "Port" },
    { name: "mxState", label: "MX state", type: "text", group: "Port" },
    { name: "bridges", label: "Bridges", type: "list", listOf: "text", group: "Port", help: "comma-separated · the crossing workbench offers them for the crossing's bridge", placeholder: "World Trade Bridge, Colombia Solidarity Bridge" },
    { name: "notes", label: "Notes", type: "textarea", group: "Details" },
    { name: "knowledgeMd", label: "Crossing knowledge", type: "textarea", group: "Details", help: "What every dispatcher should know about this port: bridges, hours, quirks." },
  ],
  customer: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Customer", unique: true },
    {
      name: "kind",
      label: "Type",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "Customer",
      options: [
        { value: "customer", label: "Customer (shipper)" },
        { value: "broker", label: "Broker / 3PL" },
      ],
    },
    { name: "country", label: "Country", type: "select", options: COUNTRY, required: true, quick: true, group: "Customer" },
    { name: "mcNumber", label: "MC #", type: "text", group: "Customer" },
    { name: "dotNumber", label: "DOT #", type: "text", group: "Customer" },
    { name: "billingEmail", label: "Billing email", type: "email", quick: true, column: true, group: "Billing" },
    { name: "termsDays", label: "Terms (days)", type: "number", quick: true, column: true, group: "Billing" },
    { name: "payWhenPaid", label: "Pay-when-paid", type: "boolean", group: "Billing" },
    { name: "billingEntityId", label: "Bill from entity", type: "ref", ref: "billingEntity", group: "Billing" },
    { name: "requiredDocs", label: "Docs before invoicing", type: "list", listOf: "code", group: "Billing", help: "Codes the invoice needs on file · blank = POD, BOL, RATE_CON · type none if nothing is required", placeholder: "POD, BOL, RATE_CON" },
    { name: "requiredRefs", label: "References before invoicing", type: "list", listOf: "code", group: "Billing", help: "Reference fields the order must carry before it invoices: PO, ASN, SHIPMENT, REFERENCE, RATE_CON · blank = none", placeholder: "PO, ASN" },
    { name: "detentionFreeMinutes", label: "Detention free time (min)", type: "number", group: "Billing", help: "blank = 120" },
    { name: "detentionRateCents", label: "Detention rate / hour", type: "cents", group: "Billing", help: "blank = 75.00" },
    { name: "reminderDays", label: "Reminder days past due", type: "list", listOf: "number", group: "Billing", help: "blank = 3, 10, 20 · type none to opt out", placeholder: "3, 10, 20" },
    { name: "qbName", label: "QuickBooks customer", type: "text", group: "Billing", help: "name as it appears in QuickBooks · blank = same as here" },
    {
      name: "trackingRequirement",
      label: "Tracking requirement",
      type: "select",
      group: "Requirements",
      options: [
        { value: "none", label: "None" },
        { value: "link", label: "Tracking link — emailed to their first contact with an email when the order is dispatched" },
        { value: "edi214", label: "EDI 214" },
        { value: "portal", label: "Portal updates" },
      ],
    },
    { name: "contacts", label: "Contacts", type: "contacts", group: "Requirements", help: "one per line: Name | role | email | phone | WhatsApp · the first with an email gets tracking links" },
    { name: "mxBrokerId", label: "Mexican customs broker", type: "ref", ref: "customsBroker", group: "Requirements" },
    { name: "usBrokerId", label: "US customs broker", type: "ref", ref: "customsBroker", group: "Requirements" },
    { name: "knowledgeMd", label: "What to know", type: "textarea", group: "Requirements", help: "Shows to dispatch on every order for this customer." },
  ],
  customsBroker: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Broker" },
    { name: "country", label: "Country", type: "select", options: COUNTRY, required: true, quick: true, column: true, group: "Broker" },
    { name: "patente", label: "Patente (MX)", type: "text", quick: true, column: true, group: "Broker" },
    { name: "filerCode", label: "Filer code (US)", type: "text", group: "Broker" },
    { name: "portalUrl", label: "Portal URL", type: "text", group: "Broker", placeholder: "https://" },
    { name: "contacts", label: "Contacts", type: "contacts", group: "Broker", help: "one per line: Name | role | email | phone | WhatsApp" },
  ],
  carrier: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Carrier" },
    { name: "country", label: "Country", type: "select", options: COUNTRY, required: true, quick: true, column: true, group: "Carrier" },
    {
      name: "kind",
      label: "Runs",
      type: "select",
      quick: true,
      column: true,
      group: "Carrier",
      options: [
        { value: "any", label: "Any leg" },
        { value: "mx", label: "Mexico legs" },
        { value: "crossing", label: "Crossing" },
        { value: "us", label: "US legs" },
        { value: "ca", label: "Canada legs" },
      ],
    },
    { name: "mcNumber", label: "MC #", type: "text", group: "Authority", unique: true },
    { name: "dotNumber", label: "DOT #", type: "text", group: "Authority" },
    { name: "scac", label: "SCAC", type: "text", group: "Authority" },
    { name: "rfc", label: "RFC", type: "text", group: "Authority", unique: true },
    { name: "caat", label: "CAAT", type: "text", group: "Authority" },
    { name: "caatExpires", label: "CAAT expires", type: "date", group: "Authority" },
    { name: "sctPermit", label: "SCT permit", type: "text", group: "Authority" },
    { name: "sctPermitExpires", label: "SCT expires", type: "date", group: "Authority" },
    { name: "ctpat", label: "C-TPAT", type: "boolean", group: "Authority" },
    { name: "ctpatExpires", label: "C-TPAT expires", type: "date", group: "Authority" },
    {
      name: "tenderChannel",
      label: "Tender by",
      type: "select",
      group: "Dispatch",
      options: [
        { value: "email", label: "Email" },
        { value: "whatsapp", label: "WhatsApp" },
        { value: "portal", label: "Carrier portal" },
        { value: "sylectus", label: "Sylectus" },
        { value: "edi", label: "EDI" },
      ],
    },
    { name: "dispatchEmail", label: "Dispatch email", type: "email", quick: true, group: "Dispatch" },
    { name: "dispatchPhone", label: "Dispatch phone", type: "phone", group: "Dispatch" },
    { name: "whatsapp", label: "WhatsApp", type: "phone", group: "Dispatch" },
    { name: "contacts", label: "Contacts", type: "contacts", group: "Dispatch", help: "one per line: Name | role | email | phone | WhatsApp" },
    { name: "quickPayPct", label: "Quick-pay discount %", type: "number", group: "Payables", help: "taken off when we pay within 7 days of approval · blank = none" },
    { name: "qbName", label: "QuickBooks vendor", type: "text", group: "Payables", help: "blank = same as here" },
    { name: "doNotUse", label: "Do not use", type: "boolean", column: true, group: "Status" },
    { name: "doNotUseReason", label: "Reason", type: "text", group: "Status" },
  ],
  carrierRate: [
    { name: "carrierId", label: "Carrier", type: "ref", ref: "carrier", required: true, quick: true, column: true, group: "Lane" },
    { name: "originZone", label: "From", type: "text", required: true, quick: true, column: true, group: "Lane", placeholder: "Toluca, MEX" },
    { name: "destinationZone", label: "To", type: "text", required: true, quick: true, column: true, group: "Lane", placeholder: "city, state or yard" },
    { name: "equipment", label: "Equipment", type: "select", options: EQUIPMENT, group: "Lane" },
    { name: "rateCents", label: "Rate", type: "cents", required: true, quick: true, column: true, group: "Rate" },
    {
      name: "currency",
      label: "Currency",
      type: "select",
      group: "Rate",
      options: [
        { value: "USD", label: "USD" },
        { value: "MXN", label: "MXN" },
      ],
    },
    {
      name: "fuelRule",
      label: "Fuel",
      type: "select",
      group: "Rate",
      options: [
        { value: "included", label: "Included" },
        { value: "pct", label: "Percent of linehaul" },
        { value: "per_mile", label: "Per mile" },
      ],
    },
    { name: "fuelValue", label: "Fuel value", type: "number", group: "Rate", help: "Percent or cents per mile, per the rule" },
    { name: "validFrom", label: "Valid from", type: "date", group: "Validity" },
    { name: "validTo", label: "Valid to", type: "date", group: "Validity" },
    { name: "notes", label: "Notes", type: "textarea", group: "Validity" },
  ],
  truck: [
    { name: "unitNumber", label: "Unit #", type: "text", required: true, quick: true, column: true, group: "Unit", unique: true },
    {
      name: "equipmentType",
      label: "Type",
      type: "select",
      quick: true,
      column: true,
      group: "Unit",
      options: [
        { value: "tractor", label: "Tractor" },
        { value: "sprinter", label: "Sprinter" },
        { value: "straight", label: "Straight truck" },
        { value: "cargo_van", label: "Cargo van" },
      ],
    },
    { name: "cargoLengthFt", label: "Cargo length (ft)", type: "number", group: "Unit", help: "straight trucks and vans that carry freight themselves" },
    { name: "maxWeightLbs", label: "Payload (lb)", type: "number", group: "Unit" },
    { name: "cubeFt", label: "Cube (cu ft)", type: "number", group: "Unit" },
    { name: "year", label: "Year", type: "number", group: "Unit" },
    { name: "make", label: "Make", type: "text", group: "Unit" },
    { name: "model", label: "Model", type: "text", group: "Unit" },
    { name: "vin", label: "VIN", type: "text", group: "Unit" },
    {
      name: "ownership",
      label: "Ownership",
      type: "select",
      group: "Unit",
      options: [
        { value: "company", label: "Company" },
        { value: "owner_op", label: "Owner-operator" },
        { value: "leased", label: "Leased" },
      ],
    },
    { name: "usPlate", label: "US plate", type: "text", quick: true, column: true, group: "Plates" },
    { name: "usPlateState", label: "US plate state", type: "text", group: "Plates" },
    { name: "usPlateExpires", label: "US plate expires", type: "date", group: "Plates" },
    { name: "mxPlate", label: "MX plate", type: "text", quick: true, column: true, group: "Plates" },
    {
      name: "mxPlateClass",
      label: "MX plate class",
      type: "select",
      quick: true,
      column: true,
      group: "Plates",
      options: [
        { value: "blue", label: "Blue (interior Mexico)" },
        { value: "brown", label: "Brown (border zone)" },
      ],
      help: "Brown plates cannot run interior Mexico. The system enforces this.",
    },
    { name: "mxPlateExpires", label: "MX plate expires", type: "date", group: "Plates" },
    { name: "caPlate", label: "Canadian plate", type: "text", column: true, group: "Plates" },
    { name: "caPlateProvince", label: "Province", type: "text", group: "Plates", placeholder: "ON" },
    { name: "caPlateExpires", label: "Canadian plate expires", type: "date", group: "Plates" },
    { name: "entityId", label: "Runs under", type: "ref", ref: "billingEntity", group: "Authority" },
    { name: "caat", label: "CAAT", type: "text", group: "Authority" },
    { name: "scac", label: "SCAC", type: "text", group: "Authority" },
    { name: "dotInspectionExpires", label: "Annual inspection", type: "date", group: "Compliance" },
    { name: "dtopsYear", label: "DTOPS year", type: "number", group: "Compliance" },
    { name: "dtopsConfirmation", label: "DTOPS confirmation", type: "text", group: "Compliance" },
    { name: "eldProvider", label: "ELD provider", type: "text", group: "Tracking", placeholder: "Motive" },
    { name: "eldVehicleId", label: "ELD vehicle id", type: "text", group: "Tracking" },
    { name: "note", label: "Note", type: "textarea", group: "Compliance" },
  ],
  trailer: [
    { name: "unitNumber", label: "Trailer #", type: "text", required: true, quick: true, column: true, group: "Trailer", unique: true },
    { name: "kind", label: "Kind", type: "select", options: EQUIPMENT, quick: true, column: true, group: "Trailer" },
    { name: "lengthFt", label: "Length (ft)", type: "number", group: "Trailer" },
    { name: "maxWeightLbs", label: "Payload (lb)", type: "number", group: "Trailer", help: "blank = 45,000 for a 53' dry van" },
    { name: "cubeFt", label: "Cube (cu ft)", type: "number", group: "Trailer", help: "blank = by length" },
    { name: "vin", label: "VIN", type: "text", group: "Trailer" },
    {
      name: "ownership",
      label: "Ownership",
      type: "select",
      group: "Trailer",
      options: [
        { value: "company", label: "Company" },
        { value: "owner_op", label: "Owner-operator" },
        { value: "leased", label: "Leased" },
        { value: "customer", label: "Customer's" },
      ],
    },
    { name: "usPlate", label: "US plate", type: "text", quick: true, column: true, group: "Plates" },
    { name: "mxPlate", label: "MX plate", type: "text", group: "Plates" },
    { name: "inspectionExpires", label: "Inspection expires", type: "date", group: "Compliance" },
    { name: "gpsDeviceId", label: "GPS device", type: "text", group: "Tracking" },
  ],
  driver: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Driver" },
    {
      name: "driverType",
      label: "Driver type",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "Driver",
      options: [
        { value: "B1", label: "B-1 (Mexican, crossing only)" },
        { value: "CDL", label: "US CDL" },
        { value: "CA", label: "Canadian licence (Class 1 / AZ)" },
        { value: "DUAL", label: "Dual (runs Mexico and the US)" },
      ],
      help: "Cabotage is enforced: a B-1 driver never runs a US-only or Canada-only leg; a US CDL never a Canada-only leg; a Canadian licence never a US-only leg. No override.",
    },
    { name: "phone", label: "Phone", type: "phone", quick: true, column: true, group: "Driver" },
    { name: "whatsapp", label: "WhatsApp", type: "phone", group: "Driver" },
    { name: "currentTruckId", label: "Current unit", type: "ref", ref: "truck", quick: true, column: true, group: "Driver" },
    { name: "hireDate", label: "Hire date", type: "date", group: "Driver" },
    { name: "licenseNumber", label: "License #", type: "text", group: "Licence (US CDL or Canadian)", unique: true },
    { name: "licenseState", label: "State / province", type: "text", group: "Licence (US CDL or Canadian)" },
    { name: "licenseClass", label: "Class", type: "text", group: "Licence (US CDL or Canadian)" },
    { name: "licenseExpires", label: "License expires", type: "date", group: "Licence (US CDL or Canadian)" },
    { name: "medicalExpires", label: "Medical card expires", type: "date", group: "Licence (US CDL or Canadian)" },
    { name: "nonDomiciledCdl", label: "Non-domiciled CDL", type: "boolean", group: "Licence (US CDL or Canadian)" },
    { name: "mxLicenseNumber", label: "Licencia federal #", type: "text", group: "Mexico" },
    { name: "mxLicenseExpires", label: "Licencia expires", type: "date", group: "Mexico" },
    { name: "fastNumber", label: "FAST card #", type: "text", group: "Border" },
    { name: "fastExpires", label: "FAST expires", type: "date", group: "Border" },
    { name: "visaType", label: "Visa", type: "text", group: "Border", placeholder: "B-1/B-2" },
    { name: "i94Until", label: "I-94 admit until", type: "date", group: "Border" },
    { name: "commercialZoneOnly", label: "Commercial zone only", type: "boolean", group: "Border" },
    { name: "elpAttestedAt", label: "English proficiency attested", type: "date", group: "Border" },
    {
      name: "payType",
      label: "Pay type",
      type: "select",
      group: "Pay",
      options: [
        { value: "per_mile", label: "Per mile" },
        { value: "pct", label: "Percent of load" },
        { value: "flat", label: "Flat per leg" },
        { value: "hourly", label: "Hourly" },
      ],
    },
    { name: "payRateCents", label: "Pay rate", type: "cents", group: "Pay", help: "per mile, per leg, per hour, or percent (62 = 62%) by pay type" },
    { name: "crossingPayCents", label: "Crossing pay", type: "cents", group: "Pay", help: "flat, on top, for every crossing leg" },
    { name: "qbName", label: "QuickBooks vendor", type: "text", group: "Pay", help: "settlements export as bills to this vendor · blank = driver name" },
    { name: "eldDriverId", label: "ELD driver id", type: "text", group: "Pay" },
  ],
  documentType: [
    { name: "name", label: "Name", type: "text", required: true, quick: true, column: true, group: "Document" },
    {
      name: "appliesTo",
      label: "Applies to",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "Document",
      options: [
        { value: "driver", label: "Driver" },
        { value: "truck", label: "Truck" },
        { value: "trailer", label: "Trailer" },
        { value: "carrier", label: "Carrier" },
        { value: "customer", label: "Customer" },
        { value: "order", label: "Order" },
      ],
    },
    { name: "tracksExpiry", label: "Tracks expiry", type: "boolean", quick: true, column: true, group: "Rules" },
    { name: "alertDays", label: "Alert days before expiry", type: "list", listOf: "number", group: "Rules", help: "blank = 30 · the board and the digest alert inside the largest", placeholder: "30, 7" },
    { name: "required", label: "Required", type: "boolean", column: true, group: "Rules" },
    { name: "blocksDispatch", label: "Blocks dispatch when missing/expired", type: "boolean", column: true, group: "Rules" },
    {
      name: "legScope",
      label: "Only for legs",
      type: "select",
      group: "Rules",
      options: [
        { value: "", label: "All legs" },
        { value: "crossing", label: "Legs that cross a border" },
        { value: "mx", label: "Legs that run in Mexico" },
        { value: "us", label: "Legs that run in the US" },
        { value: "ca", label: "Legs that run in Canada" },
      ],
      help: "A FAST card scoped to border crossings never blocks a run inside one country; the safety board still shows it.",
    },
    { name: "graceUntil", label: "Grace until", type: "date", group: "Rules", help: "New rules can be introduced without blocking today's loads." },
  ],
  ediPartner: [
    { name: "theirId", label: "Their ISA id", type: "text", required: true, quick: true, column: true, group: "Partner", help: "ISA08 / GS03 from the customer's EDI spec", placeholder: "their ISA sender id" },
    { name: "customerId", label: "Customer", type: "ref", ref: "customer", required: true, quick: true, column: true, group: "Partner" },
    {
      name: "theirQualifier",
      label: "Their qualifier",
      type: "select",
      required: true,
      quick: true,
      group: "Partner",
      options: [
        { value: "ZZ", label: "ZZ — mutually defined" },
        { value: "01", label: "01 — DUNS" },
        { value: "02", label: "02 — SCAC" },
        { value: "12", label: "12 — phone" },
        { value: "08", label: "08 — UCC EDI id" },
      ],
    },
    { name: "scac", label: "Our SCAC", type: "text", required: true, quick: true, column: true, group: "Us", placeholder: "BSTW" },
    { name: "ourId", label: "Our ISA id", type: "text", required: true, quick: true, group: "Us", help: "ISA06 / GS02 — usually the SCAC", placeholder: "BSTW" },
    {
      name: "ourQualifier",
      label: "Our qualifier",
      type: "select",
      group: "Us",
      options: [
        { value: "02", label: "02 — SCAC" },
        { value: "ZZ", label: "ZZ — mutually defined" },
        { value: "01", label: "01 — DUNS" },
        { value: "12", label: "12 — phone" },
      ],
    },
    {
      name: "usage",
      label: "Mode",
      type: "select",
      required: true,
      quick: true,
      column: true,
      group: "Us",
      options: [
        { value: "T", label: "Test" },
        { value: "P", label: "Production" },
      ],
    },
    { name: "send214", label: "Send 214 status updates", type: "boolean", column: true, group: "Messages", help: "one message per milestone: arrived, loaded, en route, delivered" },
    { name: "send210", label: "Send 210 invoices", type: "boolean", column: true, group: "Messages", help: "when an invoice is issued" },
    { name: "accept204", label: "Accept 204 load tenders", type: "boolean", column: true, group: "Messages", help: "inbound tenders create draft orders and get a 997 + 990" },
    { name: "autoCreateOrders", label: "Create orders from tenders", type: "boolean", group: "Messages", help: "off = tenders wait in the EDI inbox for a dispatcher" },
    {
      name: "delivery",
      label: "Outbound delivery",
      type: "select",
      group: "Delivery",
      options: [
        { value: "pickup", label: "Pickup — their VAN / AS2 connector collects from us" },
        { value: "email", label: "Email the X12 file" },
        { value: "sftp", label: "VAN mailbox — we drop it in their SFTP outbox" },
      ],
      help: "For the VAN mailbox, set the host and folders on the record after saving.",
    },
    { name: "deliveryEmail", label: "Delivery email", type: "email", group: "Delivery", help: "for the Email option" },
    { name: "enabled", label: "Enabled", type: "boolean", column: true, group: "Delivery" },
  ],
};

export const KIND_META: Record<RecordKind, { plural: string; singular: string; path: string; blurb: string; section: "Company" | "Fleet" | "Partners" | "Rules" }> = {
  billingEntity: { plural: "Billing entities", singular: "Billing entity", path: "billing-entities", blurb: "Who invoices: prefix, EIN/RFC, remit-to", section: "Company" },
  user: { plural: "Users", singular: "User", path: "users", blurb: "People who sign in and their role", section: "Company" },
  location: { plural: "Locations", singular: "Location", path: "locations", blurb: "Shippers, yards, border yards, consignees", section: "Company" },
  port: { plural: "Ports of entry", singular: "Port of entry", path: "ports", blurb: "Border crossings and bridges", section: "Company" },
  truck: { plural: "Trucks", singular: "Truck", path: "trucks", blurb: "Units, plates, inspection, ELD", section: "Fleet" },
  trailer: { plural: "Trailers", singular: "Trailer", path: "trailers", blurb: "Trailers and cajas", section: "Fleet" },
  driver: { plural: "Drivers", singular: "Driver", path: "drivers", blurb: "B-1, CDL, dual; licenses, FAST, I-94", section: "Fleet" },
  customer: { plural: "Customers & brokers", singular: "Customer", path: "customers", blurb: "Who pays, terms, tracking requirements", section: "Partners" },
  carrier: { plural: "Carriers", singular: "Carrier", path: "carriers", blurb: "Mexican and US partner carriers", section: "Partners" },
  carrierRate: { plural: "Carrier rates", singular: "Carrier rate", path: "carrier-rates", blurb: "Lane rates you pay carriers", section: "Partners" },
  customsBroker: { plural: "Customs brokers", singular: "Customs broker", path: "customs-brokers", blurb: "Agentes aduanales and US brokers", section: "Partners" },
  documentType: { plural: "Document types", singular: "Document type", path: "document-types", blurb: "What must be on file and when it blocks", section: "Rules" },
  ediPartner: { plural: "EDI partners", singular: "EDI partner", path: "edi-partners", blurb: "204 tenders in, 214 status and 210 invoices out", section: "Partners" },
};

export const kindByPath = (path: string): RecordKind | null => (Object.keys(KIND_META) as RecordKind[]).find((k) => KIND_META[k].path === path) ?? null;

/** Coerce a flat string map (form or CSV row) into typed values for the repository. Returns errors by field. */
export function coerce(kind: RecordKind, raw: Record<string, string | undefined | null>, opts: { partial?: boolean } = {}) {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const present = Object.prototype.hasOwnProperty.call(raw, f.name);
    if (!present && opts.partial) continue;
    if (!present && f.type === "boolean") continue; // a checkbox the form did not show keeps the database default (quick-add)
    const v = (raw[f.name] ?? "").toString().trim();
    if (f.type === "password") {
      // never a column: the action hashes raw.password itself. Required on create, "blank keeps it" on edit.
      if (!v && f.required && !opts.partial) errors[f.name] = `${f.label} is required`;
      else if (v && v.length < 10) errors[f.name] = `${f.label} needs at least 10 characters`;
      continue;
    }
    if (!v) {
      if (f.required && !opts.partial) errors[f.name] = `${f.label} is required`;
      else if (f.type === "boolean") values[f.name] = false;
      else if (f.type === "select") continue; // selects have DB defaults; an empty one is "leave it"
      else if (opts.partial && present) values[f.name] = f.type === "contacts" ? [] : null; // clearing a field on the record screen
      continue; // on create, leave the column out so the database default applies
    }
    switch (f.type) {
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[f.name] = `${f.label} must be a number`;
        else values[f.name] = Math.trunc(n);
        break;
      }
      case "cents": {
        const n = Number(v.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n)) errors[f.name] = `${f.label} must be an amount`;
        else values[f.name] = Math.round(n * 100);
        break;
      }
      case "date": {
        const d = parseDate(v);
        if (!d) errors[f.name] = `${f.label}: use YYYY-MM-DD or MM/DD/YYYY`;
        else values[f.name] = d;
        break;
      }
      case "boolean":
        values[f.name] = ["1", "true", "yes", "y", "on", "x", "si", "sí"].includes(v.toLowerCase());
        break;
      case "select": {
        const opt = f.options?.find((o) => o.value === v || o.label.toLowerCase() === v.toLowerCase());
        if (!opt) errors[f.name] = `${f.label}: "${v}" is not one of ${f.options?.map((o) => o.label).join(", ")}`;
        else values[f.name] = opt.value || null;
        break;
      }
      case "email":
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors[f.name] = `${f.label} is not a valid email`;
        else values[f.name] = v.toLowerCase();
        break;
      case "list": {
        const parts = v.toLowerCase() === "none" ? [] : (v.startsWith("[") ? (JSON.parse(v) as unknown[]).map(String) : v.split(/[,;\n]/)).map((x) => x.trim()).filter(Boolean);
        if (f.listOf === "number") {
          const nums = parts.map(Number);
          if (nums.some((n) => !Number.isFinite(n))) errors[f.name] = `${f.label}: numbers separated by commas`;
          else values[f.name] = nums;
        } else if (f.listOf === "text") values[f.name] = parts;
        else values[f.name] = parts.map((x) => x.toUpperCase().replace(/[^A-Z0-9_]+/g, "_"));
        break;
      }
      case "address": {
        try {
          values[f.name] = v.startsWith("{") ? JSON.parse(v) : parseAddress(v);
        } catch {
          errors[f.name] = `${f.label} could not be read`;
        }
        break;
      }
      case "contacts": {
        // one per line: Name | role | email | phone | WhatsApp  (JSON accepted from imports)
        try {
          const list: Contact[] = v.startsWith("[")
            ? (JSON.parse(v) as Contact[])
            : v
                .split(/\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [name, role, email, phone, whatsapp] = line.split("|").map((x) => x.trim());
                  return { name, role: role || undefined, email: email || undefined, phone: phone || undefined, whatsapp: whatsapp || undefined };
                });
          const bad = list.find((c) => !c.name || (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)));
          if (bad) errors[f.name] = bad.name ? `${f.label}: "${bad.email}" is not a valid email` : `${f.label}: every contact needs a name`;
          else values[f.name] = list;
        } catch {
          errors[f.name] = `${f.label} could not be read`;
        }
        break;
      }
      default:
        values[f.name] = v;
    }
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

export function parseDate(v: string): Date | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return utc(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function utc(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** "line1, city, ST 12345, US" → address object. Good enough for quick-add and imports; the record screen has separate boxes. */
export function parseAddress(v: string) {
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  const out: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string } = {};
  if (parts.length === 1) return { line1: parts[0] };
  out.line1 = parts[0];
  out.city = parts[1];
  if (parts[2]) {
    const m = parts[2].match(/^([A-Za-z.]+)\s*([\w-]+)?$/);
    if (m) {
      out.state = m[1];
      out.postalCode = m[2];
    } else out.state = parts[2];
  }
  if (parts[3]) out.country = parts[3].toUpperCase();
  return out;
}

export function formatCents(c: number | null | undefined, currency = "USD") {
  if (c == null) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(c / 100);
}

export function formatDate(d: Date | string | null | undefined) {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fieldDisplay(f: Field, value: unknown, refs?: Map<string, string>): string {
  if (value == null || value === "") return "";
  switch (f.type) {
    case "cents":
      return formatCents(value as number);
    case "date":
      return formatDate(value as Date);
    case "boolean":
      return value ? "Yes" : "No";
    case "select":
      return f.options?.find((o) => o.value === value)?.label ?? String(value);
    case "ref":
      return refs?.get(String(value)) ?? String(value);
    case "address": {
      const a = value as { line1?: string; city?: string; state?: string; postalCode?: string; country?: string };
      return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");
    }
    case "list":
      return Array.isArray(value) ? (value.length ? value.join(", ") : "none") : String(value);
    case "contacts":
      return Array.isArray(value) ? (value as Contact[]).map((c) => [c.name, c.role ?? "", c.email ?? "", c.phone ?? "", c.whatsapp ?? ""].join(" | ").replace(/( \| )+$/, "")).join("\n") : String(value);
    default:
      return String(value);
  }
}
