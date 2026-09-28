import { invoiceByToken } from "@/domain/billing";

export const dynamic = "force-dynamic";

/** The customer's invoice PDF. */
export async function GET(_req: Request, { params }: RouteContext<"/i/[token]">) {
  const { token } = await params;
  const r = await invoiceByToken(token);
  if (!r) return new Response("This invoice link is not valid.", { status: 404 });
  return new Response(new Uint8Array(r.blob.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.invoice.number}.pdf"`, "Cache-Control": "private, no-store" } });
}
