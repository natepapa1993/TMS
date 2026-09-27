// Features: F-14 VAN mailbox through the browser — the owner sets host, folders and password on the partner (never shown back), tests the connection, polls: the 204 in the inbox becomes a draft order, the 997 lands in the outbox, the file moves to done/
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signupFresh, quickAdd } from "./helpers";
import { startSftpServer } from "./fixtures/sftp-server";

const tender = (ref: string, isa: string) => `ISA*00*          *00*          *ZZ*RXO            *02*BSTW           *260926*1400*U*00401*${isa}*0*T*>~
GS*SM*RXO*BSTW*20260926*1400*${Number(isa)}*X*004010~
ST*204*0001~
B2**BSTW**${ref}**PP~
B2A*00~
L11*${ref}*RC~
N1*BT*RXO Expedite*93*RXO1~
S5*1*CL*12000*L*10*PLT~
N1*SH*Planta Monterrey~
N4*Monterrey*NL*64000*MX~
S5*2*CU*12000*L*10*PLT~
N1*CN*GM Arlington~
N4*Arlington*TX*76010*US~
L3*12000*G***285000~
SE*13*0001~
GE*1*${Number(isa)}~
IEA*1*${isa}~`;

test("VAN mailbox: set it up on the partner, test, poll — the tender in the inbox becomes a draft and the 997 goes back through the outbox", async ({ page }) => {
  test.setTimeout(120_000);
  // the VAN: an SFTP box on this machine with a 204 waiting
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "van-e2e-"));
  fs.mkdirSync(path.join(root, "inbox"));
  fs.mkdirSync(path.join(root, "outbox"));
  fs.writeFileSync(path.join(root, "inbox", "RXO_204_000000501.edi"), tender("RC-501", "000000501"));
  const van = await startSftpServer(root, { username: "bstw", password: "van-pass-123" });
  try {
    await signupFresh(page);
    await quickAdd(page, "customers", "Add customer", { name: "RXO", kind: "broker" });
    await quickAdd(page, "edi-partners", "Add EDI partner", { theirId: "RXO", customerId: "RXO", theirQualifier: "ZZ", scac: "BSTW", ourId: "BSTW", usage: "T" });
    await page.goto("/settings/edi-partners");
    await page.click("table a:has-text('RXO')");
    await page.locator("#f-delivery").selectOption("sftp");
    await page.click("button:has-text('Save changes')");
    await expect(page.getByRole("status")).toContainText("Saved");

    const card = page.getByTestId("mailbox-card");
    await expect(card).toContainText("Off");
    // enabling without a credential is refused with the reason
    await card.locator("#mb-host").fill("127.0.0.1");
    await card.locator("#mb-port").fill(String(van.port));
    await card.locator("#mb-user").fill("bstw");
    await card.locator("#mb-inbox").fill("/inbox");
    await card.locator("#mb-outbox").fill("/outbox");
    await card.locator("#mb-enabled").check();
    await card.locator("button:has-text('Save mailbox')").click();
    await expect(card).toContainText("password or a private key");
    await card.locator("#mb-password").fill("van-pass-123");
    await card.locator("button:has-text('Save mailbox')").click();
    await expect(page.getByRole("status").filter({ hasText: "Mailbox saved" })).toBeVisible();
    await expect(card).toContainText("not polled yet");
    await expect(card.locator("#mb-password")).toHaveValue(""); // never shown back
    await expect(card.locator("#mb-password")).toHaveAttribute("placeholder", /saved/);
    await expect(page.locator("main")).not.toContainText("van-pass-123");

    await card.locator("button:has-text('Test connection')").click();
    await expect(page.getByRole("status").filter({ hasText: "Connected · 1 file waiting" })).toBeVisible();
    await card.locator("button:has-text('Poll now')").click();
    await expect(page.getByRole("status").filter({ hasText: "Polled · 1 pulled, 1 pushed" })).toBeVisible();
    await expect(card).toContainText("Polled");

    // what the VAN sees: the file moved, the 997 in the outbox
    expect(fs.existsSync(path.join(root, "inbox", "done", "RXO_204_000000501.edi"))).toBe(true);
    const out = fs.readdirSync(path.join(root, "outbox"));
    expect(out).toEqual(["997_BSTW_1.edi"]);
    expect(fs.readFileSync(path.join(root, "outbox", out[0]), "utf8")).toContain("ST*997*");

    // what we see: the draft order from the tender, and the log says it came by sftp
    await page.goto("/orders?state=draft");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("RXO");
    await page.goto("/edi");
    await page.click(".stage-tab:has-text('Log')");
    await expect(page.locator("main")).toContainText("via sftp");

    // a second poll with nothing new is a quiet one
    await page.goto("/settings/edi-partners");
    await page.click("table a:has-text('RXO')");
    await page.getByTestId("mailbox-card").locator("button:has-text('Poll now')").click();
    await expect(page.getByRole("status").filter({ hasText: "Polled · 0 pulled, 0 pushed" })).toBeVisible();
  } finally {
    await van.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
