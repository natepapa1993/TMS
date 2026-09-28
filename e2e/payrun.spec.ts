// Features: F-26.4 F-26.5
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad, loadMenu } from "./helpers";

async function tonuLoad(page: Page, amount: string) {
  const num = await buildLoad(page, { customer: "Acme Foods", rate: "1000", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });
  const id = new URL(page.url()).searchParams.get("order");
  await page.goto(`/orders/${id}`);
  await loadMenu(page);
  await page.click("button:has-text('TONU')");
  const d = page.getByRole("dialog");
  await d.locator("#tonu-amount").fill(amount);
  await d.locator("#tonu-reason").fill("Shipper cancelled");
  await d.locator("button:has-text('Cancel & bill TONU')").click();
  await expect(page.getByRole("status").filter({ hasText: "the fee goes to billing" })).toBeVisible();
  return num;
}

test("pay run and factoring: the week's statements built, approved and paid in one batch with a PDF; a factored invoice funded, off Receivables, then collected", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "Pay Carrier LLC", country: "US", invoicePrefix: "PC" });
  await page.goto("/settings/billing-entities");
  await page.click("table a:has-text('Pay Carrier LLC')");
  await page.locator("#f-factorName").fill("Triumph");
  await page.locator("#f-factorEmail").fill("schedules@triumph.test");
  await page.locator("#f-factorAll").check();
  await page.locator("#f-factorAdvanceBp").fill("90");
  await page.locator("#f-factorFeeBp").fill("3");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await quickAdd(page, "customers", "Add customer", { name: "Acme Foods", kind: "customer", billingEmail: "ap@acme.test" });
  await page.goto("/settings/customers");
  await page.click("table a:has-text('Acme Foods')");
  await page.locator("#f-requiredDocs").fill("none");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await quickAdd(page, "drivers", "Add driver", { name: "Ana Torres", driverType: "CDL" });

  // ---- the pay run: a reimbursement due, the week run for everyone, approved and paid in one batch
  await page.goto("/billing/settlements");
  await page.click("button:has-text('+ Pay item')");
  let dlg = page.getByRole("dialog");
  await dlg.getByLabel("Pay item kind").selectOption("reimbursement");
  await dlg.locator("input.input").first().fill("Scale ticket");
  await dlg.getByLabel("Pay item amount").fill("12");
  await dlg.locator("button:has-text('Add')").click();
  await expect(page.getByRole("status")).toContainText("Pay item added");
  await page.getByTestId("run-week").click();
  await expect(page.getByRole("status")).toContainText("1 statement built");
  const row = page.getByTestId("settlement-row").filter({ hasText: "Ana Torres" });
  await expect(row).toContainText("$12.00");
  await row.getByLabel("Select Ana Torres").check();
  await page.getByTestId("settlement-bulk").locator("button:has-text('Approve selected')").click();
  await expect(page.getByRole("status")).toContainText("1 approved");
  await row.getByLabel("Select Ana Torres").check();
  await page.getByTestId("settlement-bulk").locator("button:has-text('Pay selected')").click();
  dlg = page.getByRole("dialog");
  await dlg.locator("#bp-ref").fill("ACH 0926");
  await dlg.locator("button:has-text('Mark paid')").click();
  await expect(page.getByRole("status")).toContainText("1 paid · $12.00");
  await expect(row).toContainText("paid");
  await row.click();
  const pdfHref = await page.getByRole("dialog").locator("a:has-text('PDF')").getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await page.keyboard.press("Escape");

  // ---- factoring: invoice issued to the factor, funded at 90/3, off Receivables, collected with the reserve back
  await tonuLoad(page, "1000");
  await page.goto("/billing");
  await page.click("button:has-text('Select all eligible')");
  await page.click("button:has-text('Bill selected (1)')");
  await page.getByRole("dialog").locator("button:has-text('Create, issue & send (1)')").click();
  await expect(page.getByTestId("batch-result-row")).toHaveCount(1);
  await page.getByRole("dialog").locator("button:has-text('Done')").click();
  await page.goto("/billing/factoring");
  await expect(page.getByTestId("factor-tiles")).toContainText("$1,000.00");
  const ledger = page.getByTestId("factor-ledger");
  await expect(ledger).toContainText("waiting for funding");
  await ledger.locator("input[type=checkbox]").first().check();
  await page.getByTestId("record-funding").click();
  dlg = page.getByRole("dialog");
  await expect(dlg.locator("#f-adv")).toHaveValue("90");
  await dlg.locator("#f-ref").fill("SCH-77");
  await dlg.locator("button:has-text('Record funding')").click();
  await expect(page.getByRole("status")).toContainText("$900.00 advanced");
  await expect(ledger).toContainText("funded");
  await expect(page.getByTestId("factor-tiles")).toContainText("$70.00"); // reserve held
  await page.goto("/billing/ar");
  await expect(page.locator("main")).toContainText("$1,000.00 more is with the factor");
  await page.goto("/billing/factoring");
  await page.getByTestId("factor-ledger").locator("button:has-text('Collected')").click();
  await page.getByRole("dialog").locator("button:has-text('Record collection')").click();
  await expect(page.getByRole("status")).toContainText("$70.00 reserve released");
  await expect(page.getByTestId("factor-ledger")).toContainText("collected");
});
