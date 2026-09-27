import { and, eq } from "drizzle-orm";
import { currentCtx } from "@/lib/auth";
import { db } from "@/db/client";
import { invoiceBatches } from "@/db/schema";
import { readBlob } from "@/domain/crossing";

export const dynamic = "force-dynamic";

/** A factor schedule's PDF (the schedule, the invoices and their documents). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentCtx();
  if (!ctx || !["owner", "billing"].includes(ctx.role)) return new Response("not allowed", { status: 403 });
  const { id } = await params;
  const [b] = await db.select().from(invoiceBatches).where(and(eq(invoiceBatches.tenantId, ctx.tenantId), eq(invoiceBatches.id, id))).limit(1);
  if (!b?.storageKey) return new Response("not found", { status: 404 });
  const blob = await readBlob(ctx, b.storageKey);
  return new Response(new Uint8Array(blob.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="schedule-${b.number}.pdf"` } });
}
