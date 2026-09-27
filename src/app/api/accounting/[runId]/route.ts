import { requireCtx } from "@/lib/auth";
import { exportFiles } from "@/domain/accounting";

export const dynamic = "force-dynamic";

/** Download an export run's file: ?file=0 for the IIF, ?file=invoices|bills|payments for the QBO CSVs. */
export async function GET(req: Request, ctx: RouteContext<"/api/accounting/[runId]">) {
  const { runId } = await ctx.params;
  const c = await requireCtx().catch(() => null);
  if (!c) return new Response("sign in first", { status: 401 });
  const want = new URL(req.url).searchParams.get("file") ?? "0";
  const r = await exportFiles(c, runId).catch(() => null);
  if (!r) return new Response("not found", { status: 404 });
  const f = r.files.find((x, i) => String(i) === want || x.name.endsWith(`-${want}.csv`)) ?? r.files[0];
  return new Response(f.body, { headers: { "content-type": `${f.mime}; charset=utf-8`, "content-disposition": `attachment; filename="${f.name}"` } });
}
