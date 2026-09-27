// Features: F-21.4
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd, buildLoad } from "./helpers";

/** A booked load for Acme, then TONU'd so it is billable with no paperwork. */
async function tonuLoad(page: Page, amount: string) {
  const num = await buildLoad(page, { customer: "Acme Foods", rate: "1000", stops: [{ type: "pickup", name: "Shipper Canton", country: "US" }, { type: "delivery", name: "DC Columbus", country: "US" }] });
  const id = new URL(page.url()).searchParams.get("order");
  await page.goto(`/orders/${id}`);
  await page.click("button:has-text('TONU')");
  const d = page.getByRole("dialog");
  await d.locator("#tonu-amount").fill(amount);
  await d.locator("#tonu-reason").fill("Shipper cancelled");
  await d.locator("button:has-text('Cancel & bill TONU')").click();
  await expect(page.getByTestId("load-header")).toContainText("TONU");
  return num;
}

test("billing run: a summary customer's loads become one invoice, issued and emailed with its documents; delivery is on the invoice", async ({ page }) => {
  test.setTimeout(150_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "Batch Carrier LLC", country: "US", invoicePrefix: "BC" });
  await quickAdd(page, "customers", "Add customer", { name: "Acme Foods", kind: "customer", billingEmail: "ap@acme.test" });
  await page.goto("/settings/customers");
  await page.click("table a:has-text('Acme Foods')");
  await page.locator("#f-requiredDocs").fill("none");
  await page.locator("#f-invoiceMode").selectOption("summary");
  await page.locator("#f-invoiceCc").fill("ops@acme.test");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  const n1 = await tonuLoad(page, "250");
  const n2 = await tonuLoad(page, "300");

  await page.goto("/billing");
  await page.click("button:has-text('Select all eligible')");
  await page.click("button:has-text('Bill selected (2)')");
  const plan = page.getByTestId("batch-plan");
  await expect(plan.getByTestId("batch-invoice")).toHaveCount(1);
  await expect(plan).toContainText("Summary · 2 loads");
  await expect(plan).toContainText("ap@acme.test");
  await expect(plan).toContainText("$550.00");
  await page.getByRole("dialog").locator("button:has-text('Create, issue & send (1)')").click();
  const res = page.getByTestId("batch-result-row");
  await expect(res).toContainText("sent");
  await expect(res).toContainText("BC-");
  await res.locator("a").click();
  await page.waitForURL("**/billing/invoices/**", { waitUntil: "commit" });
  await expect(page.getByTestId("invoice-loads")).toContainText(n1);
  await expect(page.getByTestId("invoice-loads")).toContainText(n2);
  await expect(page.getByTestId("invoice-deliveries")).toContainText("ap@acme.test, ops@acme.test");
  await expect(page.locator("main")).toContainText("Summary · 2 loads");
  const packet = await page.request.get(page.url().replace(/\/billing\/invoices\/([^/?]+).*/, "/api/invoices/$1/packet"));
  expect(packet.status()).toBe(200);
  expect(packet.headers()["content-type"]).toBe("application/pdf");

  // recorded by hand: uploaded to the portal
  await page.click("button:has-text('Send again')");
  const d = page.getByRole("dialog");
  await d.locator("#d-method").selectOption("portal");
  await d.locator("#d-to").fill("https://portal.acme.test");
  await d.locator("#d-ref").fill("CONF-42");
  await d.locator("button:has-text('Record')").click();
  await expect(page.getByTestId("invoice-deliveries")).toContainText("CONF-42");
});
