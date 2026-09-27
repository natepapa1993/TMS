import type { LegType } from "@/db/schema";

/**
 * Eligibility engine, Plan §7 / spec §6.5, §11.7. Pure function: give it the leg and the
 * candidates, get back green / red with reasons. Hard blocks can never be overridden.
 */

export type DriverLike = {
  id: string;
  name: string;
  driverType: "B1" | "CDL" | "DUAL" | string;
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
  dotInspectionExpires?: Date | null;
  status?: string; // active | oos
};

export type Finding = { level: "red" | "yellow"; code: string; message: string; overridable: boolean };

const expired = (d?: Date | null, now = new Date()) => !!d && d.getTime() < now.getTime();

export function checkDriver(driver: DriverLike, legType: LegType, now = new Date()): Finding[] {
  const f: Finding[] = [];
  const t = driver.driverType;
  if (driver.status && driver.status !== "active") f.push({ level: "red", code: "driver_inactive", message: `${driver.name} is ${driver.status}`, overridable: false });

  // Cabotage: a B-1 driver may only run MX legs and the crossing. No override, ever (spec §11.7).
  if (t === "B1" && (legType === "us" || legType === "domestic")) f.push({ level: "red", code: "b1_domestic", message: `${driver.name} is B-1: cannot run a US leg`, overridable: false });
  if (t === "CDL" && legType === "mx") f.push({ level: "red", code: "cdl_mexico", message: `${driver.name} holds a US CDL only: cannot run interior Mexico`, overridable: true });

  if (legType === "us" || legType === "domestic" || legType === "crossing") {
    if (expired(driver.licenseExpires, now)) f.push({ level: "red", code: "license_expired", message: `${driver.name}: licence expired`, overridable: false });
    if (expired(driver.medicalExpires, now)) f.push({ level: "red", code: "medical_expired", message: `${driver.name}: medical card expired`, overridable: false });
  }
  if (legType === "mx" || legType === "crossing") {
    if (t !== "CDL" && expired(driver.mxLicenseExpires, now)) f.push({ level: "red", code: "mx_license_expired", message: `${driver.name}: licencia federal expired`, overridable: false });
  }
  if (legType === "crossing") {
    if (expired(driver.fastExpires, now)) f.push({ level: "red", code: "fast_expired", message: `${driver.name}: FAST card expired`, overridable: false });
  }
  if (t === "B1" && expired(driver.i94Until, now)) f.push({ level: "red", code: "i94_expired", message: `${driver.name}: I-94 admit-until date passed`, overridable: false });
  if (driver.commercialZoneOnly && (legType === "us" || legType === "domestic")) f.push({ level: "red", code: "zone_only", message: `${driver.name} is limited to the border commercial zone`, overridable: false });
  return f;
}

export function checkTruck(truck: TruckLike, legType: LegType, now = new Date()): Finding[] {
  const f: Finding[] = [];
  if (truck.status === "oos") f.push({ level: "red", code: "truck_oos", message: `${truck.unitNumber} is out of service`, overridable: false });
  if (legType === "mx") {
    if (!truck.mxPlate) f.push({ level: "red", code: "no_mx_plate", message: `${truck.unitNumber} has no Mexican plate`, overridable: false });
    else if (truck.mxPlateClass === "brown") f.push({ level: "red", code: "brown_interior", message: `${truck.unitNumber} has brown plates: border zone only`, overridable: false });
  }
  if (legType === "crossing") {
    if (!truck.mxPlate) f.push({ level: "red", code: "no_mx_plate", message: `${truck.unitNumber} has no Mexican plate`, overridable: false });
    if (!truck.usPlate) f.push({ level: "red", code: "no_us_plate", message: `${truck.unitNumber} has no US plate`, overridable: false });
  }
  if (legType === "us" || legType === "domestic") {
    if (!truck.usPlate) f.push({ level: "red", code: "no_us_plate", message: `${truck.unitNumber} has no US plate`, overridable: false });
  }
  if ((legType === "mx" || legType === "crossing") && expired(truck.mxPlateExpires, now)) f.push({ level: "red", code: "mx_plate_expired", message: `${truck.unitNumber}: MX plate expired`, overridable: false });
  if ((legType === "us" || legType === "domestic" || legType === "crossing") && expired(truck.usPlateExpires, now)) f.push({ level: "red", code: "us_plate_expired", message: `${truck.unitNumber}: US plate expired`, overridable: false });
  if (expired(truck.dotInspectionExpires, now)) f.push({ level: "yellow", code: "inspection_expired", message: `${truck.unitNumber}: annual inspection expired`, overridable: true });
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
