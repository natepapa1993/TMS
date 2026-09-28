import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { daProgram } from "@/domain/safety";
import { REASON_LABEL, RESULT_LABEL } from "@/domain/safety-rules";
import { listIncidents } from "@/domain/compliance";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { NoAccess } from "@/components/no-access";
import { SafetyNav } from "../nav";
import { TestButton, ResultButton, ClearinghouseButton, DrawButton } from "../safety-ui";

export const metadata = { title: "Drug & alcohol" };
export const dynamic = "force-dynamic";

const day = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const when = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function DrugAlcoholPage({ searchParams }: PageProps<"/compliance/drug-alcohol">) {
  const ctx = await requireCtx();
  if (!can(ctx, "safety.confidential")) return <NoAccess area="Drug & alcohol (confidential, 49 CFR 40.321)" role={ctx.role} />;
  const sp = await searchParams;
  const now = new Date();
  const year = Number(sp.year) || now.getUTCFullYear();
  const [p, drivers, incidents] = await Promise.all([daProgram(ctx, year), list(ctx, "driver", { limit: 2000 }), listIncidents(ctx)]);
  const opts = drivers.map((d) => ({ id: d.id, name: String(d.name) }));
  const accidents = incidents.filter((i) => i.kind === "accident").map((i) => ({ id: i.id, label: `${day(i.occurredAt)} · ${i.description.slice(0, 60)}` }));
  const quarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  const pace = (done: number, req: number) => (req === 0 ? "text-faint" : done >= req ? "text-green" : "text-amber");
  return (
    <div>
      <PageHeader eyebrow="Safety & compliance" title="Drug & alcohol program" actions={<DrawButton period={quarter} pool={p.pool} />}>
        Parts 40 and 382: random draws, every test and its result, holds and return-to-duty, what you owe the Clearinghouse. Confidential — only the owner and Safety see this page.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-7 pb-10 space-y-5">
        <div className="flex items-center gap-2 text-[13px]">
          {[year - 1, year, year + 1]
            .filter((y) => y <= now.getUTCFullYear())
            .map((y) => (
              <Link key={y} href={`/compliance/drug-alcohol?year=${y}`} className="stage-tab" data-active={y === year}>
                {y}
              </Link>
            ))}
        </div>
        <div className="flex gap-3 flex-wrap" data-testid="da-tiles">
          <div className="card p-4 flex-1 min-w-[150px]">
            <div className="eyebrow">In the pool now</div>
            <div className="text-[26px] font-extrabold">{p.pool}</div>
            <div className="text-[12px] text-muted">average {p.required.avgPool ? p.required.avgPool.toFixed(1) : "—"} over {p.draws.length} draw{p.draws.length === 1 ? "" : "s"}</div>
          </div>
          <div className="card p-4 flex-1 min-w-[150px]">
            <div className="eyebrow">Random drug tests {year}</div>
            <div className={`text-[26px] font-extrabold ${pace(p.done.drug, p.required.drug)}`}>
              {p.done.drug} <span className="text-[15px] text-muted font-bold">of {p.required.drug}</span>
            </div>
            <div className="text-[12px] text-muted">rate × average pool</div>
          </div>
          <div className="card p-4 flex-1 min-w-[150px]">
            <div className="eyebrow">Random alcohol tests {year}</div>
            <div className={`text-[26px] font-extrabold ${pace(p.done.alcohol, p.required.alcohol)}`}>
              {p.done.alcohol} <span className="text-[15px] text-muted font-bold">of {p.required.alcohol}</span>
            </div>
          </div>
          <div className="card p-4 flex-1 min-w-[150px]">
            <div className="eyebrow">Waiting on collection / result</div>
            <div className={`text-[26px] font-extrabold ${p.open ? "text-amber" : "text-faint"}`}>{p.open}</div>
          </div>
          <div className="card p-4 flex-1 min-w-[150px]">
            <div className="eyebrow">On hold</div>
            <div className={`text-[26px] font-extrabold ${p.holds.some((h) => h.prohibited) ? "text-red" : "text-faint"}`}>{p.holds.filter((h) => h.prohibited).length}</div>
          </div>
        </div>

        {(p.duties.length > 0 || p.postAccident.some((x) => !x.alcoholDone || !x.drugDone)) && (
          <div className="card border-amber/60 p-4 space-y-2" data-testid="da-todo">
            <div className="eyebrow text-amber">To do</div>
            {p.postAccident
              .filter((x) => !x.alcoholDone || !x.drugDone)
              .map((x) => (
                <div key={x.incidentId} className="flex items-center justify-between gap-3 text-[13px]">
                  <span>
                    <b>{x.driver}</b> — post-accident testing after {x.why} on {when(x.occurredAt)}: {!x.alcoholDone && <>alcohol by {when(x.alcoholBy)} </>}
                    {!x.drugDone && <>· drug by {when(x.drugBy)}</>}. If a test can&rsquo;t be done in time, record why.
                  </span>
                  <TestButton drivers={opts} incidents={accidents} preset={{ driverId: x.driverId, reason: "post_accident", substance: x.alcoholDone ? "drug" : "alcohol", incidentId: x.incidentId }} label="Record" small />
                </div>
              ))}
            {p.duties.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 text-[13px]">
                <span>
                  <b>{d.driver}</b> — {d.duty} (result {day(d.at)}).
                </span>
                <ClearinghouseButton testId={d.id} />
              </div>
            ))}
          </div>
        )}

        {p.holds.length > 0 && (
          <div className="card p-4" data-testid="da-holds">
            <div className="eyebrow mb-2">Holds and follow-up</div>
            <ul className="space-y-1.5 text-[13px]">
              {p.holds.map((h) => (
                <li key={h.id} className="flex justify-between gap-3">
                  <Link href={`/compliance/drivers/${h.id}`} className="font-semibold hover:text-teal">
                    {h.name}
                  </Link>
                  <span>{h.prohibited ? <span className="pill pill-red">hold since {day(h.since)} — SAP and a negative return-to-duty test</span> : h.followUp ? <span className="pill pill-amber">follow-up {h.followUp.done} of {h.followUp.planned}</span> : null}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <section className="card overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b border-line gap-3">
            <div className="h2">Tests</div>
            <TestButton drivers={opts} incidents={accidents} />
          </div>
          {p.tests.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted text-[13px]">No tests in {year}. Run the quarter&rsquo;s random draw, and record every pre-employment test before a new driver&rsquo;s first load.</div>
          ) : (
            <table className="table" data-testid="da-tests">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Reason</th>
                  <th>Test</th>
                  <th>Selected / collected</th>
                  <th>Result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {p.tests.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/compliance/drivers/${t.driverId}`} className="font-semibold hover:text-teal">
                        {t.driver}
                      </Link>
                    </td>
                    <td>{REASON_LABEL[t.reason] ?? t.reason}</td>
                    <td className="capitalize">{t.substance}</td>
                    <td className="whitespace-nowrap">{t.collectedAt ? when(t.collectedAt) : t.selectedAt ? `selected ${when(t.selectedAt)}` : "—"}</td>
                    <td>
                      <span className={`pill ${t.result === "positive" || t.result === "refusal" ? "pill-red" : t.result.startsWith("negative") ? "pill-green" : t.result === "cancelled" ? "pill-slate" : "pill-amber"}`}>{RESULT_LABEL[t.result] ?? t.result}</span>
                    </td>
                    <td className="text-right whitespace-nowrap">{["selected", "pending"].includes(t.result) && <ResultButton test={JSON.parse(JSON.stringify(t))} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-line">
            <div className="h2">Random draws {year}</div>
            <div className="text-[12.5px] text-muted">Keep this list for the auditor: who was in the pool, the rates, how many were picked.</div>
          </div>
          {p.draws.length === 0 ? (
            <div className="px-5 py-6 text-muted text-[13px]">No draws yet this year.</div>
          ) : (
            <table className="table" data-testid="da-draws">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Drawn</th>
                  <th>Pool</th>
                  <th>Rates (drug / alcohol)</th>
                  <th>Picked</th>
                </tr>
              </thead>
              <tbody>
                {p.draws.map((d) => (
                  <tr key={d.id}>
                    <td className="font-semibold">{d.period}</td>
                    <td>{when(d.drawnAt)}</td>
                    <td>{d.poolSize}</td>
                    <td>
                      {d.drugRate}% / {d.alcoholRate}% · {d.drawsPerYear}× a year
                    </td>
                    <td>
                      {d.drugCount} drug · {d.alcoholCount} alcohol
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
