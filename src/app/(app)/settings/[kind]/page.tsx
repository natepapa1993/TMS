import { fold } from "@/lib/fold";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { list } from "@/data/records";
import { FIELDS, KIND_META, kindByPath, fieldDisplay, fieldsFor } from "@/data/fields";
import { can } from "@/lib/context";
import { loadRefs } from "@/data/refs";
import { PageHeader } from "@/components/page-header";
import { QuickAdd } from "./quick-add";
import { Pill } from "@/components/ui";

export default async function KindListPage({ params, searchParams }: PageProps<"/settings/[kind]">) {
  const { kind: path } = await params;
  const sp = await searchParams;
  const kind = kindByPath(path);
  if (!kind) notFound();
  const ctx = await requireCtx();
  const meta = KIND_META[kind];
  // users: the owner manages them; anyone else sees who is in the company, read-only, and their own account
  const readOnly = kind === "user" && !can(ctx, "users.manage");
  const showArchived = sp.archived === "1";
  const rows = await list(ctx, kind, { archived: showArchived ? "archived" : "active", limit: 2000 });
  const { options, names } = await loadRefs(ctx, kind);
  const cols = FIELDS[kind].filter((f) => f.column);
  const q = typeof sp.q === "string" ? fold(sp.q.trim()) : "";
  const filtered = q ? rows.filter((r) => cols.some((c) => fold(fieldDisplay(c, r[c.name], names)).includes(q))) : rows;

  return (
    <div>
      <PageHeader
        eyebrow={`Settings · ${meta.section}`}
        title={meta.plural}
        actions={
          readOnly ? (
            <Link href="/settings/account" className="btn">
              My account
            </Link>
          ) : (
          <>
            <Link href={`/settings/${path}/import`} className="btn">
              Import CSV
            </Link>
            <QuickAdd kind={kind} fields={fieldsFor(kind, can(ctx, "compliance.edit"))} refs={options} label={`Add ${meta.singular.toLowerCase()}`} openInitially={sp.add === "1"} openAfter={["driver", "truck", "trailer", "carrier", "documentType"].includes(kind) ? `/settings/${meta.path}` : undefined} />
          </>
          )
        }
      >
        {meta.blurb}. {rows.length} {showArchived ? "archived" : "active"}.
      </PageHeader>
      <div className="px-gutter pb-10">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <form className="flex gap-2">
            <input name="q" defaultValue={q} className="input w-64" placeholder={`Search ${meta.plural.toLowerCase()}…`} />
            {showArchived && <input type="hidden" name="archived" value="1" />}
          </form>
          <Link href={`/settings/${path}${showArchived ? "" : "?archived=1"}`} className="btn btn-ghost btn-sm text-muted">
            {showArchived ? "Show active" : "Show archived"}
          </Link>
          {!readOnly && (
            <a href={`/api/records/${path}${showArchived ? "?archived=1" : ""}`} className="btn btn-ghost btn-sm text-muted ml-auto" title="Every column, in the layout the import reads back">
              Export CSV
            </a>
          )}
        </div>
        <div className="card overflow-hidden">
          {filtered.length === 0 ? (
            <div className="py-14 text-center">
              <div className="font-bold">{q ? "Nothing matches" : `No ${meta.plural.toLowerCase()} yet`}</div>
              <div className="text-muted text-callout mt-1">{q ? "Try another search." : "Add one with the button above, or import a CSV."}</div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.name}>{c.label}</th>
                  ))}
                  {kind === "truck" && <th>Status</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    {cols.map((c, i) => (
                      <td key={c.name} className={i === 0 ? "font-bold" : ""}>
                        {i === 0 && readOnly ? (
                          fieldDisplay(c, r[c.name], names, r) || "—"
                        ) : i === 0 ? (
                          <Link href={`/settings/${path}/${r.id}`} className="hover:text-teal">
                            {fieldDisplay(c, r[c.name], names, r) || "—"}
                          </Link>
                        ) : c.type === "boolean" ? (
                          r[c.name] ? <Pill tone={c.name === "doNotUse" ? "red" : "teal"}>{c.label}</Pill> : <span className="text-faint">—</span>
                        ) : (
                          fieldDisplay(c, r[c.name], names, r) || <span className="text-faint">—</span>
                        )}
                      </td>
                    ))}
                    {kind === "truck" && <td>{r.status === "oos" ? <Pill tone="red" title={String(r.oosReason ?? "")}>OOS</Pill> : <Pill tone="green">Active</Pill>}</td>}
                    <td className="text-right">
                      {readOnly ? (
                        r.id === ctx.userId ? (
                          <Link href="/settings/account" className="btn btn-ghost btn-sm">
                            My account
                          </Link>
                        ) : null
                      ) : (
                        <Link href={`/settings/${path}/${r.id}`} className="btn btn-ghost btn-sm">
                          Open
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
