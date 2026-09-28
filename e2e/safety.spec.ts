// Features: F-25.1 F-25.2 F-25.3 F-25.4
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

const pdf = { name: "application.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e application") };

test("safety: a driver's qualification file, a random draw and a refusal that holds the driver, a roadside inspection in the BASICs, and the overrides log", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL" });
  await quickAdd(page, "drivers", "Add driver", { name: "Ana Torres", driverType: "CDL" });

  // the overview counts incomplete files and links each driver's
  await page.goto("/compliance");
  await expect(page.getByTestId("safety-nav")).toContainText("Drug & alcohol");
  await expect(page.getByTestId("tile-dq")).toContainText("2");
  await expect(page.getByTestId("dq-cell").first()).toContainText("missing");

  // the qualification file: record the application with the paper; "not required" asks why
  await page.goto("/compliance/drivers");
  await expect(page.getByTestId("dq-table").locator("tbody tr")).toHaveCount(2);
  await page.click("a:has-text('Daniel Reyes')");
  await page.waitForURL("**/compliance/drivers/**");
  const file = page.getByTestId("dq-file");
  await file.getByTestId("dq-record-application").click();
  let dlg = page.getByRole("dialog");
  await dlg.locator("#dq-file").setInputFiles(pdf);
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Employment application recorded" })).toBeVisible();
  const appLine = file.locator("#dq-application");
  await expect(appLine).toContainText("on file");
  await expect(appLine).toContainText("application.pdf");
  await file.getByTestId("dq-record-prior_employers").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#dq-na").check();
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "say why" })).toBeVisible();
  await dlg.locator("#dq-note").fill("First job driving; no prior DOT employers");
  await dlg.locator("button:has-text('Save')").click();
  await expect(file.locator("#dq-prior_employers")).toContainText("not required");

  // the pre-employment test comes from the drug & alcohol program
  await expect(file.locator("#dq-pre_employment_test")).toContainText("missing");
  await page.getByTestId("da-file").getByTestId("add-test").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#t-reason").selectOption("pre_employment");
  await dlg.locator("#t-result").selectOption("negative");
  await dlg.locator("#t-ccf").fill("CCF-100200");
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Test recorded" })).toBeVisible();
  await expect(file.locator("#dq-pre_employment_test")).toContainText("on file");

  // a random draw; the first selected driver refuses → hold, Clearinghouse to-do
  await page.goto("/compliance/drug-alcohol");
  await page.getByTestId("run-draw").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Draw from 2 drivers')").click();
  await expect(page.getByTestId("draw-result")).toContainText("Pool of 2");
  await dlg.locator("button:has-text('Done')").click();
  const tests = page.getByTestId("da-tests");
  const selected = tests.locator("tr", { hasText: "Selected — not collected yet" }).first();
  await expect(selected).toBeVisible();
  const who = (await selected.locator("td").first().innerText()).trim();
  await selected.getByTestId("record-result").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#r-result").selectOption("refusal");
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Refusal to test" })).toBeVisible();
  await expect(page.getByTestId("da-todo")).toContainText(`${who} — Report the refusal to the Clearinghouse`);
  await expect(page.getByTestId("da-holds")).toContainText(who);
  await page.getByTestId("da-todo").getByTestId("ch-reported").first().click();
  await expect(page.getByTestId("da-todo")).toHaveCount(0); // the only to-do is done

  // the overview: the held driver is blocked with a hold nobody can override (no override offered), said plainly
  await page.goto("/compliance");
  const heldRow = page.locator("tr", { hasText: who });
  await expect(heldRow).toContainText("blocked");
  await expect(heldRow).toContainText("hold");
  await expect(heldRow).toContainText("On a safety hold — ask Safety");
  await expect(heldRow.locator("button:has-text('24h override')")).toHaveCount(0);

  // the new company's grace on qualification files ends: blank hire prerequisites block, the law's ones with no override
  const other = who === "Daniel Reyes" ? "Ana Torres" : "Daniel Reyes";
  await expect(page.getByTestId("dq-grace")).toContainText("grace until");
  await page.getByTestId("end-dq-grace").click();
  await page.getByRole("dialog").locator("button:has-text('Enforce now')").click();
  await expect(page.getByRole("status").filter({ hasText: "Enforced" })).toBeVisible();
  let otherRow = page.locator("tr", { hasText: other });
  await expect(otherRow).toContainText("blocked");
  await expect(otherRow).toContainText("No Clearinghouse pre-employment query");
  await expect(otherRow.locator("button:has-text('24h override')")).toHaveCount(0);
  // Safety records the query and the negative test; what's left (the road test) the owner can vouch for, logged for 24 hours
  await otherRow.locator("a").first().click();
  await page.waitForURL("**/settings/drivers/**");
  await page.goto(page.url().replace("/settings/drivers/", "/compliance/drivers/"));
  await page.getByTestId("dq-file").getByTestId("dq-record-clearinghouse_full").click();
  await page.getByRole("dialog").locator("button:has-text('Save')").click();
  await expect(page.getByTestId("dq-file").locator("#dq-clearinghouse_full")).toContainText("on file");
  if (other === "Ana Torres") {
    await page.getByTestId("da-file").getByTestId("add-test").click();
    dlg = page.getByRole("dialog");
    await dlg.locator("#t-reason").selectOption("pre_employment");
    await dlg.locator("#t-result").selectOption("negative");
    await dlg.locator("button:has-text('Save')").click();
    await expect(page.getByRole("status").filter({ hasText: "Test recorded" })).toBeVisible();
  }
  await page.goto("/compliance");
  otherRow = page.locator("tr", { hasText: other });
  await expect(otherRow).toContainText("Road test certificate (or CDL in lieu) missing");
  await otherRow.locator("button:has-text('24h override')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("input.input").fill("Road test done this morning, certificate on its way");
  await dlg.locator("button:has-text('Override for 24 h')").click();
  await expect(page.getByRole("status").filter({ hasText: "Override active for 24 h" })).toBeVisible();

  // a roadside inspection: the code files itself under HOS; OOS adds 2
  await page.goto("/compliance/inspections");
  await page.getByTestId("log-inspection").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#i-juris").fill("TX");
  await dlg.locator("#i-report").fill("TXAAA0001");
  await dlg.locator("#i-driver").selectOption({ label: "Daniel Reyes" });
  await dlg.getByTestId("add-violation").click();
  await dlg.getByLabel("Violation 1 code").fill("395.8(e)");
  await expect(dlg.getByLabel("Violation 1 BASIC")).toHaveValue("hos");
  await dlg.getByLabel("Violation 1 description").fill("False report of driver's record of duty status");
  await dlg.getByLabel("Violation 1 severity").fill("7");
  await dlg.getByTestId("violation-row").locator("label:has-text('OOS') input").check();
  // a driver out-of-service order: until when (10 hours off duty here)
  await expect(dlg.getByTestId("driver-oos")).toContainText("The driver is out of service");
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "out of service until when" })).toBeVisible();
  await dlg.locator("#i-oos-until").fill(new Date(Date.now() + 10 * 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await dlg.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status").filter({ hasText: "Inspection saved" })).toBeVisible();
  await expect(page.getByTestId("basics").locator(".card", { hasText: "HOS Compliance" })).toContainText("9.00");
  await expect(page.getByTestId("driver-points")).toContainText("Daniel Reyes");
  await expect(page.getByTestId("oos-rates")).toContainText("100.0%");
  await expect(page.getByTestId("inspections-table")).toContainText("Driver out of service until");

  // the overrides log
  await page.goto("/compliance/overrides");
  const log = page.getByTestId("overrides-table");
  await expect(log).toContainText(other);
  await expect(log).toContainText("Road test done this morning");
  await expect(log).toContainText("Paperwork");
  const csv = await page.request.get("/api/compliance/overrides?days=30");
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("Road test done this morning");
});
