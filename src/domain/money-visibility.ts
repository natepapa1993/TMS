import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";

/**
 * "Hide money from dispatchers" (owner #18): a company setting the owner turns on so dispatchers work loads without
 * seeing what the customer pays or the margin — on the board, the planner and the load page. Carrier rates stay:
 * a dispatcher tenders a leg at a rate they agree with the carrier. Owner, billing and Safety are unaffected.
 */
export function moneyVisible(role: Ctx["role"], settings: Record<string, unknown> | null | undefined): boolean {
  return !(role === "dispatcher" && !!settings?.hideMoneyFromDispatch);
}

/** Whether the signed-in person sees the load's rate and margin. */
export async function canSeeMoney(ctx: Ctx): Promise<boolean> {
  assertCtx(ctx);
  if (ctx.role !== "dispatcher") return true;
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  return moneyVisible(ctx.role, t?.settings as Record<string, unknown> | null);
}

export async function hideMoneyFromDispatch(ctx: Ctx): Promise<boolean> {
  assertCtx(ctx);
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  return !!(t?.settings as Record<string, unknown> | null)?.hideMoneyFromDispatch;
}

/** The owner turns it on or off; logged. */
export async function setHideMoneyFromDispatch(ctx: Ctx, on: boolean) {
  assertCtx(ctx);
  requirePermission(ctx, "users.manage");
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const cur = (t?.settings ?? {}) as Record<string, unknown>;
  await db.update(s.tenants).set({ settings: { ...cur, hideMoneyFromDispatch: on } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { hideMoneyFromDispatch: { from: !!cur.hideMoneyFromDispatch, to: on } }, on ? "Money hidden from dispatchers" : "Dispatchers see money again");
  return on;
}
