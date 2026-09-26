import { auditLog } from "@/db/schema";
import type { Tx, Db } from "@/db/client";
import { newId } from "./ids";
import type { Ctx } from "./context";

export type AuditAction = "create" | "update" | "archive" | "restore" | "delete" | "transition" | "import" | "override" | "assign" | "dispatch";

/** Field-level diff of two plain objects; ignores audit columns and unchanged values. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const skip = new Set(["updatedAt", "updatedBy", "createdAt", "createdBy"]);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
    if (skip.has(key)) continue;
    const a = before ? before[key] : undefined;
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}

export async function writeAudit(
  tx: Tx | Db,
  ctx: Ctx,
  entity: string,
  entityId: string,
  action: AuditAction,
  changes?: Record<string, { from: unknown; to: unknown }>,
  note?: string,
) {
  await tx.insert(auditLog).values({
    id: newId(),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entity,
    entityId,
    action,
    changes: changes && Object.keys(changes).length ? changes : undefined,
    note,
  });
}
