// Features: F-8 EDI through the browser — partner setup, 204 by HTTP → draft order, inbox accept/decline, 214 in the log, .edi download
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd, future, step } from "./helpers";

const tender = (ref: string, isa: string) => `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260926*1400*U*00401*${isa}*0*T*>~
GS*SM*RXO*BSTW*20260926*1400*${Number(isa)}*X*004010~
ST*204*0001~
B2**BSTW**${ref}**PP~
B2A*00~
L11*${ref}*RC~
L11*4500991*PO~
N1*BT*RXO Expedite~
S5*1*CL*5000*L*4*PLT~
G62*37*20260927*1*0800~
N1*SH*Laredo Yard~
N3*1 Mines Rd~
N4*Laredo*TX*78045*US~
L5*1*AUTO PARTS~
S5*2*CU*5000*L*4*PLT~
G62*68*20260928*1*1500~
N1*CN*Toyota San Antonio~
N4*San Antonio*TX*78264*US~
L3*5000*G***180000~
SE*19*0001~
GE*1*${Number(isa)}~
IEA*1*${isa}~`;

test("EDI day: partner in four fields, a 204 arrives over HTTP and becomes a draft order, a manual tender is declined with a 990, milestones become 214s", async ({ page }) => {
  test.setTimeout(180_000);
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test", termsDays: "30" });
  await quickAdd(page, "trucks", "Add truck", { unitNumber: "2104", usPlate: "TX2104" });
  await quickAdd(page, "drivers", "Add driver", { name: "Daniel Reyes", driverType: "CDL", phone: "+1 956 000 0003" });
  await page.goto("/settings/drivers");
  await page.click("table a:has-text('Daniel')");
  await page.locator("#f-licenseExpires").fill(future(400));
  await page.locator("#f-medicalExpires").fill(future(300));
  await page.locator("#f-currentTruckId").selectOption({ label: "2104" });
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");

  // partner: the quick-add asks for their id, our SCAC, mode
  await quickAdd(page, "edi-partners", "Add EDI partner", { theirId: "RXO", customerId: "RXO", theirQualifier: "ZZ", scac: "BSTW", ourId: "BSTW", usage: "T" });
  await page.goto("/settings/edi-partners");
  await page.click("table a:has-text('RXO')");
  const url = (await page.locator("div.mono.select-all").textContent())!.trim();
  expect(url).toMatch(/\/api\/edi\/inbound\/[A-Za-z0-9_-]{20,}$/);

  // the customer's gateway POSTs a tender → 997 back, draft order here
  const res = await page.request.post(new URL(url).pathname, { data: tender("RC-778812", "000000123"), headers: { "content-type": "application/edi-x12" } });
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("ST*997*");
  expect(body).toContain("AK9*A*1*1*1~");
  expect(res.headers()["x-edi-result"]).toBe("204:A");
  // a wrong token is refused; the same interchange again is refused
  expect((await page.request.post("/api/edi/inbound/nope", { data: "x" })).status()).toBe(404);
  const dup = await page.request.post(new URL(url).pathname, { data: tender("RC-778812", "000000123") });
  expect(dup.status()).toBe(400);
  expect(await dup.text()).toMatch(/already received/);

  // the draft order carries the customer's stops, refs and rate; the log shows the 204 and the 997
  await page.goto("/orders");
  const row = page.locator("tr", { hasText: "RC-778812" });
  await expect(row).toContainText("RXO");
  await expect(row).toContainText("$1,800.00");
  await expect(row).toContainText("Draft");
  await page.goto("/edi");
  await page.click(".stage-tab:has-text('Log')");
  await expect(page.locator("tr", { hasText: "TENDER RC-778812" })).toContainText("accepted");
  await expect(page.locator("tr", { hasText: "997" })).toContainText("logged");
  // the ticker sends the 990 within a minute; "Send milestones now" does it right away
  await page.click("button:has-text('Send milestones now')");
  await expect(page.getByRole("status")).toContainText(/message\(s\) generated/);
  await expect(page.locator("tr", { hasText: "ACCEPT RC-778812" })).toBeVisible();
  const edi = await page.request.get(await page.locator("tr", { hasText: "ACCEPT RC-778812" }).locator("a:has-text('.edi')").getAttribute("href").then((h) => h!));
  expect(await edi.text()).toMatch(/B1\*BSTW\*RC-778812\*\d{8}\*A~/);

  // switch the partner to manual: the next tender waits in the inbox, the dispatcher sees it from the board and declines it
  await page.goto("/settings/edi-partners");
  await page.click("table a:has-text('RXO')");
  await page.locator("#f-autoCreateOrders").uncheck();
  await page.click("button:has-text('Save changes')");
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.request.post(new URL(url).pathname, { data: tender("RC-778813", "000000124") });
  await page.goto("/dispatch");
  await page.click("a:has-text('EDI'):has(.badge:has-text('1'))");
  await page.waitForURL("**/edi", { waitUntil: "commit" });
  const card = page.locator(".card", { hasText: "RC-778813" });
  await expect(card).toContainText("Laredo Yard (Laredo, TX) → Toyota San Antonio (San Antonio, TX) · $1,800.00");
  await card.locator("button:has-text('Details')").click();
  await expect(page.getByRole("dialog")).toContainText("AUTO PARTS");
  await page.keyboard.press("Escape");
  await card.locator("button:has-text('Decline')").click();
  await page.getByRole("dialog").locator("input.input").fill("no capacity Saturday");
  await page.getByRole("dialog").locator("button:has-text('Decline')").click();
  await expect(page.getByRole("status")).toContainText("990 sent");
  await expect(page.locator(".stage-tab:has-text('Inbox') .count")).toHaveCount(0);
  await page.click(".stage-tab:has-text('Log')");
  await expect(page.locator("tr", { hasText: "DECLINE RC-778813" })).toBeVisible();

  // run the first order: book, assign, walk two steps → two 214s in the log
  await page.goto("/orders");
  await page.locator("tr", { hasText: "RC-778812" }).locator("a").first().click();
  await page.waitForURL("**/orders/**", { waitUntil: "commit" });
  await expect(page.locator("main")).toContainText("Laredo Yard");
  await expect(page.locator("main")).toContainText("Toyota San Antonio");
  await page.click("button:has-text('Book')");
  await expect(page.getByRole("status")).toBeVisible();
  await page.goto("/dispatch");
  await page.locator(".row[role=button]").first().click();
  const panel = page.locator("aside").last();
  await panel.locator("button:has-text('Assign Domestic leg')").click();
  const dlg = page.getByRole("dialog");
  await dlg.locator(".cursor-pointer", { hasText: "2104" }).click();
  await dlg.locator("button:has-text('Assign & send')").click();
  await expect(page.getByRole("status")).toContainText("Assigned and sent");
  await page.click(".stage-tab:has-text('All')");
  await page.locator(".row[role=button]").first().click();
  for (let i = 0; i < 3; i++) {
    await step(panel); // accepted, rolling, arrived at pickup
    await page.waitForTimeout(200);
  }
  await page.goto("/edi");
  await page.click("button:has-text('Send milestones now')");
  await expect(page.getByRole("status")).toContainText(/message\(s\) generated/); // X3 arrived at pickup; rolling has no code
  await page.click(".stage-tab:has-text('Log')");
  await expect(page.locator("tr", { hasText: "X3 Arrived at pickup" })).toContainText("214");
});
