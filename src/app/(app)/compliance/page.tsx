import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { dashboard, FIELD_ITEMS, type SubjectKind } from "@/domain/compliance";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui";
import { ComplianceTable } from "./table";

export const metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

const KINDS: { key: SubjectKind; label: string; path: string }[] = [
  { key: "driver", label: "Drivers", path: "drivers" },
  { key: "truck", label: "Trucks", path: "trucks" },
  { key: "trailer", label: "Trailers", path: "trailers" },
  { key: "carrier", label: "Carriers", path: "carriers" },
];

export default async function CompliancePage({ searchParams }: PageProps<"/compliance">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const kind = (KINDS.find((k) => k.key === sp.tab)?.key ?? "driver") as SubjectKind;
  const filter = typeof sp.f === "string" ? sp.f : "";
  const d = await dashboard(ctx);
  const types = d.types.filter((t) => t.appliesTo === kind);
  const fields = FIELD_ITEMS[kind];
  const columns = [...types.map((t) => ({ key: t.id, label: t.name, blocks: t.blocksDispatch })), ...fields.map((f) => ({ key: `field:${f.key}`, label: f.label, blocks: f.blocks }))];
  const rows = d.subjects[kind]
    .map((sub) => ({ ...sub, st: d.status.find((x) => x.subjectKind === kind && x.subjectId === sub.id) ?? null, override: d.overrides.find((o) => o.subjectKind === kind && o.subjectId === sub.id) ?? null }))
    .filter((r) => (filter === "blocked" ? r.st && !r.st.dispatchable : filter === "expired" ? r.st?.expired.length : filter === "expiring" ? r.st?.expiring.length : filter === "missing" ? r.st?.missing.length : true))
    .sort((p, q) => Number(p.st?.dispatchable ?? true) - Number(q.st?.dispatchable ?? true) || (q.st?.expired.length ?? 0) - (p.st?.expired.length ?? 0));
  const tile = (key: string, label: string, n: number, tone: string) => (
    <Link href={`/compliance?tab=${kind}${filter === key ? "" : `&f=${key}`}`} className={`card p-4 flex-1 ${filter === key ? "border-teal" : ""}`}>
      <div className="eyebrow">{label}</div>
      <div className={`text-[26px] font-extrabold ${n ? tone : "text-faint"}`}>{n}</div>
    </Link>
  );
  return (
    <div>
      <PageHeader
        eyebrow="Safety & compliance"
        title="Compliance"
        actions={
          <>
            <Link href="/compliance/incidents" className="btn">
              Incidents
            </Link>
            <Link href="/settings/document-types" className="btn">
              Rules
            </Link>
            <a href={`/api/compliance/export?kind=${kind}`} className="btn">
              Export CSV
            </a>
          </>
        }
      >
        Every driver, truck, trailer and carrier against your document rules. Last run {d.tiles.lastRun ? d.tiles.lastRun.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never"} · re-runs on every save and every hour.
      </PageHeader>
      <div className="px-7 pb-10">
        <div className="flex gap-3 mb-4">
          {tile("blocked", "Blocked from dispatch", d.tiles.blocked, "text-red")}
          {tile("expired", "Expired", d.tiles.expired, "text-red")}
          {tile("expiring", "Expiring", d.tiles.expiring, "text-amber")}
          {tile("missing", "Missing", d.tiles.missing, "text-amber")}
        </div>
        <div className="flex items-center gap-1.5 mb-3">
          {KINDS.map((k) => (
            <Link key={k.key} href={`/compliance?tab=${k.key}${filter ? `&f=${filter}` : ""}`} className="stage-tab" data-active={kind === k.key}>
              {k.label} <span className="count">{d.subjects[k.key].length}</span>
            </Link>
          ))}
          {filter && (
            <Link href={`/compliance?tab=${kind}`} className="btn btn-ghost btn-sm ml-2 text-muted">
              Clear filter
            </Link>
          )}
          {types.length === 0 && (
            <span className="ml-auto text-[12.5px] text-muted">
              No document rules for {kind}s yet —{" "}
              <Link href="/settings/document-types?add=1" className="text-teal font-semibold">
                add one
              </Link>
              . Built-in dates (licences, plates, cards) are still checked.
            </span>
          )}
        </div>
        <ComplianceTable kind={kind} path={KINDS.find((k) => k.key === kind)!.path} columns={columns} rows={JSON.parse(JSON.stringify(rows))} role={ctx.role} />
        {rows.length === 0 && (
          <div className="card py-14 text-center">
            <div className="font-bold">{filter ? "Nothing matches" : `No ${kind}s yet`}</div>
          </div>
        )}
        <div className="mt-3 text-[12px] text-faint flex gap-3">
          <Pill tone="green">ok</Pill> <Pill tone="amber">expiring</Pill> <Pill tone="red">expired</Pill> <Pill tone="amber">missing</Pill> <Pill tone="slate">snoozed</Pill> · a red item on a rule that blocks dispatch makes the subject unassignable
        </div>
      </div>
    </div>
  );
}
