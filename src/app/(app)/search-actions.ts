"use server";

import { act } from "@/lib/action";

export async function searchAllAction(q: string) {
  const { searchAll } = await import("@/domain/search");
  return act((ctx) => searchAll(ctx, q));
}
