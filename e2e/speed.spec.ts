// Features: F-30.2 F-30.3 F-30.4 F-30.5 F-30.6 F-30.7
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, future, buildLoad, login, step } from "./helpers";

/** A truck with its driver, paperwork done, ready to dispatch. */
async function crew(page: Page, name: string, unit: string, phone: string) {
  await quickAdd(page, "trucks", "Add truck", { unitNumber: unit, usPlate: `TX${unit}` });
  await quickAdd(page, "drivers", "Add driver", { name, driverType: "CDL", phone });
  await page.goto("/settings/drivers");
  await page.click(`table a:has-text('${name}')`);
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: unit });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

async function assignAndSend(page: Page, unit: string) {
  const panel = page.locator("aside").last();
  await panel.locator("button.btn-primary.btn-lg").first().click(); // Assign … leg
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: unit }).click();
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
}

test("owner starts on Today; hold a booked load; accent-blind ⌘K; a breakdown takes the truck out until it's fixed", async ({ page }) => {
  test.setTimeout(180_000);
  const me = await signupFresh(page);
  // the owner's home is Today
  await page.click("button:has-text('Sign out')");
  await page.waitForURL("**/login");
  await login(page, me.email, me.password);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("today")).toBeVisible();
  await expect(page.getByTestId("loads-late")).toHaveAttribute("href", "/dispatch?chip=late");

  await quickAdd(page, "customers", "Add customer", { name: "Bajío Autopartes", kind: "broker" });
  await crew(page, "Óscar Peña", "2104", "+1 956 000 2104");
  const num = await buildLoad(page, { customer: "Bajío Autopartes (broker)", rate: "1500", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "DC San Antonio", country: "US" }] });
  const panel = page.locator("aside").last();

  // hold works before any truck is on it (M8), and release puts it back
  await panel.locator("button:has-text('Hold')").click();
  await page.getByRole("dialog").locator("input").fill("customer re-checking the PO");
  await page.getByRole("dialog").locator("button:has-text('Hold')").click();
  await expect(page.getByRole("status")).toContainText("On hold");
  await expect(panel).toContainText("Hold: customer re-checking the PO");
  await panel.locator("button:has-text('Release hold')").click();
  await expect(page.getByRole("status")).toContainText("Released");

  // ⌘K: "oscar" finds Óscar, "bajio" finds Bajío — customer before its loads (M19, owner #16)
  await page.keyboard.press("Control+k");
  await page.locator("#global-search").fill("oscar");
  await expect(page.getByTestId("global-search-results")).toContainText("Óscar Peña");
  await page.locator("#global-search").fill("bajio");
  const results = page.getByTestId("global-search-results").locator("li");
  await expect(results.first()).toContainText("Bajío Autopartes");
  await expect(page.getByTestId("global-search-results")).toContainText(num);
  await page.keyboard.press("Escape");

  // send it, then a breakdown on the road: the load is flagged, the truck is out of the planner (M7)
  await page.locator(".row[role=button]", { hasText: num }).click();
  await assignAndSend(page, "2104");
  await page.locator(".row[role=button]", { hasText: num }).click();
  await panel.locator("summary:has-text('Check calls')").click();
  await panel.locator("#cc-status").selectOption("breakdown");
  await panel.locator("#cc-location").fill("Love's #312, Cotulla TX");
  await panel.locator("button:has-text('Log check call')").click();
  await expect(page.getByRole("status")).toContainText("Check call logged");
  await expect(page.locator(".row[role=button]", { hasText: num })).toContainText("Breakdown");
  await page.goto("/dispatch/planner");
  const unit = page.getByTestId("planner-truck").filter({ hasText: "2104" });
  await expect(unit).toHaveAttribute("data-status", "unavailable");
  await expect(unit).toContainText("Unavailable — breakdown");
  // fixed: one click puts it back
  await page.goto("/dispatch");
  await page.locator(".row[role=button]", { hasText: num }).click();
  await panel.getByTestId("flag").filter({ hasText: "Breakdown" }).locator("button:has-text('Fixed')").click();
  await expect(page.getByRole("status")).toContainText("Breakdown cleared");
  await page.goto("/dispatch/planner");
  await expect(page.getByTestId("planner-truck").filter({ hasText: "2104" })).not.toHaveAttribute("data-status", "unavailable");
});

test("the driver app fits a 390 px phone and \"I can't take this load\" sends it back", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Transportes y Logística del Bajío Internacional", kind: "broker" });
  await crew(page, "Mateo Ruiz", "213", "+1 956 555 0159");
  const num = await buildLoad(page, { customer: "Transportes y Logística del Bajío Internacional (broker)", rate: "1850", stops: [{ type: "pickup", name: "Planta de Autopartes Bajío Industrial Park Nave 14", country: "US" }, { type: "delivery", name: "Centro de Distribución Regional San Antonio Norte", country: "US" }] });
  await assignAndSend(page, "213");
  const panel = page.locator("aside").last();
  await page.locator(".row[role=button]", { hasText: num }).click();
  await panel.locator("button:has-text('Track')").click();
  const driverUrl = await page.getByRole("dialog").locator("a:has-text('Preview')").first().getAttribute("href");
  await page.keyboard.press("Escape");

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: { latitude: 27.5, longitude: -99.5 }, permissions: ["geolocation"] });
  const phone = await ctx.newPage();
  await phone.goto(driverUrl!);
  await expect(phone.locator("body")).toContainText("Mateo Ruiz");
  await expect(phone.getByTestId("next-step")).toContainText("Accept this load");
  // no sideways scroll on a phone (M13: it was 543 px)
  const width = await phone.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  // one primary button at a time (m17)
  await expect(phone.locator(".driver-app button.btn-primary:visible")).toHaveCount(1);
  // "I can't take this load" works with a tap
  await phone.getByTestId("decline").tap().catch(() => phone.getByTestId("decline").click());
  await phone.getByLabel("Why you can't take it").fill("Truck in the shop · camión en el taller");
  await phone.getByTestId("decline-send").click();
  await expect(phone.locator("body")).toContainText("Nothing assigned right now");
  await ctx.close();
  await page.reload();
  await expect(page.locator(".row[role=button]", { hasText: num })).toContainText("declined by Mateo Ruiz");
});

test("billing: a delivered load with no POD waits; dispatch bills it without one; one click creates, issues and sends", async ({ page }) => {
  test.setTimeout(180_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "Speed Freight LLC", country: "US", invoicePrefix: "SF", taxId: "12-9876543" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await page.goto("/settings/customers");
  await page.click("table a:has-text('RXO')");
  await page.locator("#f-requiredDocs").fill("POD");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await crew(page, "Daniel Reyes", "2104", "+1 956 000 0003");
  const num = await buildLoad(page, { customer: "RXO (broker)", rate: "1850", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }] });
  await assignAndSend(page, "2104");
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]", { hasText: num }).click();
  const panel = page.locator("aside").last();
  for (let i = 0; i < 7; i++) {
    await step(panel);
    await page.waitForTimeout(200);
  }
  // delivered, no POD: the board says so; the Loads list keeps it out of "To bill"
  await page.click(".stage-tab:has-text('Delivered')");
  await page.locator(".row[role=button]", { hasText: num }).click();
  await expect(panel.getByTestId("pod-missing")).toBeVisible();
  await page.goto("/orders");
  await page.locator("button:has-text('Missing POD')").click();
  await expect(page.locator("main")).toContainText(num);
  // the receiver signs electronically: bill it without a POD, with the reason
  await page.goto("/dispatch");
  await page.click(".stage-tab:has-text('Delivered')");
  await page.locator(".row[role=button]", { hasText: num }).click();
  await panel.locator("button:has-text('Bill without POD')").click();
  await page.getByRole("dialog").locator("input").fill("receiver signs electronically");
  await page.getByRole("dialog").locator("button:has-text('Bill without POD')").click();
  await expect(page.getByRole("status")).toContainText("without a POD");
  // one click in the queue (billing #12)
  await page.goto("/billing");
  const row = page.locator("tr", { hasText: num });
  await row.getByTestId("bill-one").click();
  await expect(page.getByRole("status")).toContainText(/SF-\d{6} sent/);
});
