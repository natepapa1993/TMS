// Features: F-24.1 F-24.2 F-24.3
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, confirmStamp } from "./helpers";

test("trip board: stop-local times, buckets and chips, a carrier on it, check call to the log, time confirmed before a stamp, ⌘K finds the load by PO", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Foods", kind: "customer" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test", mcNumber: "700200" });

  // a load in Texas, typed on Texas time, with delivery out of order first
  await page.goto("/orders/new");
  await page.locator("#l-customer").selectOption({ label: "Acme Foods" });
  await page.locator("#l-rate").fill("1800");
  await page.getByLabel("Stop 1 location").fill("Laredo Yard");
  await page.getByLabel("Stop 1 state").fill("TX");
  await page.getByLabel("Stop 1 from").fill("2027-04-10T08:00");
  await page.getByLabel("Stop 2 location").fill("Dallas DC");
  await page.getByLabel("Stop 2 state").fill("TX");
  await page.getByLabel("Stop 2 from").fill("2027-04-09T08:00");
  await expect(page.getByTestId("load-summary")).toContainText("Stop times: stop 2 is scheduled before stop 1");
  await page.getByLabel("Stop 2 from").fill("2027-04-11T08:00");
  await expect(page.getByTestId("load-summary")).toContainText("Stop times in order");
  await expect(page.locator("main")).toContainText("on the stop's clock (CDT)");
  await page.getByLabel("Stop 1 reference").fill("PO-4471");
  await page.click("button:has-text('Create & book')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });

  const board = page.getByTestId("trip-board");
  const row = board.locator(".row[role=button]").first();
  await expect(row).toContainText("Apr 10, 8:00 AM CDT");
  await expect(row).toContainText("Needs truck");
  await expect(page.locator(".stage-tab:has-text('Needs truck') .count")).toHaveText("1");
  await expect(page.locator(".stage-tab:has-text('In transit') .count")).toHaveText("0");

  // a partner carrier by phone, with the margin shown before sending
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Lone Star Freight (US)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("1350");
  await expect(dlg.getByTestId("tender-margin")).toContainText("Margin $450 · 25% of the load");
  await dlg.locator("select").nth(1).selectOption("manual");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status").filter({ hasText: "Tender link copied" })).toBeVisible();
  await expect(page.locator(".stage-tab:has-text('Sent') .count")).toHaveText("1");
  await expect(row).toContainText("Lone Star Freight");

  // rolling: a check call from the panel, then the pickup arrival asks for the time first
  await panel.locator(".rounded-lg.border >> nth=0 >> button:has-text('Accepted')").click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted" })).toBeVisible();
  await panel.locator("button.btn-primary.btn-lg").first().click(); // rolling to pickup
  await expect(page.locator(".stage-tab:has-text('In transit') .count")).toHaveText("1");
  const cc = panel.getByTestId("check-call");
  await expect(cc).toBeVisible(); // open by itself once the load is rolling
  await cc.locator("#cc-status").selectOption("running_late");
  await cc.locator("#cc-location").fill("I-35 N mm 18, Laredo TX");
  await cc.locator("#cc-note").fill("Waiting on the lumper at the yard");
  await cc.locator("button:has-text('Log check call')").click();
  await expect(page.getByRole("status").filter({ hasText: "Check call logged" })).toBeVisible();
  await expect(cc.getByTestId("check-calls")).toContainText("Running late");
  await expect(cc.getByTestId("check-calls")).toContainText("Waiting on the lumper");

  await panel.locator("button.btn-primary.btn-lg").first().click(); // Arrived at pickup → asks when
  await expect(panel.getByTestId("stamp-confirm")).toContainText("Arrived at pickup at");
  await confirmStamp(panel);
  await expect(page.getByRole("status").filter({ hasText: "Arrived at pickup" })).toBeVisible();
  await expect(panel.locator("button.btn-primary.btn-lg").first()).toHaveText("Loaded");

  // ⌘K: the load by its PO
  await page.keyboard.press("Control+k");
  await page.locator("#global-search").fill("4471");
  const hit = page.getByTestId("global-search-results").locator("button").first();
  await expect(hit).toContainText(/\d{2}-\d{5}/);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/orders/**");
  await expect(page.getByTestId("load-header")).toContainText(/\d{2}-\d{5}/);
  await expect(page.getByTestId("tracking-card")).toContainText("Where it is");
  await expect(page.getByTestId("tracking-card").getByTestId("check-calls")).toContainText("Running late");
});
