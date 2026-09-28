import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { assertCtx, systemCtx, type Ctx, type Role } from "@/lib/context";
import { issueToken, publicUrl, resolveToken, revokeTokensFor } from "@/lib/tokens";
import { enqueue, canSendEmail } from "@/lib/outbox";
import { writeAudit } from "@/lib/audit";
import { ValidationError, NotFoundError } from "./orders";

/**
 * Invite a person by email (owner #22). The owner types a name, an email and a role (Dispatcher unless they
 * pick another); the person gets a one-time link and sets their own password. Nobody types or texts a password
 * for someone else. The link lasts 7 days and works once. With no email provider connected the invite is
 * logged in Messages and the owner can copy the link from the Users page.
 */
export const INVITE_TTL_MS = 7 * 86400_000;
export const INVITE_ROLES: { value: Role; label: string }[] = [
  { value: "dispatcher", label: "Dispatcher" },
  { value: "billing", label: "Billing" },
  { value: "compliance", label: "Safety & compliance" },
  { value: "mx_office", label: "Mexico office" },
  { value: "owner", label: "Owner" },
];
const ROLE_LABEL = Object.fromEntries(INVITE_ROLES.map((r) => [r.value, r.label])) as Record<string, string>;

function ownerOnly(ctx: Ctx) {
  if (ctx.role !== "owner") throw Object.assign(new Error("Only the owner invites people."), { name: "PermissionError" });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function inviteUser(ctx: Ctx, input: { name: string; email: string; role?: string | null }) {
  assertCtx(ctx);
  ownerOnly(ctx);
  const name = input.name?.trim();
  const email = input.email?.trim().toLowerCase();
  const role = (input.role || "dispatcher") as Role;
  if (!name) throw new ValidationError("their name", "name");
  if (!email || !EMAIL.test(email)) throw new ValidationError("a real email address", "email");
  if (!ROLE_LABEL[role]) throw new ValidationError("pick a role", "role");
  const [existing] = await db.select().from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.email, email))).limit(1);
  let userId: string;
  if (existing && existing.passwordHash && !existing.archivedAt) throw new ValidationError(`${email} already signs in here`, "email");
  if (existing) {
    userId = existing.id;
    await db.update(s.users).set({ name, role, passwordHash: null, archivedAt: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.users.id, existing.id));
  } else {
    userId = newId();
    await db.insert(s.users).values({ id: userId, tenantId: ctx.tenantId, email, name, role, passwordHash: null, createdBy: ctx.userId, updatedBy: ctx.userId });
  }
  await writeAudit(db, ctx, "user", userId, existing ? "update" : "create", { role: { from: existing?.role ?? null, to: role } }, `invited by email as ${ROLE_LABEL[role]}`);
  return { userId, ...(await sendInvite(ctx, userId)) };
}

/** A fresh one-time link (the old one stops working) and the email with it. */
async function sendInvite(ctx: Ctx, userId: string) {
  const [u] = await db.select().from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, userId))).limit(1);
  if (!u) throw new NotFoundError("user", userId);
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const [inviter] = ctx.userId ? await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, ctx.userId)).limit(1) : [];
  await revokeTokensFor(ctx, "user_invite", userId);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const tok = await issueToken(ctx, "user_invite", userId, { label: "invite", expiresAt, reuse: false });
  const link = publicUrl(`/invite/${tok.token}`);
  const company = tenant?.name ?? "Crossline";
  await enqueue(ctx, {
    channel: "email",
    to: u.email,
    subject: `${inviter?.name ?? "Your company"} invited you to ${company} on Crossline`,
    body: `${u.name},\n\n${inviter?.name ?? "The owner"} invited you to ${company} on Crossline as ${ROLE_LABEL[u.role] ?? u.role}.\n\nSet your password and sign in (the link works once, for 7 days):\n\n${link}\n\nYou sign in with ${u.email}.`,
    subjectKind: "user_invite",
    subjectId: userId,
  });
  return { link, expiresAt, emailed: await canSendEmail(ctx.tenantId) };
}

export async function resendInvite(ctx: Ctx, userId: string) {
  assertCtx(ctx);
  ownerOnly(ctx);
  const [u] = await db.select().from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, userId))).limit(1);
  if (!u) throw new NotFoundError("user", userId);
  if (u.passwordHash) throw new ValidationError(`${u.name} already set a password`);
  const r = await sendInvite(ctx, userId);
  await writeAudit(db, ctx, "user", userId, "update", undefined, "invite sent again");
  return r;
}

/** Take an invite back: the link stops working and the person is archived. */
export async function cancelInvite(ctx: Ctx, userId: string) {
  assertCtx(ctx);
  ownerOnly(ctx);
  const [u] = await db.select().from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.id, userId))).limit(1);
  if (!u) throw new NotFoundError("user", userId);
  if (u.passwordHash) throw new ValidationError(`${u.name} already accepted; archive them on their record instead`);
  await revokeTokensFor(ctx, "user_invite", userId);
  await db.update(s.users).set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.users.id, userId));
  await writeAudit(db, ctx, "user", userId, "archive", undefined, "invite cancelled");
}

export type PendingInvite = { userId: string; name: string; email: string; role: string; roleLabel: string; link: string | null; expiresAt: string | null; invitedAt: string };

/** People invited who haven't set a password yet, with the link to copy when email isn't connected. */
export async function pendingInvites(ctx: Ctx): Promise<PendingInvite[]> {
  assertCtx(ctx);
  if (ctx.role !== "owner") return [];
  const rows = await db.select().from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), isNull(s.users.passwordHash), isNull(s.users.archivedAt)));
  if (!rows.length) return [];
  // only people who were invited (a user added with a typed password, or the signup owner, is not an invite)
  const toks = await db
    .select()
    .from(s.accessTokens)
    .where(and(eq(s.accessTokens.tenantId, ctx.tenantId), eq(s.accessTokens.kind, "user_invite"), inArray(s.accessTokens.subjectId, rows.map((r) => r.id))));
  const live = (x: (typeof toks)[number]) => !x.revokedAt && (!x.expiresAt || x.expiresAt.getTime() > Date.now());
  return rows
    .filter((u) => toks.some((x) => x.subjectId === u.id))
    .map((u) => {
      const t = toks.find((x) => x.subjectId === u.id && live(x));
      return { userId: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABEL[u.role] ?? u.role, link: t ? publicUrl(`/invite/${t.token}`) : null, expiresAt: t?.expiresAt?.toISOString() ?? null, invitedAt: (t?.createdAt ?? u.updatedAt).toISOString() };
    });
}

/** The invite page: who the link is for (nothing if it expired, was used or taken back). */
export async function inviteTokenUser(token: string) {
  const t = await resolveToken(token, "user_invite");
  if (!t) return null;
  const [u] = await db.select({ id: s.users.id, email: s.users.email, name: s.users.name, role: s.users.role, passwordHash: s.users.passwordHash, tenantId: s.users.tenantId }).from(s.users).where(and(eq(s.users.id, t.subjectId), isNull(s.users.archivedAt))).limit(1);
  if (!u || u.passwordHash) return null;
  const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, u.tenantId)).limit(1);
  return { id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: ROLE_LABEL[u.role] ?? u.role, company: tenant?.name ?? "" };
}

/** The invitee sets their own password; the link is used up. Returns the email to sign in with. */
export async function acceptInvite(token: string, password: string) {
  if (!password || password.length < 10) throw new ValidationError("use at least 10 characters", "password");
  const t = await resolveToken(token, "user_invite");
  if (!t) throw new ValidationError("this invite link is no longer valid; ask the owner to send a new one");
  const ctx = systemCtx(t.ctx.tenantId);
  const [u] = await db.select().from(s.users).where(and(eq(s.users.id, t.subjectId), eq(s.users.tenantId, t.ctx.tenantId), isNull(s.users.archivedAt))).limit(1);
  if (!u || u.passwordHash) throw new ValidationError("this invite link is no longer valid; ask the owner to send a new one");
  await db.update(s.users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(s.users.id, u.id));
  await revokeTokensFor(ctx, "user_invite", u.id);
  await writeAudit(db, { ...ctx, userId: u.id }, "user", u.id, "update", { passwordHash: { from: null, to: "(set)" } }, "accepted the invite and set a password");
  return { email: u.email };
}
