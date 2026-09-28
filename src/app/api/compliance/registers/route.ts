import { currentCtx } from "@/lib/auth";
import { inspectionsCsv, accidentRegisterCsv } from "@/domain/safety";

export const dynamic = "force-dynamic";

/** Registers an auditor asks for, as CSV: ?kind=inspections | accidents. Dates as YYYY-MM-DD. */
export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind !== "inspections" && kind !== "accidents") return new Response("kind: inspections or accidents", { status: 400 });
  try {
    const csv = kind === "inspections" ? await inspectionsCsv(ctx) : await accidentRegisterCsv(ctx);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind === "inspections" ? "roadside-inspections" : "accident-register"}-${new Date().toISOString().slice(0, 10)}.csv"` } });
  } catch {
    return new Response("not allowed", { status: 403 });
  }
}
