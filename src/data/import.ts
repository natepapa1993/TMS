import Papa from "papaparse";
import { FIELDS, coerce, type Field } from "./fields";
import { create, update, findByUniqueKey, REGISTRY, type RecordKind } from "./records";
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Guess which field each CSV header means. Exact label or name match first, then contains. */
export function autoMap(kind: RecordKind, headers: string[]): Record<string, string> {
  const fields = FIELDS[kind];
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
    const partial = fields.find((f) => !used.has(f.name) && n.length >= 3 && (norm(f.label).includes(n) || n.includes(norm(f.label)) || n.includes(norm(f.name))));
    if (partial) pick(h, partial);
    else out[h] = "";
  }
  return out;
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
  for (let i = 0; i < rows.length; i++) {
    const raw: Record<string, string> = {};
    for (const h of headers) if (map[h]) raw[map[h]] = rows[i][h] ?? "";
    const { values, errors } = coerce(kind, raw);
    const keyVals: Record<string, unknown> = {};
    for (const k of reg.uniqueKey) if (values[k] != null && values[k] !== "") keyVals[k] = values[k];
    const keyStr = JSON.stringify(keyVals);
    let action: "insert" | "update" | "skip" = "insert";
    if (Object.keys(errors).length) action = "skip";
    else if (Object.keys(keyVals).length) {
      if (seenKeys.has(keyStr)) {
        action = "skip";
        errors._row = "duplicate of an earlier row in this file";
      } else if (await findByUniqueKey(ctx, kind, keyVals)) action = "update";
      seenKeys.add(keyStr);
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
