import { currentCtx } from "@/lib/auth";
import { invoicePacket } from "@/domain/invoicing";

export const dynamic = "force-dynamic";

/** The invoice with its documents as one PDF. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  try {
    const p = await invoicePacket(ctx, id);
    return new Response(new Uint8Array(p.pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${p.fileName.replace(/"/g, "")}"` } });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
