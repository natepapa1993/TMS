import { requireCtx } from "@/lib/auth";
import { ediMessage } from "@/domain/edi";

export const dynamic = "force-dynamic";

/** Download one message as an .edi file (same tenant only). */
export async function GET(_req: Request, ctx: RouteContext<"/api/edi/messages/[id]">) {
  const { id } = await ctx.params;
  const c = await requireCtx().catch(() => null);
  if (!c) return new Response("sign in first", { status: 401 });
  const m = await ediMessage(c, id).catch(() => null);
  if (!m) return new Response("not found", { status: 404 });
  return new Response(m.content, { headers: { "content-type": "application/edi-x12", "content-disposition": `attachment; filename="${m.type}-${m.controlNumber ?? m.id}.edi"` } });
}
