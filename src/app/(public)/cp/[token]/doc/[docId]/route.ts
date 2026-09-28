import { resolveToken } from "@/lib/tokens";
import { portalDocument } from "@/domain/customer-portal";

export const dynamic = "force-dynamic";

/** A document (POD, BOL, rate con…) off one of the customer's own loads. */
export async function GET(_req: Request, { params }: RouteContext<"/cp/[token]/doc/[docId]">) {
  const { token, docId } = await params;
  const t = await resolveToken(token, "customer_portal");
  if (!t) return new Response("This link is not valid.", { status: 404 });
  const r = await portalDocument(t.ctx.tenantId, t.subjectId, docId).catch(() => null);
  if (!r) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(r.blob.bytes), { headers: { "Content-Type": r.blob.mimeType, "Content-Disposition": `inline; filename="${r.doc.fileName.replace(/"/g, "")}"`, "Cache-Control": "private, no-store" } });
}
