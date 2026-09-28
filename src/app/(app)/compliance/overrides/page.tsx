import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { overrideLog } from "@/domain/safety";
import { PageHeader } from "@/components/page-header";
import { SafetyNav } from "../nav";
import { tenantZone } from "@/domain/company";
import { fmtWhen } from "@/lib/time";

export const metadata = { title: "Overrides" };
export const dynamic = "force-dynamic";

const KINDS: [string, string][] = [
  ["", "All"],
  ["paperwork", "Paperwork blocks"],
  ["dispatch", "Schedule calls"],
  ["crossing", "Crossings"],
  ["rate_con", "Rate con"],
];
const KIND_LABEL: Record<string, string> = { paperwork: "Paperwork", dispatch: "Schedule", crossing: "Crossing", rate_con: "Rate con" };

export default async function OverridesPage({ searchParams }: PageProps<"/compliance/overrides">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const kind = typeof sp.kind === "string" ? sp.kind : "";
  const days = [30, 90, 365].includes(Number(sp.days)) ? Number(sp.days) : 90;
  const [rows, zone] = await Promise.all([overrideLog(ctx, { days, kind: kind || undefined }), tenantZone(ctx.tenantId)]);
  const q = (k: string, d: number) => `/compliance/overrides?${new URLSearchParams({ ...(k ? { kind: k } : {}), days: String(d) })}`;
  return (
    <div>
      <PageHeader
        eyebrow="Safety & compliance"
        title="Overrides log"
        actions={
          <a className="btn" href={`/api/compliance/overrides?${new URLSearchParams({ ...(kind ? { kind } : {}), days: String(days) })}`}>
            Export CSV
          </a>
        }
      >
        Every time someone ran a load past a red finding: a paperwork block, a double booking, a crossing check, a rate-con mismatch. Who, when, on what, and why.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10">
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {KINDS.map(([k, l]) => (
            <Link key={k} href={q(k, days)} className="stage-tab" data-active={kind === k}>
              {l}
            </Link>
          ))}
          <span className="ml-auto flex gap-1.5">
            {[30, 90, 365].map((d) => (
              <Link key={d} href={q(kind, d)} className="stage-tab" data-active={days === d}>
                {d === 365 ? "12 months" : `${d} days`}
              </Link>
            ))}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="card py-14 text-center">
            <div className="font-bold">No overrides in the last {days === 365 ? "12 months" : `${days} days`}</div>
          </div>
        ) : (
          <div className="card overflow-auto">
            <table className="table" data-testid="overrides-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Kind</th>
                  <th>On</th>
                  <th>What was waved through</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmtWhen(r.at, zone, { style: "short", year: true })}</td>
                    <td className="font-semibold">{r.who}</td>
                    <td>
                      <span className={`pill ${r.kind === "paperwork" ? "pill-red" : r.kind === "dispatch" ? "pill-amber" : "pill-slate"}`}>{KIND_LABEL[r.kind]}</span>
                    </td>
                    <td className="whitespace-nowrap">
                      {r.href ? (
                        <Link href={r.href} className="text-teal font-semibold">
                          {r.subject}
                        </Link>
                      ) : (
                        r.subject
                      )}
                    </td>
                    <td className="max-w-md text-callout">{r.what}</td>
                    <td className="max-w-sm italic text-callout">{r.reason}</td>
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
