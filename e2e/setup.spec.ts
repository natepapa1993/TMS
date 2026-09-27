// Features: F-1.1 F-1.2 F-1.3 F-1.4
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, future } from "./helpers";

// Human-interface run of spec §1 (setup) and §10.1 day-one: a new company can be dispatch-ready in minutes.

test("signup → day-one checklist → add entity, truck, driver, customer, location with the quick-add popups", async ({ page }) => {
  await signupFresh(page);
  await expect(page.getByText("Day one")).toBeVisible();
  await expect(page.getByRole("link", { name: /Add billing entities/ })).toBeVisible();

  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "E2E Carrier LLC", country: "US", taxId: "12-3456789", invoicePrefix: "E2E" });
  await expect(page.locator("table")).toContainText("E2E Carrier LLC");

  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2117", equipmentType: "tractor", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown" });
  await expect(page.locator("table")).toContainText("2117");
  await expect(page.locator("table")).toContainText("Brown (border zone)");

  // duplicate unit number is refused with the error under the field
  await page.click("button:has-text('Add truck')");
  await page.locator("#f-unitNumber").fill("2117");
  await page.getByRole("dialog").locator("button:has-text('Add')").click();
  await expect(page.getByRole("dialog")).toContainText(/already exists/);
  await page.keyboard.press("Escape");

  await quickAdd(page, "drivers", "Add driver", { name: "Benjamín Xochihua", driverType: "B1", phone: "+52 867 111 2222" });
  await expect(page.locator("table")).toContainText("Benjamín Xochihua");
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await quickAdd(page, "locations", "Add location", { name: "Laredo Yard", kind: "yard", country: "US", address: "1 Yard Rd, Laredo, TX 78045, US" });

  await page.goto("/settings");
  await expect(page.getByText("Day one")).toBeHidden(); // checklist done
});

test("record screen: edit everything, history shows the change, archive blocked while in use, restore", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2109", usPlate: "TX1" });
  await page.click("table a:has-text('2109')");
  await expect(page.locator(".h1")).toContainText("2109");
  await page.locator("#f-make").fill("Freightliner");
  await page.locator("#f-usPlateExpires").fill(future(200));
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.reload();
  await expect(page.locator("#f-make")).toHaveValue("Freightliner");
  await expect(page.getByText("History", { exact: true })).toBeVisible();
  await expect(page.locator("aside.space-y-4")).toContainText("make");
  await page.click("button:has-text('Archive')");
  await page.getByRole("dialog").locator("button:has-text('Archive')").click();
  await page.waitForURL("**/settings/trucks");
  await expect(page.locator("main")).not.toContainText("2109");
  await page.click("a:has-text('Show archived')");
  await page.click("table a:has-text('2109')");
  await page.click("button:has-text('Restore')");
  await expect(page.getByRole("status")).toContainText("Restored");
});

test("CSV import: preview shows problems, commit adds, re-import updates instead of duplicating", async ({ page }) => {
  await signupFresh(page);
  await page.goto("/settings/trucks/import");
  await page.locator("textarea").fill("Unit #,US plate,MX plate,MX plate class\n2117,RC59022,35ES3A,brown\n2109,TX1,MX1,purple\n,TX9,,");
  await page.click("button:has-text('Preview')");
  await expect(page.getByText("3 rows")).toBeVisible();
  await expect(page.getByText("1 new")).toBeVisible();
  await expect(page.getByText("2 skipped")).toBeVisible();
  await expect(page.locator("table")).toContainText("purple");
  await page.click("button:has-text('Import 1 rows')");
  await expect(page.getByText("Import finished")).toBeVisible();
  await expect(page.getByText("1 added")).toBeVisible();
  await page.click("button:has-text('Import another file')");
  await page.locator("textarea").fill("Unit #,Make\n2117,Volvo");
  await page.click("button:has-text('Preview')");
  await expect(page.getByText("1 update existing")).toBeVisible();
  await page.click("button:has-text('Import 1 rows')");
  await expect(page.getByText("1 updated")).toBeVisible();
  await page.click("button:has-text('Open the list')");
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await expect(page.locator("table")).toContainText("2117");
});
