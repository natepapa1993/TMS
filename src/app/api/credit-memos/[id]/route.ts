import { currentCtx } from "@/lib/auth";
import { creditMemoPdf } from "@/domain/billing";

export const dynamic = "force-dynamic";

/** The credit memo PDF, for the office. */
export async function GET(_req: Request, { params }: RouteContext<"/api/credit-memos/[id]">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  try {
    const { memo, bytes } = await creditMemoPdf(ctx, id);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Credit memo ${memo.number}.pdf"` } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
