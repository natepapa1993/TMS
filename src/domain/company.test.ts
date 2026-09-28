// Features: F-1.7 company settings — the dispatch number drivers and partner drivers call from their app
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { getCompany, updateCompany, tenantContact } from "./company";
import { ValidationError } from "./orders";

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
});

describe("company settings", () => {
  it("dispatch phone: blank until set, refused when it is not a number, read by the public pages, cleared with blank", async () => {
    expect((await getCompany(a)).settings.dispatchPhone).toBeNull();
    expect((await tenantContact(a.tenantId)).dispatchPhone).toBeNull();
    await expect(updateCompany(a, { dispatchPhone: "call us" })).rejects.toBeInstanceOf(ValidationError);
    await updateCompany(a, { dispatchPhone: " +1 313 555 0100 " });
    expect((await getCompany(a)).settings.dispatchPhone).toBe("+1 313 555 0100");
    expect(await tenantContact(a.tenantId)).toEqual({ name: "24:7", dispatchPhone: "+1 313 555 0100" });
    // other settings survive
    await updateCompany(a, { fuelCostCentsPerMile: 80 });
    expect((await getCompany(a)).settings).toMatchObject({ fuelCostCentsPerMile: 80, dispatchPhone: "+1 313 555 0100" });
    await updateCompany(a, { dispatchPhone: "" });
    expect((await getCompany(a)).settings.dispatchPhone).toBeNull();
  });
});
