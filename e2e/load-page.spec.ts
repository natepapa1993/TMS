// Features: F-20.2
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad } from "./helpers";

test("load page: facts header, tabs, per-mile rate, people and priority, notes, lock, TONU to billing", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });
  const num = await buildLoad(page, { customer: "Acme Logistics (broker)", rate: "1000", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });
  await page.goto("/orders");
  await page.getByTestId("grid-row").filter({ hasText: num }).locator("a").first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  const header = page.getByTestId("load-header");
  await expect(header).toContainText(num);
  await expect(page.getByTestId("load-facts")).toContainText("$1,000.00");

  // money: per mile
  await page.getByTestId("tab-money").click();
  await expect(page).toHaveURL(/tab=money/);
  const money = page.getByTestId("money-box");
  await money.locator("#m-type").selectOption("per_mile");
  await money.locator("#m-unit").fill("2.50");
  await money.locator("#m-qty").fill("400");
  await expect(money).toContainText("$1,000.00");
  await money.locator("#m-qty").fill("420");
  await expect(money).toContainText("$1,050.00");
  await money.locator("button:has-text('Save rate')").click();
  await expect(page.getByRole("status").filter({ hasText: "Rate saved" })).toBeVisible();
  await expect(page.getByTestId("load-facts")).toContainText("$1,050.00");
  await expect(page.getByTestId("load-facts")).toContainText("× 420");

  // a reload keeps the tab
  await page.reload();
  await expect(page.getByTestId("money-box")).toBeVisible();

  // people and priority
  await page.getByTestId("tab-overview").click();
  await page.locator("#p-dispatcherId").selectOption({ label: "E2E Owner" });
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("group", { name: "Priority" }).locator("button:has-text('High')").click();
  await expect(header).toContainText("high priority");

  // notes
  await page.getByTestId("tab-notes").click();
  await page.locator("#n-kind").selectOption("dispatch");
  await page.locator("#n-body").fill("Dock closes at 3 — call ahead");
  await page.locator("label:has-text('Pin to the top') input").check();
  await page.click("button:has-text('Add note')");
  await expect(page.getByTestId("note")).toContainText("Dock closes at 3");
  await expect(page.getByTestId("tab-notes")).toContainText("1");
  await page.getByTestId("tab-overview").click();
  await expect(page.locator("main")).toContainText("Pinned notes");

  // lock: no edits until unlocked
  await page.click("button:has-text('Lock')");
  await expect(page.getByRole("status").filter({ hasText: "Locked" })).toBeVisible();
  await expect(header).toContainText("locked");
  await page.getByTestId("tab-stops").click();
  await expect(page.locator("main")).toContainText("Unlock the load to change its stops");
  await page.click("button:has-text('Unlock')");
  await expect(page.getByRole("status").filter({ hasText: "Unlocked" })).toBeVisible();

  // TONU → billing, no POD needed
  await page.click("button:has-text('TONU')");
  const d = page.getByRole("dialog");
  await d.locator("#tonu-amount").fill("250");
  await d.locator("#tonu-reason").fill("Shipper cancelled at the dock");
  await d.locator("button:has-text('Cancel & bill TONU')").click();
  await expect(page.getByRole("status").filter({ hasText: "TONU" })).toBeVisible();
  await expect(header).toContainText("TONU");
  await page.goto("/billing");
  const row = page.locator("tr", { hasText: num });
  await expect(row).toContainText("$250.00");
  await expect(row).not.toContainText("POD");
});
