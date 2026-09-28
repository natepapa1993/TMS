// Features: F-34.2 F-34.5 F-34.6 F-34.9 carrier legs go out through a tender, the carrier picker fits the leg, a rate con read without the AI reader, a counter-offer answered on the board
import path from "node:path";
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad, mxToUs } from "./helpers";

test("a carrier leg is sent only through a tender: the picker fits the leg, Send to carrier opens the tender, a missing WhatsApp number is added inline", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Transportes del Norte", country: "MX", kind: "mx" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Lone Star Freight", country: "US", kind: "us", dispatchEmail: "d@ls.test", mcNumber: "700300" });
  await buildLoad(page, { customer: "RXO (broker)", rate: "2950", stops: mxToUs("Magna Ramos", "Dallas DC") });
  const panel = page.locator("aside").last();

  // the MX leg offers the Mexican carrier; the US one is behind Show all
  await panel.locator("button:has-text('Assign MX leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  const picker = dlg.locator("select").first();
  await expect(picker.locator("option", { hasText: "Transportes del Norte" })).toHaveCount(1);
  await expect(picker.locator("option", { hasText: "Lone Star Freight" })).toHaveCount(0);
  await dlg.getByTestId("carrier-filter").locator("button", { hasText: "Show all" }).click();
  await expect(picker.locator("option", { hasText: "Lone Star Freight" })).toHaveCount(1);
  await picker.selectOption({ label: "Transportes del Norte (MX)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("9500");
  // planned on the carrier, not sent
  await dlg.locator("label:has-text('Send right away') input").uncheck();
  await dlg.locator("button:has-text('Assign')").last().click();
  await expect(page.getByRole("status")).toContainText("Planned on the carrier");

  // Send to carrier opens the tender dialog; WhatsApp with no number fails, the leg stays Planned, the number is added right there
  await panel.locator("button.btn-primary.btn-lg", { hasText: "Send to carrier" }).click();
  await expect(dlg).toBeVisible();
  await dlg.locator("select").nth(1).selectOption("whatsapp");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(dlg.getByTestId("add-contact")).toBeVisible();
  await expect(dlg).toContainText("has no WhatsApp number");
  await dlg.locator("#tender-contact").fill("+52 867 555 0101");
  await dlg.locator("button:has-text('Save & send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender sent on WhatsApp to +52 867 555 0101");
  await expect(panel).toContainText("Tender out");
});

test("a rate con uploaded with the AI reader off is kept and fills the builder from the PDF's text", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Northstar Brokerage", kind: "broker" });
  await page.goto("/orders/new");
  await page.getByLabel("Rate con file").setInputFiles(path.join(__dirname, "fixtures", "ratecon-ns-8812.pdf"));
  const drop = page.getByTestId("ratecon-drop");
  await expect(drop).toContainText("Filled from ratecon-ns-8812.pdf");
  await expect(drop).toContainText("AI reader is off");
  await expect(page.getByTestId("ratecon-read")).toContainText("rate USD 2,275.00");
  await expect(page.locator("#l-rate")).toHaveValue("2275.00");
  await expect(page.getByLabel("Stop 1 location")).toHaveValue("Alamo Auto Plant");
  await expect(page.getByLabel("Stop 2 location")).toHaveValue("Trinity DC");
  await expect(page.locator("#l-customer option:checked")).toContainText("Northstar Brokerage");
});

test("a carrier counters on the offer page; dispatch accepts it on the board; the carrier sees it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Bluewater Carriers", country: "US", kind: "us", dispatchEmail: "d@blue.test", mcNumber: "700400" });
  await buildLoad(page, { customer: "RXO (broker)", rate: "4500", stops: [{ type: "pickup", name: "Laredo Yard", country: "US" }, { type: "delivery", name: "Joliet DC", country: "US" }] });
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Bluewater Carriers (US)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("3000");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender emailed");
  const link = await panel.locator("a:has-text('Link')").first().getAttribute("href");

  const carrier = await (await browser.newContext()).newPage();
  await carrier.goto(link!);
  await carrier.getByTestId("counter-open").click();
  await carrier.locator("#t-name").fill("Mike");
  await carrier.locator("#t-rate").fill("3300");
  await carrier.locator("#t-note").fill("fuel is up");
  await carrier.locator("button:has-text('Send counter-offer')").click();
  await expect(carrier.getByTestId("counter-pending")).toContainText("USD 3,300.00");

  await page.reload();
  const flag = page.locator("aside").last().getByTestId("flag").filter({ hasText: "Counter-offer" });
  await expect(flag).toContainText("Bluewater Carriers asks USD 3,300.00");
  await flag.locator("button:has-text('Accept')").click();
  await expect(page.getByRole("status")).toContainText("Counter-offer accepted");
  await carrier.reload();
  await expect(carrier.getByTestId("counter-answer")).toContainText("Dispatch accepted your rate");
  await expect(carrier.locator("body")).toContainText("USD 3,300.00");
});
