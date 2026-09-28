import { currentCtx } from "@/lib/auth";
import { dashboard, dashboardCsv, type SubjectKind } from "@/domain/compliance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const kind = (new URL(req.url).searchParams.get("kind") ?? "driver") as SubjectKind;
  if (!["driver", "truck", "trailer", "carrier"].includes(kind)) return new Response("bad kind", { status: 400 });
  const csv = dashboardCsv(await dashboard(ctx), kind);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="compliance-${kind}s-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
