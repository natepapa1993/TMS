// Features: F-3.9 F-6 F-5.11 compliance through the browser — rule, blocked driver on the board and in the picker, upload from the record, a renewal from the driver's phone confirmed by safety, snooze, 24h override, export, incidents F-6.9 F-25.6
import { test, expect } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future, buildLoad, mxToUs } from "./helpers";

test("safety director day: a blocking rule, the driver goes red everywhere, the driver's photo waits for safety, upload fixes it, export, incident", async ({ page, browser }) => {
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
  await page.locator("#f-blockLevel").selectOption("override");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  // a rule that starts blocking gets 14 days' grace (safety N9); clearing the date enforces it now
  await expect(page.locator("#f-graceUntil")).toHaveValue(future(14));
  await page.locator("#f-graceUntil").fill("");
  await page.click("button:has-text('Save changes')");
  await expect.poll(async () => (await page.reload(), page.locator("#f-graceUntil").inputValue())).toBe("");

  // board: blocked
  await page.goto("/compliance");
  await expect(page.locator("main")).toContainText("Blocked from dispatch");
  const row = page.locator("tr", { hasText: "Daniel Reyes" });
  await expect(row).toContainText("blocked");
  await expect(row).toContainText("missing");
  await expect(row.locator(".pill-amber", { hasText: /\w{3} \d/ })).toHaveCount(1); // medical field expiring shows the date

  // dispatch picker: red with the reason
  await buildLoad(page, { customer: "RXO (broker)", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }] });
  await page.locator("aside").last().locator("button:has-text('Assign Domestic leg')").click();
  const cand = page.getByRole("dialog").locator(".cursor-pointer", { hasText: "2104" });
  await expect(cand).toContainText("needs override");
  await expect(cand).toContainText("Medical card missing");
  await page.keyboard.press("Escape");

  // the driver photographs the card from the app: it waits for safety, and the driver stays blocked until then
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  const appUrl = await page.getByTestId("driver-app-url").textContent();
  const phone = await browser.newPage();
  await phone.goto(appUrl!);
  const own = phone.getByTestId("own-docs");
  await expect(own).toContainText("Medical card");
  await expect(own).toContainText("missing · falta");
  await own.locator("button:has-text('Send the new one')").first().click();
  await own.locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await own.locator("input[name=expiresAt]").fill(future(300));
  await own.locator("input[name=number]").fill("MED-77");
  await own.locator("button:has-text('Send · Enviar')").click();
  await expect(own).toContainText("the office is checking it");
  await page.goto("/compliance");
  await expect(page.getByTestId("pending-uploads")).toContainText("1 document sent from the driver app");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" })).toContainText("blocked"); // nothing counts yet
  await page.getByTestId("pending-uploads").locator("a").click();
  await page.waitForURL("**/settings/drivers/**");
  await expect(page.locator("#documents")).toContainText("Blocked");
  // sent back once (wrong side), then a second photo confirmed
  const pend = page.getByTestId("pending-docs");
  await expect(pend).toContainText("bol.pdf");
  await pend.locator("button:has-text('Send back')").click();
  await pend.getByLabel("Reason").fill("that is the back of the card");
  await pend.locator("button:has-text('Reject')").click();
  await expect(page.getByRole("status")).toContainText("Sent back to the driver");
  await phone.reload();
  await expect(phone.getByTestId("own-docs")).toContainText("that is the back of the card");
  await phone.getByTestId("own-docs").locator("button:has-text('Send the new one')").first().click();
  await phone.getByTestId("own-docs").locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await phone.getByTestId("own-docs").locator("input[name=expiresAt]").fill(future(300));
  await phone.getByTestId("own-docs").locator("button:has-text('Send · Enviar')").click();
  await expect(phone.getByTestId("own-docs")).toContainText("the office is checking it");
  await page.reload();
  await page.getByTestId("pending-docs").getByLabel("Number").fill("MED-77");
  await page.getByTestId("pending-docs").locator("button:has-text('Confirm')").click();
  await expect(page.getByRole("status")).toContainText("Confirmed");
  await expect(page.locator("#documents")).toContainText("Dispatchable");
  await expect(page.locator("#documents")).toContainText("#MED-77");
  await phone.reload();
  // the card is on file; what remains is the medical date expiring in 12 days, which the driver can renew from the phone too
  await expect(phone.getByTestId("own-docs")).not.toContainText("missing · falta");
  await expect(phone.getByTestId("own-docs").locator("button:has-text('Send the new one')")).toHaveCount(1);
  await phone.close();
  // the office can also upload a renewal from the record (the manual path stays)
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await expect(page.locator("#documents")).toContainText("Dispatchable");
  await page.locator("#documents").locator("button:has-text('upload')").first().click();
  const up = page.getByRole("dialog");
  await up.locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await up.locator("button:has-text('Read with AI')").click(); // offered before the upload; honest when nothing is connected
  await expect(up.getByTestId("ai-read")).toContainText("not connected");
  await up.locator("input[name=expiresAt]").fill(future(200));
  await up.locator("input[name=number]").fill("MED-78");
  await up.locator("button:has-text('Upload')").last().click();
  await expect(page.getByRole("status")).toContainText("compliance re-run");
  await expect(page.locator("#documents")).toContainText("Dispatchable");
  await expect(page.locator("#documents")).toContainText("#MED-78");
  await expect(page.locator("#documents")).not.toContainText("#MED-77"); // superseded

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
  await r2.locator("button:has-text('Snooze')").first().click();
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

test("fleet: a trailer added from Fleet shows free, then on the load it is named on", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await page.goto("/fleet");
  await page.click("button:has-text('Add trailer')");
  const d = page.getByRole("dialog");
  await d.locator("#f-unitNumber").fill("10743");
  await d.locator("button:has-text('Add')").click();
  await expect(d).toBeHidden();
  const row = page.getByTestId("trailers").locator("tr", { hasText: "10743" });
  await expect(row).toContainText("free");
  await expect(row).toContainText("never on a load");
  // the caja is named on a crossing → the trailer is on that load
  await buildLoad(page, { customer: "RXO (broker)", stops: mxToUs("Planta Monterrey", "GM Arlington") });
  await page.goto("/crossing");
  await page.locator("a[href^='/crossing/']").first().click();
  await page.waitForURL("**/crossing/**", { waitUntil: "commit" });
  await page.locator("#x-trailer").fill("10743");
  await page.locator("button.btn-primary:has-text('Save')").first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.goto("/fleet");
  await expect(page.getByTestId("trailers").locator("tr", { hasText: "10743" })).toContainText("Crossing");
  await expect(page.getByTestId("trailers").locator("tr", { hasText: "10743" })).toContainText("26-00001");
});
