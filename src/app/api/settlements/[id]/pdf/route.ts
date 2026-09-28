import { currentCtx } from "@/lib/auth";
import { settlementPdf } from "@/domain/settlement-run";

export const dynamic = "force-dynamic";

/** A driver's pay statement as a PDF, for the office. */
export async function GET(_req: Request, { params }: RouteContext<"/api/settlements/[id]/pdf">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  try {
    const pdf = await settlementPdf(ctx, id);
    return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${pdf.fileName}"`, "Cache-Control": "private, no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
