import { requireCtx } from "@/lib/auth";
import { exportFiles } from "@/domain/accounting";

export const dynamic = "force-dynamic";

/** Download an export run's file: ?file=0 for the IIF, ?file=invoices|bills|payments|credits|journal|applications for the QBO CSVs. */
export async function GET(req: Request, ctx: RouteContext<"/api/accounting/[runId]">) {
  const { runId } = await ctx.params;
  const c = await requireCtx().catch(() => null);
  if (!c) return new Response("sign in first", { status: 401 });
  const want = new URL(req.url).searchParams.get("file") ?? "0";
  const r = await exportFiles(c, runId).catch(() => null);
  if (!r) return new Response("not found", { status: 404 });
  const f = r.files.find((x, i) => String(i) === want || x.name.endsWith(`-${want}.csv`)) ?? r.files[0];
  // the IIF goes out in Windows-1252 bytes (QuickBooks Desktop reads it as ANSI); the CSVs in UTF-8
  return new Response(f.bytes ? Buffer.from(f.bytes) : f.body, { headers: { "content-type": `${f.mime}; charset=${f.charset}`, "content-disposition": `attachment; filename="${f.name}"` } });
}
