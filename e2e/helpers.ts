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
    const tag = await el.evaluate((e) => `${e.tagName}:${(e as HTMLInputElement).type}`);
    if (tag.startsWith("SELECT")) await el.selectOption(v);
    else if (tag === "INPUT:checkbox") await el.setChecked(v === "true");
    else await el.fill(v);
  }
  await dialog.locator("button:has-text('Add')").click();
  await expect(dialog).toBeHidden();
}

export const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

export type LoadStop = { type: "pickup" | "delivery" | "yard" | "border_yard" | "transload" | "customs" | "terminal"; name: string; country: "US" | "MX" | "CA" };

/** Mexico → US through a border yard and a US yard: MX leg, the crossing, the US leg. */
export const mxToUs = (pickup: string, delivery: string): LoadStop[] => [
  { type: "pickup", name: pickup, country: "MX" },
  { type: "border_yard", name: "Border yard (MX)", country: "MX" },
  { type: "yard", name: "Laredo yard", country: "US" },
  { type: "delivery", name: delivery, country: "US" },
];

/**
 * Build a load in the load builder (n on Dispatch), book it, and land on Dispatch with it open.
 * Returns the order number.
 */
export async function buildLoad(page: Page, o: { customer: string; rate?: string; stops: LoadStop[] }) {
  await page.goto("/dispatch");
  // n opens the builder once the board has hydrated; press again if the first one landed too early
  await expect(async () => {
    if (!page.url().includes("/orders/new")) await page.keyboard.press("n");
    await page.waitForURL("**/orders/new", { waitUntil: "commit", timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await page.locator("#l-customer").selectOption({ label: o.customer });
  if (o.rate) await page.locator("#l-rate").fill(o.rate);
  for (let i = 2; i < o.stops.length; i++) await page.click("button:has-text('+ Add stop')");
  await expect(page.getByTestId("stop")).toHaveCount(o.stops.length);
  for (const [i, st] of o.stops.entries()) {
    await page.getByLabel(`Stop ${i + 1} type`).selectOption(st.type);
    await page.getByLabel(`Stop ${i + 1} location`).fill(st.name);
    await page.getByLabel(`Stop ${i + 1} country`).selectOption(st.country);
  }
  await page.click("button:has-text('Create & book')");
  await page.waitForURL("**/dispatch?order=**", { waitUntil: "commit" });
  await expect(page.locator("aside .h2").first()).toContainText(/\d{2}-\d{5}/);
  return (await page.locator("aside .h2").first().textContent())!.match(/\d{2}-\d{5}/)![0];
}
