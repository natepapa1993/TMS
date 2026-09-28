// Features: F-1.5 F-16
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { create, update, archive, restore, get } from "@/data/records";
import { previewImport, commitImport } from "@/data/import";
import { PermissionError, type Ctx } from "@/lib/context";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { updateMyAccount, changeMyPassword, userWriteProblem } from "./users";
import { toError } from "@/lib/action";

// owner N1 (security blocker): only the owner manages users, roles, emails and passwords

let owner: Ctx & { email: string };
let dispatcher: Ctx;
let safety: Ctx;

async function addUser(ctx: Ctx, role: Ctx["role"], password = "old-password-123") {
  const id = newId();
  await db.insert(s.users).values({ id, tenantId: ctx.tenantId, email: `${id}@test.local`, name: `${role} two`, role: role as never, passwordHash: await hashPassword(password) });
  return { tenantId: ctx.tenantId, userId: id, role } as Ctx;
}
const hashOf = async (id: string) => (await db.select({ h: s.users.passwordHash }).from(s.users).where(eq(s.users.id, id)))[0].h;

beforeEach(async () => {
  await truncateAll();
  owner = await makeTenant("Users Co");
  dispatcher = await addUser(owner, "dispatcher");
  safety = await addUser(owner, "compliance");
});

describe("only the owner manages users (owner N1)", () => {
  it("a dispatcher cannot create an owner (or any user)", async () => {
    await expect(create(dispatcher, "user", { name: "Evil Twin", email: "evil@x.test", role: "owner", passwordHash: "x" })).rejects.toBeInstanceOf(PermissionError);
    await expect(create(dispatcher, "user", { name: "New Guy", email: "new@x.test", role: "dispatcher" })).rejects.toBeInstanceOf(PermissionError);
    const n = await db.select().from(s.users).where(eq(s.users.tenantId, owner.tenantId));
    expect(n.length).toBe(3);
  });

  it("a dispatcher cannot edit the owner: email, role, password, archive", async () => {
    await expect(update(dispatcher, "user", owner.userId!, { email: "mine@x.test" })).rejects.toBeInstanceOf(PermissionError);
    await expect(update(dispatcher, "user", owner.userId!, { role: "billing" })).rejects.toBeInstanceOf(PermissionError);
    await expect(update(dispatcher, "user", owner.userId!, { passwordHash: await hashPassword("taken-over-123") })).rejects.toBeInstanceOf(PermissionError);
    await expect(archive(dispatcher, "user", owner.userId!)).rejects.toBeInstanceOf(PermissionError);
    const o = await get(owner, "user", owner.userId!);
    expect(o.role).toBe("owner");
    expect(o.email).toBe(owner.email);
  });

  it("a dispatcher cannot reset another user's password", async () => {
    const before = await hashOf(safety.userId!);
    await expect(update(dispatcher, "user", safety.userId!, { passwordHash: await hashPassword("new-password-123") })).rejects.toBeInstanceOf(PermissionError);
    expect(await hashOf(safety.userId!)).toBe(before);
  });

  it("nobody promotes themselves: not through the record, not through My account", async () => {
    await expect(update(dispatcher, "user", dispatcher.userId!, { role: "owner" })).rejects.toBeInstanceOf(PermissionError);
    await expect(update(safety, "user", safety.userId!, { role: "owner" })).rejects.toBeInstanceOf(PermissionError);
    // My account takes a name and phone only; a role in the payload is ignored
    await updateMyAccount(dispatcher, { name: "Maria D", role: "owner" } as never);
    const me = await get(owner, "user", dispatcher.userId!);
    expect(me.role).toBe("dispatcher");
    expect(me.name).toBe("Maria D");
    // and the rule itself refuses a self-raise even for someone who manages users
    expect(userWriteProblem({ ...owner, role: "owner" }, "update", { role: "owner" }, { id: owner.userId!, role: "dispatcher" })).toMatch(/raise their own role/);
  });

  it("Safety and billing can't manage users either; the refusal reads plainly", async () => {
    const billing = await addUser(owner, "billing");
    for (const who of [safety, billing]) await expect(create(who, "user", { name: "X", email: `${who.role}@x.test`, role: "dispatcher" })).rejects.toBeInstanceOf(PermissionError);
    const e = await create(safety, "user", { name: "X", email: "x@x.test", role: "dispatcher" }).catch((err) => err);
    expect(toError(e)).toMatchObject({ ok: false, code: "forbidden" });
    expect((toError(e) as { error: string }).error).toMatch(/Only the owner/);
  });

  it("a user import is the owner's too", async () => {
    const csv = "Name,Email,Role\nEvil,evil@x.test,Owner\n";
    await expect(previewImport(dispatcher, "user", csv)).rejects.toBeInstanceOf(PermissionError);
    await expect(commitImport(dispatcher, "user", "u.csv", csv)).rejects.toBeInstanceOf(PermissionError);
  });

  it("the owner adds people, changes roles and resets passwords — each audited in words", async () => {
    const u = await create(owner, "user", { name: "Dee", email: "dee@x.test", role: "dispatcher", passwordHash: await hashPassword("first-password-1") });
    expect("passwordHash" in u).toBe(false);
    await update(owner, "user", u.id, { role: "billing" });
    await update(owner, "user", u.id, { passwordHash: await hashPassword("second-password-2") });
    const log = await db.select().from(s.auditLog).where(and(eq(s.auditLog.tenantId, owner.tenantId), eq(s.auditLog.entityId, u.id)));
    expect(log.map((l) => l.note)).toEqual(expect.arrayContaining(["Added as Dispatcher", "Role changed: Dispatcher → Billing", "Password reset by the owner"]));
    // the log never holds a hash
    expect(JSON.stringify(log)).not.toMatch(/\$2[aby]\$/);
    await archive(owner, "user", u.id);
    await restore(owner, "user", u.id);
  });

  it("the company keeps an owner: the last one can't be demoted or archived, and nobody archives themselves", async () => {
    await expect(update(owner, "user", owner.userId!, { role: "dispatcher" })).rejects.toThrow(/at least one owner/);
    await expect(archive(owner, "user", owner.userId!)).rejects.toThrow(/archive yourself/);
    const second = await create(owner, "user", { name: "Co-owner", email: "co@x.test", role: "owner" });
    await update(owner, "user", owner.userId!, { role: "dispatcher" }).then(() => undefined);
    expect((await get({ ...owner, userId: second.id }, "user", owner.userId!)).role).toBe("dispatcher");
  });
});

describe("My account: your own name and password", () => {
  it("changes your own password only with the current one", async () => {
    await expect(changeMyPassword(dispatcher, { current: "wrong-password", next: "brand-new-pass-1" })).rejects.toThrow(/current password/);
    await expect(changeMyPassword(dispatcher, { current: "old-password-123", next: "short" })).rejects.toThrow(/10 characters/);
    await changeMyPassword(dispatcher, { current: "old-password-123", next: "brand-new-pass-1" });
    expect(await verifyPassword("brand-new-pass-1", await hashOf(dispatcher.userId!))).toBe(true);
    // someone else's password didn't move
    expect(await verifyPassword("old-password-123", await hashOf(safety.userId!))).toBe(true);
    const [log] = await db.select().from(s.auditLog).where(and(eq(s.auditLog.entityId, dispatcher.userId!), eq(s.auditLog.note, "Password changed")));
    expect(log.userId).toBe(dispatcher.userId);
  });

  it("a name is required", async () => {
    await expect(updateMyAccount(safety, { name: "  " })).rejects.toThrow(/your name/);
  });
});
