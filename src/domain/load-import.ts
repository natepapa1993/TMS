import { and, eq, isNull } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { StopType } from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { localToInstant, zoneFor } from "@/lib/time";
import { parseCsv } from "@/data/import";
import { createOrder, ValidationError, type StopInput } from "./orders";
import { normCountry } from "./zones";

/**
 * Import loads from a spreadsheet (Excel or CSV), the way other TMSs take a customer's weekly plan.
 * Two layouts, found from the headers:
 *  - one row per load: customer, rate, pickup name/city/state/country/date/time, delivery …
 *  - one row per stop: a "load" column groups the rows; each row has its stop type, place and time
 * A preview shows every load with what is wrong with it before anything is created. Times are wall-clock
 * at each stop.
 */

export type Table = { headers: string[]; rows: Record<string, string>[] };

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (v instanceof Date) {
    // Excel keeps wall-clock; exceljs hands it back as that wall-clock in UTC
    const iso = v.toISOString();
    if (iso.startsWith("1899-12-3")) return iso.slice(11, 16); // a time-only cell
    return iso.slice(11, 16) === "00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    return "";
  }
  return String(v).trim();
};

/** The first sheet of an .xlsx, or a .csv, as header → value rows. */
export async function readTable(file: { fileName: string; bytes: Buffer }): Promise<Table> {
  if (/\.csv$/i.test(file.fileName) || !/\.xlsx$/i.test(file.fileName)) {
    if (!/\.(csv|txt)$/i.test(file.fileName)) throw new ValidationError("upload an .xlsx or .csv file", "file");
    return parseCsv(file.bytes.toString("utf8"));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new ValidationError("the workbook has no sheets", "file");
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => (headers[col - 1] = cellText(c.value)));
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r: Record<string, string> = {};
    headers.forEach((h, i) => h && (r[h] = cellText(row.getCell(i + 1).value)));
    if (Object.values(r).some((v) => v)) rows.push(r);
  });
  return { headers: headers.filter(Boolean), rows };
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Header aliases → our fields. */
const ALIAS: Record<string, string[]> = {
  load: ["load", "loadno", "loadnumber", "loadid", "group", "trip", "order"],
  customer: ["customer", "billto", "broker", "customername", "cliente"],
  rate: ["rate", "linehaul", "amount", "price", "tarifa"],
  currency: ["currency", "moneda"],
  equipment: ["equipment", "trailertype", "equipo"],
  po: ["po", "ponumber", "purchaseorder"],
  reference: ["reference", "ref", "customerload", "customerref", "loadref", "pro"],
  commodity: ["commodity", "product", "freight", "mercancia"],
  weight: ["weight", "weightlb", "weightlbs", "lbs", "peso"],
  pieces: ["pieces", "pallets", "qty", "piezas"],
  notes: ["notes", "instructions", "comments", "notas"],
  stoptype: ["stoptype", "type", "tipo"],
  name: ["name", "location", "facility", "stopname"],
  address: ["address", "street", "address1", "direccion"],
  city: ["city", "ciudad"],
  state: ["state", "province", "st", "estado"],
  zip: ["zip", "postal", "postalcode", "cp"],
  country: ["country", "pais"],
  date: ["date", "fecha", "appointmentdate"],
  time: ["time", "hora", "appointmenttime", "from"],
  appointment: ["appointment", "appt", "cita"],
};
function field(headers: string[], key: string, prefix = "") {
  const want = (ALIAS[key] ?? [key]).map((a) => norm(prefix + a));
  return headers.find((h) => want.includes(norm(h))) ?? null;
}

export type PreviewLoad = { key: string; customer: string; customerId: string | null; rateCents: number | null; currency: string; equipment: string; refs: Record<string, string>; freight: { commodity: string; pieces?: number; weightLb?: number }[]; cargoNote: string | null; stops: (StopInput & { windowStart: Date | null })[]; errors: string[] };

const EQUIP: Record<string, string> = { "53": "53_dry", "53dry": "53_dry", "53van": "53_dry", dryvan: "53_dry", van: "53_dry", "53reefer": "53_reefer", reefer: "53_reefer", "48": "48_dry", "48dry": "48_dry", flatbed: "flatbed", sprinter: "sprinter", cargovan: "sprinter", straight: "straight", straighttruck: "straight", boxtruck: "straight", poweronly: "power_only" };

function parseDate(v: string): string | null {
  const t = v.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); // US m/d/y
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
function parseTime(v: string): string | null {
  const t = v.trim().toLowerCase();
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}${String(min).padStart(2, "0")}`;
}

/** Read the table into loads, find each customer, check what can be checked. Pure but for the customer lookup. */
export async function previewLoads(ctx: Ctx, table: Table): Promise<{ layout: "per_load" | "per_stop"; loads: PreviewLoad[] }> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  if (!table.rows.length) throw new ValidationError("the sheet has no rows under the headers", "file");
  if (table.rows.length > 2000) throw new ValidationError("up to 2,000 rows at a time", "file");
  const H = table.headers;
  const perStop = !!field(H, "stoptype") && !!field(H, "load");
  const [customers, tenant] = await Promise.all([
    db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), isNull(s.customers.archivedAt))),
    db.select({ zone: s.tenants.timeZone }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1),
  ]);
  const zone = tenant[0]?.zone ?? "America/Detroit";
  const get = (r: Record<string, string>, key: string, prefix = "") => {
    const h = field(H, key, prefix);
    return h ? (r[h] ?? "").trim() : "";
  };
  const stopOf = (r: Record<string, string>, type: StopType, prefix: string, errors: string[], label: string) => {
    const name = get(r, "name", prefix) || get(r, "city", prefix);
    if (!name) errors.push(`${label}: no location name`);
    const country = normCountry(get(r, "country", prefix) || "US");
    const state = get(r, "state", prefix).toUpperCase();
    const dRaw = get(r, "date", prefix);
    const tRaw = get(r, "time", prefix);
    const date = dRaw ? parseDate(dRaw) : null;
    if (dRaw && !date) errors.push(`${label}: can't read the date "${dRaw}"`);
    const hhmm = tRaw ? parseTime(tRaw) : dRaw.match(/\d{1,2}:\d{2}/) ? parseTime(dRaw.slice(dRaw.search(/\d{1,2}:\d{2}/))) : null;
    if (tRaw && !hhmm) errors.push(`${label}: can't read the time "${tRaw}"`);
    const at = date ? localToInstant(date, hhmm ?? "0000", zoneFor({ state, country }, zone)) : null;
    const address = get(r, "address", prefix) || get(r, "city", prefix) || state ? { line1: get(r, "address", prefix) || undefined, city: get(r, "city", prefix) || undefined, state: state || undefined, postalCode: get(r, "zip", prefix) || undefined, country } : null;
    return { type, name, country, address, windowStart: at, windowEnd: null, appointment: /^(y|yes|si|sí|true|1|x)$/i.test(get(r, "appointment", prefix)) } as StopInput & { windowStart: Date | null };
  };
  const common = (r: Record<string, string>, key: string, errors: string[]): Omit<PreviewLoad, "stops" | "errors"> => {
    const cName = get(r, "customer");
    const want = cName.toLowerCase();
    const cust = customers.find((c) => c.name.toLowerCase() === want) ?? customers.find((c) => want && (c.name.toLowerCase().includes(want) || want.includes(c.name.toLowerCase())));
    if (!cName) errors.push("no customer");
    else if (!cust) errors.push(`customer "${cName}" is not on file`);
    const rateRaw = get(r, "rate");
    const rate = rateRaw ? Math.round(Number(rateRaw.replace(/[$,\s]/g, "")) * 100) : null;
    if (rateRaw && !Number.isFinite(rate)) errors.push(`can't read the rate "${rateRaw}"`);
    const eq = EQUIP[norm(get(r, "equipment"))] ?? (get(r, "equipment") ? null : "53_dry");
    if (!eq) errors.push(`unknown equipment "${get(r, "equipment")}"`);
    const cur = get(r, "currency").toUpperCase();
    const commodity = get(r, "commodity");
    const weight = Number(get(r, "weight").replace(/[,\s]/g, ""));
    const pieces = Number(get(r, "pieces").replace(/[,\s]/g, ""));
    const refs: Record<string, string> = {};
    if (get(r, "po")) refs.po = get(r, "po");
    if (get(r, "reference")) refs.reference = get(r, "reference");
    return { key, customer: cust?.name ?? cName, customerId: cust?.id ?? null, rateCents: Number.isFinite(rate) ? rate : null, currency: ["USD", "MXN", "CAD"].includes(cur) ? cur : "USD", equipment: eq ?? "53_dry", refs, freight: commodity ? [{ commodity, weightLb: Number.isFinite(weight) && weight > 0 ? weight : undefined, pieces: Number.isFinite(pieces) && pieces > 0 ? pieces : undefined }] : [], cargoNote: get(r, "notes") || null };
  };

  const loads: PreviewLoad[] = [];
  if (perStop) {
    const groups = new Map<string, Record<string, string>[]>();
    for (const r of table.rows) {
      const k = get(r, "load");
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const [key, rows] of groups) {
      const errors: string[] = [];
      const head = rows.find((r) => get(r, "customer")) ?? rows[0];
      const base = common(head, key, errors);
      const stops = rows.map((r, i) => {
        const t = get(r, "stoptype").toLowerCase();
        const type: StopType = /^(p|pu|pick|pickup|recoleccion|carga)/.test(t) ? "pickup" : /^(d|del|drop|delivery|entrega|descarga)/.test(t) ? "delivery" : /border/.test(t) ? "border_yard" : /yard|patio/.test(t) ? "yard" : /trans/.test(t) ? "transload" : "delivery";
        return stopOf(r, type, "", errors, `stop ${i + 1}`);
      });
      if (!stops.some((x) => x.type === "pickup")) errors.push("no pickup");
      if (!stops.some((x) => x.type === "delivery")) errors.push("no delivery");
      loads.push({ ...base, stops, errors });
    }
  } else {
    if (!field(H, "name", "pickup") && !field(H, "city", "pickup")) throw new ValidationError("the sheet needs pickup and delivery columns (e.g. Pickup Name, Pickup City, Pickup Date, Delivery Name…), or a Load + Stop Type layout", "file");
    table.rows.forEach((r, i) => {
      const errors: string[] = [];
      const base = common(r, get(r, "load") || get(r, "reference") || `row ${i + 2}`, errors);
      const stops = [stopOf(r, "pickup", "pickup", errors, "pickup"), stopOf(r, "delivery", "delivery", errors, "delivery")];
      loads.push({ ...base, stops, errors });
    });
  }
  return { layout: perStop ? "per_stop" : "per_load", loads };
}

/** Create the loads that passed the preview; the rest are reported. */
export async function importLoads(ctx: Ctx, table: Table, opts: { book?: boolean; fileName?: string } = {}) {
  const { loads } = await previewLoads(ctx, table);
  const created: { key: string; orderNumber: string; orderId: string }[] = [];
  const skipped: { key: string; errors: string[] }[] = [];
  for (const l of loads) {
    if (l.errors.length) {
      skipped.push({ key: l.key, errors: l.errors });
      continue;
    }
    try {
      const o = await createOrder(ctx, { customerId: l.customerId, rateCents: l.rateCents, rateTbd: l.rateCents == null, currency: l.currency, equipment: l.equipment, refs: l.refs, freight: l.freight, cargoNote: l.cargoNote, stops: l.stops, book: !!opts.book && l.rateCents != null, source: "import" });
      created.push({ key: l.key, orderNumber: o.order.orderNumber, orderId: o.order.id });
    } catch (e) {
      skipped.push({ key: l.key, errors: [e instanceof Error ? e.message : String(e)] });
    }
  }
  await writeAudit(db, ctx, "order", "import", "import", undefined, `${opts.fileName ?? "sheet"}: ${created.length} created, ${skipped.length} skipped`);
  return { created, skipped };
}
