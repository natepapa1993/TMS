"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut, createTenantWithOwner } from "@/lib/auth";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { throttled, failed, succeeded, safeNext } from "@/lib/throttle";

async function clientKey() {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "local").split(",")[0].trim();
}

export type AuthState = { error?: string; fields?: Record<string, string> };

export async function loginAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/dispatch");
  if (!email || !password) return { error: "Enter your email and password.", fields: { email } };
  const keys = [`email:${email.toLowerCase()}`, `ip:${await clientKey()}`];
  const wait = keys.map((k) => throttled(k)).find((w) => w != null);
  if (wait != null) return { error: `Too many attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`, fields: { email } };
  const user = await signIn(email, password);
  if (!user) {
    for (const k of keys) failed(k, Date.now(), k.startsWith("ip:") ? 40 : undefined); // an office NAT shares one address
    return { error: "That email and password don't match.", fields: { email } };
  }
  for (const k of keys) succeeded(k);
  redirect(safeNext(next));
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

export type ResetState = { error?: string; done?: "sent" | "no_sender"; fields?: Record<string, string> };

export async function forgotAction(_prev: ResetState, form: FormData): Promise<ResetState> {
  const email = String(form.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email.", fields: { email } };
  const key = `reset:${await clientKey()}`;
  const wait = throttled(key);
  if (wait != null) return { error: `Too many requests. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`, fields: { email } };
  failed(key, Date.now(), 10); // ten reset requests per address per quarter hour, whatever the outcome
  const { requestReset } = await import("@/domain/password-reset");
  const r = await requestReset(email);
  // an unknown address reads exactly like a sent one
  return { done: r === "no_sender" ? "no_sender" : "sent", fields: { email } };
}

export async function resetAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const again = String(form.get("again") ?? "");
  if (password !== again) return { error: "The two passwords don't match." };
  const { completeReset } = await import("@/domain/password-reset");
  let email: string;
  try {
    ({ email } = await completeReset(token, password));
  } catch (e) {
    return { error: (e as Error).message };
  }
  await signIn(email, password);
  redirect("/dispatch");
}
