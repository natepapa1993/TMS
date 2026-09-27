"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut, createTenantWithOwner } from "@/lib/auth";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { eq } from "drizzle-orm";

export type AuthState = { error?: string; fields?: Record<string, string> };

export async function loginAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/dispatch");
  if (!email || !password) return { error: "Enter your email and password.", fields: { email } };
  const user = await signIn(email, password);
  if (!user) return { error: "That email and password don't match.", fields: { email } };
  redirect(next.startsWith("/") ? next : "/dispatch");
}

export async function logoutAction() {
  await signOut();
  redirect("/login");
}

const signupSchema = z.object({
  tenantName: z.string().trim().min(2, "Company name is too short"),
  ownerName: z.string().trim().min(2, "Your name is too short"),
  email: z.string().trim().email("That email doesn't look right"),
  password: z.string().min(10, "Use at least 10 characters"),
});

export async function signupAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0].message, fields: raw };
  const { tenantName, ownerName, email, password } = parsed.data;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing) return { error: "That email already has an account. Sign in instead.", fields: raw };
  const base = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "company";
  let slug = base;
  for (let i = 2; ; i++) {
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (!t) break;
    slug = `${base}-${i}`;
  }
  await createTenantWithOwner({ tenantName, slug, ownerName, email, password });
  await signIn(email, password);
  redirect("/settings?welcome=1");
}
