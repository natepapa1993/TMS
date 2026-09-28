/**
 * Does the equipment fit the load? (owner N8) Pure, no database. A mismatch is a warning, never a block: a
 * dry load can ride in a reefer, a dispatcher may know the Sprinter only runs the first 20 miles. It shows on
 * the truck in the assign list and as a yellow flag on the load once assigned.
 */

export const EQUIPMENT_LABEL: Record<string, string> = { "53_dry": "53' dry van", "53_reefer": "53' reefer", "48_dry": "48' dry van", flatbed: "flatbed", sprinter: "Sprinter", straight: "straight truck", power_only: "power only" };
const TRUCK_LABEL: Record<string, string> = { tractor: "tractor", sprinter: "Sprinter", straight: "straight truck", cargo_van: "cargo van" };
/** What a unit that carries the freight itself holds when its record says nothing. */
const DEFAULT_PAYLOAD_LB: Record<string, number> = { sprinter: 3500, cargo_van: 3000, straight: 10000 };
/** A trailer's payload when its record says nothing. */
const TRAILER_PAYLOAD_LB: Record<string, number> = { "53_dry": 45000, "53_reefer": 43000, "48_dry": 45000, flatbed: 48000 };
const TRAILER_LOADS = ["53_dry", "53_reefer", "48_dry", "flatbed"];

export type EquipmentLoad = { equipment: string | null; weightLb: number | null };
export type EquipmentTruck = { unitNumber: string; equipmentType: string | null; cargoLengthFt?: number | null; custom?: Record<string, unknown> | null };
export type EquipmentTrailer = { unitNumber: string; kind: string | null; lengthFt?: number | null; maxWeightLbs?: number | null };

const lb = (n: number) => `${n.toLocaleString("en-US")} lb`;

/** Plain sentences, one per mismatch; empty when the equipment fits. */
export function equipmentMismatches(load: EquipmentLoad, truck: EquipmentTruck | null, trailer: EquipmentTrailer | null): string[] {
  const out: string[] = [];
  const need = load.equipment ?? "53_dry";
  const w = load.weightLb ?? 0;
  const type = truck?.equipmentType ?? "tractor";
  const carriesItself = ["sprinter", "cargo_van", "straight"].includes(type);
  if (truck) {
    if (TRAILER_LOADS.includes(need) && carriesItself) out.push(`unit ${truck.unitNumber} is a ${TRUCK_LABEL[type] ?? type}; the load needs a ${EQUIPMENT_LABEL[need]}`);
    else if (need === "sprinter" && type === "straight") out.push(`unit ${truck.unitNumber} is a straight truck; the load is booked for a Sprinter`);
    if (carriesItself && w > 0) {
      const cap = Number((truck.custom as Record<string, unknown> | null)?.maxPayloadLbs) || DEFAULT_PAYLOAD_LB[type] || 0;
      if (cap && w > cap) out.push(`${lb(w)} is over what unit ${truck.unitNumber} carries (about ${lb(cap)})`);
    }
  }
  if (trailer && TRAILER_LOADS.includes(need)) {
    const kind = trailer.kind ?? "53_dry";
    // a reefer can haul dry freight; a dry van can't keep a reefer load cold; a flatbed is its own thing
    if (need === "53_reefer" && kind !== "53_reefer") out.push(`trailer ${trailer.unitNumber} is a ${EQUIPMENT_LABEL[kind] ?? kind}; the load needs a reefer`);
    else if (need === "flatbed" && kind !== "flatbed") out.push(`trailer ${trailer.unitNumber} is a ${EQUIPMENT_LABEL[kind] ?? kind}; the load needs a flatbed`);
    else if (need !== "flatbed" && kind === "flatbed") out.push(`trailer ${trailer.unitNumber} is a flatbed; the load needs a ${EQUIPMENT_LABEL[need]}`);
    else if (need.startsWith("53") && (kind === "48_dry" || (trailer.lengthFt != null && trailer.lengthFt < 53))) out.push(`trailer ${trailer.unitNumber} is ${trailer.lengthFt ?? 48}'; the load needs 53'`);
    const cap = trailer.maxWeightLbs ?? TRAILER_PAYLOAD_LB[kind] ?? 0;
    if (cap && w > cap) out.push(`${lb(w)} is over trailer ${trailer.unitNumber}'s ${lb(cap)}`);
  }
  return out;
}

/** The load's weight: its freight lines, else the weight on the order. */
export const loadWeight = (o: { freight?: { weightLb?: number | null }[] | null; weightLbs?: number | null }) => (o.freight ?? []).reduce((a, f) => a + (f.weightLb ?? 0), 0) || o.weightLbs || null;
