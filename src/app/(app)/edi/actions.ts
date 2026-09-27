"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as E from "@/domain/edi";

const touch = () => {
  revalidatePath("/edi");
  revalidatePath("/dispatch");
  revalidatePath("/orders");
};

export async function respondTenderAction(messageId: string, accept: boolean, note?: string) {
  const r = await act((ctx) => E.respondToTender(ctx, messageId, accept, note ?? null));
  if (r.ok) touch();
  return r;
}

/** Paste an interchange by hand (testing with the partner, or a file they emailed). */
export async function receivePastedAction(partnerId: string, text: string) {
  const r = await act(async (ctx) => {
    const { db } = await import("@/db/client");
    const { ediPartners } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const [p] = await db.select({ id: ediPartners.id }).from(ediPartners).where(and(eq(ediPartners.tenantId, ctx.tenantId), eq(ediPartners.id, partnerId))).limit(1);
    if (!p) throw Object.assign(new Error("partner not found"), { name: "NotFoundError" });
    return E.receiveInterchange(p.id, text, { via: "paste", userId: ctx.userId });
  });
  if (r.ok) touch();
  return r;
}

export async function emit214NowAction() {
  const r = await act(async () => {
    const a = await E.emit214();
    const b = await E.send990ForAutoAccepted();
    return { sent: a.sent + b.sent };
  });
  if (r.ok) touch();
  return r;
}
