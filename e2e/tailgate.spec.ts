// Features: F-12 tailgate through the browser — build a trip from stops, add shipments with live fit, over-capacity refused, book, dispatch the trip, shipments follow, manifest, per-shipment billing
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, future } from "./helpers";

test("tailgate day: stops → shipments (LIFO, capacity) → book → run the trip → shipments deliver and bill one by one", async ({ page }) => {
  test.setTimeout(180_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", taxId: "12-3456789" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "customers", "Add customer", { name: "Magna", kind: "customer" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // build: a US milk run, three stops
  await page.goto("/trips/new");
  await page.locator("select").nth(1).selectOption({ label: "US milk run" });
  const rows = page.getByTestId("stop-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(0).getByLabel("Stop 1 name").fill("Canton dock");
  await rows.nth(0).getByLabel("City").fill("Canton");
  await rows.nth(0).getByLabel("State").fill("MI");
  await rows.nth(1).getByLabel("Stop 2 name").fill("Toledo supplier");
  await rows.nth(1).getByLabel("City").fill("Toledo");
  await rows.nth(1).getByLabel("State").fill("OH");
  await rows.nth(2).getByLabel("Stop 3 name").fill("Laredo yard");
  await rows.nth(2).getByLabel("City").fill("Laredo");
  await rows.nth(2).getByLabel("State").fill("TX");
  await page.click("button:has-text('Create trip')");
  await page.waitForURL("**/trips/**", { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("Canton dock → Laredo yard");
  await expect(page.locator("main")).toContainText("Domestic (Pending)");
  await expect(page.locator("main")).toContainText("No shipments yet");

  // shipments with live fit; the third would not fit
  const add = async (customer: string, rate: string, po: string, on: string, weight: string, ft: string) => {
    await page.click("button:has-text('+ Shipment')");
    const d = page.getByRole("dialog");
    await d.getByLabel("Customer").selectOption({ label: customer });
    await d.getByLabel("Rate").fill(rate);
    await d.getByLabel("PO").fill(po);
    await d.getByLabel("Pickup stop").selectOption({ label: on });
    await d.getByLabel("Pieces").fill("10");
    await d.getByLabel("Weight").fill(weight);
    await d.getByLabel("Linear feet").fill(ft);
    return d;
  };
  let d = await add("RXO", "1200", "PO-1", "1. Canton dock", "20000", "24");
  await expect(d.getByTestId("fit")).toContainText("Fits · 29 ft");
  await d.locator("button:text-is('Add')").click();
  await expect(page.getByRole("status")).toContainText("Shipment added");
  d = await add("Magna", "900", "PO-2", "2. Toledo supplier", "20000", "20");
  await expect(d.getByTestId("fit")).toContainText("Fits · 9 ft");
  await d.locator("button:text-is('Add')").click();
  await expect(page.getByRole("status")).toContainText("Shipment added");
  d = await add("RXO", "500", "PO-3", "2. Toledo supplier", "9000", "12");
  await expect(d.getByTestId("fit")).toContainText("Will not fit: 49,000 lb, 56 linear ft");
  await d.locator("button:text-is('Add')").click();
  await expect(d).toContainText("will not fit");
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).toContainText("2 on the trip · $2,100.00 revenue");
  await expect(page.locator("main")).toContainText("83%"); // 44 of 53 ft
  await expect(page.getByTestId("trailer")).toContainText("9 ft free");

  // book → the trip is on the dispatch board as one row; assign our truck and run it
  await page.click("button:has-text('Book the trip')");
  await expect(page.getByRole("status")).toContainText("Booked");
  await page.goto("/dispatch");
  const row = page.locator(".row[role=button]", { hasText: "Tailgate trip · 2 shipments" });
  await expect(row).toHaveCount(1);
  await row.click();
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2104" }).click();
  await dlg.locator("#plan-miles").fill("1500");
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.locator(".row[role=button]").first().click();
  for (let i = 0; i < 4; i++) {
    await panel.locator("button.btn-primary.btn-lg").click(); // accepted, rolling, arrived at pickup, loaded (= departed Canton)
    await page.waitForTimeout(200);
  }
  // shipment 1 (on at Canton) is on the truck; shipment 2 (Toledo) waits for its stop
  await page.goto("/orders");
  await expect(page.locator("tr", { hasText: "PO-1" })).toContainText("In transit");
  await expect(page.locator("tr", { hasText: "PO-2" })).toContainText("Dispatched");
  await page.goto("/dispatch");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.locator(".row[role=button]").first().click();
  await panel.locator("button.btn-primary.btn-lg").click(); // en route
  await expect(panel.locator("button.btn-primary.btn-lg")).toHaveText("Arrived at Toledo supplier"); // the stop in between comes before the delivery
  await panel.locator("button.btn-primary.btn-lg").click();
  await expect(panel.locator("button.btn-primary.btn-lg")).toHaveText("Leaving Toledo supplier");
  await panel.locator("button.btn-primary.btn-lg").click();
  await expect(panel.locator("button.btn-primary.btn-lg")).toHaveText("Arrived at delivery");
  await page.goto("/orders");
  await expect(page.locator("tr", { hasText: "PO-2" })).toContainText("In transit"); // on the truck since it left Toledo
  await page.goto("/dispatch");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.locator(".row[role=button]").first().click();
  for (let i = 0; i < 2; i++) {
    await panel.locator("button.btn-primary.btn-lg").click(); // arrived, delivered
    await page.waitForTimeout(200);
  }
  await expect(page.locator(".stage-tab:has-text('Delivered') .count")).toHaveText("1");
  await page.goto("/orders");
  await expect(page.locator("tr", { hasText: "PO-1" })).toContainText("Delivered");
  await expect(page.locator("tr", { hasText: "PO-2" })).toContainText("Delivered");

  // the trip page: manifest, cost split; billing sees two shipments, never the trip
  await page.locator("tr", { has: page.locator(".pill", { hasText: /^trip$/ }) }).locator("a").first().click();
  await page.waitForURL("**/trips/**", { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("50%"); // equal weights → equal cost share
  const manifest = await page.request.get(await page.locator("a:has-text('Manifest PDF')").getAttribute("href").then((h) => h!));
  expect(manifest.headers()["content-type"]).toContain("application/pdf");
  await page.goto("/billing");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("main")).toContainText("$1,200.00");
  await expect(page.locator("main")).toContainText("$900.00");
  await expect(page.locator("main")).not.toContainText("Tailgate");
});
