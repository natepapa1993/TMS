import { resolveToken } from "@/lib/tokens";
import { rateConPdf } from "@/domain/carrier-portal";

export const dynamic = "force-dynamic";

/** The rate confirmation PDF for one of this carrier's legs. */
export async function GET(_req: Request, ctx: RouteContext<"/c/[token]/ratecon/[legId]">) {
  const { token, legId } = await ctx.params;
  const t = await resolveToken(token, "carrier_portal");
  if (!t) return new Response("not found", { status: 404 });
  try {
    const pdf = await rateConPdf(t.ctx.tenantId, t.subjectId, legId);
    return new Response(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="rate-confirmation-${legId}.pdf"` } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
