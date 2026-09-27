// Features: F-20.8
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("templates: save a lane from the builder, create a week of loads from it, start a load from it", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });

  // the lane, filled once in the builder, saved as a template
  await page.goto("/orders/new");
  await page.locator("#l-customer").selectOption({ label: "Acme Logistics (broker)" });
  await page.locator("#l-rate").fill("1800");
  await page.getByLabel("Stop 1 location").fill("Shipper Canton");
  await page.getByLabel("Stop 1 city").fill("Canton");
  await page.getByLabel("Stop 1 state").fill("MI");
  await page.getByLabel("Stop 1 from").fill("2026-11-02T08:00");
  await page.getByLabel("Stop 2 location").fill("Consignee Toronto");
  await page.getByLabel("Stop 2 city").fill("Toronto");
  await page.getByLabel("Stop 2 state").fill("ON");
  await page.getByLabel("Stop 2 country").selectOption("CA");
  await page.getByLabel("Stop 2 from").fill("2026-11-03T06:30");
  page.once("dialog", (d) => d.accept("Canton → Toronto"));
  await page.click("button:has-text('Save as a template for next time')");
  await expect(page.locator("body")).toContainText("Saved as template");

  // a week of weekday loads
  await page.goto("/orders");
  await page.click("a:has-text('Templates')");
  await page.waitForURL("**/orders/templates", { waitUntil: "commit" });
  const row = page.getByTestId("template-row").filter({ hasText: "Canton → Toronto" });
  await expect(row).toContainText("Acme Logistics");
  await expect(row).toContainText("pickup 08:00");
  await row.locator("button:has-text('Create loads')").click();
  const d = page.getByRole("dialog");
  await d.locator("#b-start").fill("2026-11-02"); // a Monday
  await expect(page.getByTestId("bulk-dates")).toContainText("5 loads");
  await d.locator("button:has-text('Create 5 loads')").click();
  await expect(page.getByRole("status")).toContainText("Created 5 loads");
  await expect(row).toContainText("5×");
  await page.goto("/orders");
  await expect(page.getByTestId("grid-row")).toHaveCount(5);

  // a single load from the template in the builder
  await page.goto("/orders/new");
  await page.getByLabel("Template").selectOption({ label: "Canton → Toronto · Acme Logistics" });
  await page.getByLabel("Pickup date").fill("2026-11-10");
  await page.click("button:has-text('Use template')");
  await expect(page.getByTestId("template-strip")).toContainText("Filled from");
  await expect(page.getByTestId("legs-preview")).toContainText("Crossing");
  await page.getByLabel("Edit stop 1").click();
  await expect(page.getByLabel("Stop 1 location")).toHaveValue("Shipper Canton");
  await expect(page.getByLabel("Stop 1 from")).toHaveValue(/^2026-11-10T/);
});

test("import: a sheet previews every load with its problems, then creates the good ones", async ({ page }) => {
  test.setTimeout(90_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });
  await page.goto("/orders");
  await page.click("a:has-text('Import')");
  await page.waitForURL("**/orders/import", { waitUntil: "commit" });
  const csv = ["Customer,Rate,PO,Pickup Name,Pickup City,Pickup State,Pickup Date,Pickup Time,Delivery Name,Delivery City,Delivery State,Delivery Country,Delivery Date", "Acme Logistics,1850,PO-1,Shipper Canton,Canton,MI,2026-11-02,08:00,Consignee Toronto,Toronto,ON,CA,2026-11-03", "Acme Logistics,900,PO-2,Plant Toledo,Toledo,OH,2026-11-02,,DC Dayton,Dayton,OH,US,2026-11-02", "Nobody Inc,1,,A,,,2026-11-02,,B,,,,"].join("\n");
  await page.getByLabel("Sheet file").setInputFiles({ name: "plan.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const pv = page.getByTestId("import-preview");
  await expect(pv).toContainText("3 loads found");
  await expect(pv).toContainText("2 ready");
  await expect(page.getByTestId("import-row").nth(2)).toContainText('customer "Nobody Inc" is not on file');
  await page.locator("label:has-text('Book them') input").check();
  await page.click("button:has-text('Import 2 loads')");
  await expect(page.getByTestId("import-done")).toContainText("2 loads created, 1 skipped");
  await page.click("a:has-text('See them on Loads')");
  await expect(page.getByTestId("grid-row")).toHaveCount(2);
  await expect(page.getByTestId("grid-row").first()).toContainText("Booked");
});
