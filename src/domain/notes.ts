import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { NOTE_KINDS, type NoteKind } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "./orders";

/** Notes on a load: dispatch, billing, safety, customer or general; pinned ones stay on top. */

async function orderOf(ctx: Ctx, orderId: string) {
  const [o] = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.tenantId, ctx.tenantId), eq(s.orders.id, orderId))).limit(1);
  if (!o) throw new NotFoundError("order", orderId);
  return o;
}

export async function listNotes(ctx: Ctx, orderId: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const rows = await db
    .select({ n: s.orderNotes, author: s.users.name })
    .from(s.orderNotes)
    .leftJoin(s.users, eq(s.users.id, s.orderNotes.createdBy))
    .where(and(eq(s.orderNotes.tenantId, ctx.tenantId), eq(s.orderNotes.orderId, orderId), isNull(s.orderNotes.archivedAt)))
    .orderBy(desc(s.orderNotes.pinned), desc(s.orderNotes.createdAt));
  return rows.map((r) => ({ ...r.n, author: r.author }));
}

export async function addNote(ctx: Ctx, orderId: string, input: { kind?: string; body: string; pinned?: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  await orderOf(ctx, orderId);
  const body = input.body?.trim();
  if (!body) throw new ValidationError("write the note", "body");
  if (body.length > 4000) throw new ValidationError("keep a note under 4,000 characters", "body");
  const kind = (NOTE_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as NoteKind) : "general";
  const id = newId();
  await db.insert(s.orderNotes).values({ id, tenantId: ctx.tenantId, orderId, kind, body, pinned: !!input.pinned, createdBy: ctx.userId, updatedBy: ctx.userId });
  await writeAudit(db, ctx, "order", orderId, "update", undefined, `${kind} note added`);
  return { id };
}

async function noteOf(ctx: Ctx, id: string) {
  const [n] = await db.select().from(s.orderNotes).where(and(eq(s.orderNotes.tenantId, ctx.tenantId), eq(s.orderNotes.id, id))).limit(1);
  if (!n || n.archivedAt) throw new NotFoundError("note", id);
  return n;
}

export async function pinNote(ctx: Ctx, id: string, pinned: boolean) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  const n = await noteOf(ctx, id);
  await db.update(s.orderNotes).set({ pinned, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orderNotes.id, n.id));
}

/** The author, or the owner, removes a note. */
export async function deleteNote(ctx: Ctx, id: string) {
  assertCtx(ctx);
  const n = await noteOf(ctx, id);
  if (n.createdBy !== ctx.userId && ctx.role !== "owner") throw new ValidationError("only whoever wrote it, or the owner, can delete a note");
  await db.update(s.orderNotes).set({ archivedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.orderNotes.id, n.id));
  await writeAudit(db, ctx, "order", n.orderId, "update", undefined, `${n.kind} note deleted`);
}
