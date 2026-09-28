// Features: F-20.6
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

test("map: Fleet ↔ Map, units without a position are listed, the map renders", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await page.goto("/fleet");
  await page.click("a:has-text('Map')");
  await page.waitForURL("**/fleet/map", { waitUntil: "commit" });
  await expect(page.getByTestId("map-list")).toContainText("No positions yet");
  await expect(page.locator("main")).toContainText("No position: 2104");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await page.click("a:has-text('Units')");
  await page.waitForURL("**/fleet", { waitUntil: "commit" });
});
