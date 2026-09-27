// Features: F-20.4 F-20.5
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, future, buildLoad } from "./helpers";

async function driver(page: Page, name: string, unit: string) {
  await quickAdd(page, "trucks", "Add truck", { unitNumber: unit, usPlate: `TX${unit}` });
  await quickAdd(page, "drivers", "Add driver", { name, driverType: "CDL", phone: "+1 956 000 0003" });
  await page.goto("/settings/drivers");
  await page.click(`table a:has-text('${name}')`);
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: unit });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

test("planner: loads beside drivers, time off blocks, rank for a load, assign & send", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });
  await driver(page, "Daniel Reyes", "2104");
  await driver(page, "Ana Cruz", "2117");
  const num = await buildLoad(page, { customer: "Acme Logistics (broker)", rate: "1200", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });

  // Board ↔ Planner
  await page.goto("/dispatch");
  await page.click("a:has-text('Planner')");
  await page.waitForURL("**/dispatch/planner", { waitUntil: "commit" });
  await expect(page.getByTestId("planner-leg")).toHaveCount(1);
  await expect(page.getByTestId("planner-driver")).toHaveCount(2);

  // Ana is on vacation from now
  await page.getByTestId("planner-driver").filter({ hasText: "Ana Cruz" }).locator("button:has-text('+ Time off')").click();
  const d = page.getByRole("dialog");
  await d.locator("#ev-kind").selectOption("vacation");
  await d.locator("#ev-note").fill("family trip");
  await d.locator("button:has-text('Add')").click();
  await expect(page.getByRole("status")).toContainText("Vacation added");
  const ana = page.getByTestId("planner-driver").filter({ hasText: "Ana Cruz" });
  await expect(ana).toContainText("Off");
  await expect(ana).toContainText("Vacation");

  // pick the load: Daniel ranks first, Ana needs an override for her vacation
  await page.getByTestId("planner-leg").filter({ hasText: num }).click();
  await expect(page.locator("section[aria-label='Drivers']")).toContainText(`Drivers for ${num}`);
  await expect(page.getByTestId("planner-driver").first()).toContainText("Daniel Reyes");
  await expect(ana).toContainText(/Override: .*vacation/);

  await page.getByTestId("planner-driver").filter({ hasText: "Daniel Reyes" }).locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText(`${num} → 2104 · Daniel Reyes — sent`);
  await expect(page.getByTestId("planner-leg")).toHaveCount(0);
  await expect(page.getByTestId("planner-driver").filter({ hasText: "Daniel Reyes" })).toContainText(num);
});
