// Features: F-1.5 F-25.2 F-25.3 F-25.7
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, login, uid } from "./helpers";

// Round-2 safety retest: only the owner manages users (owner N1), same-day repair sign-off (safety N1),
// the SAP / return-to-duty gate (safety #16), role scope (reports, IFTA)

test("users: a dispatcher can't add people, open the owner or promote themselves; they change their own password on My account", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  const email = `maria-${uid()}@e2e.local`;
  await quickAdd(page, "users", "Add user", { name: "Maria Dispatch", email, role: "dispatcher", password: "first-password-1" });
  // the owner's own record, for the dispatcher to try later
  await page.goto("/settings/users");
  const ownerHref = await page.locator("tr", { hasText: "E2E Owner" }).locator("a:has-text('Open')").getAttribute("href");
  expect(ownerHref).toMatch(/^\/settings\/users\/.+/);
  await page.click("button:has-text('Sign out')");

  await login(page, email, "first-password-1");
  await page.goto("/settings/users");
  await expect(page.locator("button:has-text('Add user')")).toHaveCount(0);
  await expect(page.locator("a:has-text('Import CSV')")).toHaveCount(0);
  await expect(page.locator("tr", { hasText: "E2E Owner" }).locator("a:has-text('Open')")).toHaveCount(0);
  await page.goto(ownerHref!);
  await expect(page.getByText("Managing users is not part of your role")).toBeVisible();
  await expect(page.locator("#f-role")).toHaveCount(0);
  await page.goto("/settings/users/import");
  await expect(page.getByText("Managing users is not part of your role")).toBeVisible();

  // My account: the role is shown, not editable; the password needs the current one
  await page.goto("/settings/account");
  await expect(page.getByTestId("my-role")).toHaveText("Dispatcher");
  await page.fill("#me-pw-current", "wrong-password-9");
  await page.fill("#me-pw-next", "second-password-2");
  await page.fill("#me-pw-again", "second-password-2");
  await page.click("button:has-text('Change password')");
  await expect(page.getByRole("alert").filter({ hasText: "That isn't your current password." })).toBeVisible();
  await page.fill("#me-pw-current", "first-password-1");
  await page.click("button:has-text('Change password')");
  await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();

  // money reports are the owner's and billing's
  await page.goto("/reports");
  await expect(page.getByText("is not part of your role")).toBeVisible();
  await page.click("button:has-text('Sign out')");
  await login(page, email, "second-password-2");
});

test("roadside: a brake OOS repaired the same afternoon is signed off today and the truck is back in service; unticking OOS needs a reason", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "Q317", usPlate: "TXQ317" });
  await page.goto("/compliance/inspections");
  await page.getByTestId("log-inspection").click();
  let dlg = page.getByRole("dialog");
  // the inspection an hour ago, on the company's clock (the label names the zone)
  await expect(dlg.locator("label[for=i-at]")).toContainText(/\((EDT|EST)\)/);
  const at = await dlg.locator("#i-at").inputValue();
  const hourAgo = new Date(new Date(`${at}:00Z`).getTime() - 3600_000).toISOString().slice(0, 16);
  await dlg.locator("#i-at").fill(hourAgo);
  await dlg.locator("#i-juris").fill("TX");
  await dlg.locator("#i-report").fill("TXQA2-0101");
  await dlg.locator("#i-truck").selectOption({ label: "Q317" });
  await dlg.getByTestId("add-violation").click();
  await dlg.getByLabel("Violation 1 code").fill("393.47(e)");
  await dlg.getByTestId("violation-row").locator("label:has-text('OOS') input").check();
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Inspection saved" })).toBeVisible();
  await page.getByTestId("sign-off-repair").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#rp-note").fill("Slack adjuster replaced at the scale — Laredo Truck Repair RO 5521");
  await dlg.locator("button:has-text('Back in service')").click();
  await expect(page.getByRole("status").filter({ hasText: "back in service" })).toBeVisible();
  await expect(page.getByTestId("repair-signed")).toContainText("Repair signed off by E2E Owner");

  // a second OOS inspection logged by mistake: unticking OOS asks why
  await page.getByTestId("log-inspection").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#i-report").fill("TXQA2-0102");
  await dlg.locator("#i-truck").selectOption({ label: "Q317" });
  await dlg.getByTestId("add-violation").click();
  await dlg.getByLabel("Violation 1 code").fill("393.48(a)");
  await dlg.getByTestId("violation-row").locator("label:has-text('OOS') input").check();
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Inspection saved" })).toBeVisible();
  await page.locator("tr", { hasText: "TXQA2-0102" }).getByTestId("edit-inspection").click();
  dlg = page.getByRole("dialog");
  await dlg.getByTestId("violation-row").locator("label:has-text('OOS') input").uncheck();
  await expect(dlg.getByTestId("oos-release")).toBeVisible();
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Why is the out-of-service finding coming off" })).toBeVisible();
  await dlg.locator("#i-oos-release").fill("Data entry error — it wasn't OOS on the report");
  await dlg.locator("button:has-text('Save')").click();
  await expect(dlg).toBeHidden();
  await page.goto("/compliance/overrides");
  await expect(page.getByTestId("overrides-table")).toContainText("Data entry error");
});

test("return to duty: the SAP fields are asked for and a negative RTD without them keeps the hold", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "drivers", "Add driver", { name: "Fernando Aguilar", driverType: "CDL" });
  await page.goto("/compliance/drivers");
  await page.click("a:has-text('Fernando Aguilar')");
  await page.waitForURL("**/compliance/drivers/**");
  const da = page.getByTestId("da-file");
  await da.getByTestId("add-test").click();
  let dlg = page.getByRole("dialog");
  await dlg.locator("#t-reason").selectOption("reasonable_suspicion");
  await dlg.locator("#t-result").selectOption("refusal");
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Test recorded" })).toBeVisible();
  await expect(page.locator("main")).toContainText("safety hold");

  await da.getByTestId("add-test").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#t-reason").selectOption("return_to_duty");
  await expect(dlg.getByTestId("sap-fields")).toBeVisible();
  await dlg.locator("#t-result").selectOption("negative");
  await dlg.locator("button:has-text('Save')").click();
  await expect(dlg.getByRole("alert")).toContainText("Name the SAP");
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await dlg.locator("#t-sap").fill("Dr. R. Salinas, SAP");
  await dlg.locator("#t-sap-eval").fill(today);
  await dlg.locator("#t-sap-done").fill(today);
  await dlg.locator("#t-fu").fill("6");
  await dlg.locator("#t-fu-months").fill("12");
  await expect(dlg.getByTestId("t-observed")).toBeChecked();
  await dlg.locator("button:has-text('Save')").click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Test recorded" })).toBeVisible();
  await expect(da).toContainText("SAP Dr. R. Salinas, SAP");
  await expect(da).toContainText("Follow-up testing: 0 of 6 done over 12 months");
});
