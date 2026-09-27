import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { get, history, archiveBlockers } from "@/data/records";
import { FIELDS, KIND_META, kindByPath } from "@/data/fields";
import { loadRefs } from "@/data/refs";
import { PageHeader } from "@/components/page-header";
import { RecordEditor } from "./editor";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export default async function RecordPage({ params }: PageProps<"/settings/[kind]/[id]">) {
  const { kind: path, id } = await params;
  const kind = kindByPath(path);
  if (!kind) notFound();
  const ctx = await requireCtx();
  const row = await get(ctx, kind, id).catch(() => null);
  if (!row) notFound();
  const meta = KIND_META[kind];
  const [{ options }, hist, blockers, people] = await Promise.all([loadRefs(ctx, kind), history(ctx, kind, id), archiveBlockers(ctx, kind, id), db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId))]);
  const who = new Map(people.map((p) => [p.id, p.name]));
  const labelField = FIELDS[kind][0].name;
  const title = String(row[labelField] ?? meta.singular);
  return (
    <div>
      <PageHeader
        eyebrow={
          <span>
            <Link href="/settings" className="hover:text-teal">
              Settings
            </Link>
            {" · "}
            <Link href={`/settings/${path}`} className="hover:text-teal">
              {meta.plural}
            </Link>
          </span>
        }
        title={
          <span className="flex items-center gap-3">
            {title}
            {row.archivedAt && <span className="pill pill-slate">Archived</span>}
            {kind === "truck" && row.status === "oos" && <span className="pill pill-red">Out of service</span>}
          </span>
        }
      />
      <div className="px-7 pb-10 grid grid-cols-[1fr_320px] gap-5 items-start">
        <div className="card p-5">
          <RecordEditor
            kind={kind}
            id={id}
            fields={FIELDS[kind]}
            refs={options}
            initial={JSON.parse(JSON.stringify(row))}
            archived={!!row.archivedAt}
            blockers={blockers.map((b) => b.label)}
            listPath={`/settings/${path}`}
          />
        </div>
        <aside className="space-y-4">
          {kind === "truck" && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Status</div>
              {row.status === "oos" ? (
                <div className="text-[13px]">
                  <span className="pill pill-red">OOS</span> <span className="ml-1">{String(row.oosReason ?? "")}</span>
                  {row.oosUntil ? <div className="text-muted mt-1">Until {new Date(row.oosUntil as string).toLocaleDateString()}</div> : null}
                </div>
              ) : (
                <div className="text-[13px]">
                  <span className="pill pill-green">Active</span>
                </div>
              )}
              <div className="help mt-2">Put a unit out of service from the Fleet page; planned loads go back to Pending automatically.</div>
            </div>
          )}
          <div className="card p-4">
            <div className="eyebrow mb-2">History</div>
            {hist.length === 0 ? (
              <div className="text-muted text-[13px]">No changes yet.</div>
            ) : (
              <ul className="space-y-2.5">
                {hist.slice(0, 30).map((h) => (
                  <li key={h.id} className="text-[12.5px]">
                    <div className="flex justify-between gap-2">
                      <span className="font-bold capitalize">{h.action}</span>
                      <span className="text-faint whitespace-nowrap">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    </div>
                    <div className="text-muted">{h.userId ? (who.get(h.userId) ?? "someone") : "system"}</div>
                    {h.changes && (
                      <div className="text-muted mt-0.5">
                        {Object.entries(h.changes)
                          .slice(0, 6)
                          .map(([k, c]) => `${k}: ${fmt(c.from)} → ${fmt(c.to)}`)
                          .join(" · ")}
                      </div>
                    )}
                    {h.note && <div className="text-muted italic">{h.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function fmt(v: unknown) {
  if (v == null || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
