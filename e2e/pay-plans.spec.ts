// Features: F-21.1 F-21.2
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("pay plans: build a plan with a live preview, put a driver on it, add escrow", async ({ page }) => {
  test.setTimeout(90_000);
  await signupFresh(page);
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL" });
  await page.goto("/billing/pay-plans");
  await expect(page.locator("main")).toContainText("No pay plans yet");
  await page.click("button:has-text('+ New pay plan')");
  const d = page.getByRole("dialog");
  await d.locator("#pp-name").fill("Company solo");
  await d.getByLabel("Rule 1 kind").selectOption("per_loaded_mile");
  await d.getByLabel("Rule 1 amount").fill("0.60");
  await d.locator("button:has-text('+ Add rule')").click();
  await d.getByLabel("Rule 2 kind").selectOption("crossing");
  await d.getByLabel("Rule 2 amount").fill("75");
  // preview: 500 mi × 0.60 = $300 a load, 4 loads a week; the crossing rule only on crossing legs
  await expect(page.getByTestId("pay-week")).toContainText("$1,200.00");
  await d.locator("#pp-diem").fill("15");
  await expect(page.getByTestId("pay-week")).toContainText("$1,275.00"); // + 5 days × $15
  await d.locator("button:has-text('Save plan')").click();
  await expect(page.getByRole("status")).toContainText("Plan saved");
  const card = page.getByTestId("pay-plan").filter({ hasText: "Company solo" });
  await expect(card).toContainText("$0.60 / mi");
  await expect(card).toContainText("Crossing pay");
  await card.locator("button:has-text('Drivers')").click();
  await page.getByRole("dialog").locator("label", { hasText: "Daniel Reyes" }).locator("input").check();
  await page.getByRole("dialog").locator("button:has-text('Save')").click();
  await expect(card).toContainText("Daniel Reyes");

  // escrow on the driver, from Driver pay; it shows on Pay plans with its balance
  await page.goto("/billing/settlements");
  await expect(page.locator("main")).toContainText("Daniel Reyes"); // the only driver is picked
  await page.click("button:has-text('+ Pay item')");
  const it = page.getByRole("dialog");
  await it.getByLabel("Pay item kind").selectOption("escrow");
  await it.locator("input").nth(0).fill("Escrow — equipment");
  await it.getByLabel("Pay item amount").fill("100");
  await it.getByLabel("Escrow target").fill("2500");
  await it.locator("button:has-text('Add')").click();
  await expect(page.getByRole("status")).toContainText("Pay item added");
  await page.goto("/billing/pay-plans");
  await expect(page.getByTestId("escrows")).toContainText("Daniel Reyes");
  await expect(page.getByTestId("escrows")).toContainText("$2,500.00");
});
