// Features: F-4 F-5 F-5.11 — tender by email link, driver app (steps, seal + POD photos, a line to dispatch), customer tracking link, all through the browser
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future } from "./helpers";

async function fleet(page: Page) {
  await page.goto("/settings/company");
  await page.locator("#c-dispatch").fill("+1 313 555 0100");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "despacho@garza.test" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown" });
  await quickAdd(page, "drivers", "Add driver", { name: "Benjamín Xochihua", driverType: "B1", phone: "+52 867 111 2222" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Benjamín')");
  for (const [f, d] of [["mxLicenseExpires", 400], ["fastExpires", 400], ["i94Until", 120], ["medicalExpires", 300], ["licenseExpires", 400]] as const) await page.locator(`#f-${f}`).fill(future(d));
  await page.locator("#f-currentTruckId").selectOption({ label: "2117" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

async function newOrder(page: Page) {
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.getByPlaceholder("blank = TBD").fill("2850");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
}

test("tender by email: carrier opens the link, accepts with driver details; dispatcher sees it on the leg", async ({ page, browser }) => {
  await signupFresh(page);
  await fleet(page);
  await newOrder(page);
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign MX leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Transportes Garza (MX)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("450");
  await dlg.getByPlaceholder(/Team drivers/).fill("Appointment is firm.");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender emailed to despacho@garza.test");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  await expect(panel).toContainText("Tender out");
  await expect(panel).toContainText("min left");

  // the carrier's side: the same link the email carries is on the leg card for the dispatcher
  const url = (await panel.locator("a:has-text('Link')").getAttribute("href"))!;
  expect(url).toMatch(/\/t\//);

  const ctx2 = await browser.newContext();
  const carrier = await ctx2.newPage();
  await carrier.goto(url);
  await expect(carrier.locator("body")).toContainText("Transportes Garza, can you cover this?");
  await expect(carrier.locator("body")).toContainText("USD 450.00");
  await expect(carrier.locator("body")).toContainText("Appointment is firm.");
  await carrier.click("button:has-text('Yes, accept')");
  await carrier.locator("input").first().fill("Luis");
  await carrier.click("button:has-text('Confirm')");
  await expect(carrier.locator(".error")).toContainText(/driver name/i);
  await carrier.locator("#f-driverName, input").nth(1).fill("Pedro Ruiz");
  await carrier.locator("input").nth(2).fill("+52 81 000 0000");
  await carrier.locator("input").nth(3).fill("MX-45");
  await carrier.click("button:has-text('Confirm')");
  await expect(carrier.locator("body")).toContainText("it's yours");
  await expect(carrier.locator("body")).toContainText("Pedro Ruiz");
  await carrier.reload();
  await expect(carrier.locator("body")).toContainText("Accepted");
  await ctx2.close();

  await page.reload();
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  await expect(panel.locator(".rounded-lg.border").first()).toContainText("Accepted");
  await expect(panel).toContainText("Luis accepted");
  await expect(panel).toContainText("driver Pedro Ruiz");
});

test("driver app: link from Fleet, one button per step with GPS, customer tracking link shows the progress", async ({ page, browser }) => {
  await signupFresh(page);
  await fleet(page);
  await newOrder(page);
  const panel = page.locator("aside").last();
  // crossing on 2117 with Benjamín, sent
  await panel.locator(".rounded-lg.border >> nth=1 >> button:has-text('Assign')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2117" }).click();
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");

  // Track popup gives both links (the order stays in Pending: its MX leg still needs a carrier — per-leg dispatch)
  await expect(page.locator(".stage-tab:has-text('Pending') .count")).toHaveText("1");
  await panel.locator("button:has-text('Track')").click();
  const track = page.getByRole("dialog");
  const trackUrl = await track.locator("input[readonly]").inputValue();
  expect(trackUrl).toMatch(/\/track\//);
  await expect(track).toContainText("Benjamín Xochihua");
  const preview = track.locator("a:has-text('Preview')");
  const driverUrl = await preview.getAttribute("href");
  expect(driverUrl).toMatch(/\/d\//);
  await page.keyboard.press("Escape");

  // the driver's phone
  const ctx2 = await browser.newContext({ geolocation: { latitude: 27.5064, longitude: -99.5075 }, permissions: ["geolocation"] });
  const phone = await ctx2.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(driverUrl!);
  await expect(phone.locator("body")).toContainText("Benjamín Xochihua");
  await expect(phone.locator("body")).toContainText("Border yard (MX)");
  await expect(phone.locator("body")).toContainText("Unit 2117");
  await expect(phone.locator("span.pill", { hasText: "GPS on" })).toBeVisible({ timeout: 10000 });
  await expect(phone.getByTestId("dispatch-links").locator("a[href='tel:+13135550100']")).toBeVisible(); // the company's dispatch number, one tap
  const big = phone.locator("button.btn-primary").first();
  const bol = path.join(__dirname, "fixtures", "bol.pdf");
  for (const label of ["Accept this load", "Rolling to pickup", "Arrived at pickup"]) {
    await expect(big).toContainText(label);
    await big.click();
    await phone.waitForTimeout(400);
  }
  // a line to dispatch while loading
  await phone.getByPlaceholder("Message dispatch · Mensaje a despacho").fill("Shipper says 40 min more");
  await phone.getByTestId("chat").locator("button:has-text('Send')").click();
  await expect(phone.getByTestId("chat")).toContainText("Shipper says 40 min more");
  await expect(phone.getByTestId("chat")).toContainText("sent · enviado");
  // seal photo while loading: one tap, a check
  await expect(big).toContainText("Loaded — leaving");
  await expect(phone.getByTestId("photo-POD")).toHaveCount(0);
  await phone.getByTestId("photo-SEAL_PHOTO").locator("input[type=file]").setInputFiles(bol);
  await expect(phone.getByTestId("photo-SEAL_PHOTO")).toContainText("✓ Seal · Sello on file", { timeout: 10000 });
  for (const label of ["Loaded — leaving", "En route to delivery", "Arrived at delivery"]) {
    await expect(big).toContainText(label);
    await big.click();
    await phone.waitForTimeout(400);
  }
  // at the delivery: the POD photo is asked for before the last button
  await expect(big).toContainText("Delivered — empty");
  await expect(phone.locator("body")).toContainText("No POD photo yet");
  await phone.getByTestId("photo-POD").locator("input[type=file]").setInputFiles(bol);
  await expect(phone.getByTestId("photo-POD")).toContainText("✓ POD on file", { timeout: 10000 });
  await expect(phone.locator("body")).not.toContainText("No POD photo yet");
  await big.click();
  await phone.waitForTimeout(400);
  await expect(phone.locator("body")).toContainText("Nothing assigned right now");

  // the customer's tracking page
  const cust = await ctx2.newPage();
  await cust.goto(trackUrl);
  await expect(cust.locator("body")).toContainText("shipment tracking");
  await expect(cust.locator("body")).toContainText("Laredo yard");
  await expect(cust.locator("body")).toContainText("Arrived");
  await expect(cust.locator("body")).toContainText("Last known position");
  await expect(cust.locator("body")).toContainText("GPS");
  await expect(cust.locator("body")).not.toContainText("2,850");
  await expect(cust.locator("body")).not.toContainText("+52 867");
  await cust.getByTestId("lang").click(); // Spanish, one tap
  await expect(cust.locator("body")).toContainText("rastreo de embarque");
  await expect(cust.locator("body")).toContainText("Entregado");
  await expect(cust.locator("body")).toContainText("Última posición conocida");
  await ctx2.close();

  // dispatcher sees verified events and the US leg is next
  await page.reload();
  await page.click(".stage-tab:has-text('Pending')");
  await page.click(".row[role=button]");
  await expect(panel.locator(".rounded-lg.border").nth(1)).toContainText("Delivered");
  await expect(panel).toContainText("Assign MX leg"); // MX leg was never covered; it is first in line

  // the photos are the order's documents; the message is in Messages, on the order, and the reply reaches the phone
  await page.goto("/messages");
  const row = page.locator("tr", { hasText: "Shipper says 40 min more" });
  await expect(row).toContainText("Benjamín Xochihua");
  await expect(row).toContainText("driver app");
  await expect(row).toContainText("26-00001");
  await row.locator("button:has-text('Reply')").click();
  await page.getByRole("dialog").getByLabel("Reply").fill("OK, tell them we need to leave by 3");
  await page.getByRole("dialog").locator("button:has-text('Send')").click();
  await expect(page.getByRole("status")).toContainText("the driver sees it in the app");
  await expect(page.locator("tr", { hasText: "Shipper says 40 min more" })).toHaveCount(0); // handled
  await expect(page.getByTestId("sent-log")).toContainText("Reply to driver");
  await page.goto("/orders");
  await page.click("a:has-text('26-00001')");
  await expect(page.locator("body")).toContainText("SEAL_PHOTO");
  await expect(page.locator("body")).toContainText("POD");
  await expect(page.locator("body")).toContainText("POD photo from the driver app at Laredo yard");
  await expect(page.locator("body")).toContainText("Dispatch to Benjamín Xochihua: OK, tell them");
  const ctx3 = await browser.newContext();
  const phone2 = await ctx3.newPage();
  await phone2.goto(driverUrl!);
  await expect(phone2.getByTestId("chat")).toContainText("OK, tell them we need to leave by 3");
  await expect(phone2.getByTestId("chat")).toContainText("seen by dispatch");
  await ctx3.close();
});

test("a revoked or random public link is refused politely", async ({ page }) => {
  await page.goto("/t/not-a-real-token-at-all-0000");
  await expect(page.locator("body")).toContainText("isn't valid");
  await page.goto("/d/not-a-real-token-at-all-0000");
  await expect(page.locator("body")).toContainText("isn't valid");
  await page.goto("/track/not-a-real-token-at-all-0000");
  await expect(page.locator("body")).toContainText("isn't valid");
});
