import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { users, tenants } from "@/db/schema";
import type { Ctx, Role } from "./context";
import { newId } from "./ids";
import { newCompanySettings } from "@/domain/compliance-rules";

export type SessionData = { userId?: string; tenantId?: string; role?: Role };

const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "",
  cookieName: "tms_session",
  cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 14 },
};

export async function getSession() {
  if (!sessionOptions.password || (sessionOptions.password as string).length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}

/** The Ctx for the current request, or null when nobody is signed in. */
export async function currentCtx(): Promise<(Ctx & { name: string; email: string; tenantName: string }) | null> {
  const s = await getSession();
  if (!s.userId || !s.tenantId) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, tenantId: users.tenantId, tenantName: tenants.name })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.id, s.userId), eq(users.tenantId, s.tenantId), isNull(users.archivedAt)))
    .limit(1);
  if (!row) return null;
  return { tenantId: row.tenantId, userId: row.id, role: row.role, name: row.name, email: row.email, tenantName: row.tenantName };
}

export async function requireCtx() {
  const ctx = await currentCtx();
  if (!ctx) throw new Error("not signed in");
  return ctx;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string | null) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/** Sign in by tenant slug + email + password. Returns the user or null; never says which part was wrong. */
export async function signIn(email: string, password: string) {
  const rows = await db
    .select({ id: users.id, tenantId: users.tenantId, role: users.role, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.email, email.toLowerCase().trim()), isNull(users.archivedAt)))
    .limit(5);
  for (const u of rows) {
    if (await verifyPassword(password, u.passwordHash)) {
      const s = await getSession();
      s.userId = u.id;
      s.tenantId = u.tenantId;
      s.role = u.role;
      await s.save();
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
      return u;
    }
  }
  return null;
}

export async function signOut() {
  const s = await getSession();
  s.destroy();
}

/** First-run: create a tenant and its owner. Used by the signup page and by tests. */
export async function createTenantWithOwner(input: { tenantName: string; slug: string; ownerName: string; email: string; password: string; timeZone?: string }) {
  const tenantId = newId();
  const userId = newId();
  await db.transaction(async (tx) => {
    // a new company gets 30 days to enter its drivers' qualification files before blank ones block dispatch
    await tx.insert(tenants).values({ id: tenantId, name: input.tenantName, slug: input.slug, timeZone: input.timeZone ?? "America/Detroit", settings: newCompanySettings() });
    await tx.insert(users).values({
      id: userId,
      tenantId,
      email: input.email.toLowerCase().trim(),
      name: input.ownerName,
      role: "owner",
      passwordHash: await hashPassword(input.password),
      createdBy: userId,
      updatedBy: userId,
    });
  });
  return { tenantId, userId };
}
