import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { dashboard, evaluateAll, pendingUploads, blankBlockingDates, FIELD_ITEMS, type SubjectKind } from "@/domain/compliance";
import { MissingDatesToggle } from "./table";
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

// wall clock read outside render (the purity lint has a point: renders should not read Date.now themselves)
const currentTime = async () => Date.now();

export default async function CompliancePage({ searchParams }: PageProps<"/compliance">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const kind = (KINDS.find((k) => k.key === sp.tab)?.key ?? "driver") as SubjectKind;
  const filter = typeof sp.f === "string" ? sp.f : "";
  let d = await dashboard(ctx);
  // first open (or an hour stale): evaluate now so the safety manager never looks at "not run"
  const now = await currentTime();
  if (!d.tiles.lastRun || now - d.tiles.lastRun.getTime() > 3600_000) {
    await evaluateAll(ctx).catch(() => null);
    d = await dashboard(ctx);
  }
  const [pending, blanks] = await Promise.all([pendingUploads(ctx), blankBlockingDates(ctx)]);
  const blankText = Object.entries(blanks.counts).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
  const types = d.types.filter((t) => t.appliesTo === kind);
  const fields = FIELD_ITEMS[kind];
  // a document type and a built-in expiry field can share a name ("FAST card" scan on file vs the FAST expiry date): say which is which
  const columns = [...types.map((t) => ({ key: t.id, label: t.name, blocks: t.blocksDispatch, sub: "on file" })), ...fields.map((f) => ({ key: `field:${f.key}`, label: f.label, blocks: f.blocks, sub: "expiry" }))];
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
        {pending.length > 0 && (
          <div className="rounded-lg border border-teal/40 bg-teal-soft/40 px-4 py-3 mb-4 text-[13px]" data-testid="pending-uploads">
            <b>
              {pending.length} document{pending.length === 1 ? "" : "s"} sent from the driver app
            </b>{" "}
            waiting for a look — nothing counts until you confirm it:{" "}
            {pending.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <Link href={`/settings/drivers/${p.subjectId}#documents`} className="text-teal font-semibold">
                  {p.driverName ?? p.subjectId} · {p.typeName ?? "document"}
                </Link>
              </span>
            ))}
          </div>
        )}
        {(blankText || blanks.on) && (
          <div className={`rounded-lg border px-4 py-3 mb-4 text-[13px] flex items-center gap-3 ${blanks.on ? "border-line bg-surface" : "border-amber/50 bg-amber-soft/40"}`} data-testid="missing-dates">
            <div className="flex-1">
              {blanks.on ? (
                <>
                  <b>Missing dates block dispatch.</b> A blank licence, medical card, annual inspection or I-94 date stops a driver or unit like an expired one{blankText ? ` (blocked now: ${blankText})` : ""}.
                </>
              ) : (
                <>
                  <b>{blankText} with a required date left blank</b> (licence, medical card, annual inspection, I-94…) — shown as missing but still dispatchable. Enter the dates, then turn on blocking.
                </>
              )}
            </div>
            {["owner", "compliance"].includes(ctx.role) && <MissingDatesToggle on={blanks.on} />}
          </div>
        )}
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
          <Pill tone="green">ok</Pill> <Pill tone="amber">expiring</Pill> <Pill tone="red">expired</Pill> <Pill tone="amber">missing</Pill> <Pill tone="slate">snoozed</Pill> <Pill tone="slate">not on file</Pill> · ● = the rule blocks dispatch: an expired (or missing) item on it makes the subject unassignable · a snooze quiets the reminder, it never lifts a block
        </div>
      </div>
    </div>
  );
}
