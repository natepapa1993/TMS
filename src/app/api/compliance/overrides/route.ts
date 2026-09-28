import { currentCtx } from "@/lib/auth";
import { overrideLog, overridesCsv } from "@/domain/safety";

export const dynamic = "force-dynamic";

/** The overrides log as CSV, for the safety file or an auditor. */
export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const u = new URL(req.url);
  const days = Math.min(730, Math.max(1, Number(u.searchParams.get("days")) || 90));
  try {
    const rows = await overrideLog(ctx, { days, kind: u.searchParams.get("kind") || undefined });
    return new Response(overridesCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="overrides-${days}d.csv"` } });
  } catch {
    return new Response("not allowed", { status: 403 });
  }
}
