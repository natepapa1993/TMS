import { requireCtx } from "./auth";
import type { Ctx } from "./context";

/**
 * Every server function returns this shape. The UI never sees a stack trace; it sees the
 * plain-English message the domain layer wrote, and the field it belongs to when there is one.
 */
export type Finding = { level: string; code: string; message: string; overridable: boolean };
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; field?: string; code?: string; findings?: Finding[]; hardBlocked?: boolean };

export async function act<T>(fn: (ctx: Ctx & { name: string }) => Promise<T>): Promise<ActionResult<T>> {
  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, error: "You are signed out. Sign in again.", code: "unauthenticated" };
  }
  try {
    return { ok: true, data: await fn(ctx) };
  } catch (e) {
    return toError(e);
  }
}

export function toError(e: unknown): ActionResult<never> {
  const err = e as Error & { name?: string; field?: string; findings?: Finding[]; hardBlocked?: boolean; blockers?: { label: string }[]; permission?: string };
  const name = err?.name ?? "Error";
  if (name === "PermissionError") {
    const custom = err.message && !/^role \S+ lacks permission/.test(err.message) ? err.message : null;
    const perm = err.permission ?? /lacks permission (\S+)/.exec(err.message ?? "")?.[1];
    const why = custom ?? (perm === "compliance.override" ? "Only Safety or the owner can override a paperwork block." : perm === "compliance.edit" ? "Only Safety or the owner can change that." : perm === "billing.void" ? "Credit memos and voids need the owner." : perm === "safety.confidential" ? "Drug & alcohol records are confidential: Safety or the owner only." : "Your role can't do that.");
    return { ok: false, error: why, code: "forbidden" };
  }
  if (name === "NotFoundError") return { ok: false, error: "That record no longer exists.", code: "not_found" };
  if (name === "ConflictError") return { ok: false, error: "Someone else saved this record after you opened it. Reload to see their change.", code: "conflict" };
  if (name === "ArchiveBlockedError") return { ok: false, error: `Still in use: ${(err.blockers ?? []).map((b) => b.label).join(", ")}`, code: "blocked" };
  if (name === "EligibilityError") return { ok: false, error: err.message, code: "eligibility", findings: err.findings, hardBlocked: err.hardBlocked };
  if (name === "ValidationError") return { ok: false, error: err.message, field: err.field, code: "validation" };
  if (name === "TransitionError") return { ok: false, error: err.message, code: "transition" };
  if (name === "ApprovalRequestedError") return { ok: false, error: err.message, code: "approval_requested" };
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause;
  const msg = `${err?.message ?? ""} ${cause?.message ?? ""}`;
  if (/duplicate key/.test(msg) || cause?.code === "23505") return { ok: false, error: "That value already exists on another record.", code: "duplicate" };
  console.error(e);
  return { ok: false, error: process.env.NODE_ENV === "production" ? "Something went wrong. Nothing was saved." : msg, code: "unknown" };
}
