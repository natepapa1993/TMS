// Features: F-32.23 F-1.5 invite users by email (owner #22): one-time link, the person sets their own password
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { db } from "@/db/client";
import { users, outbox } from "@/db/schema";
import { verifyPassword } from "@/lib/auth";
import { inviteUser, pendingInvites, inviteTokenUser, acceptInvite, resendInvite, cancelInvite } from "./invites";

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Lakes & Laredo Freight");
});

const tokenOf = (link: string) => link.split("/invite/")[1];

describe("invite by email", () => {
  it("the owner invites a dispatcher by default; the person sets their own password from a one-time link", async () => {
    const r = await inviteUser(a, { name: "Maria Lopez", email: " Maria@NewCo.example " });
    expect(r.emailed).toBe(false); // no email provider: the invite is logged, the owner copies the link
    const [u] = await db.select().from(users).where(eq(users.id, r.userId));
    expect(u).toMatchObject({ email: "maria@newco.example", role: "dispatcher", passwordHash: null });
    const [mail] = await db.select().from(outbox).where(and(eq(outbox.tenantId, a.tenantId), eq(outbox.subjectKind, "user_invite")));
    expect(mail.to).toBe("maria@newco.example");
    expect(mail.body).toContain(r.link);
    expect(mail.body).toContain("Dispatcher");

    const pend = await pendingInvites(a);
    expect(pend).toEqual([expect.objectContaining({ name: "Maria Lopez", roleLabel: "Dispatcher", link: r.link })]);

    const token = tokenOf(r.link);
    expect(await inviteTokenUser(token)).toMatchObject({ name: "Maria Lopez", roleLabel: "Dispatcher", company: "Lakes & Laredo Freight" });
    await expect(acceptInvite(token, "short")).rejects.toThrow(/10 characters/);
    const done = await acceptInvite(token, "Dispatch-2026!");
    expect(done.email).toBe("maria@newco.example");
    const [after] = await db.select().from(users).where(eq(users.id, r.userId));
    expect(await verifyPassword("Dispatch-2026!", after.passwordHash)).toBe(true);
    // the link works once
    expect(await inviteTokenUser(token)).toBeNull();
    await expect(acceptInvite(token, "Another-2026!!")).rejects.toThrow(/no longer valid/);
    expect(await pendingInvites(a)).toEqual([]);
    // and they can't be invited again over their password
    await expect(inviteUser(a, { name: "Maria", email: "maria@newco.example" })).rejects.toThrow(/already signs in/);
  });

  it("only the owner invites; a role is picked from the list", async () => {
    const disp = { ...a, role: "dispatcher" as const };
    await expect(inviteUser(disp, { name: "Evil Twin", email: "evil@x.example", role: "owner" })).rejects.toThrow(/owner/);
    await expect(inviteUser(a, { name: "X", email: "not-an-email" })).rejects.toThrow(/email/);
    await expect(inviteUser(a, { name: "X", email: "x@x.example", role: "driver" })).rejects.toThrow(/role/);
    const r = await inviteUser(a, { name: "Bea", email: "bea@x.example", role: "billing" });
    const [u] = await db.select().from(users).where(eq(users.id, r.userId));
    expect(u.role).toBe("billing");
    expect(await pendingInvites(disp)).toEqual([]);
  });

  it("sending again makes the old link stop working; cancelling takes the invite back", async () => {
    const r = await inviteUser(a, { name: "Raj", email: "raj@x.example" });
    const again = await resendInvite(a, r.userId);
    expect(again.link).not.toBe(r.link);
    expect(await inviteTokenUser(tokenOf(r.link))).toBeNull();
    expect(await inviteTokenUser(tokenOf(again.link))).not.toBeNull();
    await cancelInvite(a, r.userId);
    expect(await inviteTokenUser(tokenOf(again.link))).toBeNull();
    expect(await pendingInvites(a)).toEqual([]);
  });
});
