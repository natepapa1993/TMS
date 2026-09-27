import { type Page, expect } from "@playwright/test";

export const uid = () => Math.random().toString(36).slice(2, 8);

/** Create a fresh company through the real signup flow and land on Settings. */
export async function signupFresh(page: Page, name = `E2E Carrier ${uid()}`) {
  const email = `owner-${uid()}@e2e.local`;
  const password = "e2e-password-123";
  await page.goto("/signup");
  await page.fill("#tenantName", name);
  await page.fill("#ownerName", "E2E Owner");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button:has-text('Create company')");
  await page.waitForURL("**/settings**", { waitUntil: "commit" });
  return { email, password, name };
}

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button:has-text('Sign in')");
  await page.waitForURL("**/dispatch", { waitUntil: "commit" });
}

/** Fill the quick-add popup for a record kind. Values keyed by field name (input id f-<name>). */
export async function quickAdd(page: Page, path: string, label: string, values: Record<string, string>) {
  await page.goto(`/settings/${path}`);
  await page.click(`button:has-text('${label}')`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const [k, v] of Object.entries(values)) {
    const el = dialog.locator(`#f-${k}`);
    if ((await el.evaluate((e) => e.tagName)) === "SELECT") await el.selectOption(v);
    else await el.fill(v);
  }
  await dialog.locator("button:has-text('Add')").click();
  await expect(dialog).toBeHidden();
}

export const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
