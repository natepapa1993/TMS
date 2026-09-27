// Features: F-13 customer portal through the browser — link from the customer record, their load with tracking, delivered with the POD, invoice with balance, a load request that lands on Dispatch and is booked
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { signupFresh, quickAdd, future, buildLoad } from "./helpers";

const POD = path.join(__dirname, "fixtures", "bol.pdf");

async function walkToDelivered(page: Page, orderNumber: string, steps = 7) {
  await page.click(".stage-tab:has-text('Dispatched')");
  await page.locator(".row[role=button]", { hasText: orderNumber }).click();
  const panel = page.locator("aside").last();
  for (let i = 0; i < steps; i++) {
    await panel.locator("button.btn-primary.btn-lg").click();
    await page.waitForTimeout(200);
  }
}

test("customer's day: one link, a load tracked to delivered, the POD and the invoice in hand, then a border load requested from the portal that Dispatch books", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signupFresh(page);
  await quickAdd(page, "billing-entities", "Add billing entity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", taxId: "12-3456789" });
  await quickAdd(page, "customers", "Add customer", { name: "Magna", kind: "customer", billingEmail: "ap@magna.test", termsDays: "45" });
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.goto("/settings/customers");
  await page.click("table a:has-text('Magna')");
  await page.locator("#f-requiredDocs").fill("POD");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // the link lives on the customer record
  const url = (await page.getByTestId("customer-portal-url").textContent())!.trim();
  expect(url).toMatch(/\/cp\/[A-Za-z0-9_-]{20,}$/);

  // a domestic load for Magna, our truck
  await buildLoad(page, { customer: "Magna", rate: "1800", stops: [{ type: "pickup", name: "Magna Detroit", country: "US" }, { type: "delivery", name: "Toyota San Antonio", country: "US" }] });
  const o1 = (await page.locator("aside .h2").first().textContent())!.match(/\d{2}-\d{5}/)![0];
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2104" }).click();
  await dlg.locator("#plan-miles").fill("1400");
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");

  // the customer's phone: the load is there with a tracking link; nothing about our costs
  const ctx2 = await browser.newContext();
  const phone = await ctx2.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(new URL(url).pathname);
  await expect(phone.locator("body")).toContainText("Magna");
  await expect(phone.locator("body")).toContainText("customer portal");
  const card = phone.getByTestId("load-card").filter({ hasText: o1 });
  await expect(card).toContainText("Driver assigned");
  await expect(card).toContainText("Magna Detroit → Toyota San Antonio");
  const track = card.locator("a:has-text('Track')");
  await expect(track).toHaveAttribute("href", /\/track\//);
  await expect(phone.locator("body")).not.toContainText("1,400");
  await expect(phone.locator("body")).not.toContainText("956 000");
  const trackPage = await ctx2.newPage();
  await trackPage.goto(new URL((await track.getAttribute("href"))!).pathname);
  await expect(trackPage.locator("body")).toContainText(o1);
  await trackPage.close();

  // we run it; the customer sees delivered, then the POD, then the invoice
  await walkToDelivered(page, o1);
  await phone.reload();
  await phone.locator(".stage-tab", { hasText: "Delivered" }).click();
  await expect(phone.getByTestId("load-card").filter({ hasText: o1 })).toContainText("Delivered");
  await expect(phone.getByTestId("load-card").filter({ hasText: o1 }).locator("a:has-text('Proof of delivery')")).toHaveCount(0);
  await page.goto("/billing");
  await page.locator("tr", { hasText: o1 }).locator("button.pill-red:has-text('POD')").click();
  const up = page.getByRole("dialog");
  await up.locator("input[type=file]").setInputFiles(POD);
  await up.locator("button:has-text('Upload')").last().click();
  await expect(up).toBeHidden();
  await page.locator("tr", { hasText: o1 }).locator("button:has-text('Create invoice')").click();
  await expect(page.getByRole("status")).toContainText("Draft invoice created");
  await page.locator("tr", { hasText: o1 }).locator("a:has-text('Open draft')").click();
  await page.waitForURL("**/billing/invoices/**", { waitUntil: "commit" });
  await page.click("button:has-text('Issue invoice')");
  await expect(page.getByRole("status")).toContainText("Issued");
  await phone.reload();
  await phone.locator(".stage-tab", { hasText: "Delivered" }).click();
  const done = phone.getByTestId("load-card").filter({ hasText: o1 });
  const pod = done.locator("a:has-text('Proof of delivery')");
  await expect(pod).toHaveCount(1);
  const podResp = await phone.request.get((await pod.getAttribute("href"))!);
  expect(podResp.headers()["content-type"]).toContain("application/pdf");
  await expect(done.locator("a:has-text('Invoice 247-000001')")).toHaveCount(1);
  await phone.locator(".stage-tab", { hasText: "Invoices" }).click();
  await expect(phone.locator("body")).toContainText("$1,800.00");
  await expect(phone.locator("body")).toContainText("terms net 45");
  await expect(phone.locator(".pill", { hasText: "$1,800.00 open" })).toBeVisible();

  // the page reads in Spanish for a Mexican shipper (one tap either way); Magna is a US customer here, so English first
  await phone.getByTestId("lang").click();
  await expect(phone.locator("body")).toContainText("portal del cliente");
  await expect(phone.locator(".stage-tab", { hasText: "Embarques" })).toBeVisible();
  await expect(phone.locator("body")).toContainText("por pagar");
  await phone.getByTestId("lang").click();
  await expect(phone.locator(".stage-tab", { hasText: "Loads" })).toBeVisible();

  // the customer asks for a border load; it lands on Dispatch as a draft with a flag; dispatch prices and books it
  await phone.locator(".stage-tab", { hasText: "Request a load" }).click();
  await phone.locator("button:has-text('Send the request')").click();
  await expect(phone.locator("body")).toContainText("where do we pick up");
  await phone.getByLabel("Shipper / location").fill("Magna Ramos Arizpe");
  await phone.locator("select").first().selectOption("MX");
  await phone.getByLabel("Consignee / location").fill("Magna Arlington");
  await phone.locator("input.input").nth(9).fill("PO-9001"); // PO #
  await phone.getByLabel("What is it").fill("26 pallets seats");
  await phone.locator("button:has-text('Send the request')").click();
  await expect(phone.locator("body")).toContainText("Request received");
  await phone.locator("button:has-text('See your loads')").click();
  await expect(phone.getByTestId("load-card").filter({ hasText: "PO-9001" })).toContainText("Requested");

  await page.goto("/dispatch");
  await expect(page.locator("a:has-text('Requests · 1')")).toBeVisible();
  const req = page.locator(".row[role=button]", { hasText: "Magna Ramos Arizpe" });
  await expect(req).toHaveCount(1);
  await req.click();
  await expect(panel).toContainText("Load request from Magna");
  await panel.locator("summary:has-text('Details')").click();
  await panel.locator("a:has-text('Open order')").click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("Draft");
  await page.getByTestId("tab-money").click();
  await page.locator("label:has-text('TBD') input[type=checkbox]").uncheck(); // the request came in TBD
  await page.locator("input[aria-label='Rate']").fill("3100");
  await page.click("button:has-text('Save rate')");
  await expect(page.getByRole("status")).toContainText("Rate saved");
  await page.click("button:has-text('Book')");
  await expect(page.getByRole("status").filter({ hasText: "Booked" })).toBeVisible();
  await page.goto("/dispatch");
  await expect(page.locator("a:has-text('Requests')")).toHaveCount(0);
  await phone.reload();
  await expect(phone.getByTestId("load-card").filter({ hasText: "PO-9001" })).toContainText("Booked");
  await ctx2.close();
});
