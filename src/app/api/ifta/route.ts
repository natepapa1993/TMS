import { currentCtx } from "@/lib/auth";
import { iftaReport, iftaCsv } from "@/domain/ifta";

export const dynamic = "force-dynamic";

/** The quarter's IFTA return as CSV. */
export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const q = new URL(req.url).searchParams.get("quarter") ?? "";
  try {
    const r = await iftaReport(ctx, q);
    return new Response(iftaCsv(r), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ifta-${q}.csv"` } });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
