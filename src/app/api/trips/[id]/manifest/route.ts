import { requireCtx } from "@/lib/auth";
import { manifestPdf } from "@/domain/tailgate";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/trips/[id]/manifest">) {
  const { id } = await ctx.params;
  const c = await requireCtx().catch(() => null);
  if (!c) return new Response("sign in first", { status: 401 });
  try {
    const pdf = await manifestPdf(c, id);
    return new Response(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="manifest-${id}.pdf"` } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
