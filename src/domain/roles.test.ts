// Features: F-1.5 F-21.5 F-9
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { PermissionError, type Ctx } from "@/lib/context";
import { iftaReport, addTripMiles } from "./ifta";
import { dashboard, breakdown } from "./reports";
import { create } from "@/data/records";
import { moneyVisible, canSeeMoney, setHideMoneyFromDispatch, hideMoneyFromDispatch } from "./money-visibility";

// Role scope (safety #23, #37; owner #18): Safety runs IFTA, reports are the owner's and billing's, the owner can hide money from dispatchers

let owner: Ctx;
const as = (role: Ctx["role"]) => ({ ...owner, role }) as Ctx;
const period = { from: "2026-09-01", to: "2026-09-30" };

beforeEach(async () => {
  await truncateAll();
  owner = await makeTenant("Roles Co");
});

describe("who sees what", () => {
  it("Safety opens and works the IFTA return; the Mexico office doesn't", async () => {
    const t = await create(owner, "truck", { unitNumber: "301" });
    await expect(iftaReport(as("compliance"), "2026Q3")).resolves.toBeTruthy();
    await addTripMiles(as("compliance"), { truckId: t.id, date: "2026-09-10", jurisdiction: "TX", miles: 120 });
    await expect(iftaReport(as("mx_office"), "2026Q3")).rejects.toBeInstanceOf(PermissionError);
    await expect(addTripMiles(as("dispatcher"), { truckId: t.id, date: "2026-09-10", jurisdiction: "TX", miles: 1 })).rejects.toBeInstanceOf(PermissionError);
  });

  it("revenue and margin reports are for the owner and billing only", async () => {
    await expect(dashboard(owner, period)).resolves.toBeTruthy();
    await expect(dashboard(as("billing"), period)).resolves.toBeTruthy();
    for (const role of ["compliance", "dispatcher", "mx_office"] as const) {
      await expect(dashboard(as(role), period)).rejects.toBeInstanceOf(PermissionError);
      await expect(breakdown(as(role), "truck", period)).rejects.toBeInstanceOf(PermissionError);
    }
  });

  it("'Hide money from dispatchers': only the owner turns it on; only dispatchers stop seeing money", async () => {
    expect(await canSeeMoney(as("dispatcher"))).toBe(true);
    await expect(setHideMoneyFromDispatch(as("dispatcher"), true)).rejects.toBeInstanceOf(PermissionError);
    await expect(setHideMoneyFromDispatch(as("compliance"), true)).rejects.toBeInstanceOf(PermissionError);
    await setHideMoneyFromDispatch(owner, true);
    expect(await hideMoneyFromDispatch(owner)).toBe(true);
    expect(await canSeeMoney(as("dispatcher"))).toBe(false);
    for (const role of ["owner", "billing", "compliance"] as const) expect(await canSeeMoney(as(role))).toBe(true);
    expect(moneyVisible("dispatcher", { hideMoneyFromDispatch: false })).toBe(true);
    expect(moneyVisible("dispatcher", null)).toBe(true);
  });
});
