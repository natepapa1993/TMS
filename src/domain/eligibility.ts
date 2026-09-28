import type { LegType } from "@/db/schema";
import { zoneOf, touches, onlyIn, crosses, type LegZone } from "./zones";

/**
 * Eligibility engine, Plan §7 / spec §6.5, §11.7. Pure function: give it the leg and the
 * candidates, get back green / red with reasons. Hard blocks can never be overridden.
 */

export type DriverLike = {
  id: string;
  name: string;
  driverType: "B1" | "CDL" | "CA" | "DUAL" | string;
  licenseExpires?: Date | null;
  mxLicenseExpires?: Date | null;
  medicalExpires?: Date | null;
  fastExpires?: Date | null;
  i94Until?: Date | null;
  commercialZoneOnly?: boolean;
  status?: string;
};

export type TruckLike = {
  id: string;
  unitNumber: string;
  usPlate?: string | null;
  usPlateExpires?: Date | null;
  mxPlate?: string | null;
  mxPlateClass?: string | null; // blue | brown
  mxPlateExpires?: Date | null;
  caPlate?: string | null;
  caPlateExpires?: Date | null;
  dotInspectionExpires?: Date | null;
  status?: string; // active | oos
};

export type Finding = { level: "red" | "yellow"; code: string; message: string; overridable: boolean };

const expired = (d?: Date | null, now = new Date()) => !!d && d.getTime() < now.getTime();

/**
 * Driver rules by where the leg runs (US / Mexico / Canada):
 * - cabotage: a B-1 driver never runs a leg inside the US or inside Canada; a US CDL never a leg inside
 *   Canada; a Canadian licence never a leg inside the US. No override, ever.
 * - interior Mexico needs the licencia federal (a US CDL or Canadian licence on a Mexico-only leg is an
 *   overridable red: a dual-licensed driver's paperwork may be on its way).
 * - licence and medical wherever the leg touches the US or Canada; licencia federal wherever it touches
 *   Mexico (for drivers who hold one); FAST on every border crossing; the B-1's I-94.
 */
export function checkDriver(driver: DriverLike, leg: LegZone | LegType, now = new Date()): Finding[] {
  const z = zoneOf(leg);
  const f: Finding[] = [];
  const t = driver.driverType;
  if (driver.status && driver.status !== "active") f.push({ level: "red", code: "driver_inactive", message: `${driver.name} is ${driver.status}`, overridable: false });

  if (t === "B1" && onlyIn(z, "US")) f.push({ level: "red", code: "b1_domestic", message: `${driver.name} is B-1: cannot run a US leg`, overridable: false });
  if (t === "B1" && onlyIn(z, "CA")) f.push({ level: "red", code: "b1_canada", message: `${driver.name} is B-1: cannot run a leg inside Canada`, overridable: false });
  if (t === "CDL" && onlyIn(z, "CA")) f.push({ level: "red", code: "cabotage_canada", message: `${driver.name} holds a US CDL: cannot run a leg inside Canada (cabotage)`, overridable: false });
  if (t === "CA" && onlyIn(z, "US")) f.push({ level: "red", code: "cabotage_us", message: `${driver.name} holds a Canadian licence: cannot run a leg inside the US (cabotage)`, overridable: false });
  if ((t === "CDL" || t === "CA") && onlyIn(z, "MX")) f.push({ level: "red", code: "cdl_mexico", message: `${driver.name} has no licencia federal: cannot run interior Mexico`, overridable: true });
  if (t === "B1" && touches(z, "CA")) {
    if (!onlyIn(z, "CA")) f.push({ level: "red", code: "b1_canada", message: `${driver.name} is B-1: the B-1 covers the US, not Canada`, overridable: false });
  }

  if (touches(z, "US") || touches(z, "CA")) {
    if (expired(driver.licenseExpires, now)) f.push({ level: "red", code: "license_expired", message: `${driver.name}: licence expired`, overridable: false });
    if (expired(driver.medicalExpires, now)) f.push({ level: "red", code: "medical_expired", message: `${driver.name}: medical card expired`, overridable: false });
  }
  if (touches(z, "MX") && (t === "B1" || t === "DUAL")) {
    if (expired(driver.mxLicenseExpires, now)) f.push({ level: "red", code: "mx_license_expired", message: `${driver.name}: licencia federal expired`, overridable: false });
  }
  if (crosses(z) && expired(driver.fastExpires, now)) f.push({ level: "red", code: "fast_expired", message: `${driver.name}: FAST card expired`, overridable: false });
  if (t === "B1" && expired(driver.i94Until, now)) f.push({ level: "red", code: "i94_expired", message: `${driver.name}: I-94 admit-until date passed`, overridable: false });
  if (driver.commercialZoneOnly && onlyIn(z, "US")) f.push({ level: "red", code: "zone_only", message: `${driver.name} is limited to the border commercial zone`, overridable: false });
  return f;
}

/**
 * Truck rules: a Mexican plate wherever the leg touches Mexico (brown plates never beyond the border
 * zone: no Mexico-only leg); a US or Canadian plate wherever it touches the US or Canada (IRP plates
 * from either run both); every plate it needs in date.
 */
export function checkTruck(truck: TruckLike, leg: LegZone | LegType, now = new Date()): Finding[] {
  const z = zoneOf(leg);
  const f: Finding[] = [];
  if (truck.status === "oos") f.push({ level: "red", code: "truck_oos", message: `${truck.unitNumber} is out of service`, overridable: false });
  if (touches(z, "MX")) {
    if (!truck.mxPlate) f.push({ level: "red", code: "no_mx_plate", message: `${truck.unitNumber} has no Mexican plate`, overridable: false });
    else if (truck.mxPlateClass === "brown" && onlyIn(z, "MX")) f.push({ level: "red", code: "brown_interior", message: `${truck.unitNumber} has brown plates: border zone only`, overridable: false });
    if (expired(truck.mxPlateExpires, now)) f.push({ level: "red", code: "mx_plate_expired", message: `${truck.unitNumber}: MX plate expired`, overridable: false });
  }
  if (touches(z, "US") || touches(z, "CA")) {
    if (!truck.usPlate && !truck.caPlate) f.push({ level: "red", code: "no_us_plate", message: `${truck.unitNumber} has no US or Canadian plate`, overridable: false });
    if (truck.usPlate && expired(truck.usPlateExpires, now)) f.push({ level: "red", code: "us_plate_expired", message: `${truck.unitNumber}: US plate expired`, overridable: false });
    if (truck.caPlate && expired(truck.caPlateExpires, now)) f.push({ level: "red", code: "ca_plate_expired", message: `${truck.unitNumber}: Canadian plate expired`, overridable: false });
  }
  if (expired(truck.dotInspectionExpires, now)) f.push({ level: "yellow", code: "inspection_expired", message: `${truck.unitNumber}: annual inspection expired`, overridable: true });
  return f;
}

/**
 * Carrier rules: the country a carrier is based in runs its own country and international moves in
 * and out of it; a leg entirely inside another country is cabotage (a Mexican carrier on a US or
 * Canadian leg, a US carrier inside Canada, a Canadian carrier inside the US). A Mexican carrier never
 * runs in Canada. A US or Canadian carrier inside Mexico needs Mexican authority (overridable red).
 */
export function checkCarrierZone(carrier: { name: string; country: string }, leg: LegZone | LegType): Finding[] {
  const z = zoneOf(leg);
  const c = carrier.country;
  const f: Finding[] = [];
  if (c === "MX" && onlyIn(z, "US")) f.push({ level: "red", code: "mx_carrier_us_leg", message: `${carrier.name} is a Mexican carrier: cannot run a US leg`, overridable: false });
  if (c === "MX" && touches(z, "CA")) f.push({ level: "red", code: "mx_carrier_canada", message: `${carrier.name} is a Mexican carrier: cannot run in Canada`, overridable: false });
  if (c === "US" && onlyIn(z, "CA")) f.push({ level: "red", code: "cabotage_canada", message: `${carrier.name} is a US carrier: cannot run a leg inside Canada (cabotage)`, overridable: false });
  if (c === "CA" && onlyIn(z, "US")) f.push({ level: "red", code: "cabotage_us", message: `${carrier.name} is a Canadian carrier: cannot run a leg inside the US (cabotage)`, overridable: false });
  if ((c === "US" || c === "CA") && onlyIn(z, "MX")) f.push({ level: "red", code: "foreign_carrier_mexico", message: `${carrier.name} needs Mexican authority to run inside Mexico`, overridable: true });
  return f;
}

export function summarize(findings: Finding[]) {
  const red = findings.filter((x) => x.level === "red");
  return {
    ok: red.length === 0,
    hardBlocked: red.some((x) => !x.overridable),
    findings,
  };
}
