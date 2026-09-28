// Features: F-32.25 equipment mismatch warning (owner N8): reefer load on a dry van, Sprinter for a 53' load, over weight
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { flags } from "@/db/schema";
import { createOrder, planLeg, candidatesForLeg } from "./orders";
import { equipmentMismatches, loadWeight } from "./equipment-rules";

const future = new Date(Date.now() + 365 * 86400_000);

describe("equipment fit (pure)", () => {
  const tractor = { unitNumber: "101", equipmentType: "tractor" };
  const sprinter = { unitNumber: "V1", equipmentType: "sprinter" };
  it("a reefer load on a dry van, a Sprinter for a 53' load, a 48' for a 53' load", () => {
    expect(equipmentMismatches({ equipment: "53_reefer", weightLb: 30000 }, tractor, { unitNumber: "5302", kind: "53_dry" })).toEqual(["trailer 5302 is a 53' dry van; the load needs a reefer"]);
    expect(equipmentMismatches({ equipment: "53_dry", weightLb: 38000 }, sprinter, null)).toEqual(["unit V1 is a Sprinter; the load needs a 53' dry van", "38,000 lb is over what unit V1 carries (about 3,500 lb)"]);
    expect(equipmentMismatches({ equipment: "53_dry", weightLb: 1000 }, tractor, { unitNumber: "4801", kind: "48_dry" })).toEqual(["trailer 4801 is 48'; the load needs 53'"]);
  });
  it("what fits says nothing: dry freight in a reefer, a Sprinter load in a Sprinter, no trailer yet", () => {
    expect(equipmentMismatches({ equipment: "53_dry", weightLb: 30000 }, tractor, { unitNumber: "R1", kind: "53_reefer" })).toEqual([]);
    expect(equipmentMismatches({ equipment: "sprinter", weightLb: 2000 }, sprinter, null)).toEqual([]);
    expect(equipmentMismatches({ equipment: "53_reefer", weightLb: 30000 }, tractor, null)).toEqual([]);
  });
  it("weight over what the unit or trailer carries", () => {
    expect(equipmentMismatches({ equipment: "sprinter", weightLb: 5200 }, sprinter, null)).toEqual(["5,200 lb is over what unit V1 carries (about 3,500 lb)"]);
    expect(equipmentMismatches({ equipment: "53_dry", weightLb: 46000 }, tractor, { unitNumber: "5302", kind: "53_dry", maxWeightLbs: 44000 })).toEqual(["46,000 lb is over trailer 5302's 44,000 lb"]);
    expect(loadWeight({ freight: [{ weightLb: 20000 }, { weightLb: 18000 }], weightLbs: 1 })).toBe(38000);
    expect(loadWeight({ freight: [], weightLbs: 900 })).toBe(900);
  });
});

describe("on the assign list and the load", () => {
  let a: Awaited<ReturnType<typeof makeTenant>>;
  beforeEach(async () => {
    await truncateAll();
    a = await makeTenant("Fit Carrier");
  });

  it("the Sprinter is not 'free now' without a word for a 38,000 lb dry van load; a dry trailer on a reefer load flags the load until it's fixed", async () => {
    const cust = await create(a, "customer", { name: "Bosch", kind: "customer" });
    const t101 = await create(a, "truck", { unitNumber: "101", usPlate: "MI101", usPlateExpires: future });
    const v1 = await create(a, "truck", { unitNumber: "V1", equipmentType: "sprinter", usPlate: "MIV1", usPlateExpires: future });
    const mike = await create(a, "driver", { name: "Mike Kowalski", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t101.id });
    await create(a, "driver", { name: "Tom Sprinter", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: v1.id });
    const dry = await create(a, "trailer", { unitNumber: "5302", kind: "53_dry" });
    const reefer = await create(a, "trailer", { unitNumber: "R77", kind: "53_reefer" });
    const stops = [
      { type: "pickup" as const, name: "Bosch Plymouth", country: "US", windowStart: new Date(Date.now() + 24 * 3600_000) },
      { type: "delivery" as const, name: "Bosch Laredo", country: "US", windowStart: new Date(Date.now() + 48 * 3600_000) },
    ];
    const dryLoad = await createOrder(a, { customerId: cust.id, rateCents: 300000, equipment: "53_dry", freight: [{ commodity: "Auto parts", pieces: 22, weightLb: 38000 }], stops, book: true } as never);
    const cands = await candidatesForLeg(a, dryLoad.legs[0].id);
    const sprinter = cands.find((c) => c.unitNumber === "V1")!;
    expect(sprinter.findings.map((f) => f.code)).toContain("equipment_mismatch");
    expect(sprinter.reason).toMatch(/Sprinter; the load needs a 53' dry van/);
    expect(cands.find((c) => c.unitNumber === "101")!.findings.map((f) => f.code)).not.toContain("equipment_mismatch");
    expect(cands[0].unitNumber).toBe("101"); // the one that fits ranks first

    const reeferLoad = await createOrder(a, { customerId: cust.id, rateCents: 300000, equipment: "53_reefer", stops, book: true } as never);
    const leg = reeferLoad.legs[0].id;
    const r = await planLeg(a, leg, { kind: "truck", truckId: t101.id, driverId: mike.id, trailerId: dry.id });
    expect(r.findings.map((f) => f.message)).toContain("trailer 5302 is a 53' dry van; the load needs a reefer");
    const open = async () => db.select().from(flags).where(and(eq(flags.legId, leg), eq(flags.code, "equipment_mismatch"), isNull(flags.clearedAt)));
    expect((await open()).map((f) => [f.level, f.title])).toEqual([["yellow", "Equipment: trailer 5302 is a 53' dry van; the load needs a reefer"]]);
    await planLeg(a, leg, { kind: "truck", truckId: t101.id, driverId: mike.id, trailerId: reefer.id });
    expect(await open()).toEqual([]);
  });
});
