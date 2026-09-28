"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";

export async function setHideMoneyAction(on: boolean) {
  const r = await act(async (ctx) => {
    const { setHideMoneyFromDispatch } = await import("@/domain/money-visibility");
    return setHideMoneyFromDispatch(ctx, on);
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}
