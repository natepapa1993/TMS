import type { LegType, StopType } from "@/db/schema";

/**
 * Leg templates (Plan §3). A template says how to cut an order's stops into legs.
 * `stops` describes the stop types the template expects, in order; `legs` says which stop
 * indexes each leg runs between and what type it is.
 */
export type LegTemplate = {
  key: string;
  label: string;
  description: string;
  stops: StopType[];
  legs: { type: LegType; from: number; to: number }[];
};

export const LEG_TEMPLATES: LegTemplate[] = [
  {
    key: "domestic",
    label: "Domestic",
    description: "one truck, pickup to delivery",
    stops: ["pickup", "delivery"],
    legs: [{ type: "domestic", from: 0, to: 1 }],
  },
  {
    key: "mx_crossing_us",
    label: "MX → crossing → US",
    description: "Mexican carrier to the border yard, our truck crosses to the Laredo yard, US leg to delivery",
    stops: ["pickup", "border_yard", "yard", "delivery"],
    legs: [
      { type: "mx", from: 0, to: 1 },
      { type: "crossing", from: 1, to: 2 },
      { type: "us", from: 2, to: 3 },
    ],
  },
  {
    key: "mx_crossing",
    label: "MX → crossing",
    description: "Mexican leg plus the crossing; delivery at the Laredo yard or terminal",
    stops: ["pickup", "border_yard", "yard"],
    legs: [
      { type: "mx", from: 0, to: 1 },
      { type: "crossing", from: 1, to: 2 },
    ],
  },
  {
    key: "crossing_us",
    label: "Crossing → US",
    description: "trailer already at the border yard; we cross and deliver",
    stops: ["border_yard", "yard", "delivery"],
    legs: [
      { type: "crossing", from: 0, to: 1 },
      { type: "us", from: 1, to: 2 },
    ],
  },
  {
    key: "crossing_only",
    label: "Crossing only",
    description: "border yard to the Laredo yard",
    stops: ["border_yard", "yard"],
    legs: [{ type: "crossing", from: 0, to: 1 }],
  },
  {
    key: "equipment_move",
    label: "Equipment move",
    description: "trailer only, yard to yard, no revenue",
    stops: ["yard", "yard"],
    legs: [{ type: "equipment_move", from: 0, to: 1 }],
  },
];

export const templateByKey = (key: string) => LEG_TEMPLATES.find((t) => t.key === key) ?? null;

/** Pick a template from the stops' countries when the user did not choose one. */
export function suggestTemplate(stopCountries: string[]): string {
  const first = stopCountries[0];
  const last = stopCountries[stopCountries.length - 1];
  if (first === "MX" && last === "US") return stopCountries.length >= 4 ? "mx_crossing_us" : "mx_crossing";
  if (first === "MX" && last === "MX") return "mx_crossing";
  if (first === "US" && last === "US") return "domestic";
  return "domestic";
}
