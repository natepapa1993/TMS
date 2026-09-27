"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import { markHandled } from "@/domain/messaging";

export async function markHandledAction(id: string) {
  const r = await act((ctx) => markHandled(ctx, id));
  if (r.ok) {
    revalidatePath("/messages");
    revalidatePath("/dispatch");
  }
  return r;
}
