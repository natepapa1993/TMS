// Features: F-1.6 forgot password: link by email when a sender exists, honest "ask the owner" when not, one hour, one use, no enumeration
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { db } from "@/db/client";
import { users, outbox, integrations, accessTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { hashPassword, verifyPassword } from "@/lib/auth";
import * as R from "./password-reset";

let a: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await db.update(users).set({ passwordHash: await hashPassword("old-password-1") }).where(eq(users.id, a.userId!));
});

describe("password reset", () => {
  it("without an email sender nothing can go out and the page says to ask the owner; an unknown address is indistinguishable", async () => {
    expect(await R.requestReset(a.email)).toBe("no_sender");
    expect(await R.requestReset("nobody@nowhere.test")).toBe("unknown"); // the action maps both to the same wording
    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it("with a sender: one link, an hour, one use; the new password signs in and the old one does not", async () => {
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "resend", enabled: true, config: { apiKey: "re_test", from: "Dispatch <dispatch@example.com>" } });
    expect(await R.requestReset(a.email.toUpperCase())).toBe("sent");
    const [mail] = await db.select().from(outbox).where(eq(outbox.subjectKind, "password_reset"));
    expect(mail.to).toBe(a.email);
    const token = mail.body.match(/\/reset\/([A-Za-z0-9_-]+)/)![1];
    expect(token.length).toBeGreaterThan(20);
    expect((await R.resetTokenUser(token))?.email).toBe(a.email);
    // asking again replaces the link
    await R.requestReset(a.email);
    expect(await R.resetTokenUser(token)).toBeNull();
    const [mail2] = (await db.select().from(outbox).where(eq(outbox.subjectKind, "password_reset"))).slice(-1);
    const token2 = mail2.body.match(/\/reset\/([A-Za-z0-9_-]+)/)![1];
    await expect(R.completeReset(token2, "short")).rejects.toThrow(/10 characters/);
    const done = await R.completeReset(token2, "brand-new-password-9");
    expect(done.email).toBe(a.email);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId!));
    expect(await verifyPassword("brand-new-password-9", u.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-1", u.passwordHash)).toBe(false);
    // once
    await expect(R.completeReset(token2, "another-password-9")).rejects.toThrow(/no longer valid/);
    // expired
    await R.requestReset(a.email);
    await db.update(accessTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accessTokens.kind, "password_reset"));
    const [mail3] = (await db.select().from(outbox).where(eq(outbox.subjectKind, "password_reset"))).slice(-1);
    expect(await R.resetTokenUser(mail3.body.match(/\/reset\/([A-Za-z0-9_-]+)/)![1])).toBeNull();
  });
});
