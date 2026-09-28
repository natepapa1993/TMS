import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { dqOverview } from "@/domain/safety";
import { DQ_ITEMS } from "@/domain/safety-rules";
import { PageHeader } from "@/components/page-header";
import { SafetyNav } from "../nav";
import { tenantZone } from "@/domain/company";
import { fmtWhen } from "@/lib/time";

export const metadata = { title: "Driver files" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { ok: "pill-green", expiring: "pill-amber", expired: "pill-red", missing: "pill-amber" };
const SHORT: Record<string, string> = { application: "Application", mvr_hire: "Record at hire", road_test: "Road test", clearinghouse_full: "CH full query", pre_employment_test: "Pre-emp. test", prior_employers: "Prior employers", mvr_annual: "Annual record", annual_review: "Annual review", clearinghouse_annual: "CH annual" };

export default async function DriverFilesPage({ searchParams }: PageProps<"/compliance/drivers">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const only = sp.f === "gaps";
  const [all, zone] = await Promise.all([dqOverview(ctx), tenantZone(ctx.tenantId)]);
  // four-digit years on the company's calendar: "Sep 13, 2025", never "Sep 13, 25" (safety N16)
  const day = (iso: string | null) => fmtWhen(iso, zone, { style: "date" }) ?? "";
  const rows = only ? all.filter((d) => d.missing || d.overdue) : all;
  const gaps = all.filter((d) => d.missing || d.overdue).length;
  return (
    <div>
      <PageHeader eyebrow="Safety & compliance" title="Driver qualification files">
        What 49 CFR 391.51 asks you to keep for every driver, plus the Clearinghouse queries. Hire prerequisites (●) block dispatch once &ldquo;missing dates block&rdquo; is on; annual items come due 12 months after the last one.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10">
        <div className="flex items-center gap-2 mb-3 text-callout">
          <Link href="/compliance/drivers" className="stage-tab" data-active={!only}>
            All drivers <span className="count">{all.length}</span>
          </Link>
          <Link href="/compliance/drivers?f=gaps" className="stage-tab" data-active={only}>
            With gaps <span className="count">{gaps}</span>
          </Link>
        </div>
        {rows.length === 0 ? (
          <div className="card py-14 text-center">
            <div className="font-bold">{only ? "Every file is complete" : "No drivers yet"}</div>
            {!only && (
              <div className="text-muted text-callout mt-1">
                Add drivers under{" "}
                <Link href="/settings/drivers" className="text-teal font-semibold">
                  Drivers
                </Link>
                .
              </div>
            )}
          </div>
        ) : (
          <div className="card overflow-auto">
            <table className="table" data-testid="dq-table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>File</th>
                  {DQ_ITEMS.map((i) => (
                    <th key={i.key} title={`${i.cite} · ${i.hint}`}>
                      {SHORT[i.key]}
                      {i.blocks ? " ●" : ""}
                      <div className="normal-case tracking-normal font-semibold text-caption text-faint">{i.cite}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/compliance/drivers/${d.id}`} className="font-bold hover:text-teal whitespace-nowrap">
                        {d.name}
                      </Link>
                      <div className="text-footnote text-muted">
                        {d.driverType}
                        {d.hireDate ? ` · hired ${day(d.hireDate.toISOString())}` : " · no hire date"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {d.missing || d.overdue ? (
                        <span className="pill pill-amber">{[d.missing && `${d.missing} missing`, d.overdue && `${d.overdue} overdue`].filter(Boolean).join(", ")}</span>
                      ) : d.due ? (
                        <span className="pill pill-amber">{d.due} due soon</span>
                      ) : (
                        <span className="pill pill-green">complete</span>
                      )}
                    </td>
                    {d.lines.map((l) => (
                      <td key={l.key} className="whitespace-nowrap">
                        <Link href={`/compliance/drivers/${d.id}#dq-${l.key}`} className={`pill ${TONE[l.status] ?? "pill-slate"}`} title={l.note ?? undefined}>
                          {l.notRequired ? "n/a" : l.status === "ok" ? (l.dueAt ? `due ${day(l.dueAt)}` : day(l.completedAt) || "ok") : l.status === "missing" ? "missing" : l.status === "expired" ? `overdue ${day(l.dueAt)}` : `due ${day(l.dueAt)}`}
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
