import { currentCtx } from "@/lib/auth";
import { statementPdf } from "@/domain/billing";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const customerId = new URL(req.url).searchParams.get("customer");
  if (!customerId) return new Response("customer required", { status: 400 });
  const { pdf, fileName } = await statementPdf(ctx, customerId);
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName.replace(/"/g, "")}"` } });
}
