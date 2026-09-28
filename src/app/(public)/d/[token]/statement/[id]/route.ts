import { resolveToken } from "@/lib/tokens";
import { driverSettlementPdf } from "@/domain/settlement-run";

export const dynamic = "force-dynamic";

/** The driver's own approved or paid statement, from the driver app link. */
export async function GET(_req: Request, { params }: RouteContext<"/d/[token]/statement/[id]">) {
  const { token, id } = await params;
  const t = await resolveToken(token, "driver_app");
  if (!t) return new Response("this link no longer works", { status: 404 });
  const pdf = await driverSettlementPdf(t.ctx.tenantId, t.subjectId, id);
  if (!pdf) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${pdf.fileName}"`, "Cache-Control": "private, no-store" } });
}
