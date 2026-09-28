"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as O from "@/domain/orders";
import * as P from "@/domain/planner";

const touch = () => {
  revalidatePath("/dispatch/planner");
  revalidatePath("/dispatch");
};

export async function rankAction(legId: string) {
  return act((ctx) => P.rankForLeg(ctx, legId));
}

export async function addEventAction(input: { subjectKind: string; subjectId: string; kind: string; startsAt: string; endsAt: string; hard: boolean; note: string }) {
  const r = await act((ctx) => P.addEvent(ctx, { ...input, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt) }));
  if (r.ok) touch();
  return r;
}

export async function deleteEventAction(id: string) {
  const r = await act((ctx) => P.deleteEvent(ctx, id));
  if (r.ok) touch();
  return r;
}

/** Send every planned leg in the selection; says which could not go and why. */
export async function dispatchManyAction(legIds: string[]) {
  const r = await act(async (ctx) => {
    let sent = 0;
    const failed: string[] = [];
    for (const id of legIds.slice(0, 200)) {
      try {
        await O.dispatchLeg(ctx, id);
        sent++;
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { sent, failed };
  });
  if (r.ok) touch();
  return r;
}
