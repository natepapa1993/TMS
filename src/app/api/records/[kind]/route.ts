import Papa from "papaparse";
import { currentCtx } from "@/lib/auth";
import { list } from "@/data/records";
import { can } from "@/lib/context";
import { FIELDS, KIND_META, kindByPath, csvDate } from "@/data/fields";

export const dynamic = "force-dynamic";

/** Every record of a kind as CSV, in the same columns the import reads — your data, round-trippable. */
export async function GET(req: Request, { params }: RouteContext<"/api/records/[kind]">) {
  const ctx = await currentCtx();
  if (!ctx) return new Response("sign in", { status: 401 });
  const { kind: path } = await params;
  const kind = kindByPath(path);
  if (!kind) return new Response("not found", { status: 404 });
  if (kind === "user" && !can(ctx, "users.manage")) return new Response("only the owner exports users", { status: 403 });
  const archived = new URL(req.url).searchParams.get("archived") === "1";
  const rows = await list(ctx, kind, { archived: archived ? "archived" : "active", limit: 10000 });
  const fields = FIELDS[kind].filter((f) => f.type !== "password");
  const refOptions = new Map<string, Map<string, string>>();
  for (const f of fields) {
    if (f.type !== "ref" || !f.ref) continue;
    const refs = await list(ctx, f.ref, { archived: "all", limit: 10000 });
    const labelField = FIELDS[f.ref][0].name;
    refOptions.set(f.name, new Map(refs.map((r) => [String(r.id), String(r[labelField] ?? r.id)])));
  }
  const cell = (f: (typeof fields)[number], v: unknown): string => {
    if (v == null) return "";
    if (f.type === "ref") return refOptions.get(f.name)?.get(String(v)) ?? String(v);
    if (f.type === "cents") return (Number(v) / 100).toFixed(2);
    if (f.type === "date") return csvDate(v); // with the year: String(Date) was "Sat May 20"
    if (f.type === "boolean") return v ? "yes" : "no";
    if (f.type === "select") return f.options?.find((o) => o.value === v)?.label ?? String(v);
    if (f.type === "list") return Array.isArray(v) ? v.join(", ") : String(v);
    if (f.type === "address" && typeof v === "object") {
      const a = v as Record<string, string>;
      return [a.line1, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ");
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  const csv = Papa.unparse({ fields: fields.map((f) => f.label), data: rows.map((r) => fields.map((f) => cell(f, r[f.name]))) });
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${KIND_META[kind].path}${archived ? "-archived" : ""}-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
