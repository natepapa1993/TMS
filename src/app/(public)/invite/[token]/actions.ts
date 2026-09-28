"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { homeFor } from "@/lib/home";

export type InviteState = { error?: string };

/** The invitee sets their own password, then is signed in and lands on their role's home page. */
export async function acceptInviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const again = String(form.get("again") ?? "");
  if (password !== again) return { error: "The two passwords don't match." };
  const { acceptInvite } = await import("@/domain/invites");
  let email: string;
  try {
    ({ email } = await acceptInvite(token, password));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const u = await signIn(email, password);
  redirect(homeFor(u?.role));
}
