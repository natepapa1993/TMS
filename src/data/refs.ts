import { list, REGISTRY, type RecordKind } from "./records";
import { FIELDS } from "./fields";
import type { Ctx } from "@/lib/context";
import type { RefOptions } from "@/components/record-form";

/** Options for every ref field on a record kind, plus a name map for the list columns. */
export async function loadRefs(ctx: Ctx, kind: RecordKind): Promise<{ options: RefOptions; names: Map<string, string> }> {
  const refKinds = [...new Set(FIELDS[kind].filter((f) => f.type === "ref" && f.ref).map((f) => f.ref!))];
  const options: RefOptions = {};
  const names = new Map<string, string>();
  for (const rk of refKinds) {
    const rows = await list(ctx, rk, { limit: 2000 });
    const lf = REGISTRY[rk].labelField;
    options[rk] = rows.map((r) => ({ id: r.id, label: String(r[lf] ?? r.id) })).sort((p, q) => p.label.localeCompare(q.label, undefined, { numeric: true }));
    for (const r of rows) names.set(r.id, String(r[lf] ?? r.id));
  }
  return { options, names };
}
