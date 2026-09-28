// Features: F-10 F-5.12 carrier portal through the browser — link from the carrier record, offer accepted with a driver, load walked to delivered, rate con, invoice against the leg, COI upload lands in compliance, scorecard F-2.10
import { test, expect } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future, buildLoad, mxToUs } from "./helpers";

test("carrier's day: one link, accept the offer, run the load, get paid, keep documents current", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", taxId: "12-3456789" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "despacho@garza.test" });
  await quickAdd(page, "carrier-rates", "Add carrier rate", { carrierId: "Transportes Garza", originZone: "Monterrey", destinationZone: "Border yard", rateCents: "450" });
  await quickAdd(page, "document-types", "Add document type", { name: "Certificate of insurance", appliesTo: "carrier", tracksExpiry: "true" });
  await page.goto("/settings/document-types");
  await page.click("table a:has-text('Certificate')");
  await page.locator("#f-required").check();
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // the link lives on the carrier record with the scorecard
  await page.goto("/settings/carriers");
  await page.click("table a:has-text('Garza')");
  const url = (await page.getByTestId("portal-url").textContent())!.trim();
  expect(url).toMatch(/\/c\/[A-Za-z0-9_-]{20,}$/);
  await expect(page.locator("main")).toContainText("Scorecard");

  // an MX leg tendered by email to Garza
  await buildLoad(page, { customer: "RXO (broker)", rate: "2850", stops: mxToUs("Planta Monterrey", "GM Arlington") });
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign MX leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Transportes Garza (MX)" });
  await expect(dlg.getByTestId("carrier-pick")).toContainText("Last 90 days: 0 loads"); // the scorecard, on selection
  await expect(dlg.getByTestId("lane-rate")).toContainText("Monterrey → Border yard"); // the rate on file prefills
  await expect(dlg.locator("input[placeholder='what you pay them']")).toHaveValue("450.00");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender emailed");

  // the carrier's phone
  const ctx2 = await browser.newContext();
  const phone = await ctx2.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(new URL(url).pathname);
  await expect(phone.locator("body")).toContainText("Transportes Garza");
  await expect(phone.locator(".stage-tab", { hasText: "Offers" }).locator(".count")).toHaveText("1");
  const offer = phone.locator(".card", { hasText: "26-00001" });
  await expect(offer).toContainText("USD 450.00");
  await expect(offer).toContainText("Planta Monterrey");
  await offer.locator("button:has-text('Accept · Aceptar')").click();
  await offer.locator("button:has-text('Confirm accept')").click();
  await expect(phone.locator("body")).toContainText("name"); // refused without a name
  await offer.getByPlaceholder("Your name · Tu nombre").fill("Luis");
  await offer.getByPlaceholder("Driver name · Nombre del operador").fill("Pedro Ruiz");
  await offer.getByPlaceholder("Unit · Unidad").fill("MX-77");
  await offer.locator("button:has-text('Confirm accept')").click();
  await expect(phone.locator("body")).toContainText("Accepted 26-00001");
  await phone.click(".stage-tab:has-text('Loads')");
  const load = phone.locator(".card", { hasText: "26-00001" });
  await expect(load).toContainText("Pedro Ruiz");
  await expect(load).toContainText("unit MX-77");
  // rate con PDF
  const rc = await phone.request.get(await load.locator("a:has-text('Rate confirmation PDF')").getAttribute("href").then((h) => h!));
  expect(rc.status()).toBe(200);
  expect(rc.headers()["content-type"]).toContain("application/pdf");
  // the office sees the acceptance and the driver
  await page.reload();
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]").first().click();
  await expect(panel).toContainText("Luis accepted · driver Pedro Ruiz");
  // the carrier's dispatcher takes the first steps from the portal
  for (const label of ["Rolling to pickup", "Arrived at pickup"]) {
    const btn = load.locator("button.btn-primary.btn-lg");
    await expect(btn).toContainText(label);
    await btn.click();
    await phone.waitForTimeout(300);
  }
  await expect(load.getByTestId("driver-link")).toContainText("Your driver's link");
  // ...and their driver the rest, from the link our dispatcher can also send from the Track popup
  await panel.locator("button:has-text('Track')").click();
  const links = page.getByRole("dialog").getByTestId("carrier-driver-links");
  await expect(links).toContainText("Pedro Ruiz");
  const gUrl = await links.locator("a:has-text('Preview')").getAttribute("href");
  expect(gUrl).toMatch(/\/g\//);
  await page.keyboard.press("Escape");
  const ctx3 = await browser.newContext({ geolocation: { latitude: 25.68, longitude: -100.31 }, permissions: ["geolocation"] });
  const driver = await ctx3.newPage();
  await driver.setViewportSize({ width: 390, height: 844 });
  await driver.goto(gUrl!);
  await expect(driver.locator("body")).toContainText("Pedro Ruiz");
  await expect(driver.locator("body")).toContainText("Transportes Garza");
  await expect(driver.locator("span.pill", { hasText: "GPS on" })).toBeVisible({ timeout: 10000 });
  const big = driver.locator("button.btn-primary").first();
  for (const label of ["Loaded — leaving", "En route to delivery", "Arrived at delivery"]) {
    await expect(big).toContainText(label);
    await big.click();
    await driver.waitForTimeout(400);
  }
  // the drop at the border yard for the crossing truck: the caja number, the seal and a photo (M18), no POD
  const drop = driver.getByTestId("caja-drop");
  await expect(drop).toContainText("Leaving the caja at Border yard (MX)");
  await driver.getByTestId("photo-POD").locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await expect(driver.getByTestId("photo-POD")).toContainText("✓ POD on file", { timeout: 10000 });
  await big.click();
  await expect(driver.locator(".error")).toContainText("caja number");
  await drop.getByLabel("Caja number").fill("caja-7702");
  await driver.getByLabel("Seal on the caja").fill("sm-448812");
  await driver.getByTestId("photo-caja").locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await expect(driver.getByTestId("photo-caja")).toContainText("✓ Caja photo on file", { timeout: 10000 });
  await big.click();
  await expect(driver.locator("body")).toContainText("Done — thank you");
  await ctx3.close();
  await phone.reload();
  await phone.click(".stage-tab:has-text('Loads')");
  await expect(phone.locator("body")).toContainText("Nothing assigned right now");
  // the office: verified steps and a last position on the customer's tracking page, from a partner carrier's leg
  await page.reload();
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]").first().click();
  await expect(panel.locator(".rounded-lg.border").first()).toContainText("Delivered");
  await panel.locator("button:has-text('Track')").click();
  const trackUrl = await page.getByRole("dialog").locator("input[readonly]").first().inputValue();
  await page.keyboard.press("Escape");
  const cust = await browser.newPage();
  await cust.goto(trackUrl);
  await expect(cust.locator("body")).toContainText("Last known position");
  await expect(cust.locator("body")).not.toContainText("450");
  await cust.close();

  // pay: the delivered load is waiting for their invoice
  await phone.click(".stage-tab:has-text('Pay')");
  const pay = phone.locator(".card", { hasText: "26-00001" });
  await expect(pay).toContainText("Send your invoice");
  await expect(pay).toContainText("✓ POD on file");
  await pay.locator("button:has-text('Send invoice')").click();
  const inv = phone.getByRole("dialog");
  await expect(inv.locator("input[name=amount]")).toHaveValue("450.00");
  await inv.locator("input[name=invoiceNumber]").fill("G-1001");
  await inv.locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "invoice.pdf"));
  await inv.locator("button:has-text('Send · Enviar')").click();
  await expect(phone.locator("body")).toContainText("Invoice received");
  await expect(phone.locator(".card", { hasText: "26-00001" })).toContainText("under review");
  // the office sees it received with the three-way check
  await page.goto("/billing/carriers");
  const row = page.locator("tr", { hasText: "Transportes Garza" });
  await expect(row).toContainText("received");
  await expect(row).toContainText("G-1001");
  await expect(row).toContainText("POD ✓"); // the carrier's own POD satisfies the three-way check

  // documents: the COI is missing → upload from the portal → compliance goes green on both sides
  await phone.click(".stage-tab:has-text('Documents')");
  await expect(phone.locator("body")).toContainText("missing · falta");
  await phone.locator("select[name=documentTypeId]").selectOption({ label: "Certificate of insurance" });
  await phone.locator("input[type=file]").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await phone.locator("input[name=expiresAt]").fill(future(300));
  await phone.locator("input[name=number]").fill("POL-9");
  await phone.locator("button:has-text('Upload · Subir')").click();
  await expect(phone.locator("body")).toContainText("Document received");
  await expect(phone.locator("body")).toContainText("1 document to update"); // the optional CAAT date is still blank
  await expect(phone.locator("body")).toContainText("#POL-9");
  await page.goto("/compliance?tab=carrier");
  await expect(page.locator("tr", { hasText: "Transportes Garza" })).toContainText("dispatchable");
  // scorecard on both sides
  await expect(phone.locator("body")).toContainText("100%"); // accepted 1/1
  await page.goto("/settings/carriers");
  await page.click("table a:has-text('Garza')");
  await expect(page.locator("main")).toContainText("accepted · 1/1 answered");
  await ctx2.close();
});
