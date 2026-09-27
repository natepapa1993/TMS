// Features: F-15 the inbox agent through the browser — mailbox set up, a rate con emailed in becomes a card and, on a tap, a draft order; a status question becomes a drafted reply
import { test, expect } from "@playwright/test";
import { signupFresh, quickAdd } from "./helpers";

function mime(o: { from: string; fromName?: string; subject: string; text: string; pdf?: boolean }) {
  const b = "----=_Part_e2e";
  const head = [`From: ${o.fromName ? `"${o.fromName}" <${o.from}>` : o.from}`, "To: dispatch@247expedite.test", `Subject: ${o.subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Math.random().toString(36).slice(2)}@e2e>`, "MIME-Version: 1.0"];
  if (!o.pdf) return [...head, "Content-Type: text/plain; charset=utf-8", "", o.text].join("\r\n");
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, "Content-Type: text/plain; charset=utf-8", "", o.text, `--${b}`, 'Content-Type: application/pdf; name="RC_4500991.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="RC_4500991.pdf"', "", Buffer.from("%PDF-1.4 rate con fixture").toString("base64"), `--${b}--`].join("\r\n");
}

test("inbox agent: a rate con to dispatch@ becomes a card and a draft order on a tap; a status question becomes a drafted reply; the office reads the paper", async ({ page }) => {
  await signupFresh(page);
  await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker", billingEmail: "ap@rxo.test" });
  // the mailbox: saved once for the inbound URL (no IMAP needed when the mailbox is forwarded)
  await page.goto("/settings/integrations");
  const card = page.locator(".card", { hasText: "Dispatch mailbox" });
  await card.locator("input[type=checkbox]").check();
  await card.locator("button:has-text('Save')").click();
  await expect(page.getByRole("status")).toContainText("Saved");
  const url = await page.getByTestId("inbound-url").textContent();
  expect(url).toMatch(/\/api\/mail\/inbound\//);
  await card.getByTestId("poll-mail").click();
  await expect(page.getByRole("status").filter({ hasText: "no IMAP host" })).toBeVisible(); // honest: nothing to pull from

  // the rate con arrives (what Cloudflare / Mailgun / Postmark would POST)
  const res = await page.request.post(new URL(url!).pathname, { headers: { "content-type": "message/rfc822" }, data: mime({ from: "ap@rxo.test", fromName: "Ana Lopez", subject: "Rate Confirmation PO 4500991", text: "Pickup: Planta Monterrey, Apodaca NL MX\nDelivery: GM Arlington, TX\nRate: $2,850.00\n53' dry van\n26 pallets seats", pdf: true }) });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).kind).toBe("rate_con");
  await page.goto("/messages");
  const mc = page.getByTestId("mail-card").first();
  await expect(mc).toContainText("Rate confirmation");
  await expect(mc).toContainText("Create draft order");
  await expect(mc).toContainText("RXO"); // the sender's address is RXO's billing address
  await expect(mc).toContainText("RC_4500991.pdf");
  await mc.locator("button:has-text('Open')").click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("Customer")).toHaveValue(/./);
  await expect(dlg.getByLabel("Rate")).toHaveValue("2850.00");
  await expect(dlg).toContainText("Planta Monterrey");
  await expect(dlg).toContainText("the PDF goes on as RATE CON");
  await dlg.getByLabel("Rate").fill("2900"); // a correction on the card wins
  await dlg.getByTestId("approve-edited").click();
  await expect(page.getByRole("status")).toContainText("draft order 26-00001 created with the rate con attached");
  await expect(page.getByTestId("mail-card")).toHaveCount(0); // handled
  await page.goto("/orders?state=draft");
  await page.click("a:has-text('26-00001')");
  await expect(page.locator("body")).toContainText("RXO");
  await expect(page.locator("body")).toContainText("2,900");
  await expect(page.locator("body")).toContainText("4500991");
  await expect(page.locator("#charges")).toContainText("RATE CON ✓");
  await expect(page.locator("body")).toContainText("email from Ana Lopez");

  // a status question about it: a reply drafted from tracking, sent (logged: no sender in tests) on approval
  await page.request.post(new URL(url!).pathname, { headers: { "content-type": "message/rfc822" }, data: mime({ from: "ap@rxo.test", fromName: "Ana Lopez", subject: "Status on 26-00001?", text: "Hi, any update on this one? Where is the truck?" }) });
  await page.goto("/messages");
  const sc = page.getByTestId("mail-card").first();
  await expect(sc).toContainText("Status question");
  await expect(sc).toContainText("Send reply");
  await expect(sc).toContainText("26-00001");
  await sc.locator("button:has-text('Open')").click();
  await expect(page.getByRole("dialog").getByLabel("Reply body")).toHaveValue(/Hi Ana,[\s\S]*26-00001 is booked/);
  await page.getByRole("dialog").getByTestId("approve-edited").click();
  await expect(page.getByRole("status")).toContainText("logged — connect an email sender");
  await expect(page.getByTestId("sent-log")).toContainText("ap@rxo.test");

  // noise never becomes a card; it is filed
  await page.request.post(new URL(url!).pathname, { headers: { "content-type": "message/rfc822" }, data: mime({ from: "news@vendor.test", subject: "Our summer webinar", text: "Join us Thursday." }) });
  await page.goto("/messages");
  await expect(page.getByTestId("mail-card")).toHaveCount(0);
  await page.getByTestId("mail-cards").locator("input[type=checkbox]").check(); // show handled
  await expect(page.getByTestId("mail-card")).toHaveCount(3);
  // a bad token is refused
  expect((await page.request.post("/api/mail/inbound/not-a-token", { data: "x" })).status()).toBe(404);
});
