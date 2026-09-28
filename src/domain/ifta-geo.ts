import JUR from "@/data/geo/jurisdictions.json";
import { haversineMiles } from "@/lib/geo";

/**
 * Which state, province or country a point is in, from simplified Natural Earth boundaries (public
 * domain, 1:50m, ~1 km precision): US states and Canadian provinces by postal code, Mexico as "MX".
 * Good for splitting miles between jurisdictions; a point within a kilometre of a line can land on
 * either side.
 */

type Ring = number[][];
type J = { code: string; country: string; ifta: boolean; bbox: number[]; polygons: Ring[][] };
const LIST = JUR as unknown as J[];

/** IFTA member jurisdictions (the 48 contiguous states and the 10 provinces); AK, HI, DC, the territories and Mexico are not. */
export const IFTA_MEMBERS = new Set(LIST.filter((j) => j.ifta).map((j) => j.code));
export const JURISDICTION_COUNTRY: Record<string, string> = Object.fromEntries(LIST.map((j) => [j.code, j.country]));

function inRing(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The jurisdiction code at a point, or null (offshore, or outside the US, Canada and Mexico). */
export function jurisdictionAt(lat: number, lng: number): string | null {
  for (const j of LIST) {
    const [x0, y0, x1, y1] = j.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    for (const poly of j.polygons) {
      if (!inRing(lng, lat, poly[0])) continue;
      if (poly.slice(1).some((hole) => inRing(lng, lat, hole))) continue;
      return j.code;
    }
  }
  return null;
}

/**
 * Split `miles` driven from a to b between the jurisdictions the straight line crosses, sampling it
 * every few miles. Points that land nowhere (a lake, a river mouth) take the jurisdiction of the
 * nearest sample that landed somewhere.
 */
export function splitSegment(a: { lat: number; lng: number }, b: { lat: number; lng: number }, miles: number): Record<string, number> {
  const straight = haversineMiles(a, b);
  const n = Math.max(2, Math.min(400, Math.ceil(straight / 3)));
  const codes: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    codes.push(jurisdictionAt(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t));
  }
  // fill gaps from the nearest known sample
  for (let i = 0; i < n; i++) {
    if (codes[i]) continue;
    for (let d = 1; d < n; d++) {
      const c = codes[i - d] ?? codes[i + d];
      if (c) {
        codes[i] = c;
        break;
      }
    }
  }
  const out: Record<string, number> = {};
  for (const c of codes) out[c ?? "??"] = (out[c ?? "??"] ?? 0) + miles / n;
  return out;
}

/** Normalize what people type for a jurisdiction ("Texas", "tx", "Ontario", "Nuevo León") to its code; a Mexican country wins ("NL" in Mexico is Nuevo León, not Newfoundland). */
export function jurisdictionCode(v: string | null | undefined, country?: string | null): string | null {
  if (["MX", "MEX", "MEXICO", "MÉXICO"].includes((country ?? "").trim().toUpperCase())) return "MX";
  if (!v) return null;
  const s = v
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  if (!s) return null;
  if (JURISDICTION_COUNTRY[s]) return s;
  const byName: Record<string, string> = NAMES;
  if (byName[s]) return byName[s];
  if (["MEXICO", "MEX", "MX"].includes(s) || MX_STATES.has(s)) return "MX";
  return null;
}

const NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
  ALBERTA: "AB", "BRITISH COLUMBIA": "BC", MANITOBA: "MB", "NEW BRUNSWICK": "NB", "NEWFOUNDLAND AND LABRADOR": "NL", NEWFOUNDLAND: "NL", "NOVA SCOTIA": "NS", ONTARIO: "ON", "PRINCE EDWARD ISLAND": "PE", QUEBEC: "QC", SASKATCHEWAN: "SK", "NORTHWEST TERRITORIES": "NT", NUNAVUT: "NU", YUKON: "YT",
};
const MX_STATES = new Set(["NL", "NUEVO LEON", "COAHUILA", "COAH", "TAMAULIPAS", "TAMPS", "TAM", "CHIHUAHUA", "CHIH", "SONORA", "SON", "BAJA CALIFORNIA", "BCN", "JALISCO", "JAL", "GUANAJUATO", "GTO", "QUERETARO", "QRO", "SAN LUIS POTOSI", "SLP", "ESTADO DE MEXICO", "EDOMEX", "CDMX", "CIUDAD DE MEXICO", "PUEBLA", "PUE", "AGUASCALIENTES", "AGS", "ZACATECAS", "ZAC", "DURANGO", "DGO", "SINALOA", "SIN", "VERACRUZ", "VER", "HIDALGO", "HGO", "MICHOACAN", "MICH", "MORELOS", "MOR", "TLAXCALA", "TLAX"]);
