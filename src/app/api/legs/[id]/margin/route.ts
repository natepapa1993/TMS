import { currentCtx } from "@/lib/auth";
import { legMarginPreview } from "@/domain/pay-estimate";

export const dynamic = "force-dynamic";

/**
 * The assign dialog's margin preview (a GET, not a server action, so it never queues ahead of the board's
 * refresh): ?driverId=&coDriverId=&miles= for this leg on our truck.
 */
export async function GET(req: Request, { params }: RouteContext<"/api/legs/[id]/margin">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const miles = q.get("miles");
  try {
    const r = await legMarginPreview(ctx, id, { driverId: q.get("driverId") || null, coDriverId: q.get("coDriverId") || null, ...(miles != null && miles !== "" && Number.isFinite(Number(miles)) ? { plannedMiles: Number(miles) } : {}) });
    return Response.json(r, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
