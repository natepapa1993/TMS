"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";

export async function saveMyAccountAction(values: { name: string; phone: string }) {
  const r = await act(async (ctx) => {
    const { updateMyAccount } = await import("@/domain/users");
    const u = await updateMyAccount(ctx, values);
    return { name: u.name };
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

export async function changeMyPasswordAction(values: { current: string; next: string }) {
  return act(async (ctx) => {
    const { changeMyPassword } = await import("@/domain/users");
    return changeMyPassword(ctx, values);
  });
}
