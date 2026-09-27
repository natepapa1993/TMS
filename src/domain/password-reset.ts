import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { issueToken, publicUrl, resolveToken, revokeTokensFor } from "@/lib/tokens";
import { enqueue, deliverQueued } from "@/lib/outbox";
import { writeAudit } from "@/lib/audit";
import { systemCtx } from "@/lib/context";
import { ValidationError } from "./orders";

/**
 * Forgot password. The email is the same whatever we know about the address (no enumeration). A link
 * lasts an hour and works once. It goes out through the company's email sender, or the platform's when
 * one is configured; with neither there is nothing to send, and the page says to ask the owner instead
 * (the owner sets a new password on the user's record).
 */
export const RESET_TTL_MS = 60 * 60_000;

export async function canSendResetEmails(tenantId: string) {
  const [row] = await db.select({ enabled: s.integrations.enabled, config: s.integrations.config }).from(s.integrations).where(and(eq(s.integrations.tenantId, tenantId), eq(s.integrations.provider, "resend"))).limit(1);
  return !!((row?.enabled && row.config.apiKey && row.config.from) || (process.env.RESEND_API_KEY && process.env.EMAIL_FROM));
}

/** Returns what happened for the page's wording; never who exists. */
export async function requestReset(email: string, now = new Date()): Promise<"sent" | "no_sender" | "unknown"> {
  const addr = email.toLowerCase().trim();
  const users = await db.select().from(s.users).where(and(eq(s.users.email, addr), isNull(s.users.archivedAt))).limit(5);
  if (!users.length) return "unknown";
  let sent = false;
  for (const u of users) {
    if (!(await canSendResetEmails(u.tenantId))) continue;
    const ctx = systemCtx(u.tenantId);
    await revokeTokensFor(ctx, "password_reset", u.id);
    const tok = await issueToken(ctx, "password_reset", u.id, { label: "reset", expiresAt: new Date(now.getTime() + RESET_TTL_MS), reuse: false });
    const [tenant] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, u.tenantId)).limit(1);
    const link = publicUrl(`/reset/${tok.token}`);
    await enqueue(ctx, {
      channel: "email",
      to: addr,
      subject: `Reset your ${tenant?.name ?? "Crossline"} password`,
      body: `${u.name},\n\nSomeone asked to reset the password for ${addr} at ${tenant?.name ?? "Crossline"}. If that was you, open this link within an hour:\n\n${link}\n\nIf it was not you, ignore this message; nothing changes.`,
      subjectKind: "password_reset",
      subjectId: u.id,
    });
    await writeAudit(db, ctx, "user", u.id, "update", undefined, "password reset requested");
    sent = true;
  }
  if (sent) await deliverQueued().catch(() => null);
  return sent ? "sent" : "no_sender";
}

export async function resetTokenUser(token: string) {
  const t = await resolveToken(token, "password_reset");
  if (!t) return null;
  const [u] = await db.select({ id: s.users.id, email: s.users.email, name: s.users.name, tenantId: s.users.tenantId }).from(s.users).where(and(eq(s.users.id, t.subjectId), isNull(s.users.archivedAt))).limit(1);
  return u ?? null;
}

export async function completeReset(token: string, password: string) {
  if (!password || password.length < 10) throw new ValidationError("use at least 10 characters", "password");
  const t = await resolveToken(token, "password_reset");
  if (!t) throw new ValidationError("this reset link is no longer valid; ask for a new one");
  const ctx = systemCtx(t.ctx.tenantId);
  await db.update(s.users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(and(eq(s.users.id, t.subjectId), eq(s.users.tenantId, t.ctx.tenantId)));
  await revokeTokensFor(ctx, "password_reset", t.subjectId);
  await writeAudit(db, ctx, "user", t.subjectId, "update", { passwordHash: { from: "(set)", to: "(changed)" } }, "password reset through the emailed link");
  const [u] = await db.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, t.subjectId)).limit(1);
  return u!;
}
