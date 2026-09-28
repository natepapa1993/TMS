import { and, eq, isNull, ne } from "drizzle-orm";
import { db, type Tx, type Db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, can, PermissionError, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { ValidationError, NotFoundError } from "./orders";

/**
 * Who may manage the people who sign in. Only the owner adds users, changes anyone's role, email or password
 * and archives them (users.manage). Everyone else can change only their own name, phone and password — the
 * password with the current one. Enforced here, under every screen, import and API: a dispatcher who opens
 * the users screen by URL or posts to the action directly gets the same refusal.
 */

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", dispatcher: "Dispatcher", billing: "Billing", compliance: "Safety & compliance", mx_office: "Mexico office", driver: "Driver", carrier: "Carrier", customer: "Customer" };

/** How much a role can do: nobody may move themselves up this list. */
export const ROLE_RANK: Record<string, number> = { owner: 4, dispatcher: 2, billing: 2, compliance: 2, mx_office: 1, driver: 0, carrier: 0, customer: 0 };

const refuse = (message: string) => Object.assign(new PermissionError("users.manage", "user"), { message });

/**
 * The rule for one write to a user record, before it touches the database. `before` is the stored row on an
 * edit, archive or restore. Returns the refusal, or null when the write may go ahead.
 */
export function userWriteProblem(ctx: Ctx, op: "create" | "update" | "archive" | "restore", values: Record<string, unknown>, before?: { id: string; role: string } | null): string | null {
  if (!can(ctx, "users.manage")) return "Only the owner adds people or changes roles, emails and passwords. Change your own name and password under My account.";
  const self = !!before && before.id === ctx.userId;
  if (self && op === "archive") return "You can't archive yourself — another owner can.";
  if (self && op === "update" && "role" in values && values.role !== before!.role && (ROLE_RANK[String(values.role)] ?? 0) > (ROLE_RANK[before!.role] ?? 0)) return "Nobody can raise their own role.";
  if ("role" in values && values.role != null && !(String(values.role) in ROLE_RANK)) return "Pick a role from the list.";
  return null;
}

/** The company keeps at least one active owner: the last one can't be demoted or archived. */
async function assertAnotherOwner(tx: Tx | Db, ctx: Ctx, userId: string) {
  const others = await tx
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.role, "owner"), isNull(s.users.archivedAt), ne(s.users.id, userId)))
    .limit(1);
  if (!others.length) throw refuse("The company needs at least one owner — make someone else owner first.");
}

/** Called by the records layer for every user write (create, edit, archive, restore). Throws the refusal. */
export async function assertUserWrite(tx: Tx | Db, ctx: Ctx, op: "create" | "update" | "archive" | "restore", values: Record<string, unknown>, before?: { id: string; role: string; archivedAt?: Date | null } | null) {
  const problem = userWriteProblem(ctx, op, values, before);
  if (problem) throw refuse(problem);
  if (!before || before.role !== "owner" || before.archivedAt) return;
  const demoted = op === "update" && "role" in values && values.role !== "owner";
  if (demoted || op === "archive") await assertAnotherOwner(tx, ctx, before.id);
}

/** A readable audit note when a user's role, email or password changed (the diff never holds the hash). */
export function userChangeNote(before: { role: string; email: string; id: string }, after: { role: string; email: string }, ctx: Ctx, passwordChanged: boolean) {
  const parts: string[] = [];
  if (before.role !== after.role) parts.push(`Role changed: ${ROLE_LABEL[before.role] ?? before.role} → ${ROLE_LABEL[after.role] ?? after.role}`);
  if (before.email !== after.email) parts.push(`Sign-in email changed: ${before.email} → ${after.email}`);
  if (passwordChanged) parts.push(before.id === ctx.userId ? "Password changed" : "Password reset by the owner");
  return parts.length ? parts.join(" · ") : undefined;
}

// ---------- my account: every role, only their own record ----------

export async function myAccount(ctx: Ctx) {
  assertCtx(ctx);
  if (!ctx.userId) throw new NotFoundError("user", "system");
  const [u] = await db.select({ id: s.users.id, name: s.users.name, email: s.users.email, role: s.users.role, phone: s.users.phone }).from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, ctx.userId))).limit(1);
  if (!u) throw new NotFoundError("user", ctx.userId);
  return u;
}

/** Your own name and phone. Role and email stay with the owner. */
export async function updateMyAccount(ctx: Ctx, input: { name: string; phone?: string | null }) {
  const me = await myAccount(ctx);
  const name = input.name?.trim();
  if (!name) throw new ValidationError("your name", "name");
  if (name.length > 120) throw new ValidationError("a shorter name", "name");
  const phone = input.phone === undefined ? me.phone : input.phone?.trim() || null;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== me.name) changes.name = { from: me.name, to: name };
  if (phone !== me.phone) changes.phone = { from: me.phone, to: phone };
  if (!Object.keys(changes).length) return me;
  await db.update(s.users).set({ name, phone, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, me.id)));
  await writeAudit(db, ctx, "user", me.id, "update", changes, "Changed on My account");
  return { ...me, name, phone };
}

/** Your own password, with the current one. Nobody but the owner sets someone else's. */
export async function changeMyPassword(ctx: Ctx, input: { current: string; next: string }) {
  const me = await myAccount(ctx);
  const [row] = await db.select({ hash: s.users.passwordHash }).from(s.users).where(eq(s.users.id, me.id)).limit(1);
  if (!(await verifyPassword(input.current ?? "", row?.hash ?? null))) throw new ValidationError("That isn't your current password.", "current");
  const next = input.next ?? "";
  if (next.length < 10) throw new ValidationError("The new password needs at least 10 characters.", "next");
  if (next === input.current) throw new ValidationError("Pick a password different from the current one.", "next");
  await db.update(s.users).set({ passwordHash: await hashPassword(next), updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, me.id)));
  await writeAudit(db, ctx, "user", me.id, "update", { passwordHash: { from: "(set)", to: "(changed)" } }, "Password changed");
  return { ok: true };
}
