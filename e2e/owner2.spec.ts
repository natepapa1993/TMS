// Features: F-32.21 F-32.22 F-32.23 F-32.24 owner round 2 — documents once, approvals, invites by email, IFTA rate matrix, sidebar and freight grid on a 1440×900 screen
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, buildLoad, mxToUs, uid } from "./helpers";

const fx = (n: string) => path.join(__dirname, "fixtures", `${n}.pdf`);

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button:has-text('Sign in')");
}

test("a BOL uploaded on the crossing counts for billing, the checklist and the portal, and the load says so", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await buildLoad(page, { customer: "RXO (broker)", rate: "2850", stops: mxToUs("Planta Monterrey", "GM Arlington") });
  await page.goto("/crossing");
  await page.locator("a[href^='/crossing/']", { hasText: "26-00001" }).click();
  await page.waitForURL("**/crossing/**");
  const row = page.locator("li", { hasText: "Bill of lading" }).first();
  await row.locator("button:has-text('Upload')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("input[type=file]").setInputFiles(fx("bol"));
  await dlg.locator("button:has-text('Upload')").last().click();
  await expect(page.getByRole("status")).toContainText("Uploaded");
  await expect(page.locator("li", { hasText: "Bill of lading" }).first()).toContainText("present");

  // the load's Documents tab: one BOL, from the crossing, counted everywhere it's asked for
  await page.locator("a[href^='/orders/']").first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await page.goto(`${page.url().split("?")[0]}?tab=documents`);
  const docs = page.getByTestId("load-docs");
  await expect(docs.locator("tr", { hasText: "Bill of lading" })).toContainText("Crossing");
  const counts = docs.locator("tr", { hasText: "Bill of lading" }).getByTestId("counts-for");
  for (const where of ["Billing", "Crossing checklist", "Customer portal"]) await expect(counts).toContainText(where);
  // "Needed to bill" ticks the BOL without a second upload
  await expect(page.locator("li", { hasText: "Bill of lading" }).locator("span", { hasText: "✓" }).first()).toBeVisible();
});

test("the owner invites a dispatcher by email; they set their own password from the link", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signupFresh(page);
  await page.goto("/settings/users");
  await page.getByTestId("invite-user").click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.locator("#inv-role")).toHaveValue("dispatcher");
  const email = `maria-${uid()}@e2e.local`;
  await dlg.locator("#inv-name").fill("Maria Lopez");
  await dlg.locator("#inv-email").fill(email);
  await dlg.locator("button:has-text('Send invite')").click();
  await expect(dlg.getByTestId("invite-sent")).toContainText("Email isn't connected");
  const link = await dlg.getByLabel("Invite link").inputValue();
  expect(link).toContain("/invite/");
  await dlg.locator("button:has-text('Done')").click();
  await expect(page.getByTestId("pending-invites")).toContainText("Maria Lopez");

  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await phone.goto(new URL(link).pathname);
  await expect(phone.locator("body")).toContainText("Welcome, Maria Lopez");
  await expect(phone.locator("body")).toContainText("Dispatcher");
  await phone.fill("#password", "Dispatch-2026!");
  await phone.fill("#again", "Dispatch-2026!");
  await phone.click("button:has-text('Set password and sign in')");
  await phone.waitForURL("**/dispatch**", { waitUntil: "commit" });
  // the link is used up
  await phone.goto(new URL(link).pathname);
  await expect(phone.locator("body")).toContainText("This invite has expired");
  await ctx.close();

  await page.goto("/settings/users");
  await expect(page.getByTestId("pending-invites")).toHaveCount(0);
  // and she signs in with her own password
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await signIn(p2, email, "Dispatch-2026!");
  await p2.waitForURL("**/dispatch**", { waitUntil: "commit" });
  await ctx2.close();
});

test("Today: the approvals list and its setting; the sidebar says what is below and the freight grid has room", async ({ page }) => {
  test.setTimeout(90_000);
  await signupFresh(page);
  await page.goto("/today");
  const ap = page.getByTestId("approvals");
  await expect(ap).toContainText("Nothing to approve");
  await ap.getByTestId("override-approval-setting").check();
  await expect(page.getByRole("status")).toContainText("Overrides now wait for you");
  await page.goto("/settings/company");
  await expect(page.getByTestId("override-approval-card").locator("input[type=checkbox]")).toBeChecked();

  // 1440×900: the rail can't show everything; it says what is below and one click gets to Settings
  await page.goto("/today");
  const more = page.getByTestId("rail-more");
  await expect(more).toBeVisible();
  await expect(more).toContainText("Company");
  await more.click();
  await expect(page.locator("aside nav a", { hasText: "Settings" })).toBeInViewport();
  await expect(page.locator("aside nav a", { hasText: "Reports" })).toBeInViewport();

  // the load builder's commodity is a real field, not "Au"
  await page.goto("/orders/new");
  const box = await page.getByLabel("Freight 1 commodity").boundingBox();
  expect(box!.width).toBeGreaterThan(180);
});

test("IFTA: import the quarter's rate matrix CSV with a preview", async ({ page }) => {
  test.setTimeout(90_000);
  await signupFresh(page);
  await page.goto("/billing/ifta");
  const csv = "Jurisdiction,Rate Type,Gasoline,Special Diesel\nTexas,U.S./Gal,0.2000,0.2000\nTexas,Can./Liter,0.0700,0.0700\nOklahoma,U.S./Gal,0.2000,0.1900\nKentucky,U.S./Gal,0.2600,0.2330\nKentucky Surcharge,U.S./Gal,0.0000,0.0200\n";
  await page.getByTestId("ifta-matrix-import").locator("input[type=file]").setInputFiles({ name: "IFTA-matrix.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const pv = page.getByTestId("ifta-matrix-preview");
  await expect(pv).toContainText("3 jurisdictions from the Special Diesel column");
  await expect(pv.locator("tr", { hasText: "KY" })).toContainText("0.2330");
  await expect(pv.locator("tr", { hasText: "KY" })).toContainText("0.0200");
  await page.getByRole("dialog").locator("button:has-text('Save 3 rates')").click();
  await expect(page.getByRole("status").filter({ hasText: "3 rate(s) saved from the matrix" })).toBeVisible();
});
