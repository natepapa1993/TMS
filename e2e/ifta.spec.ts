// Features: F-21.5
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("IFTA: fuel from a receipt and a fuel-card sheet, trip-sheet miles, the quarter's rates, the return and its CSV", async ({ page }) => {
  test.setTimeout(120_000);
  await signupFresh(page);
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await page.goto("/billing/ifta");
  await expect(page.getByTestId("ifta-warnings")).toContainText("No fuel purchases");
  const quarterStart = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(Math.floor(d.getMonth() / 3) * 3 + 1).padStart(2, "0")}-02`;
  });

  // recalculate: nothing to find yet, still fine
  await page.click("button:has-text('Recalculate miles')");
  await expect(page.getByRole("status").filter({ hasText: "Miles recalculated" })).toBeVisible();

  // trip-sheet miles
  await page.click("button.stage-tab:has-text('Trip sheets')");
  for (const [j, mi] of [["TX", "1200"], ["OK", "300"], ["MX", "500"]]) {
    await page.click("button:has-text('+ Trip-sheet miles')");
    const d = page.getByRole("dialog");
    await d.locator("#tp-date").fill(quarterStart);
    await d.locator("#tp-j").fill(j);
    await d.locator("#tp-miles").fill(mi);
    await d.locator("button:has-text('Add')").click();
    await expect(d).toBeHidden();
  }
  await expect(page.getByTestId("trip-row")).toHaveCount(3);

  // a receipt, then the fuel card's export
  await page.click("button.stage-tab:has-text('Fuel purchases')");
  await page.click("button:has-text('+ Fuel purchase')");
  const d = page.getByRole("dialog");
  await d.locator("#fp-date").fill(quarterStart);
  await d.locator("#fp-j").fill("Texas");
  await d.locator("#fp-qty").fill("150");
  await d.locator("#fp-amount").fill("600");
  await d.locator("button:has-text('Add')").click();
  await expect(d).toBeHidden();
  const [m, day] = [quarterStart.slice(5, 7), "03"];
  const csv = `Tran Date,Unit,Location Name,City,State/Prov,Item,Qty,Amount,Invoice\n${m}/${day}/${quarterStart.slice(0, 4)},2104,Pilot 1,Oklahoma City,OK,ULSD,100,380.00,A1\n${m}/${day}/${quarterStart.slice(0, 4)},2104,Pilot 1,Oklahoma City,OK,DEF,5,20.00,A2\n${m}/${day}/${quarterStart.slice(0, 4)},7777,Love's,Dallas,TX,ULSD,80,300.00,A3\n`;
  await page.getByLabel("Fuel card file").setInputFiles({ name: "efs.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("fuel-import")).toContainText("2 purchases imported");
  await expect(page.getByTestId("fuel-import")).toContainText("unit 7777 is not one of your trucks");
  await expect(page.getByTestId("fuel-row")).toHaveCount(3);

  // miles 2,000 ÷ 250 taxable gallons (DEF out) = 8.00 MPG
  await expect(page.getByTestId("ifta-summary")).toContainText("2,000");
  await expect(page.getByTestId("ifta-summary")).toContainText("8.00");
  await page.click("button.stage-tab:has-text('Return')");
  await expect(page.getByTestId("ifta-row").filter({ hasText: "MX" })).toContainText("not IFTA");
  // TX: 1,200 mi ÷ 8 = 150 taxable − 150 paid = 0; OK: 300 ÷ 8 = 37.5 − 100 = −62.5 gal credit
  await page.getByLabel("TX rate").fill("0.20");
  await page.getByLabel("OK rate").fill("0.20");
  await page.click("button:has-text('Save rates')");
  await expect(page.getByRole("status").filter({ hasText: "2 rate(s) saved" })).toBeVisible();
  await expect(page.getByTestId("ifta-total")).toHaveText("($12.50)");

  const res = await page.request.get(`/api/ifta?quarter=${quarterStart.slice(0, 4)}Q${Math.floor((Number(m) - 1) / 3) + 1}`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("OK,yes,300,37.5,100,-62.5,0.2,,-12.50");
  expect(body).toContain("Fleet MPG,8");
});
