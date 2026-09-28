// Features: F-7 F-7.2 F-9 billing & settlements through the browser, ending with the QuickBooks export and the owner's reports — charges, docs gate, invoice issue/send/receipt, AR, carrier bill three-way, driver statement, driver app pay, company settings F-26.2
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future, buildLoad, step, confirmStamp } from "./helpers";

const POD = path.join(__dirname, "fixtures", "bol.pdf");

async function masterData(page: Page) {
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", taxId: "12-3456789" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "dispatch@lonestar.test", mcNumber: "700100" });
  // driver: paperwork, on the truck, paid per mile
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.locator("#f-payType").selectOption("per_mile");
  await page.locator("#f-payRateCents").fill("0.62");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  // customer: only POD + RATE_CON before invoicing, 1 h free time (master data, not code)
  await page.goto("/settings/customers");
  await page.click("table a:has-text('RXO')");
  await page.locator("#f-requiredDocs").fill("POD, RATE_CON");
  await page.locator("#f-requiredRefs").fill("PO");
  await page.locator("#f-detentionFreeMinutes").fill("60");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.locator("#f-requiredDocs")).toHaveValue("POD, RATE_CON");
  // carrier: 2% quick pay
  await page.goto("/settings/carriers");
  await page.click("table a:has-text('Lone Star')");
  await page.locator("#f-quickPayPct").fill("2");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

/** A domestic order for RXO at `rate`, created from the dispatch board. */
async function newDomestic(page: Page, rate: string) {
  await buildLoad(page, { customer: "RXO (broker)", rate: rate, stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }] });
  const num = (await page.locator("aside .h2").first().textContent())!.match(/\d{2}-\d{5}/)![0];
  return num;
}

async function walkToDelivered(page: Page, orderNumber: string, steps = 7) {
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]", { hasText: orderNumber }).click();
  const panel = page.locator("aside").last();
  for (let i = 0; i < steps; i++) {
    await step(panel);
    await page.waitForTimeout(200);
  }
}

test("billing day: charges, docs gate, invoice to paid, AR, carrier three-way with quick pay, driver statement and pay in the app", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signupFresh(page);
  await masterData(page);

  // ---- order 1: our truck, 420 planned miles, delivered
  const o1 = await newDomestic(page, "1800");
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  let dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2104" }).click();
  await dlg.locator("#plan-miles").fill("420");
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  await walkToDelivered(page, o1);
  await expect(page.locator(".stage-tab:has-text('Delivered') .count")).toHaveText("1");

  // ---- order 2: partner carrier by phone at $450, delivered
  const o2 = await newDomestic(page, "900");
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Lone Star Freight (US)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("450");
  await dlg.locator("select").nth(1).selectOption("phone");
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Marked sent");
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]", { hasText: o2 }).click();
  for (const label of ["Accepted", "Rolling to pickup", "Arrived at pickup", "Loaded", "En route", "Arrived at delivery", "Delivered"]) {
    await panel.locator(`.rounded-lg.border >> nth=0 >> button:has-text('${label}')`).click();
    await confirmStamp(panel);
    await expect(page.getByRole("status")).toBeVisible();
    await page.waitForTimeout(150);
  }
  await expect(page.locator(".stage-tab:has-text('Delivered') .count")).toHaveText("2");

  // ---- order page: line haul from the rate con, add a lumper, P&L shows the miles
  await page.click(".stage-tab:has-text('Delivered')");
  await page.locator(".row[role=button]", { hasText: o1 }).click();
  await panel.locator("summary:has-text('Details')").click();
  await panel.locator("a:has-text('Open order')").click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await page.getByTestId("tab-money").click();
  const charges = page.locator("#charges");
  await expect(charges).toContainText("Line haul");
  await expect(charges).toContainText("$1,800.00");
  await expect(page.locator("input[aria-label='Planned miles']").first()).toHaveValue("420");
  await charges.locator("select").first().selectOption("lumper");
  await charges.locator("input[inputmode=decimal]").last().fill("50");
  await charges.locator("button:has-text('Add')").click();
  await expect(page.getByRole("status")).toContainText("Charge added");
  // the lumper is an extra: it waits for RXO's OK before it bills
  await expect(page.getByTestId("charges-waiting")).toContainText("1 extra");
  await expect(charges).toContainText("$1,800.00");
  await expect(charges).toContainText("420 mi");

  // ---- billing queue: the extra approved (who and how), then the docs gate, both from the queue
  await page.goto("/billing");
  const row1 = page.locator("tr", { hasText: o1 });
  await expect(row1.getByTestId("to-approve")).toContainText("+$50.00 to approve (1)");
  await row1.getByTestId("to-approve").click();
  const ap = page.getByRole("dialog");
  await ap.locator("#ap-by").fill("Maria at RXO");
  await ap.locator("#ap-ref").fill("phone call, email on file");
  await ap.locator("button:has-text('Approve')").click();
  await expect(ap).toBeHidden();
  await expect(row1.getByTestId("to-approve")).toHaveCount(0);
  await expect(row1).toContainText("$1,850.00");
  for (const code of ["POD", "RATE CON"]) {
    await page.locator("tr", { hasText: o1 }).locator(`button.pill-red:has-text('${code}')`).click();
    const up = page.getByRole("dialog");
    await up.locator("input[type=file]").setInputFiles(POD);
    await up.locator("button:has-text('Upload')").last().click();
    await expect(up).toBeHidden();
  }
  await expect(page.locator("tr", { hasText: o1 }).locator("button.pill-red")).toHaveCount(0);
  // RXO also requires its PO on the order: the red reference pill opens the order to add it
  await expect(page.locator("tr", { hasText: o1 }).getByTestId("bill-one")).toBeDisabled();
  await page.locator("tr", { hasText: o1 }).locator("a.pill-red:has-text('po #')").click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.locator("#charges")).toContainText("po # missing");
  await page.getByLabel("PO reference").fill("5700489439");
  await page.click("button:has-text('Save details')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(page.locator("#charges")).toContainText("po # ✓");
  await page.goto("/billing");
  await expect(page.locator("tr", { hasText: o1 }).locator(".pill-red")).toHaveCount(0);
  await page.locator("tr", { hasText: o1 }).locator("button:has-text('Draft')").click();
  await expect(page.getByRole("status")).toContainText("Draft invoice created");

  // ---- invoice: issue → number, send, partial receipt, AR, full receipt → paid
  await page.locator("tr", { hasText: o1 }).locator("a:has-text('Open draft')").click();
  await page.waitForURL("**/billing/invoices/**", { waitUntil: "commit" });
  await page.click("button:has-text('Issue invoice')");
  await expect(page.getByRole("status")).toContainText("Issued");
  await expect(page.locator("main")).toContainText("247-000001");
  await expect(page.locator("main")).toContainText("$1,850.00");
  await page.click("button:has-text('Send invoice')");
  await expect(page.getByRole("dialog").locator("input[type=email]")).toHaveValue("ap@rxo.test");
  await page.getByRole("dialog").locator("button:has-text('Send')").click();
  await expect(page.getByRole("status")).toContainText("Sent");
  await page.click("button:has-text('Record receipt')");
  let rc = page.getByRole("dialog");
  await rc.locator("input[inputmode=decimal]").fill("1000");
  await rc.locator("button:has-text('Record')").click();
  await expect(page.getByRole("status")).toContainText("Receipt recorded");
  await expect(page.locator("main")).toContainText("partially paid");
  await page.goto("/billing/ar");
  await expect(page.locator("main")).toContainText("RXO");
  await expect(page.locator("main")).toContainText("$850.00");
  await page.goBack();
  await page.click("button:has-text('Record receipt')");
  rc = page.getByRole("dialog");
  await rc.locator("input[inputmode=decimal]").fill("850");
  await rc.locator("button:has-text('Record')").click();
  await expect(page.getByRole("status")).toContainText("Receipt recorded");
  await expect(page.locator("main .pill", { hasText: /^paid$/ })).toBeVisible();
  await expect(page.locator("main")).toContainText("Open$0.00");
  await expect(page.locator("button:has-text('Record receipt')")).toHaveCount(0);

  // ---- carrier bills: expected from the phone rate, record the invoice, three-way, approve, pay with the 2% quick-pay
  await page.goto("/billing/carriers");
  const cb = page.locator("tr", { hasText: "Lone Star Freight" });
  await expect(cb).toContainText("$450.00");
  await expect(cb).toContainText("expected");
  await cb.locator("button:has-text('Record invoice')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("input[inputmode=decimal]").first().fill("450");
  await dlg.locator("input").nth(1).fill("GZ-1001");
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Recorded");
  await page.locator("tr", { hasText: "Lone Star Freight" }).locator("button:has-text('Approve')").click();
  dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("no POD on the order");
  await dlg.locator("button:has-text('Approve')").last().click();
  await expect(page.getByRole("status")).toContainText(/POD/);
  await dlg.locator("label:has-text('Approve without a POD') input").check();
  await dlg.locator("button:has-text('Approve')").last().click();
  await expect(page.getByRole("status")).toContainText("Approved");
  await page.locator("tr", { hasText: "Lone Star Freight" }).locator("button:has-text('Pay')").click();
  await page.getByRole("dialog").locator("button:has-text('Mark paid')").click();
  await expect(page.getByRole("status")).toContainText("Paid");
  await expect(page.locator("tr", { hasText: "Lone Star Freight" })).toContainText("$441.00"); // 2% off within 7 days

  // ---- driver statement: 420 mi × $0.62, deduction, reviewed → approved → the driver sees it and disputes → paid
  await page.goto("/billing/settlements");
  const drvSel = page.locator("select").first();
  await drvSel.selectOption({ label: (await drvSel.locator("option", { hasText: "Daniel Reyes" }).textContent())! });
  await page.locator("button:has-text('+ Pay item')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("label:has-text('Description') + input").fill("Occupational insurance");
  await dlg.locator("input[inputmode=decimal]").first().fill("45");
  await dlg.locator("label:has-text('Recurring') input").check();
  await dlg.locator("button:has-text('Add')").click();
  await expect(page.getByRole("status")).toContainText("Pay item added");
  // the week is prefilled with the company's current week (company time zone, not the server's)
  await expect(page.locator("input[type=date]")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.click("button:has-text('Build statement')");
  await expect(page.getByRole("status")).toContainText("Statement built");
  const srow = page.locator("tr", { hasText: "Daniel Reyes" });
  await expect(srow).toContainText("$260.40");
  await expect(srow).toContainText("$215.40");
  await srow.click();
  dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("420 mi");
  await dlg.locator("button:has-text('Mark reviewed')").click();
  await expect(page.getByRole("status")).toContainText("Reviewed");
  await dlg.locator("button:has-text('Approve')").click();
  await expect(page.getByRole("status")).toContainText("driver can see it");
  await page.keyboard.press("Escape");

  // driver app link from Fleet
  await page.goto("/fleet");
  await page.locator("button:has-text('App link')").first().click();
  const toast = page.getByRole("status");
  await expect(toast).toContainText(/\/d\/|copied/);
  const driverUrl = (await toast.textContent())!.match(/https?:\/\/\S+\/d\/\S+/)?.[0];
  expect(driverUrl).toMatch(/\/d\//);
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(new URL(driverUrl!).pathname); // baseURL; APP_URL may differ on a laptop
  await expect(phone.locator("body")).toContainText("Your pay");
  await expect(phone.locator("body")).toContainText("$215.40");
  await expect(phone.locator("body")).toContainText("Approved");
  await phone.locator("button[aria-expanded]").first().click();
  await expect(phone.locator("body")).toContainText("Occupational insurance");
  await phone.locator("button:has-text('Something wrong?')").first().click();
  await phone.locator("textarea").fill("I ran 480 miles, not 420");
  await phone.locator("button:has-text('Send · Enviar')").click();
  await expect(phone.locator("body")).toContainText("Disputed: I ran 480");
  await expect(phone.locator("body")).toContainText("In review");
  await phoneCtx.close();

  // office sees the dispute, fixes the miles, re-approves, pays
  await page.goto("/billing/settlements");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" })).toContainText("dispute");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" })).toContainText("reviewed");
  await page.locator("tr", { hasText: "Daniel Reyes" }).click();
  dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("I ran 480 miles");
  await dlg.locator("select").last().selectOption("adjustment");
  await dlg.locator("label:has-text('Description') + input").fill("60 extra miles per the driver");
  await dlg.locator("input[inputmode=decimal]").last().fill("37.20");
  await dlg.locator("button:text-is('Add')").click();
  await expect(page.getByRole("status")).toContainText("Line added");
  await dlg.locator("button:has-text('Approve')").click();
  await expect(page.getByRole("status")).toContainText("driver can see it");
  await dlg.locator("input[placeholder='reference']").fill("ACH-77");
  await dlg.locator("button:has-text('Mark paid')").click();
  await expect(page.getByRole("status")).toContainText("Paid");
  await page.keyboard.press("Escape");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" })).toContainText("$252.60");
  await expect(page.locator("tr", { hasText: "Daniel Reyes" })).toContainText("paid");

  // ---- company settings: fuel cost per mile changes the P&L
  await page.goto("/settings/company");
  await page.locator("#c-fuel").fill("0.80");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.goto("/orders");
  await page.locator("a", { hasText: o1 }).first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.locator("#charges")).toContainText("$336.00"); // 420 × 0.80

  // ---- QuickBooks: preview counts the month, the IIF balances, the second run finds nothing new
  await page.goto("/billing/exports");
  await expect(page.getByTestId("export-preview")).toContainText("1 invoices ($1,850.00) · 2 receipts ($1,850.00) · 1 carrier bills · 1 driver settlements");
  await page.click("button:has-text('Create export')");
  await expect(page.getByRole("status")).toContainText("Export ready — 1 invoices, 2 receipts, 1 carrier bills, 1 settlements");
  const iifHref = await page.locator("a:has-text('.iif')").first().getAttribute("href");
  const iif = await (await page.request.get(iifHref!)).text();
  expect(iif).toContain("CUST\tRXO");
  expect(iif).toContain("VEND\tLone Star Freight");
  expect(iif).toMatch(/TRNS\t\tINVOICE\t.*\tAccounts Receivable\tRXO\t\t1850\.00\t247-000001/);
  expect(iif).toMatch(/TRNS\t\tBILLPMT\t.*\t-441\.00\t/);
  await expect(page.getByTestId("export-preview")).toContainText("Nothing in that period that has not been exported");
  await expect(page.locator("button:has-text('Create export')")).toBeDisabled();
  await page.locator("label:has-text('Only what has not been exported yet') input").uncheck();
  await expect(page.getByTestId("export-preview")).toContainText("1 invoices");

  // ---- reports: the six numbers from the same loads; drill-down to the order
  await page.goto("/reports");
  const six = page.getByTestId("six");
  await expect(six).toContainText("$2,750.00"); // 1,850 + 900 on one active unit
  await expect(six).toContainText("2 loads");
  await expect(six.locator("a", { hasText: "Margin" })).toContainText(/\d+(\.\d)?%/);
  const truckRow = page.locator("tr", { hasText: "Unit 2104" });
  await expect(truckRow).toContainText("$1,850.00");
  await expect(truckRow).toContainText("420");
  await page.click(".stage-tab:has-text('By carrier')");
  await expect(page.locator("tr", { hasText: "Lone Star Freight" })).toContainText("$900.00");
  await expect(page.locator("tr", { hasText: "Lone Star Freight" })).toContainText("$441.00"); // what we paid, after quick-pay
  await page.click(".stage-tab:has-text('By customer')");
  await page.locator("tr", { hasText: "RXO" }).click();
  await expect(page.getByRole("dialog")).toContainText("RXO · 2 loads");
  await expect(page.getByRole("dialog")).toContainText(o1);
  await expect(page.getByRole("dialog")).toContainText(o2);
  await page.keyboard.press("Escape");
  const csv = await (await page.request.get(`/api/reports?by=truck&from=${new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400_000).toISOString().slice(0, 10)}`)).text();
  expect(csv.split("\n")[0]).toBe("truck,loads,revenue,cost,margin,margin_pct,miles");
  expect(csv).toContain("Unit 2104,1,1850.00,");
});
