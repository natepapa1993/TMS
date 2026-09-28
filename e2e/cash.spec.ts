// Features: F-26.1 F-26.2 F-26.3
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad } from "./helpers";

/** A booked load for Acme, TONU'd so it bills with no paperwork. */
async function tonuLoad(page: Page, amount: string) {
  const num = await buildLoad(page, { customer: "Acme Foods", rate: "1000", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });
  const id = new URL(page.url()).searchParams.get("order");
  await page.goto(`/orders/${id}`);
  await page.click("button:has-text('TONU')");
  const d = page.getByRole("dialog");
  await d.locator("#tonu-amount").fill(amount);
  await d.locator("#tonu-reason").fill("Shipper cancelled");
  await d.locator("button:has-text('Cancel & bill TONU')").click();
  await expect(page.getByRole("status").filter({ hasText: "the fee goes to billing" })).toBeVisible();
  return num;
}

test("cash: bill three loads, find one by its load #, one check pays two invoices with the rest on account, rebill the third", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "Cash Carrier LLC", country: "US", invoicePrefix: "CC" });
  await quickAdd(page, "customers", "Add customer", { name: "Acme Foods", kind: "customer", billingEmail: "ap@acme.test" });
  await page.goto("/settings/customers");
  await page.click("table a:has-text('Acme Foods')");
  await page.locator("#f-requiredDocs").fill("none");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  const n1 = await tonuLoad(page, "250");
  const n2 = await tonuLoad(page, "300");
  const n3 = await tonuLoad(page, "400");

  await page.goto("/billing");
  await page.click("button:has-text('Select all eligible')");
  await page.click("button:has-text('Bill selected (3)')");
  await page.getByRole("dialog").locator("button:has-text('Create, issue & send (3)')").click();
  await expect(page.getByTestId("batch-result-row")).toHaveCount(3);
  await page.getByRole("dialog").locator("button:has-text('Done')").click();

  // the invoice list: search by load #, the open total
  await page.goto("/billing/invoices");
  await expect(page.getByTestId("invoice-count")).toContainText("3 invoices · $950.00 open");
  await page.locator("#inv-q").fill(n2);
  await page.click("button:has-text('Filter')");
  await expect(page.getByTestId("invoice-count")).toContainText("1 invoice");
  const csv = await page.request.get(`/api/invoices/export?q=${n2}`);
  expect((await csv.text()).split("\n")).toHaveLength(2);

  // one check for $600: oldest first pays the $250 and the $300, $50 goes on account
  await page.goto("/billing/payments");
  await page.getByTestId("record-payment").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("#p-customer").selectOption({ label: "Acme Foods" });
  await expect(dlg.getByTestId("apply-row")).toHaveCount(3);
  await dlg.locator("#p-amount").fill("600");
  await dlg.locator("#p-ref").fill("CHK 5521");
  await dlg.locator("#p-remit").fill(`Loads ${n1} and ${n2}`);
  await dlg.getByTestId("auto-apply").click();
  await expect(dlg.getByTestId("payment-balance")).toContainText("Applied $550.00 of $600.00 · $50.00 goes on account");
  await dlg.locator("button:has-text('Apply payment')").click();
  await expect(dlg.getByTestId("payment-result")).toContainText("$50.00 on account");
  await expect(dlg.getByTestId("payment-result")).not.toContainText("still open");
  await dlg.locator("button:has-text('Done')").click();
  const pays = page.getByTestId("payments-table");
  await expect(pays).toContainText("CHK 5521");
  await expect(pays).toContainText("$50.00");
  await page.goto("/billing/ar");
  await expect(page.locator("main")).toContainText("$400.00");
  await expect(page.locator("tr", { hasText: "Acme Foods" })).toContainText("$50.00");

  // the third: the customer wants it rebilled
  await page.goto(`/billing/invoices?q=${n3}`);
  await page.locator("table a.mono, table td.mono a").first().click();
  await page.waitForURL("**/billing/invoices/**");
  await page.click("button:has-text('Rebill')");
  const rb = page.getByRole("dialog");
  await rb.locator("input.input").fill("Acme wants their PO on it");
  await rb.locator("button:has-text('Void & open the new draft')").click();
  await expect(page.locator("main")).toContainText("rebill of CC-");
  await expect(page.locator("main")).toContainText("Draft invoice");
  await page.click("button:has-text('Issue invoice')");
  await expect(page.getByRole("status")).toContainText("Issued");
});
