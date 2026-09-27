// Features: F-2.1 F-2.3 F-3.1 F-3.2 F-11.1 F-11.2 F-11.3 F-11.4 F-11.5 F-15 (through the real UI) F-2.9
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, future, login } from "./helpers";

// T1 through the real UI: order → assign (eligibility enforced) → send → drive → delivered.
// Plus the ease rules the owner asked for: OOS, split, add a driver to a unit, hold.

async function readyFleet(page: Page) {
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2117", usPlate: "RC59022", mxPlate: "35ES3A", mxPlateClass: "brown" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Benjamín Xochihua", driverType: "B1", phone: "+52 867 111 2222" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Transportes Garza", country: "MX", kind: "mx", dispatchEmail: "despacho@garza.test" });
  // give the B-1 driver the paperwork the crossing needs
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Benjamín')");
  for (const [f, d] of [["mxLicenseExpires", 400], ["fastExpires", 400], ["i94Until", 120], ["medicalExpires", 300], ["licenseExpires", 400]] as const) await page.locator(`#f-${f}`).fill(future(d));
  await page.locator("#f-currentTruckId").selectOption({ label: "2117" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
}

async function newOrder(page: Page) {
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.getByPlaceholder("blank = TBD").fill("2850");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  await expect(page.locator("aside .h2").first()).toContainText(/\d{2}-\d{5}/);
}

test("dispatcher day: new order in four fields, B-1 blocked on the US leg, carrier on MX, truck crosses, delivered", async ({ page }) => {
  await signupFresh(page);
  await readyFleet(page);
  await newOrder(page);
  const panel = page.locator("aside").last();
  await expect(panel).toContainText("Assign MX leg");

  // MX leg → Mexican carrier
  await panel.locator("button:has-text('Assign MX leg')").click();
  let dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Transportes Garza (MX)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("450");
  await dlg.locator("select").nth(1).selectOption("phone"); // tendered by phone: dispatcher confirms
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Marked sent");
  await expect(page.locator(".stage-tab:has-text('Dispatched') .count")).toHaveText("1");

  // walk the MX leg to completed with the per-leg buttons
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  for (const label of ["Accepted", "Rolling to pickup", "Arrived at pickup", "Loaded", "En route", "Arrived at delivery", "Delivered"]) {
    await panel.locator(`.rounded-lg.border >> nth=0 >> button:has-text('${label}')`).click();
    await expect(page.getByRole("status")).toBeVisible();
    await page.waitForTimeout(150);
  }
  await expect(panel.locator(".rounded-lg.border").first()).toContainText("Delivered");
  // the crossing is next, so the order is back in Pending for the dispatcher
  await expect(page.locator(".stage-tab:has-text('Pending') .count")).toHaveText("1");

  // crossing: our brown-plate 2117 with the B-1 driver — ranked first and green
  await page.click(".stage-tab:has-text('Pending')");
  await page.click(".row[role=button]");
  await panel.locator("button:has-text('Assign Crossing leg')").click();
  dlg = page.getByRole("dialog");
  const first = dlg.locator(".cursor-pointer").first();
  await expect(first).toContainText("2117");
  await expect(first).toContainText("free, Benjamín");
  await first.click();
  await dlg.locator("label:has-text('Send right away') input").uncheck();
  await dlg.locator("button:has-text('Assign')").last().click();
  await expect(page.getByRole("status")).toContainText("in Planned");
  await expect(page.locator(".stage-tab:has-text('Planned') .count")).toHaveText("1");

  // send it, then run it through to the Laredo yard
  await page.click(".stage-tab:has-text('Planned')");
  await page.click(".row[role=button]");
  await panel.locator("button:has-text('Send to driver')").click();
  await expect(page.getByRole("status")).toContainText("Sent");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  for (const label of ["Mark accepted", "Rolling to pickup", "Arrived at pickup", "Loaded", "En route", "Arrived at delivery", "Delivered"]) {
    await panel.locator("button.btn-primary.btn-lg").click();
    await page.waitForTimeout(200);
    void label;
  }
  // US leg: try the B-1 team on it → hard block, no override offered
  await panel.locator("button:has-text('Assign US leg')").click();
  dlg = page.getByRole("dialog");
  const blocked = dlg.locator(".cursor-pointer", { hasText: "2117" });
  await expect(blocked).toContainText("Blocked");
  await expect(blocked).toContainText("B-1");
  const ok = dlg.locator(".cursor-pointer", { hasText: "2104" });
  await expect(ok).toContainText("free, Daniel");
  await ok.click();
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  for (let i = 0; i < 7; i++) {
    await panel.locator("button.btn-primary.btn-lg").click();
    await page.waitForTimeout(200);
  }
  await expect(page.locator(".stage-tab:has-text('Delivered') .count")).toHaveText("1");
  await page.click(".stage-tab:has-text('Delivered')");
  await expect(page.locator(".row[role=button]")).toContainText("Delivered");

  // the order page tells the whole story
  await page.click(".row[role=button]");
  await panel.locator("summary:has-text('Details')").click();
  await panel.locator("a:has-text('Open order')").click();
  await page.waitForURL("**/orders/**");
  await expect(page.locator(".h1")).toContainText("Delivered");
  await expect(page.getByText("Timeline")).toBeVisible();
  await expect(page.locator("aside.space-y-4")).toContainText("US leg");
});

test("unit OOS from Fleet pulls the planned leg back to Pending; split makes a second Pending leg; hold blocks sending", async ({ page }) => {
  await signupFresh(page);
  await readyFleet(page);
  await newOrder(page);
  const panel = page.locator("aside").last();
  // plan the crossing on 2117 (not sent)
  await panel.locator(".rounded-lg.border >> nth=1 >> button:has-text('Assign')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2117" }).click();
  await dlg.locator("label:has-text('Send right away') input").uncheck();
  await dlg.locator("button:has-text('Assign')").last().click();
  await expect(page.getByRole("status")).toContainText("in Planned");

  // Fleet: 2117 shows the load; put it OOS
  await page.goto("/fleet");
  const row = page.locator("tr", { hasText: "2117" });
  await expect(row).toContainText(/\d{2}-\d{5}/);
  await row.locator("button:has-text('Unit OOS')").click();
  await page.getByRole("dialog").locator("input").fill("blown turbo");
  await page.getByRole("dialog").locator("button:has-text('Unit OOS')").click();
  await expect(page.getByRole("status")).toContainText("1 leg(s) back in Pending");
  await expect(page.locator("tr", { hasText: "2117" })).toContainText("OOS");
  await page.click(".stage-tab:has-text('Out of service')");
  await expect(page.locator("tr", { hasText: "2117" })).toBeVisible();
  await page.locator("tr", { hasText: "2117" }).locator("button:has-text('Back in service')").click();
  await expect(page.getByRole("status")).toContainText("back in service");

  // add a co-driver to the unit from Fleet
  await page.click(".stage-tab:has-text('All')");
  await page.locator("tr", { hasText: "2117" }).locator("button:has-text('Change')").click();
  await page.getByRole("dialog").locator("label", { hasText: "Daniel Reyes" }).click();
  await page.getByRole("dialog").locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Team set on unit 2117");

  // Dispatch: crossing is Pending again; split the US leg
  await page.goto("/dispatch");
  await expect(page.locator(".stage-tab:has-text('Pending') .count")).toHaveText("1");
  await page.click(".row[role=button]");
  await expect(panel.locator(".rounded-lg.border").nth(1)).toContainText("Pending");
  await panel.locator("button:has-text('Split')").click();
  await page.getByRole("dialog").getByPlaceholder("San Antonio yard").fill("San Antonio Yard");
  await page.getByRole("dialog").locator("button:has-text('Split')").click();
  await expect(page.getByRole("status")).toContainText("Split");
  await expect(panel.locator(".rounded-lg.border")).toHaveCount(4);
  await panel.locator("summary:has-text('Stops')").scrollIntoViewIfNeeded();
  await expect(panel).toContainText("San Antonio Yard");

  // hold: only once something is sent
  await expect(panel.locator("button:has-text('Hold')")).toBeDisabled();
  await panel.locator(".rounded-lg.border >> nth=0 >> button:has-text('Assign')").click();
  await page.getByRole("dialog").locator("button:has-text('Partner carrier')").click();
  await page.getByRole("dialog").locator("select").first().selectOption({ label: "Transportes Garza (MX)" });
  await page.getByRole("dialog").locator("select").nth(1).selectOption("phone");
  await page.getByRole("dialog").locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Marked sent");
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.click(".row[role=button]");
  await panel.locator("button:has-text('Hold')").click();
  await page.getByRole("dialog").locator("input").fill("rate con missing");
  await page.getByRole("dialog").locator("button:has-text('Hold')").click();
  await expect(page.getByRole("status")).toContainText("On hold");
  await expect(panel).toContainText("Hold: rate con missing");
  await expect(panel.locator("button:has-text('Release hold')")).toBeVisible();
  await panel.locator("button:has-text('Release hold')").click();
  await expect(page.getByRole("status")).toContainText("Released");
});

test("tenant isolation through the UI: a second company sees nothing of the first", async ({ page, browser }) => {
  const a = await signupFresh(page, "Company A");
  await quickAdd(page, "customers", "Add customer", { name: "Secret Customer A", kind: "customer" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "9001", usPlate: "A1" });
  await page.goto("/settings/trucks");
  const truckHref = await page.locator("table a:has-text('9001')").getAttribute("href");

  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await signupFresh(p2, "Company B");
  await p2.goto("/settings/customers");
  await expect(p2.locator("body")).not.toContainText("Secret Customer A");
  await p2.goto("/settings/trucks");
  await expect(p2.locator("body")).toContainText("No trucks yet");
  await p2.goto(truckHref!);
  await expect(p2.locator("body")).toContainText(/not found|404/i);
  await p2.goto("/dispatch");
  await expect(p2.locator(".stage-tab:has-text('Pending') .count")).toHaveText("0");
  await ctx2.close();

  // A still sees its own things after signing out and in again
  await page.click("button:has-text('Sign out')");
  await page.waitForURL("**/login");
  await login(page, a.email, a.password);
  await page.goto("/settings/customers");
  await expect(page.locator("table")).toContainText("Secret Customer A");
});

test("signed-out visitor is sent to login; wrong password is refused without saying which part", async ({ page }) => {
  await page.goto("/dispatch");
  await page.waitForURL("**/login?next=%2Fdispatch");
  await page.fill("#email", "nobody@e2e.local");
  await page.fill("#password", "wrong-password-1");
  await page.click("button:has-text('Sign in')");
  await expect(page.locator(".error[role=alert]")).toContainText("don't match");
});

test("book it again: a copy of an order is a new draft with the same shape and nothing from the old load", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await page.goto("/dispatch");
  await page.keyboard.press("n");
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  await d.locator("select").first().selectOption({ label: "RXO (broker)" });
  await d.getByPlaceholder("Planta Monterrey").fill("Planta Monterrey");
  await d.getByPlaceholder("GM Arlington").fill("GM Arlington");
  await d.getByPlaceholder("blank = TBD").fill("2850");
  await d.locator("button:has-text('Create & book')").click();
  await expect(page.getByRole("status")).toContainText("Order created");
  const panel = page.locator("aside").last();
  await panel.locator("summary:has-text('Details')").click();
  await panel.locator("a:has-text('Open order')").click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  const first = page.url();
  await page.click("button:has-text('Book again')");
  await page.waitForURL((u) => u.toString().includes("/orders/") && u.toString() !== first, { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("26-00002");
  await expect(page.locator("main")).toContainText("Draft");
  await expect(page.locator("main")).toContainText("Planta Monterrey");
  await expect(page.locator("main")).toContainText("GM Arlington");
  await expect(page.locator("input[aria-label='Rate']")).toHaveValue("2850.00");
  await page.click("button:has-text('Book')");
  await expect(page.getByRole("status").filter({ hasText: "Booked" })).toBeVisible();
});
