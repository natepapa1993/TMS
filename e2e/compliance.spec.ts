// Features: F-6 compliance through the browser — rule, blocked driver on the board and in the picker, upload from the record, snooze, 24h override, export, incidents
import { test, expect } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future } from "./helpers";

test("safety director day: a blocking rule, the driver goes red everywhere, upload fixes it, export, incident", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(12)); // expiring
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // rule: medical card document required, blocks dispatch
  await quickAdd(page, "document-types", "Add document type", { name: "Medical card", appliesTo: "driver", tracksExpiry: "true" });
  await page.goto("/settings/document-types");
  await page.click("table a:has-text('Medical card')");
  await page.locator("#f-required").check();
  await page.locator("#f-blocksDispatch").check();
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // board: blocked
  await page.goto("/compliance");
  await expect(page.locator("main")).toContainText("Blocked from dispatch");
  const row = page.locator("tr", { hasText: "Daniel Reyes" });
  await expect(row).toContainText("blocked");
  await expect(row).toContainText("missing");
  await expect(row.locator(".pill-amber", { hasText: /\w{3} \d/ })).toHaveCount(1); // medical field expiring shows the date

  // dispatch picker: red with the reason
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Laredo Yard");
  await d.locator("select").nth(1).selectOption("US");
  await d.getByPlaceholder("GM Arlington").fill("Toyota San Antonio");
  await d.locator("select").last().selectOption("domestic");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  await page.locator("aside").last().locator("button:has-text('Assign Domestic leg')").click();
  const cand = page.getByRole("dialog").locator(".cursor-pointer", { hasText: "2104" });
  await expect(cand).toContainText("needs override");
  await expect(cand).toContainText("Medical card missing");
  await page.keyboard.press("Escape");

  // upload the card from the driver record → dispatchable
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await expect(page.locator("#documents")).toContainText("Blocked");
  await page.locator("#documents").locator("button:has-text('upload')").first().click();
  const up = page.getByRole("dialog");
  await up.locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await up.locator("input[name=expiresAt]").fill(future(200));
  await up.locator("input[name=number]").fill("MED-77");
  await up.locator("button:has-text('Upload')").last().click();
  await expect(page.getByRole("status")).toContainText("compliance re-run");
  await expect(page.locator("#documents")).toContainText("Dispatchable");
  await expect(page.locator("#documents")).toContainText("#MED-77");

  // export
  const res = await page.request.get("/api/compliance/export?kind=driver");
  expect(res.ok()).toBeTruthy();
  const csv = await res.text();
  expect(csv).toContain("Daniel Reyes");
  expect(csv.split("\n")[0]).toContain("Medical card");

  // snooze the expiring medical date
  await page.goto("/compliance");
  const r2 = page.locator("tr", { hasText: "Daniel Reyes" });
  await expect(r2).toContainText("dispatchable");
  await r2.locator("button[title='Snooze this alert']").first().click();
  await page.getByRole("dialog").locator("input[type=date]").fill(future(10));
  await page.getByRole("dialog").locator("input[placeholder='renewal in progress']").fill("physical booked");
  await page.getByRole("dialog").locator("button:has-text('Snooze')").click();
  await expect(page.getByRole("status")).toContainText("Snoozed");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" }).locator(".pill-slate[title='physical booked']")).toHaveCount(1);

  // incident
  await page.click("a:has-text('Incidents')");
  await page.click("button:has-text('Log incident')");
  const inc = page.getByRole("dialog");
  await inc.locator("select").first().selectOption("roadside_inspection");
  await inc.locator("select").nth(2).selectOption({ label: "Daniel Reyes" });
  await inc.locator("textarea").fill("Level 2 inspection at Laredo, no violations");
  await inc.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.locator("table")).toContainText("roadside inspection");
  await expect(page.locator("table")).toContainText("Daniel Reyes");
});
