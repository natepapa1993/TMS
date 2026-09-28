import { currentCtx } from "@/lib/auth";
import { toError } from "@/lib/action";

export const dynamic = "force-dynamic";

/** One driver's qualification file as a PDF for an auditor: the summary, then every paper on file. */
export async function GET(_req: Request, { params }: RouteContext<"/api/compliance/dq-packet/[id]">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  try {
    const { driverDqPacket } = await import("@/domain/dq-packet");
    const p = await driverDqPacket(ctx, id);
    return new Response(new Uint8Array(p.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${p.fileName}"`, "Cache-Control": "private, no-store" } });
  } catch (e) {
    const r = toError(e);
    return new Response(r.ok ? "" : r.error, { status: !r.ok && r.code === "forbidden" ? 403 : !r.ok && r.code === "not_found" ? 404 : 400 });
  }
}
