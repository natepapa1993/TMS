import Papa from "papaparse";
import { FIELDS, coerce, type Field } from "./fields";
import { create, update, findByUniqueKey, list, REGISTRY, validateRecord, phoneKey, type RecordKind } from "./records";
import { db } from "@/db/client";
import { importJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";

/**
 * CSV import (spec §1.3): paste or upload → auto-map headers → preview every row with its
 * problems → commit. Rows that match the unique key update instead of duplicating.
 */

export type ImportPreview = {
  headers: string[];
  mapping: Record<string, string>; // csv header → field name ("" = ignore)
  rows: { row: number; raw: Record<string, string>; values: Record<string, unknown>; errors: Record<string, string>; action: "insert" | "update" | "skip"; label: string }[];
  summary: { total: number; insert: number; update: number; skip: number };
};

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

/**
 * What trucking spreadsheets call things (owner report #4): "CDL #" is the licence number, "Cell" the
 * phone, "Truck" the unit the driver is in, "Med Card Exp" the medical card. Headers are compared with
 * punctuation, case and accents taken off.
 */
const SYNONYMS: Partial<Record<RecordKind, Record<string, string[]>>> = {
  driver: {
    licenseNumber: ["cdl", "cdlno", "cdlnumber", "cdlnum", "cdllicense", "license", "licence", "licenseno", "licenceno", "licensenumber", "licencenumber", "licenseid", "dl", "dlno", "dlnumber", "driverslicense", "driverlicense"],
    licenseExpires: ["cdlexp", "cdlexpires", "cdlexpiration", "cdlexpdate", "licenseexp", "licenceexp", "licenseexpiration", "licenceexpiry", "dlexp", "expdate", "expiration", "expires", "expirationdate"],
    licenseState: ["cdlstate", "licensestate", "dlstate", "issuingstate"],
    licenseClass: ["cdlclass", "licenseclass"],
    medicalExpires: ["medcard", "medcardexp", "medcardexpires", "medcardexpiration", "medicalcard", "medicalcardexp", "medicalexp", "medicalexpiration", "medexp", "dotmedical", "dotphysical", "physicalexp"],
    phone: ["cell", "cellphone", "cellular", "celular", "mobile", "mobilephone", "phoneno", "phonenumber", "tel", "telephone", "telefono"],
    whatsapp: ["wa", "whatsappno", "whatsappnumber"],
    currentTruckId: ["truck", "truckno", "truckid", "trucknumber", "unit", "unitno", "unitid", "unitnumber", "tractor", "tractorno", "currentunit", "currenttruck", "assignedtruck", "assignedunit"],
    hireDate: ["hired", "datehired", "hiredate", "startdate"],
    mxLicenseNumber: ["licenciafederal", "licenciafederalno", "mxlicense", "mxlicence"],
    fastNumber: ["fast", "fastcard", "fastno", "fastcardno"],
  },
  truck: {
    unitNumber: ["truck", "truckno", "trucknumber", "unit", "unitno", "unitnumber", "tractor", "tractorno", "tractornumber", "truckid"],
    vin: ["vinno", "vinnumber", "serial"],
    usPlate: ["plate", "plateno", "platenumber", "license", "licenseplate", "tag"],
  },
  trailer: {
    unitNumber: ["trailer", "trailerno", "trailernumber", "caja", "cajano", "unit", "unitno"],
  },
};

/**
 * Guess which field each CSV header means: exact label or name first, then the trucking synonyms, then
 * "contains" — but never by a partial guess into a yes/no field ("CDL #" is not "Non-domiciled CDL").
 */
export function autoMap(kind: RecordKind, headers: string[]): Record<string, string> {
  const fields = FIELDS[kind];
  const syn = SYNONYMS[kind] ?? {};
  const out: Record<string, string> = {};
  const used = new Set<string>();
  const pick = (h: string, f: Field) => {
    out[h] = f.name;
    used.add(f.name);
  };
  for (const h of headers) {
    const n = norm(h);
    const exact = fields.find((f) => !used.has(f.name) && (norm(f.label) === n || norm(f.name) === n));
    if (exact) pick(h, exact);
  }
  for (const h of headers) {
    if (out[h]) continue;
    const n = norm(h);
    const name = Object.entries(syn).find(([field, alts]) => !used.has(field) && alts.includes(n))?.[0];
    const f = name ? fields.find((x) => x.name === name) : undefined;
    if (f) pick(h, f);
  }
  for (const h of headers) {
    if (out[h]) continue;
    const n = norm(h);
    const partial = fields.find((f) => !used.has(f.name) && f.type !== "boolean" && n.length >= 3 && (norm(f.label).includes(n) || n.includes(norm(f.label)) || n.includes(norm(f.name))));
    if (partial) pick(h, partial);
    else out[h] = "";
  }
  return out;
}

/**
 * A reference column names the record the way people do — unit "101", customer "RXO" — so the import
 * finds it (by id, or by its label: a truck's unit number, a customer's name). One it can't find is an
 * error on that row, never text stored in an id column (owner report #5).
 */
async function resolveRefs(ctx: Ctx, kind: RecordKind, values: Record<string, unknown>, errors: Record<string, string>, cache: Map<string, { id: string; label: string }[]>) {
  for (const f of FIELDS[kind]) {
    if (f.type !== "ref" || !f.ref) continue;
    const v = values[f.name];
    if (v == null || v === "") continue;
    const want = String(v).trim();
    let rows = cache.get(f.ref);
    if (!rows) {
      const lf = REGISTRY[f.ref].labelField;
      rows = (await list(ctx, f.ref, { limit: 5000 })).map((r) => ({ id: r.id, label: String(r[lf] ?? "") }));
      cache.set(f.ref, rows);
    }
    const hit = rows.find((r) => r.id === want) ?? rows.find((r) => norm(r.label) === norm(want));
    if (hit) values[f.name] = hit.id;
    else {
      errors[f.name] = `${f.label}: no ${REGISTRY[f.ref].label.toLowerCase()} "${want}" on file`;
      delete values[f.name];
    }
  }
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const headers = res.meta.fields ?? [];
  return { headers, rows: res.data };
}

export async function previewImport(ctx: Ctx, kind: RecordKind, text: string, mapping?: Record<string, string>): Promise<ImportPreview> {
  assertCtx(ctx);
  requirePermission(ctx, "records.create");
  const { headers, rows } = parseCsv(text);
  const map = mapping ?? autoMap(kind, headers);
  const reg = REGISTRY[kind];
  const out: ImportPreview["rows"] = [];
  const seenKeys = new Set<string>();
  const refCache = new Map<string, { id: string; label: string }[]>();
  const seenPhones = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const raw: Record<string, string> = {};
    for (const h of headers) if (map[h]) raw[map[h]] = rows[i][h] ?? "";
    const { values, errors } = coerce(kind, raw);
    await resolveRefs(ctx, kind, values, errors, refCache);
    // one phone per driver: two drivers on one number would get each other's WhatsApp (M23)
    if (kind === "driver" && typeof values.phone === "string" && values.phone) {
      const digits = phoneKey(values.phone);
      const earlier = seenPhones.get(digits);
      if (earlier) errors.phone = `Phone ${values.phone} is already on ${earlier} in this file — each driver needs their own number`;
      else seenPhones.set(digits, String(values.name ?? raw.name ?? `row ${i + 2}`));
    }
    const keyVals: Record<string, unknown> = {};
    for (const k of reg.uniqueKey) if (values[k] != null && values[k] !== "") keyVals[k] = values[k];
    const keyStr = JSON.stringify(keyVals);
    let action: "insert" | "update" | "skip" = "insert";
    let existingId: string | undefined;
    if (Object.keys(errors).length) action = "skip";
    else if (Object.keys(keyVals).length) {
      if (seenKeys.has(keyStr)) {
        action = "skip";
        errors._row = "duplicate of an earlier row in this file";
      } else {
        const found = await findByUniqueKey(ctx, kind, keyVals);
        if (found) {
          action = "update";
          existingId = found.id;
        }
      }
      seenKeys.add(keyStr);
    }
    if (action !== "skip") {
      try {
        await validateRecord(ctx, kind, values, existingId);
      } catch (e) {
        action = "skip";
        errors[(e as { field?: string }).field ?? "_row"] = (e as Error).message;
      }
    }
    const label = String(values[reg.labelField] ?? raw[reg.labelField] ?? `row ${i + 2}`);
    out.push({ row: i + 2, raw, values, errors, action, label });
  }
  return {
    headers,
    mapping: map,
    rows: out,
    summary: { total: out.length, insert: out.filter((r) => r.action === "insert").length, update: out.filter((r) => r.action === "update").length, skip: out.filter((r) => r.action === "skip").length },
  };
}

export async function commitImport(ctx: Ctx, kind: RecordKind, fileName: string, text: string, mapping?: Record<string, string>) {
  assertCtx(ctx);
  requirePermission(ctx, "records.create");
  const preview = await previewImport(ctx, kind, text, mapping);
  const reg = REGISTRY[kind];
  const jobId = newId();
  let inserted = 0;
  let updated = 0;
  const errors: { row: number; message: string }[] = [];
  for (const r of preview.rows) {
    if (r.action === "skip") {
      errors.push({ row: r.row, message: Object.values(r.errors).join("; ") });
      continue;
    }
    try {
      if (r.action === "update") {
        const keyVals: Record<string, unknown> = {};
        for (const k of reg.uniqueKey) if (r.values[k] != null) keyVals[k] = r.values[k];
        const existing = (await findByUniqueKey(ctx, kind, keyVals))!;
        const nonEmpty: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.values)) if (v !== null && v !== "") nonEmpty[k] = v;
        await update(ctx, kind, existing.id, nonEmpty);
        updated++;
      } else {
        await create(ctx, kind, r.values);
        inserted++;
      }
    } catch (e) {
      errors.push({ row: r.row, message: (e as Error).message });
    }
  }
  await db.insert(importJobs).values({
    id: jobId,
    tenantId: ctx.tenantId,
    entity: kind,
    fileName,
    mapping: preview.mapping,
    rowCount: preview.rows.length,
    insertedCount: inserted,
    updatedCount: updated,
    skippedCount: errors.length,
    errors,
    status: "committed",
    createdBy: ctx.userId,
  });
  await writeAudit(db, ctx, "import", jobId, "import", undefined, `${kind}: ${inserted} added, ${updated} updated, ${errors.length} skipped from ${fileName}`);
  return { jobId, inserted, updated, errors };
}

/** A CSV template with one header row and one example row, for the "download template" button. */
export function csvTemplate(kind: RecordKind) {
  const fields = FIELDS[kind].filter((f) => f.type !== "address" || true);
  const header = fields.map((f) => f.label);
  const example = fields.map((f) => {
    if (f.placeholder) return f.placeholder;
    switch (f.type) {
      case "date":
        return "2027-01-31";
      case "boolean":
        return "no";
      case "number":
        return "0";
      case "cents":
        return "1250.00";
      case "select":
        return f.options?.find((o) => o.value)?.label ?? "";
      case "address":
        return "123 Main St, Laredo, TX 78045, US";
      default:
        return "";
    }
  });
  return Papa.unparse([header, example]);
}
