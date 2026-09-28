"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as I from "@/domain/invites";

export async function inviteUserAction(input: { name: string; email: string; role: string }) {
  const r = await act(async (ctx) => {
    const x = await I.inviteUser(ctx, input);
    return { link: x.link, emailed: x.emailed };
  });
  if (r.ok) revalidatePath("/settings/users");
  return r;
}

export async function resendInviteAction(userId: string) {
  const r = await act(async (ctx) => {
    const x = await I.resendInvite(ctx, userId);
    return { link: x.link, emailed: x.emailed };
  });
  if (r.ok) revalidatePath("/settings/users");
  return r;
}

export async function cancelInviteAction(userId: string) {
  const r = await act((ctx) => I.cancelInvite(ctx, userId));
  if (r.ok) revalidatePath("/settings/users");
  return r;
}
