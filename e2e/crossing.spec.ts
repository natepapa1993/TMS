// Features: F-3 crossing through the browser — checklist, uploads with typed fields, cross-check failure + override, Solicitud de Retiro, packet, driver taps through the border
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future } from "./helpers";

const fx = (n: string) => path.join(__dirname, "fixtures", `${n}.pdf`);

async function fleet(page: Page) {
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "24/7 Expedite LLC", country: "US", taxId: "12-3456789", invoicePrefix: "247" });
  await quickAdd(page, "customs-brokers", "Add customs broker", { name: "Agencia Demo", country: "MX", patente: "3456" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await page.goto("/settings/customers");
  await page.click("table a:has-text('RXO')");
  await page.locator("#f-mxBrokerId").selectOption({ label: "Agencia Demo" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown" });
  await page.goto("/settings/trucks");
  await page.click("table a:has-text('2117')");
  await page.locator("#f-usPlateExpires").fill(future(300));
  await page.locator("#f-mxPlateExpires").fill(future(300));
  await page.locator("#f-scac").fill("TSEX");
  await page.locator("#f-dtopsYear").fill(String(new Date().getUTCFullYear()));
  await page.locator("#f-dtopsConfirmation").fill("DT-1");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await quickAdd(page, "drivers", "Add driver", { name: "Benjamín Xochihua", driverType: "B1", phone: "+52 867 111 2222" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Benjamín')");
  for (const [f, d] of [["mxLicenseExpires", 400], ["fastExpires", 400], ["i94Until", 120], ["medicalExpires", 300], ["licenseExpires", 400]] as const) await page.locator(`#f-${f}`).fill(future(d));
  await page.locator("#f-currentTruckId").selectOption({ label: "2117" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

async function upload(page: Page, label: string, file: string, fields: Record<string, string>) {
  const row = page.locator("li", { hasText: label }).first();
  await row.locator("button:has-text('Upload'), button:has-text('Replace')").first().click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("input[type=file]").setInputFiles(file);
  for (const [k, v] of Object.entries(fields)) await dlg.locator(`input[name='f_${k}']`).fill(v);
  await dlg.locator("button:has-text('Upload')").last().click();
  await expect(page.getByRole("status")).toContainText("Uploaded");
  await page.waitForTimeout(300);
}

test("border day: waiting on DODA → seal mismatch → override → packet → driver crosses; the board follows", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signupFresh(page);
  await fleet(page);
  // order + crossing assignment
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.getByPlaceholder("blank = TBD").fill("2850");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  const panel = page.locator("aside").last();
  await panel.locator(".rounded-lg.border >> nth=1 >> button:has-text('Assign')").click();
  await page.getByRole("dialog").locator(".cursor-pointer", { hasText: "2117" }).click();
  await page.getByRole("dialog").locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");

  // the crossing board already has it, waiting on the carta de retiro
  await page.goto("/crossing");
  await expect(page.locator(".stage-tab", { hasText: "Waiting on docs" }).locator(".count")).toHaveText("1");
  await expect(page.locator(".row", { hasText: "26-00001" })).toContainText("Carta de retiro");
  await page.click(".row:has-text('26-00001')");
  await page.waitForURL("**/crossing/**");

  // trailer number, then generate the Solicitud de Retiro
  await page.locator("input.mono").first().fill("10743");
  await page.locator("input.mono").nth(1).fill("S-771");
  await page.click("button:has-text('Save')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.click("button:has-text('Trailer is at the yard')");
  await expect(page.getByRole("status")).toContainText("Dwell clock");
  await page.locator("li", { hasText: "Carta de retiro" }).locator("button:has-text('Generate')").click();
  await page.getByRole("dialog").getByPlaceholder("Santa Fe Yard").fill("Santa Fe Yard");
  await page.getByRole("dialog").getByPlaceholder("name on the signature line").fill("Nate Papa");
  await page.getByRole("dialog").locator("button:has-text('Generate PDF')").click();
  await expect(page.getByRole("status")).toContainText("generated");
  await expect(page.locator("li", { hasText: "Carta de retiro" })).toContainText("verified");
  await expect(page.locator("iframe[title=document]")).toBeVisible();

  await upload(page, "Carta porte", fx("carta_porte"), { trailer: "10743", usPlate: "RC59022", mxPlate: "35ES3A", seal: "S-771", uuid: "AB12", grossWeight: "18200", pieces: "26" });
  await upload(page, "ACE e-Manifest", fx("ace_manifest"), { trailer: "10743", driver: "Benjamin Xochihua", usPlate: "RC59022", mxPlate: "35ES3A", scac: "TSEX", grossWeight: "18300", pieces: "26" });
  await upload(page, "Bill of lading", fx("bol"), { trailer: "10743", seal: "S-771", pieces: "26", grossWeight: "18250" });
  await upload(page, "Commercial invoice", fx("invoice"), { seal: "S-771", grossWeight: "18200", pieces: "26" });
  await expect(page.locator(".pill.pill-slate", { hasText: "Waiting on DODA" })).toBeVisible();
  await expect(page.locator(".pill.pill-amber", { hasText: "MX customs broker" })).toBeVisible();

  // DODA arrives with a different seal → check fails → owner overrides
  await upload(page, "DODA", fx("doda"), { trailer: "10743", seal: "S-772", uuid: "AB12", pedimento: "26 24 3456 6001234", patente: "3456" });
  await expect(page.locator("main")).toContainText("1 failing");
  await expect(page.locator("main")).toContainText("seal differs");
  await expect(page.locator("button:has-text('Build packet')")).toBeDisabled();
  await page.locator("li", { hasText: "Seal number matches" }).locator("button:has-text('Override')").click();
  await page.getByRole("dialog").locator("input").fill("seal replaced at the yard, S-772 recorded");
  await page.getByRole("dialog").locator("button:has-text('Override')").click();
  await expect(page.getByRole("status")).toContainText("Overridden");
  await expect(page.locator("main")).toContainText("all clear");
  await expect(page.locator(".pill", { hasText: "Eligibility OK" })).toBeVisible();

  // packet
  await page.click("button:has-text('Build packet')");
  await expect(page.getByRole("status")).toContainText("Packet built");
  await expect(page.locator(".pill", { hasText: "Ready to cross" })).toBeVisible();
  await page.click("button:has-text('Send to driver')");
  await expect(page.getByRole("status")).toContainText("Packet sent");
  await expect(page.locator("main")).toContainText("not opened yet");

  // the driver: opens the packet (ack), taps through the border
  await page.goto("/fleet");
  await page.locator("tr", { hasText: "2117" }).locator("button:has-text('App link')").click();
  // headless has no clipboard: the app falls back to showing the link in the toast
  await expect(page.getByRole("status")).toContainText("/d/");
  const url = (await page.getByRole("status").innerText()).match(/https?:\/\/\S+/)![0];
  const ctx2 = await browser.newContext({ geolocation: { latitude: 27.5, longitude: -99.5 }, permissions: ["geolocation"] });
  const phone = await ctx2.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(url!);
  await expect(phone.locator("body")).toContainText("Border · Frontera");
  await expect(phone.locator("body")).toContainText("Caja 10743");
  const packet = phone.locator("a:has-text('Open packet')");
  const res = await phone.request.get((await packet.getAttribute("href"))!);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("pdf");
  for (const label of ["Departed the yard", "At Mexican customs", "At US customs", "Cleared"]) {
    await expect(phone.locator("button.btn-primary", { hasText: label })).toBeVisible();
    await phone.locator("button.btn-primary", { hasText: label }).click();
    await phone.waitForTimeout(400);
  }
  await expect(phone.locator("body")).not.toContainText("Border · Frontera");
  await ctx2.close();

  // dispatcher sees it cleared, acknowledged, GPS-verified
  await page.goto("/crossing?b=cleared");
  await expect(page.locator(".row", { hasText: "26-00001" })).toContainText("Cleared");
  await page.click(".row:has-text('26-00001')");
  await expect(page.locator("main")).toContainText("opened");
  await expect(page.locator("main")).toContainText("driver app · GPS");
});

test("a returned crossing withdraws the packet and re-verifies; hold from the driver shows red on the board", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await fleet(page);
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  const panel = page.locator("aside").last();
  await panel.locator(".rounded-lg.border >> nth=1 >> button:has-text('Assign')").click();
  await page.getByRole("dialog").locator(".cursor-pointer", { hasText: "2117" }).click();
  await page.getByRole("dialog").locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  await panel.locator("a:has-text('Crossing →')").click();
  await page.waitForURL("**/crossing/**");
  await page.locator("input.mono").first().fill("10743");
  await page.click("button:has-text('Save')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.locator("li", { hasText: "Carta de retiro" }).locator("button:has-text('Generate')").click();
  await page.getByRole("dialog").locator("button:has-text('Generate PDF')").click();
  await expect(page.getByRole("status")).toContainText("generated");
  await upload(page, "Carta porte", fx("carta_porte"), { trailer: "10743", seal: "S-1" });
  await upload(page, "DODA", fx("doda"), { trailer: "10743", seal: "S-1", patente: "3456" });
  await upload(page, "ACE e-Manifest", fx("ace_manifest"), { trailer: "10743", driver: "Benjamin Xochihua", scac: "TSEX" });
  await upload(page, "Bill of lading", fx("bol"), { trailer: "10743", seal: "S-1" });
  await upload(page, "Commercial invoice", fx("invoice"), { seal: "S-1" });
  await page.click("button:has-text('Build packet')");
  await expect(page.getByRole("status")).toContainText("Packet built");
  await page.click("button:has-text('Send to driver')");
  await expect(page.getByRole("status")).toContainText("Packet sent");
  await page.click("button:has-text('Departed the yard')");
  await expect(page.getByRole("status")).toBeVisible();
  await page.click("button:has-text('At Mexican customs')");
  await page.waitForTimeout(300);
  await page.click("button:has-text('Hold')");
  await page.getByRole("dialog").locator("input").fill("CBP secondary");
  await page.getByRole("dialog").locator("button:has-text('Hold')").click();
  await expect(page.getByRole("status")).toContainText("On hold");
  await expect(page.locator(".pill", { hasText: "Held" }).first()).toBeVisible();
  await page.goto("/crossing?b=held");
  await expect(page.locator(".row", { hasText: "26-00001" })).toContainText("CBP secondary");
  await page.click(".row:has-text('26-00001')");
  await page.click("button:has-text('Returned to MX')");
  await page.getByRole("dialog").locator("input").fill("rejected: wrong SCAC");
  await page.getByRole("dialog").locator("button:has-text('Mark returned')").click();
  await expect(page.getByRole("status")).toContainText("Marked returned");
  await expect(page.locator("main")).toContainText("Returned: rejected");
  await page.click("button:has-text('Docs fixed — re-verify')");
  await expect(page.getByRole("status")).toContainText("Re-verifying");
  await expect(page.locator("button:has-text('Build packet')")).toBeVisible();
});

// Features: F-3.4 AI document reader through the browser — without a key the button explains; with a key the read is attempted on upload and its result shown; a person still confirms
test("AI reader: the workbench offers Read with AI, tells you when it is not connected, and shows the read result on the document", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await fleet(page);
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.getByPlaceholder("blank = TBD").fill("2850");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  await page.goto("/crossing");
  await page.click(".row:has-text('26-00001')");
  await page.waitForURL("**/crossing/**");
  await upload(page, "Bill of lading", fx("bol"), { trailer: "10743" });
  await page.locator("li", { hasText: "Bill of lading" }).first().click();
  await expect(page.locator("label", { hasText: "Trailer #" }).filter({ hasText: "typed" })).toHaveCount(1);
  await page.click("button:has-text('Read with AI')");
  await expect(page.getByRole("status")).toContainText("AI extractor not connected");

  // connect (a fake key: the read fails at the API and says so, instead of pretending)
  await page.goto("/settings/integrations");
  const card = page.locator(".card", { hasText: "AI document reader" });
  await card.locator("label:has-text('Anthropic API key') + input").fill("sk-ant-not-real");
  await card.locator("label:has-text('Enabled') input").check();
  await card.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.goto("/crossing");
  await page.click(".row:has-text('26-00001')");
  await page.waitForURL("**/crossing/**");
  await upload(page, "Carta porte", fx("carta_porte"), {});
  await page.locator("li", { hasText: "Carta porte" }).first().click();
  await expect(page.locator("main")).toContainText(/failed: extractor/);
  await expect(page.locator("button:has-text('Re-read with AI')")).toBeVisible();
  await expect(page.locator("li", { hasText: "Carta porte" }).first()).not.toContainText("verified"); // nothing counts until a person confirms
});
