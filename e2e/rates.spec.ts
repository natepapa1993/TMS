// Features: F-21.3
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("fuel table + weekly diesel price; the builder offers the customer's contract rate and fuel, and the load keeps them", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Foods", kind: "customer" });
  await page.goto("/settings/customers");
  await quickAdd(page, "customer-rates", "Add customer rate", { customerId: "Acme Foods", originZone: "Laredo", destinationZone: "Dallas", rateType: "flat", rateCents: "1500", fuelRule: "table" });

  // Billing → Fuel surcharge: a per-mile table, default, and this week's price
  await page.goto("/billing/fuel");
  await expect(page.getByTestId("fuel-current")).toContainText("No price");
  await page.click("button:has-text('+ New table')");
  const d = page.getByRole("dialog");
  await d.locator("#ft-name").fill("DOE weekly");
  await d.locator("#ft-method").selectOption("per_mile");
  await d.getByLabel("Band 1 from").fill("3.50");
  await d.getByLabel("Band 1 to").fill("4.00");
  await d.getByLabel("Band 1 surcharge").fill("48");
  await d.locator("button:has-text('+ Add band')").click();
  await expect(d.getByLabel("Band 2 from")).toHaveValue("4.00");
  await d.getByLabel("Band 2 to").fill("");
  await d.getByLabel("Band 2 surcharge").fill("55");
  await d.getByLabel("Default table (used by lane rates set to \"fuel table\")").check();
  await d.locator("button:has-text('Save table')").click();
  await expect(page.getByRole("status").filter({ hasText: "Table saved" })).toBeVisible();
  await expect(page.getByTestId("fuel-table")).toContainText("DOE weekly");
  await expect(page.getByTestId("fuel-table")).toContainText("Default");
  await page.locator("#fp-price").fill("3.89");
  await page.click("button:has-text('Save price')");
  await expect(page.getByTestId("fuel-current")).toContainText("$3.89/gal");
  await expect(page.getByTestId("fuel-prices")).toContainText("DOE weekly: 48¢/mi surcharge");

  // the builder: pick the customer and the lane → the contract rate is offered; Apply fills the rate and fuel
  await page.goto("/orders/new");
  await page.locator("#l-customer").selectOption({ label: "Acme Foods" });
  await page.getByLabel("Stop 1 location").fill("Laredo yard");
  await page.getByLabel("Stop 2 location").fill("Dallas DC");
  const offer = page.getByTestId("contract-rate");
  await expect(offer).toContainText("Laredo → Dallas");
  await expect(offer).toContainText("1,500.00");
  await expect(offer).toContainText("48¢/mi");
  await offer.locator("button:has-text('Apply')").click();
  await expect(page.locator("#l-rate")).toHaveValue("1500.00");
  await expect(offer).toContainText("Applied");
  await expect(page.getByTestId("load-summary")).toContainText("48¢/mi");
  await page.click("button:has-text('Create & book')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });
  const id = new URL(page.url()).searchParams.get("order");
  await page.goto(`/orders/${id}?tab=money`);
  await expect(page.locator("#m-fuel")).toHaveValue("per_mile");
  await expect(page.locator("#m-fuelcpm")).toHaveValue("48");
});
