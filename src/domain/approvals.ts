import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { enqueue } from "@/lib/outbox";
import { publicUrl } from "@/lib/tokens";
import { NotFoundError, ValidationError } from "./orders";
import { TransitionError } from "./states";

/**
 * The owner's approval queue for overrides (owner #18).
 *
 * The rules let a dispatcher (or the MX office, Safety, billing) wave some things through with a reason: a
 * schedule call (double booking, time off), a paperwork block at the "override" level, a rate-con mismatch,
 * a failed crossing check or a red eligibility. Each of those now lands in the owner's Approvals list on
 * Today, with Approve and Reject:
 *   - by default the override takes effect at once, as it always did, and the owner reviews it afterwards;
 *     Reject reopens what was waved through and tells the person;
 *   - with the company setting "Overrides need the owner's approval first", it is only a request: nothing
 *     happens until the owner approves (the same call, made as the owner); Reject tells the person.
 * The owner's own overrides need no approval.
 */

export const OVERRIDE_KIND_LABEL: Record<string, string> = { schedule: "Schedule", paperwork: "Paperwork", rate_con: "Rate con", crossing: "Crossing" };

/** The call a pending request makes when the owner approves it. */
export type Replay =
  | { fn: "planLeg"; legId: string; assignment: Record<string, unknown>; opts: { plannedStart?: string | null; plannedEnd?: string | null; plannedMiles?: number | null } }
  | { fn: "setLegDrivers"; legId: string; drivers: { driverId?: string | null; coDriverId?: string | null } }
  | { fn: "overrideDispatch"; kind: string; subjectId: string }
  | { fn: "overrideCheck"; crossingId: string; code: string }
  | { fn: "overrideEligibility"; crossingId: string }
  | { fn: "acceptRateConMismatch"; orderId: string };

export type OverrideInput = { kind: "schedule" | "paperwork" | "rate_con" | "crossing"; title: string; reason: string; orderId?: string | null; legId?: string | null; crossingId?: string | null; subjectKind?: string | null; subjectId?: string | null; replay: Replay };

/** Thrown when the override became a request for the owner: nothing was changed. The UI shows the message. */
export class ApprovalRequestedError extends Error {
  constructor(
    public requestId: string,
    message = "Sent to the owner for approval. Nothing changes until they approve; you'll get an email when they decide.",
  ) {
    super(message);
    this.name = "ApprovalRequestedError";
  }
}

export async function overridesNeedOwner(tenantId: string) {
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  return !!(t?.settings as Record<string, unknown> | null)?.overrideApproval;
}

export async function setOverrideApproval(ctx: Ctx, on: boolean) {
  assertCtx(ctx);
  if (ctx.role !== "owner") throw Object.assign(new Error("Only the owner decides who approves overrides."), { name: "PermissionError" });
  const [t] = await db.select({ settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const cur = (t?.settings ?? {}) as Record<string, unknown>;
  await db.update(s.tenants).set({ settings: { ...cur, overrideApproval: on } }).where(eq(s.tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, "tenant", ctx.tenantId, "update", { overrideApproval: { from: !!cur.overrideApproval, to: on } });
  return on;
}

/**
 * Call right before an override is written (after its own checks). The owner and the system pass straight
 * through. Anyone else: with the approval setting on, the request is saved (outside the caller's transaction,
 * so it survives the rollback) and ApprovalRequestedError is thrown; otherwise the override goes ahead and is
 * queued for the owner's review in the caller's transaction.
 */
export async function overrideGate(ctx: Ctx, input: OverrideInput, tx: Tx | typeof db = db) {
  assertCtx(ctx);
  if (ctx.role === "owner" || ctx.role === "system") return;
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("an override needs a reason", "reason");
  const row = { tenantId: ctx.tenantId, kind: input.kind, title: input.title.slice(0, 500), reason, orderId: input.orderId ?? null, legId: input.legId ?? null, crossingId: input.crossingId ?? null, subjectKind: input.subjectKind ?? null, subjectId: input.subjectId ?? null, replay: input.replay as unknown as Record<string, unknown>, requestedBy: ctx.userId };
  if (await overridesNeedOwner(ctx.tenantId)) {
    const id = newId();
    await db.insert(s.overrideRequests).values({ id, state: "pending", ...row });
    await writeAudit(db, ctx, "override_request", id, "create", undefined, `${input.title}: ${reason}`);
    await tellOwners(ctx, `${await nameOf(ctx.userId)} asks you to approve an override`, `${input.title}\n\nWhy: ${reason}\n\nApprove or reject it on Today: ${publicUrl("/today")}`);
    throw new ApprovalRequestedError(id);
  }
  await tx.insert(s.overrideRequests).values({ id: newId(), state: "applied", ...row });
}

async function nameOf(userId: string | null) {
  if (!userId) return "Someone";
  const [u] = await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, userId)).limit(1);
  return u?.name ?? "Someone";
}

async function tellOwners(ctx: Ctx, subject: string, body: string) {
  const owners = await db.select({ email: s.users.email }).from(s.users).where(and(eq(s.users.tenantId, ctx.tenantId), eq(s.users.role, "owner"), isNull(s.users.archivedAt)));
  for (const o of owners) await enqueue(ctx, { channel: "email", to: o.email, subject, body, subjectKind: "override_request" });
}

async function tellRequester(ctx: Ctx, r: typeof s.overrideRequests.$inferSelect, subject: string, body: string) {
  if (!r.requestedBy) return;
  const [u] = await db.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, r.requestedBy)).limit(1);
  if (u?.email) await enqueue(ctx, { channel: "email", to: u.email, subject, body, subjectKind: "override_request", subjectId: r.id });
}

export type ApprovalRow = { id: string; kind: string; kindLabel: string; state: "pending" | "applied"; title: string; reason: string; who: string; at: string; href: string | null; orderNumber: string | null };

/** The owner's list: requests waiting, and overrides already made that the owner hasn't looked at. */
export async function approvalsQueue(ctx: Ctx): Promise<ApprovalRow[]> {
  assertCtx(ctx);
  if (ctx.role !== "owner") return [];
  const rows = await db
    .select()
    .from(s.overrideRequests)
    .where(and(eq(s.overrideRequests.tenantId, ctx.tenantId), inArray(s.overrideRequests.state, ["pending", "applied"])))
    .orderBy(desc(s.overrideRequests.createdAt))
    .limit(200);
  const userIds = [...new Set(rows.map((r) => r.requestedBy).filter((x): x is string => !!x))];
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
  const [people, ords] = await Promise.all([
    userIds.length ? db.select({ id: s.users.id, name: s.users.name }).from(s.users).where(inArray(s.users.id, userIds)) : [],
    orderIds.length ? db.select({ id: s.orders.id, n: s.orders.orderNumber }).from(s.orders).where(inArray(s.orders.id, orderIds)) : [],
  ]);
  const subjectHref = (r: (typeof rows)[number]) => (r.crossingId ? `/crossing/${r.crossingId}` : r.orderId ? `/orders/${r.orderId}` : r.subjectKind && r.subjectId ? `/settings/${r.subjectKind}s/${r.subjectId}` : null);
  return rows
    .sort((p, q) => (p.state === q.state ? 0 : p.state === "pending" ? -1 : 1))
    .map((r) => ({ id: r.id, kind: r.kind, kindLabel: OVERRIDE_KIND_LABEL[r.kind] ?? r.kind, state: r.state as "pending" | "applied", title: r.title, reason: r.reason, who: people.find((p) => p.id === r.requestedBy)?.name ?? "Someone", at: r.createdAt.toISOString(), href: subjectHref(r), orderNumber: ords.find((o) => o.id === r.orderId)?.n ?? null }));
}

async function loadRequest(ctx: Ctx, id: string) {
  const [r] = await db.select().from(s.overrideRequests).where(and(eq(s.overrideRequests.tenantId, ctx.tenantId), eq(s.overrideRequests.id, id))).limit(1);
  if (!r) throw new NotFoundError("override request", id);
  return r;
}

function ownerOnly(ctx: Ctx) {
  if (ctx.role !== "owner") throw Object.assign(new Error("Only the owner approves overrides."), { name: "PermissionError" });
}

/** Approve: a pending request is carried out now, as the owner; an override already made is marked reviewed. */
export async function approveOverride(ctx: Ctx, id: string, note?: string | null) {
  assertCtx(ctx);
  ownerOnly(ctx);
  const r = await loadRequest(ctx, id);
  if (r.state !== "pending" && r.state !== "applied") throw new TransitionError("order", r.state, "approved", "already decided");
  if (r.state === "pending") await replay(ctx, r);
  await db.update(s.overrideRequests).set({ state: "approved", decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note?.trim() || null }).where(eq(s.overrideRequests.id, id));
  await writeAudit(db, ctx, "override_request", id, "transition", { state: { from: r.state, to: "approved" } }, note?.trim() || undefined);
  if (r.state === "pending") await tellRequester(ctx, r, `Approved: ${r.title}`, `The owner approved your override and it is done now.\n\n${r.title}\nYour reason: ${r.reason}${note?.trim() ? `\nOwner: ${note.trim()}` : ""}`);
  return { state: "approved" as const, carriedOut: r.state === "pending" };
}

/** Reject: tell the person why; an override already made is undone (the block, the check, the mismatch is open again). */
export async function rejectOverride(ctx: Ctx, id: string, note: string) {
  assertCtx(ctx);
  ownerOnly(ctx);
  if (!note?.trim()) throw new ValidationError("say why, for the person who asked", "note");
  const r = await loadRequest(ctx, id);
  if (r.state !== "pending" && r.state !== "applied") throw new TransitionError("order", r.state, "rejected", "already decided");
  const reopened = r.state === "applied" ? await reopen(ctx, r, note.trim()) : null;
  await db.update(s.overrideRequests).set({ state: "rejected", decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note.trim() }).where(eq(s.overrideRequests.id, id));
  await writeAudit(db, ctx, "override_request", id, "transition", { state: { from: r.state, to: "rejected" } }, note.trim());
  await tellRequester(ctx, r, `Not approved: ${r.title}`, `The owner did not approve your override${r.state === "applied" ? ", and it has been undone" : ""}.\n\n${r.title}\nYour reason: ${r.reason}\nOwner: ${note.trim()}${reopened ? `\n\n${reopened}` : ""}`);
  return { state: "rejected" as const, reopened };
}

/** Carry out a pending request as the owner. */
async function replay(ctx: Ctx, r: typeof s.overrideRequests.$inferSelect) {
  const p = r.replay as unknown as Replay;
  const reason = `${r.reason} (asked by ${await nameOf(r.requestedBy)}, approved by the owner)`;
  switch (p.fn) {
    case "planLeg": {
      const { planLeg } = await import("./orders");
      const o = p.opts ?? {};
      await planLeg(ctx, p.legId, p.assignment as never, { override: true, reason, plannedStart: o.plannedStart ? new Date(o.plannedStart) : o.plannedStart === null ? null : undefined, plannedEnd: o.plannedEnd ? new Date(o.plannedEnd) : o.plannedEnd === null ? null : undefined, plannedMiles: o.plannedMiles });
      return;
    }
    case "setLegDrivers": {
      const { setLegDrivers } = await import("./orders");
      await setLegDrivers(ctx, p.legId, p.drivers, { override: true, reason });
      return;
    }
    case "overrideDispatch": {
      const { overrideDispatch } = await import("./compliance");
      await overrideDispatch(ctx, p.kind as never, p.subjectId, reason);
      return;
    }
    case "overrideCheck": {
      const { overrideCheck } = await import("./crossing");
      await overrideCheck(ctx, p.crossingId, p.code, reason);
      return;
    }
    case "overrideEligibility": {
      const { overrideEligibility } = await import("./crossing");
      await overrideEligibility(ctx, p.crossingId, reason);
      return;
    }
    case "acceptRateConMismatch": {
      const { acceptRateConMismatch } = await import("./billing");
      await acceptRateConMismatch(ctx, p.orderId, reason);
      return;
    }
  }
}

/** Undo an override already made. Returns what reopened, in plain words. */
async function reopen(ctx: Ctx, r: typeof s.overrideRequests.$inferSelect, note: string): Promise<string> {
  const p = r.replay as unknown as Replay;
  const flag = async (orderId: string | null, legId: string | null, title: string) => {
    if (!orderId) return;
    await db.insert(s.flags).values({ id: newId(), tenantId: ctx.tenantId, orderId, legId, code: "override_rejected", level: "red", title, detail: `Owner: ${note}`, owner: "dispatch" });
  };
  switch (p.fn) {
    case "planLeg":
    case "setLegDrivers":
      // a truck already sent is never pulled back by itself: dispatch gets a red flag to fix the assignment
      await flag(r.orderId, r.legId, `Owner rejected the override — fix the assignment: ${r.title}`);
      return "The load has a red flag on Dispatch until the assignment is fixed.";
    case "overrideDispatch": {
      await db.update(s.complianceOverrides).set({ expiresAt: new Date() }).where(and(eq(s.complianceOverrides.tenantId, ctx.tenantId), eq(s.complianceOverrides.subjectKind, p.kind), eq(s.complianceOverrides.subjectId, p.subjectId), gt(s.complianceOverrides.expiresAt, new Date())));
      await writeAudit(db, ctx, p.kind, p.subjectId, "update", { dispatchable: { from: "24h", to: false } }, `override rejected by the owner: ${note}`);
      return "The paperwork block is back: it can't be dispatched until the paperwork is fixed.";
    }
    case "overrideCheck": {
      const [chk] = await db.select().from(s.crossingChecks).where(and(eq(s.crossingChecks.tenantId, ctx.tenantId), eq(s.crossingChecks.crossingId, p.crossingId), eq(s.crossingChecks.code, p.code))).limit(1);
      if (chk?.state === "overridden") await db.update(s.crossingChecks).set({ state: "fail", overrideReason: null, overrideBy: null, overrideAt: null }).where(eq(s.crossingChecks.id, chk.id));
      await db.insert(s.crossingEvents).values({ id: newId(), tenantId: ctx.tenantId, crossingId: p.crossingId, kind: "check", source: "dispatcher", userId: ctx.userId, note: `owner rejected the waiver of ${p.code}: ${note}` });
      const { recompute } = await import("./crossing");
      await recompute(ctx, p.crossingId);
      return "The cross-check is failing again on the crossing.";
    }
    case "overrideEligibility": {
      await db.update(s.crossings).set({ eligibilityOverride: null, updatedAt: new Date(), updatedBy: ctx.userId }).where(and(eq(s.crossings.tenantId, ctx.tenantId), eq(s.crossings.id, p.crossingId)));
      await db.insert(s.crossingEvents).values({ id: newId(), tenantId: ctx.tenantId, crossingId: p.crossingId, kind: "check", source: "dispatcher", userId: ctx.userId, note: `owner rejected the eligibility override: ${note}` });
      const { recompute } = await import("./crossing");
      await recompute(ctx, p.crossingId);
      return "Eligibility is red again on the crossing.";
    }
    case "acceptRateConMismatch": {
      const [o] = await db.select().from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, p.orderId))).limit(1);
      if (o && !["invoiced", "paid"].includes(o.state)) {
        const custom = { ...((o.custom ?? {}) as Record<string, unknown>) };
        delete custom.rateConMismatchAccepted;
        await db.update(s.orders).set({ custom, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orders.id, o.id));
        await writeAudit(db, ctx, "order", o.id, "update", { rateCon: { from: "accepted", to: "mismatch" } }, `owner rejected: ${note}`);
        return "The load is back to 'charges differ from the rate con' in billing.";
      }
      await flag(p.orderId, null, `Owner rejected the rate-con override (already invoiced): ${r.title}`);
      return "The load was already invoiced: a red flag asks billing to correct it.";
    }
  }
  return "";
}

/** "Driver Mike Kowalski", "Unit 101": what an override was about, for the owner's list. */
export async function subjectName(tenantId: string, kind: string, id: string) {
  const one = async (q: Promise<{ n: string | null }[]>) => (await q)[0]?.n ?? null;
  const n =
    kind === "driver"
      ? await one(db.select({ n: s.drivers.name }).from(s.drivers).where(and(eq(s.drivers.tenantId, tenantId), eq(s.drivers.id, id))).limit(1))
      : kind === "truck"
        ? await one(db.select({ n: s.trucks.unitNumber }).from(s.trucks).where(and(eq(s.trucks.tenantId, tenantId), eq(s.trucks.id, id))).limit(1))
        : kind === "trailer"
          ? await one(db.select({ n: s.trailers.unitNumber }).from(s.trailers).where(and(eq(s.trailers.tenantId, tenantId), eq(s.trailers.id, id))).limit(1))
          : kind === "carrier"
            ? await one(db.select({ n: s.carriers.name }).from(s.carriers).where(and(eq(s.carriers.tenantId, tenantId), eq(s.carriers.id, id))).limit(1))
            : null;
  const label: Record<string, string> = { driver: "Driver", truck: "Unit", trailer: "Trailer", carrier: "Carrier" };
  return `${label[kind] ?? kind} ${n ?? ""}`.trim();
}
