// Features: F-20.1
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad } from "./helpers";

test("load board: grid with totals, quick filters, search, columns, a saved view that comes back, bulk book", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });
  await quickAdd(page, "customers", "Add customer", { name: "Globex", kind: "customer" });
  await buildLoad(page, { customer: "Acme Logistics (broker)", rate: "3100", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "Consignee Toronto", country: "CA" }] });
  await buildLoad(page, { customer: "Globex", rate: "900", stops: [{ type: "pickup", name: "Plant Toledo", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });
  // a draft
  await page.goto("/orders/new");
  await page.locator("#l-customer").selectOption({ label: "Globex" });
  await page.getByLabel("Stop 1 location").fill("Plant Toledo");
  await page.getByLabel("Stop 2 location").fill("DC Dayton");
  await page.click("button:has-text('Save as draft')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });

  await page.goto("/orders");
  const rows = page.getByTestId("grid-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("total-Loads")).toContainText("3");
  await expect(page.getByTestId("total-Revenue")).toContainText("$4,000");

  // quick filter + search
  await page.getByRole("tab", { name: /Cross-border/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Acme Logistics");
  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByLabel("Search the list").fill("dayton");
  await expect(rows).toHaveCount(1);
  await page.getByLabel("Search the list").fill("");

  // hide PO, show Stops, then save the view
  await page.getByTestId("columns-menu").click();
  await page.locator("label", { hasText: /^References$/ }).locator("input").uncheck();
  await page.locator("label", { hasText: /^Stops$/ }).locator("input").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("thead th", { hasText: /^References/ })).toHaveCount(0);
  await expect(page.locator("thead th", { hasText: /^Stops/ })).toHaveCount(1);
  page.once("dialog", (d) => d.accept("Stops view"));
  await page.getByTestId("views-menu").click();
  await page.click("button:has-text('Save as new view')");
  await expect(page.getByRole("status")).toContainText("View saved");

  // it comes back after a reload
  await page.reload();
  await expect(page.locator("thead th", { hasText: /^References/ })).toHaveCount(1); // default view on load
  await page.getByTestId("views-menu").click();
  await page.click("button:has-text('Stops view')");
  await expect(page.locator("thead th", { hasText: /^References/ })).toHaveCount(0);
  await expect(page.locator("thead th", { hasText: /^Stops/ })).toHaveCount(1);

  // bulk: book the draft
  await page.getByTestId("views-menu").click();
  await page.click("button.menu-item:has-text('Default view')");
  await rows.filter({ hasText: "Draft" }).getByLabel("Select row").check();
  await expect(page.getByTestId("bulk-bar")).toContainText("1 selected");
  await page.getByTestId("bulk-bar").locator("button:has-text('Book 1 draft')").click();
  await expect(page.getByRole("status")).toContainText("Booked 1");
  await expect(rows.filter({ hasText: "Draft" })).toHaveCount(0);

  // the load # opens the load
  await rows.first().locator("a").first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
});
