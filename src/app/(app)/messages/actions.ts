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

/** Dispatch answers a driver who wrote from the app (or WhatsApp): shows in their app, and on WhatsApp when connected. */
export async function replyToDriverAction(driverId: string, body: string, orderId?: string | null, inboundId?: string | null) {
  const r = await act(async (ctx) => {
    const { replyToDriver } = await import("@/domain/tracking");
    const row = await replyToDriver(ctx, driverId, body, orderId);
    if (inboundId) await markHandled(ctx, inboundId);
    return { id: row.id };
  });
  if (r.ok) {
    revalidatePath("/messages");
    revalidatePath("/dispatch");
  }
  return r;
}

// ---------- the inbox agent's cards ----------

export async function approveMailAction(id: string, edits: import("@/domain/mail").MailEdits = {}) {
  const r = await act(async (ctx) => {
    const { approveMail } = await import("@/domain/mail");
    return approveMail(ctx, id, edits);
  });
  if (r.ok) {
    revalidatePath("/messages");
    revalidatePath("/dispatch");
    revalidatePath("/orders");
    revalidatePath("/billing");
  }
  return r;
}

export async function ignoreMailAction(id: string, why?: string) {
  const r = await act(async (ctx) => {
    const { ignoreMail } = await import("@/domain/mail");
    await ignoreMail(ctx, id, why);
    return { ok: true };
  });
  if (r.ok) revalidatePath("/messages");
  return r;
}

export async function retryMailAction(id: string) {
  const r = await act(async (ctx) => {
    const { retryMail } = await import("@/domain/mail");
    await retryMail(ctx, id);
    return { ok: true };
  });
  if (r.ok) revalidatePath("/messages");
  return r;
}
