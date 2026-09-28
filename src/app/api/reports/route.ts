import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { breakdown, breakdownCsv, type Breakdown } from "@/domain/reports";

export const dynamic = "force-dynamic";

/** CSV of a breakdown: /api/reports?by=truck&from=2026-09-01&to=2026-09-30&entity=… */
export async function GET(req: Request) {
  const c = await requireCtx().catch(() => null);
  if (!c) return new Response("sign in first", { status: 401 });
  if (!can(c, "reports.view")) return new Response("reports are for the owner and billing", { status: 403 });
  const p = new URL(req.url).searchParams;
  const by = (p.get("by") ?? "truck") as Breakdown;
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return new Response("from and to are required (YYYY-MM-DD)", { status: 400 });
  const rows = await breakdown(c, by, { from, to }, p.get("entity") || null);
  return new Response(breakdownCsv(by, rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="crossline-${by}-${from}-to-${to}.csv"` } });
}
