import { and, eq } from "drizzle-orm";
import { currentCtx } from "@/lib/auth";
import { db } from "@/db/client";
import { documents } from "@/db/schema";
import { readBlob } from "@/domain/crossing";
import { can } from "@/lib/context";

export const dynamic = "force-dynamic";

/** Streams a stored document to a signed-in user of the same company. */
export async function GET(_req: Request, { params }: RouteContext<"/api/files/[id]">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  const [doc] = await db.select().from(documents).where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.id, id))).limit(1);
  if (!doc) return new Response("not found", { status: 404 });
  // drug & alcohol papers (CCF, MRO letter) are confidential: owner and Safety only (49 CFR 40.321)
  if (doc.subjectKind === "da_test" && !can(ctx, "safety.confidential")) return new Response("not found", { status: 404 });
  const blob = await readBlob(ctx, doc.storageKey);
  return new Response(new Uint8Array(blob.bytes), { headers: { "Content-Type": blob.mimeType, "Content-Disposition": `inline; filename="${encodeURIComponent(doc.fileName)}"`, "Cache-Control": "private, max-age=300" } });
}
