import type { LegType, StopType } from "@/db/schema";

/**
 * Where a leg runs. Cross-border here means the United States, Mexico and Canada: a leg touches one
 * or more of them, and what may legally run it (cabotage, plates, licences, authority) follows from
 * which. Legs are cut from the stops the dispatcher entered — any number, any order — never from a
 * fixed template.
 */
export const COUNTRIES = ["US", "MX", "CA"] as const;
export type Country = (typeof COUNTRIES)[number];
export const COUNTRY_LABEL: Record<Country, string> = { US: "United States", MX: "Mexico", CA: "Canada" };
/** "MX", "mex", "México", "Mexico" → MX; "CA", "CAN", "Canada", "Canadá" → CA; anything else → US. */
export const normCountry = (c: string | null | undefined): Country => {
  const v = String(c ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\./g, "");
  if (v === "MX" || v === "MEX" || v === "MEXICO") return "MX";
  if (v === "CA" || v === "CAN" || v === "CANADA") return "CA";
  return "US";
};

export type LegZone = { type: LegType; countries: Country[] };

/** Older call sites pass only a leg type; this is what each type means on its own. */
export function zoneOf(z: LegZone | LegType | string | null | undefined): LegZone {
  if (z && typeof z === "object") return z;
  switch (z) {
    case "mx":
      return { type: "mx", countries: ["MX"] };
    case "ca":
      return { type: "ca", countries: ["CA"] };
    case "crossing":
      return { type: "crossing", countries: ["MX", "US"] };
    case "us":
      return { type: "us", countries: ["US"] };
    default:
      return { type: (z as LegType) ?? "domestic", countries: ["US"] };
  }
}

export const touches = (z: LegZone, c: Country) => z.countries.includes(c);
export const onlyIn = (z: LegZone, c: Country) => z.countries.length === 1 && z.countries[0] === c;
export const crosses = (z: LegZone) => z.countries.length > 1;

/** The zone of one leg, from the stops it runs through (its first, its last and any between). */
export function legZone(leg: { type: LegType; fromStopId: string | null; toStopId: string | null }, stops: { id: string; seq: number; country: string }[]): LegZone {
  const from = stops.find((s) => s.id === leg.fromStopId);
  const to = stops.find((s) => s.id === leg.toStopId);
  if (!from || !to) return zoneOf(leg.type);
  const on = stops.filter((s) => s.seq >= from.seq && s.seq <= to.seq);
  const countries = [...new Set(on.map((s) => normCountry(s.country)))];
  return { type: leg.type, countries };
}

/** Stop types where the trailer changes hands: a leg ends there and the next begins. */
export const HANDOFF: StopType[] = ["yard", "border_yard", "transload", "terminal"];

/**
 * Cut legs from stops: a new leg starts at every hand-off stop (a yard, a border yard, a transload,
 * a terminal). A leg whose ends are in different countries is the crossing; the others are named by
 * their country — "us" when the load crosses a border somewhere, "domestic" for an all-US load.
 * Pickups and deliveries in between ride the same leg as stops on the way.
 */
export function legsFromStops(stops: { type: StopType | string; country?: string | null }[]): { type: LegType; from: number; to: number }[] {
  if (stops.length < 2) return [];
  const countries = stops.map((s) => normCountry(s.country));
  const international = new Set(countries).size > 1;
  const cuts = [0];
  for (let i = 1; i < stops.length - 1; i++) if (HANDOFF.includes(stops[i].type as StopType)) cuts.push(i);
  cuts.push(stops.length - 1);
  const legs: { type: LegType; from: number; to: number }[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const from = cuts[k];
    const to = cuts[k + 1];
    const on = new Set(countries.slice(from, to + 1));
    const type: LegType = on.size > 1 ? "crossing" : on.has("MX") ? "mx" : on.has("CA") ? "ca" : international ? "us" : "domestic";
    legs.push({ type, from, to });
  }
  return legs;
}

export const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", ca: "Canada", us: "US", domestic: "Domestic", crossing: "Crossing", equipment_move: "Equipment move" };
