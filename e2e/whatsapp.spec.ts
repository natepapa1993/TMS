// Features: F-4.2 WhatsApp Business through the browser — integration card, webhook verify + signed inbound, tender channel, driver reply on the timeline, Messages page
import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { signupFresh, quickAdd, future, buildLoad } from "./helpers";

test("WhatsApp day: connect the number, a tender goes by WhatsApp, Meta verifies the webhook, a driver reply lands on the load and in Messages", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.goto("/settings/carriers");
  await page.click("table a:has-text('Lone Star')");
  await page.locator("#f-whatsapp").fill("+1 210 555 0199");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // the integration card: saving once mints the webhook URL and verify token
  await page.goto("/settings/integrations");
  const card = page.locator(".card", { hasText: "WhatsApp Business" });
  await expect(card).toContainText("Save once to get this company");
  await card.locator("input[placeholder='from Meta → WhatsApp → API setup']").fill("123456789");
  await card.locator("label:has-text('Access token') + input").fill("EAAB-not-a-real-token");
  await card.locator("label:has-text('App secret') + input").fill("app-secret-1");
  await card.locator("label:has-text('Enabled') input").check();
  await card.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expect(card).toContainText("Webhook (paste into Meta");
  const hook = (await card.locator("div.mono.select-all").textContent())!.trim();
  const verify = (await card.locator("span.mono.select-all").textContent())!.trim();
  expect(hook).toMatch(/\/api\/whatsapp\/[A-Za-z0-9_-]{20,}$/);
  const path = new URL(hook).pathname;

  // Meta's verification handshake
  const ok = await page.request.get(`${path}?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=4242`);
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toBe("4242");
  expect((await page.request.get(`${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status()).toBe(403);

  // a tender by WhatsApp: the message is queued for the carrier's number (the token is fake, so it stays queued with the API's answer)
  await buildLoad(page, { customer: "RXO (broker)", rate: "1800", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }] });
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  let dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Lone Star Freight (US)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("900");
  await dlg.locator("select").nth(1).selectOption("whatsapp");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender sent on WhatsApp to +1 210 555 0199");
  await expect(panel).toContainText("whatsapp to +1 210 555 0199");
  await expect(panel.locator(".pill", { hasText: /queued|failed/ })).toBeVisible(); // the fake token never reaches Meta: the card says so instead of pretending
  await panel.locator("button:has-text('Withdraw')").click();
  await expect(page.getByRole("status")).toContainText("Tender withdrawn");

  // our truck runs it; the driver writes back on WhatsApp → timeline + Messages
  await page.click(".stage-tab:has-text('Pending')");
  await page.locator(".row[role=button]").first().click();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2104" }).click();
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "19560000003", profile: { name: "Daniel" } }], messages: [{ id: "wamid.e2e.1", from: "19560000003", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "en el patio, cargando" } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "app-secret-1").update(body).digest("hex");
  expect((await page.request.post(path, { data: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" } })).status()).toBe(401);
  const posted = await page.request.post(path, { data: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
  expect(posted.status()).toBe(200);
  expect(await posted.json()).toEqual({ statuses: 0, messages: 1, attached: 1 });
  await page.goto("/dispatch");
  await expect(page.locator("a:has-text('Messages · 1')")).toBeVisible();
  await page.click("a:has-text('Messages · 1')");
  await page.waitForURL("**/messages", { waitUntil: "commit" });
  const row = page.locator("tr", { hasText: "en el patio, cargando" });
  await expect(row).toContainText("Daniel Reyes");
  await expect(row).toContainText("26-00001");
  await row.locator("a:has-text('26-00001')").click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("WhatsApp from Daniel Reyes: en el patio, cargando");
  await page.goto("/messages");
  await page.locator("tr", { hasText: "en el patio" }).locator("button:has-text('Handled')").click();
  await expect(page.getByRole("status")).toContainText("Handled");
  await expect(page.locator("main")).toContainText("No messages waiting");
});
