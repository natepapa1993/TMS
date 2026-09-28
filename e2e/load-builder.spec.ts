// Features: F-2.11 F-2.12 F-3.10 F-20.3
import path from "node:path";
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("load builder: several pickups, a hand-off yard and a Canada delivery; the legs follow the stops; stops edited on the load; the crossing gets the Canadian checklist", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Acme Logistics", kind: "broker" });

  // nothing is pre-filled: a blank pickup and a blank delivery
  await page.goto("/dispatch");
  await expect(async () => {
    if (!page.url().includes("/orders/new")) await page.keyboard.press("n");
    await page.waitForURL("**/orders/new", { waitUntil: "commit", timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  const stops = page.getByTestId("stop");
  await expect(stops).toHaveCount(2);
  await expect(page.getByLabel("Stop 1 location")).toHaveValue("");
  await expect(page.getByLabel("Stop 2 location")).toHaveValue("");

  // a rate con can start the load; without the AI reader connected it says what to do
  await page.getByLabel("Rate con file").setInputFiles(path.join(__dirname, "fixtures", "bol.pdf"));
  await expect(page.getByTestId("ratecon-drop")).toContainText("connect the AI reader in Settings → Integrations");

  await page.locator("#l-customer").selectOption({ label: "Acme Logistics (broker)" });
  await page.locator("#l-rate").fill("3100");
  await page.locator("#ref-po").fill("PO-7781");
  await page.getByLabel("Freight 1 commodity").fill("Auto parts");
  await page.getByLabel("Freight 1 pieces").fill("22");
  await page.getByLabel("Freight 1 weight").fill("18000");

  // two pickups and a delivery in Canada: one truck runs it straight through → one crossing leg
  await page.click("button:has-text('+ Add stop')");
  await expect(stops).toHaveCount(3);
  const stop = async (n: number, type: string, name: string, country: string) => {
    await page.getByLabel(`Stop ${n} type`).selectOption(type);
    await page.getByLabel(`Stop ${n} location`).fill(name);
    await page.getByLabel(`Stop ${n} country`).selectOption(country);
  };
  await stop(1, "pickup", "Shipper Canton", "US");
  await stop(2, "pickup", "Supplier Toledo", "US");
  await stop(3, "delivery", "Consignee Toronto", "CA");
  const legs = page.getByTestId("legs-preview");
  await expect(legs.locator("li")).toHaveCount(1);
  await expect(legs).toContainText("Leg 1 · Crossing");
  await expect(legs).toContainText("1 stop on the way");

  // a yard before the border: the trailer changes trucks there → a US leg and the crossing
  await page.getByLabel("Insert a stop after stop 2").click();
  await expect(stops).toHaveCount(4);
  await stop(3, "yard", "Detroit yard", "US");
  await expect(legs.locator("li")).toHaveCount(2);
  await expect(legs.locator("li").nth(0)).toContainText("Leg 1 · US");
  await expect(legs.locator("li").nth(0)).toContainText("Shipper Canton → Detroit yard");
  await expect(legs.locator("li").nth(1)).toContainText("Leg 2 · Crossing");
  await expect(legs.locator("li").nth(1)).toContainText("Detroit yard → Consignee Toronto");

  // reorder in the builder, then put it back
  await page.getByLabel("Move stop 2 down").click();
  await expect(page.getByLabel("Stop 3 location")).toHaveValue("Supplier Toledo");
  await page.getByLabel("Move stop 3 up").click();
  await expect(page.getByLabel("Stop 2 location")).toHaveValue("Supplier Toledo");

  await page.click("button:has-text('Create & book')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });
  const panel = page.locator("aside").last();
  await expect(page.locator("aside .h2").first()).toContainText(/\d{2}-\d{5}/);
  await expect(panel).toContainText("Assign US leg");

  // the crossing is US → Canada: PARS and ACI, no Mexican paperwork
  await page.goto("/crossing");
  await page.locator("a[href^='/crossing/']").first().click();
  await page.waitForURL("**/crossing/**", { waitUntil: "commit" });
  const main = page.locator("main");
  await expect(main).toContainText("PARS");
  await expect(main).toContainText("ACI eManifest");
  await expect(main).not.toContainText("DODA");
  await expect(main).not.toContainText("Carta de retiro");

  // on the load: add a second Canadian drop, move it, remove it
  await page.goto("/orders");
  await page.locator("a[href^='/orders/']", { hasText: /\d{2}-\d{5}/ }).first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(main).toContainText("Shipper Canton");
  await page.getByTestId("tab-stops").click();
  await page.click("button:has-text('+ Add stop')");
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  await d.getByLabel("Stop 100 type").selectOption("delivery");
  await d.getByLabel("Stop 100 location").fill("Consignee Montreal");
  await d.getByLabel("Stop 100 country").selectOption("CA");
  await d.getByLabel("Stop 100 city").fill("Montreal");
  await d.getByLabel("Stop 100 state").fill("QC");
  await d.locator("button:has-text('Add stop')").last().click();
  await expect(d).toBeHidden();
  await expect(main).toContainText("Consignee Montreal");
  await expect(main).toContainText("Montreal, QC");

  await page.getByLabel("Move stop 5 up").click();
  await expect(page.getByRole("status")).toContainText("legs re-cut");
  await expect(page.getByLabel("Remove stop 4")).toBeVisible();
  await expect(page.getByTestId("stops-card").locator(".rounded-lg.border").nth(3)).toContainText("Consignee Montreal");

  await page.getByLabel("Remove stop 4").click();
  await page.getByRole("dialog").locator("button:has-text('Remove stop')").click();
  const stopCard = page.getByTestId("stops-card");
  await expect(stopCard).not.toContainText("Consignee Montreal");
  await expect(stopCard).toContainText("Consignee Toronto");
  await expect(main).toContainText("stop removed"); // on the history
});
