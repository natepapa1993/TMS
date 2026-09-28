import Papa from "papaparse";
import { IFTA_MEMBERS } from "./ifta-geo";

/**
 * The quarterly IFTA tax rate matrix, read from the CSV IFTA, Inc. publishes (owner #21), so nobody types 58
 * rates by hand. No network: the owner downloads the file and drops it here.
 *
 * The published matrix has one line per jurisdiction per unit: a "U.S./Gal" line and a "Can./Liter" line,
 * with a column per fuel type (Gasoline, Special Diesel, Gasohol, Propane, …). A jurisdiction that charges a
 * surcharge has an extra "Surcharge" line. Names may be spelled out ("Kentucky") or coded ("KY"), and rates may
 * carry footnote marks ("0.2460*"). We take the diesel column in US $ per gallon; the Canadian litre lines only
 * back it up. A plain sheet "jurisdiction, rate, surcharge" works too.
 */

export const JURISDICTION_NAMES: Record<string, string> = {
  ALABAMA: "AL", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
  ALBERTA: "AB", "BRITISH COLUMBIA": "BC", MANITOBA: "MB", "NEW BRUNSWICK": "NB", NEWFOUNDLAND: "NL", "NEWFOUNDLAND AND LABRADOR": "NL", "NOVA SCOTIA": "NS", ONTARIO: "ON", "PRINCE EDWARD ISLAND": "PE", QUEBEC: "QC", "QUÉBEC": "QC", SASKATCHEWAN: "SK",
};

export type MatrixRow = { jurisdiction: string; rate: number; surcharge: number | null; line: number };
export type MatrixSkip = { line: number; text: string; reason: string };
export type MatrixParse = { column: string; rows: MatrixRow[]; skipped: MatrixSkip[]; warnings: string[] };

/** "Kentucky", "KY", "KY*", "Kentucky Surcharge", "#KY" → "KY"; anything else → null. */
export function matrixJurisdiction(cell: string): string | null {
  const raw = cell
    .toUpperCase()
    .replace(/SURCHARGE/g, "")
    .replace(/[*#†‡\d()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return null;
  if (/^[A-Z]{2}$/.test(raw) && IFTA_MEMBERS.has(raw)) return raw;
  if (JURISDICTION_NAMES[raw]) return JURISDICTION_NAMES[raw];
  // "AL - Alabama", "Alabama (AL)"
  const code = raw.split(/[\s\-–,/]+/).find((w) => /^[A-Z]{2}$/.test(w) && IFTA_MEMBERS.has(w));
  if (code) return code;
  const name = Object.keys(JURISDICTION_NAMES).find((n) => raw.startsWith(n + " ") || raw.endsWith(" " + n));
  return name ? JURISDICTION_NAMES[name] : null;
}

/** "$0.2900*" → 0.29; blank or text → null. */
export function rateNumber(cell: string | undefined | null): number | null {
  if (cell == null) return null;
  const t = String(cell).replace(/[$*#†‡,\s]/g, "");
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (cells: string[]): "gal" | "liter" | null => {
  const t = cells.join(" ").toLowerCase();
  if (/lit(er|re)|can\.?\s*\$?\s*\//.test(t)) return "liter";
  if (/gal|u\.?\s*s\.?\s*\$?\s*\//.test(t)) return "gal";
  return null;
};

export function parseRateMatrix(text: string): MatrixParse {
  const grid = (Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: false }).data ?? []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : []));
  const warnings: string[] = [];
  const skipped: MatrixSkip[] = [];
  // the header: the line that names a diesel column (the matrix), else one that names a rate column (a plain sheet)
  let head = grid.findIndex((r) => r.some((c) => /diesel/i.test(c)));
  let col = head >= 0 ? grid[head].findIndex((c) => /special\s*diesel/i.test(c)) : -1;
  if (head >= 0 && col < 0) col = grid[head].findIndex((c) => /diesel/i.test(c) && !/bio/i.test(c));
  if (head < 0) {
    head = grid.findIndex((r) => r.some((c) => /^(tax\s*)?rate\b/i.test(c)));
    col = head >= 0 ? grid[head].findIndex((c) => /^(tax\s*)?rate\b/i.test(c)) : -1;
  }
  if (head < 0 || col < 0) {
    // no header at all: "TX,0.20" lines
    head = -1;
    col = 1;
  }
  const header = head >= 0 ? grid[head] : [];
  const column = head >= 0 ? header[col] : "rate (2nd column)";
  let jCol = header.findIndex((c) => /jurisdiction|state|province/i.test(c));
  if (jCol < 0) jCol = 0;
  const sCol = header.findIndex((c) => /surcharge/i.test(c));
  const found = new Map<string, MatrixRow>();
  const surcharges = new Map<string, number>();
  const litreOnly = new Set<string>();
  let current: string | null = null;
  for (let i = head + 1; i < grid.length; i++) {
    const cells = grid[i];
    const line = i + 1;
    if (!cells.some((c) => c)) continue;
    const text = cells.filter(Boolean).join(", ").slice(0, 120);
    const jCell = cells[jCol] ?? "";
    const code = matrixJurisdiction(jCell);
    const isSurcharge = cells.some((c) => /surcharge/i.test(c));
    if (code) current = code;
    else if (jCell && !/^(u\.?s|can)/i.test(jCell)) {
      // a title, a footnote or a jurisdiction that is not in IFTA
      if (rateNumber(cells[col]) != null) skipped.push({ line, text, reason: `"${jCell}" is not an IFTA jurisdiction` });
      current = null;
      continue;
    }
    const j = code ?? current;
    if (!j) continue;
    const unit = unitOf(cells.filter((_, k) => k !== col)) ?? (code ? "gal" : null);
    const value = rateNumber(cells[col]);
    if (isSurcharge) {
      if (unit === "liter") continue;
      if (value != null) surcharges.set(j, value);
      continue;
    }
    if (unit === "liter") {
      if (!found.has(j)) litreOnly.add(j);
      continue;
    }
    if (value == null) {
      skipped.push({ line, text, reason: `no ${column} rate for ${j}` });
      continue;
    }
    if (value < 0 || value > 3) {
      skipped.push({ line, text, reason: `${j}: ${value} is not a rate in $ per gallon` });
      continue;
    }
    if (found.has(j)) {
      warnings.push(`${j} appears twice; kept line ${found.get(j)!.line} (${found.get(j)!.rate.toFixed(4)})`);
      continue;
    }
    const sur = sCol >= 0 ? rateNumber(cells[sCol]) : null;
    found.set(j, { jurisdiction: j, rate: value, surcharge: sur && sur > 0 ? sur : null, line });
    litreOnly.delete(j);
  }
  for (const [j, v] of surcharges) {
    const r = found.get(j);
    if (r && v > 0) r.surcharge = v;
  }
  for (const j of litreOnly) if (!found.has(j)) skipped.push({ line: 0, text: j, reason: `${j}: only a Canadian $ per litre line — no US $ per gallon rate` });
  return { column, rows: [...found.values()].sort((p, q) => p.jurisdiction.localeCompare(q.jurisdiction)), skipped, warnings };
}
