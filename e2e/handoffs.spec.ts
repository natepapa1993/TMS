// Features: F-31.1 F-31.4 F-31.5
import { test, expect, type Page } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

/** Every React error the page logs; #418 is a server/browser text mismatch (hydration). */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

// the browser sits in Tokyo on purpose: nothing a dispatcher reads may depend on the viewer's zone
test.use({ timezoneId: "Asia/Tokyo" });

test("one clock: a Mexican pickup reads CST on every screen, a stop edit keeps its city, the MX carrier's offer is in Spanish", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "Sierra Madre", kind: "customer" });
  await quickAdd(page, "carriers", "Add carrier", { name: "Transportes del Norte", country: "MX", kind: "mx", dispatchEmail: "despacho@norte.test" });

  // Ramos Arizpe (CST all year) → Patio Nuevo Laredo (US daylight time) → Laredo yard → Dallas
  await page.goto("/orders/new");
  await page.locator("#l-customer").selectOption({ label: "Sierra Madre" });
  await page.locator("#l-rate").fill("2950");
  for (let i = 2; i < 4; i++) await page.click("button:has-text('+ Add stop')");
  const stops = [
    { type: "pickup", name: "Magna Ramos", city: "Ramos Arizpe", state: "COAH", country: "MX", from: "2027-06-15T08:00" },
    { type: "border_yard", name: "Patio Nuevo Laredo", city: "Nuevo Laredo", state: "TAMPS", country: "MX", from: "" },
    { type: "yard", name: "Laredo Yard", city: "Laredo", state: "TX", country: "US", from: "" },
    { type: "delivery", name: "Dallas DC", city: "Dallas", state: "TX", country: "US", from: "2027-06-16T09:00" },
  ];
  for (const [i, st] of stops.entries()) {
    const n = i + 1;
    await page.getByLabel(`Stop ${n} type`).selectOption(st.type);
    await page.getByLabel(`Stop ${n} location`).fill(st.name);
    await page.getByLabel(`Stop ${n} country`).selectOption(st.country);
    await page.getByLabel(`Stop ${n} city`).fill(st.city);
    await page.getByLabel(`Stop ${n} state`).fill(st.state);
    if (st.from) await page.getByLabel(`Stop ${n} from`).fill(st.from);
  }
  await page.click("button:has-text('Create & book')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });
  const row = page.getByTestId("trip-board").locator(".row[role=button]").first();
  await expect(row).toContainText("Jun 15, 8:00 AM CST");
  const num = (await page.locator("aside .h2").first().textContent())!.match(/\d{2}-\d{5}/)![0];

  // Loads grid: the stop's clock too
  await page.goto("/orders");
  const gridRow = page.getByTestId("grid-row").filter({ hasText: num });
  await expect(gridRow).toContainText("Jun 15, 8:00 AM CST");
  await expect(gridRow).toContainText("Jun 16, 9:00 AM CDT");

  // the load page: header and stops, rendered once on the server and hydrated without a mismatch
  await gridRow.locator("a").first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.getByTestId("load-facts")).toContainText("Tue Jun 15, 8:00 AM CST");
  await expect(page.getByTestId("load-facts")).toContainText("Wed Jun 16, 9:00 AM CDT");
  await page.getByTestId("tab-stops").click();
  const first = page.getByTestId("load-stop").first();
  await expect(first).toContainText("Jun 15, 8:00 AM CST");

  // B4: change only the time in the builder's stop editor; the city, state and zone stay
  await first.locator(".cursor-pointer").first().click();
  await expect(page.getByLabel("Stop 1 city")).toHaveValue("Ramos Arizpe");
  await expect(first).toContainText("on the stop's clock (CST)");
  await page.getByLabel("Stop 1 from").fill("2027-06-15T09:00");
  await first.locator("button:has-text('Save stop')").click();
  await expect(page.getByRole("status").filter({ hasText: "Stop 1 saved" })).toBeVisible();
  await expect(page.getByTestId("load-stop").first()).toContainText("Ramos Arizpe");
  await expect(page.getByTestId("load-stop").first()).toContainText("Jun 15, 9:00 AM CST");
  await page.reload();
  await expect(page.getByTestId("load-facts")).toContainText("Tue Jun 15, 9:00 AM CST");
  await expect(page.getByTestId("load-header")).toContainText("Ramos Arizpe");

  // the MX leg offered to a Mexican carrier: Spanish, the full load, each stop on its clock
  await page.goto(`/dispatch?order=${encodeURIComponent((page.url().match(/orders\/([^/?]+)/) ?? [])[1] ?? "")}`);
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign MX leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator("button:has-text('Partner carrier')").click();
  await dlg.locator("select").first().selectOption({ label: "Transportes del Norte (MX)" });
  await dlg.locator("input[placeholder='what you pay them']").fill("480");
  await dlg.locator("button:has-text('Send tender')").click();
  await expect(page.getByRole("status")).toContainText("Tender emailed");
  await page.click(".stage-tab:has-text('All')");
  await page.getByTestId("trip-board").locator(".row[role=button]").filter({ hasText: num }).click();
  const url = (await panel.locator("a:has-text('Link')").first().getAttribute("href"))!;
  const ctx2 = await browser.newContext({ timezoneId: "America/New_York" });
  const carrier = await ctx2.newPage();
  await carrier.goto(url);
  await expect(carrier.locator("body")).toContainText("Transportes del Norte, ¿puede cubrir esta carga?");
  await expect(carrier.locator("body")).toContainText("Tue Jun 15, 9:00 AM CST");
  await expect(carrier.getByTestId("tender-details")).toContainText("Caja seca 53'");
  await carrier.click("button:has-text('Sí, acepto')");
  await carrier.locator("#t-name").fill("Luis");
  await carrier.locator("#t-driver").fill("Juan Pérez");
  await carrier.locator("#t-unit").fill("TN-14");
  await carrier.locator("#t-trailer").fill("caja-7702");
  await carrier.click("button:has-text('Confirmar')");
  await expect(carrier.locator("body")).toContainText("Gracias — es suya.");
  await expect(carrier.locator("body")).toContainText("caja CAJA-7702");
  await ctx2.close();

  // the caja the carrier gave is already on the crossing
  await page.goto("/crossing");
  await page.click(`.row:has-text('${num}')`);
  await page.waitForURL("**/crossing/**");
  await expect(page.locator("#x-trailer")).toHaveValue("CAJA-7702");

  expect(errors.filter((e) => /#418|Hydration|hydrat/i.test(e))).toEqual([]);
});
