import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { driverSafetyFile } from "@/domain/safety";
import { BASICS, REASON_LABEL, RESULT_LABEL, SPECIMEN_LABEL } from "@/domain/safety-rules";
import { tenantZone } from "@/domain/company";
import { fmtWhen } from "@/lib/time";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { SafetyNav } from "../../nav";
import { DqRecordButton, TestButton, ResultButton, ClearinghouseButton, InspectionButton } from "../../safety-ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { ok: "pill-green", expiring: "pill-amber", expired: "pill-red", missing: "pill-amber", snoozed: "pill-slate", na: "pill-slate" };
const basicLabel = (k: string) => BASICS.find((b) => b.key === k)?.label ?? k;

export async function generateMetadata({ params }: PageProps<"/compliance/drivers/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const f = await driverSafetyFile(ctx, id).catch(() => null);
  return { title: f ? `${f.driver.name} · safety file` : "Safety file" };
}

export default async function DriverSafetyFilePage({ params }: PageProps<"/compliance/drivers/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const f = await driverSafetyFile(ctx, id).catch(() => null);
  if (!f) notFound();
  const canEdit = can(ctx, "compliance.edit");
  // the company's clock, with the zone printed (safety N2); calendar dates (done on, due) as dates
  const zone = await tenantZone(ctx.tenantId);
  const day = (v: string | Date | null | undefined) => fmtWhen(v, zone, { style: "date" }) ?? "—";
  const when = (v: string | Date | null | undefined) => fmtWhen(v, zone, { style: "short", year: true }) ?? "—";
  const [drivers, trucks, trailers] = await Promise.all([list(ctx, "driver", { limit: 2000 }), list(ctx, "truck", { limit: 2000 }), list(ctx, "trailer", { limit: 2000 })]);
  // pickers in name / unit-number order
  const opts = { drivers: drivers.map((d) => ({ id: d.id, name: String(d.name) })).sort((p, q) => p.name.localeCompare(q.name, "en-US", { numeric: true })), trucks: trucks.map((t) => ({ id: t.id, name: String(t.unitNumber) })).sort((p, q) => p.name.localeCompare(q.name, "en-US", { numeric: true })), trailers: trailers.map((t) => ({ id: t.id, name: String(t.unitNumber) })).sort((p, q) => p.name.localeCompare(q.name, "en-US", { numeric: true })) };
  const d = f.driver;
  const gaps = f.dq.filter((l) => l.status === "missing" || l.status === "expired").length;
  // one obvious next step: only the first gap gets the primary button
  const firstGap = f.dq.find((l) => l.status === "missing" || l.status === "expired")?.key;
  const accidents = f.incidents.filter((i) => i.kind === "accident").map((i) => ({ id: i.id, label: `${day(i.occurredAt)} · ${i.description.slice(0, 60)}` }));
  return (
    <div>
      <PageHeader
        eyebrow={
          <span>
            <Link href="/compliance/drivers" className="hover:text-teal">
              Driver files
            </Link>
          </span>
        }
        title={
          <span className="flex items-center gap-3 flex-wrap">
            {d.name}
            {f.dispatchable ? <span className="pill pill-green">dispatchable</span> : <span className="pill pill-red">blocked</span>}
            {f.da?.standing.prohibited && <span className="pill pill-red">safety hold</span>}
          </span>
        }
        actions={
          <>
            <a href={`/api/compliance/dq-packet/${d.id}`} className="btn" data-testid="dq-packet" title="The qualification file for an auditor: every item with its dates, then every paper on file">
              DQ file (PDF)
            </a>
            <Link href={`/settings/drivers/${d.id}`} className="btn">
              Driver record
            </Link>
          </>
        }
      >
        {d.driverType} · {d.driverType === "B1" ? `licencia federal ${d.mxLicenseNumber ?? "—"}` : `licence ${d.licenseNumber ?? "—"} ${d.licenseState ?? ""} ${d.licenseClass ? `class ${d.licenseClass}` : ""}`} · hired {d.hireDate ? day(d.hireDate) : "— (add the hire date on the driver record: 30-day and annual items count from it)"}
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10 grid xl:grid-cols-[1fr_380px] gap-5 items-start [&>*]:min-w-0">
        <div className="space-y-5">
          <section className="card overflow-hidden" data-testid="dq-file">
            <div className="px-5 py-4 flex items-center justify-between border-b border-line">
              <div>
                <div className="h2">Qualification file</div>
                <div className="text-callout text-muted">49 CFR 391.51 and the Clearinghouse. {gaps ? `${gaps} item${gaps === 1 ? "" : "s"} missing or overdue.` : "Complete."}</div>
              </div>
            </div>
            <table className="table">
              <tbody>
                {f.dq.map((l) => (
                  <tr key={l.key} id={`dq-${l.key}`} data-testid="dq-line">
                    <td className="w-[45%]">
                      <div className="font-semibold">
                        {l.label}
                        {l.blocks && <span className="text-faint" title="A hire prerequisite: the driver can't be dispatched until it is recorded"> ●</span>}
                      </div>
                      <div className="text-footnote text-muted">
                        {l.cite} · {l.hint}
                      </div>
                      {l.history.length > 1 && (
                        <details className="text-footnote text-muted mt-1">
                          <summary className="cursor-pointer">History ({l.history.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {l.history.map((h, i) => (
                              <li key={i}>
                                {h.notRequired ? "Not required" : day(h.at)}
                                {h.note ? ` — ${h.note}` : ""}
                                {h.file && (
                                  <>
                                    {" · "}
                                    <a href={`/api/files/${h.file.id}`} target="_blank" rel="noreferrer" className="text-teal">
                                      {h.file.fileName}
                                    </a>
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {l.status === "ok" && !l.completedAt && !l.notRequired ? (
                        <span className="pill pill-slate">not due yet</span>
                      ) : (
                        <span className={`pill ${TONE[l.status] ?? "pill-slate"}`}>{l.notRequired ? "not required" : l.status === "ok" ? "on file" : l.status === "expired" ? "overdue" : l.status === "expiring" ? "due soon" : "missing"}</span>
                      )}
                    </td>
                    <td className="text-callout whitespace-nowrap">
                      {l.completedAt && <div>Done {day(l.completedAt)}</div>}
                      {l.dueAt && <div className={l.status === "expired" ? "text-red font-semibold" : "text-muted"}>Due {day(l.dueAt)}</div>}
                      {l.note && <div className="text-muted truncate max-w-[220px]" title={l.note}>{l.note}</div>}
                      {l.history[0]?.file && (
                        <a href={`/api/files/${l.history[0].file.id}`} target="_blank" rel="noreferrer" className="text-teal">
                          {l.history[0].file.fileName}
                        </a>
                      )}
                    </td>
                    <td className="text-right">{canEdit && (l.key !== "pre_employment_test" || l.status !== "ok") && <DqRecordButton driverId={d.id} itemKey={l.key} label={l.label} hint={l.hint} primary={l.key === firstGap} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {f.da && (
            <section className="card overflow-hidden" data-testid="da-file">
              <div className="px-5 py-4 flex items-center justify-between border-b border-line gap-3">
                <div>
                  <div className="h2">Drug & alcohol</div>
                  <div className="text-callout text-muted">
                    Confidential: owner and Safety only.{" "}
                    {f.da.standing.prohibited ? (
                      <b className="text-red">On hold since {day(f.da.standing.violation?.resultAt ?? f.da.standing.violation?.createdAt)} — back to work only after the SAP process and a negative return-to-duty test.</b>
                    ) : f.da.standing.followUp ? (
                      <b>
                        Follow-up testing: {f.da.standing.followUp.done} of {f.da.standing.followUp.planned} done{f.da.standing.followUp.months ? ` over ${f.da.standing.followUp.months} months` : ""}.
                        {f.da.standing.followUp.nextDue && <span className={f.da.standing.followUp.overdue ? "text-red" : ""}> Next due by {day(f.da.standing.followUp.nextDue)}.</span>}
                      </b>
                    ) : (
                      "No hold."
                    )}
                  </div>
                </div>
                <TestButton drivers={opts.drivers} driverId={d.id} incidents={accidents} small />
              </div>
              {f.da.tests.length === 0 ? (
                <div className="px-5 py-6 text-muted text-callout">No tests recorded. The pre-employment drug test comes first — before any safety-sensitive work.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Test</th>
                      <th>Collected</th>
                      <th>Result</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.da.tests.map((t) => (
                      <tr key={t.id}>
                        <td>{REASON_LABEL[t.reason] ?? t.reason}</td>
                        <td>
                          <span className="capitalize">{t.substance}</span>
                          {(t.specimenType || t.observed) && <div className="text-footnote text-muted">{[t.specimenType ? SPECIMEN_LABEL[t.specimenType] : null, t.observed ? "observed" : null].filter(Boolean).join(" · ")}</div>}
                        </td>
                        <td className="whitespace-nowrap">{t.collectedAt ? when(t.collectedAt) : t.selectedAt ? `selected ${when(t.selectedAt)}` : "—"}</td>
                        <td>
                          <span className={`pill ${t.result === "positive" || t.result === "refusal" ? "pill-red" : t.result.startsWith("negative") ? "pill-green" : "pill-amber"}`}>{RESULT_LABEL[t.result] ?? t.result}</span>
                          {t.mroVerifiedAt && <div className="text-footnote text-muted">MRO verified {day(t.mroVerifiedAt)}</div>}
                          {t.reason === "return_to_duty" && t.sapName && <div className="text-footnote text-muted">SAP {t.sapName} · evaluated {day(t.sapEvaluatedAt)} · done {day(t.sapEducationDoneAt)} · {t.followUpPlanned} follow-ups over {t.followUpMonths} months</div>}
                          {t.docs.map((doc) => (
                            <a key={doc.id} href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer" className="block text-footnote text-teal">
                              {doc.fileName}
                            </a>
                          ))}
                          {t.duty && <div className="text-footnote text-red mt-1">{t.duty}</div>}
                        </td>
                        <td className="text-right whitespace-nowrap space-x-1">
                          {["selected", "pending"].includes(t.result) && <ResultButton test={JSON.parse(JSON.stringify(t))} />}
                          {t.duty && <ClearinghouseButton testId={t.id} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <section className="card overflow-hidden" data-testid="driver-inspections">
            <div className="px-5 py-4 flex items-center justify-between border-b border-line gap-3">
              <div>
                <div className="h2">Roadside inspections</div>
                <div className="text-callout text-muted">{f.points ? `${f.points.inspections} in 24 months · ${f.points.clean} clean · ${f.points.oos} out of service · ${f.points.points} time-weighted points` : "None in 24 months."}</div>
              </div>
              {canEdit && <InspectionButton {...opts} driverId={d.id} label="+ Log inspection" />}
            </div>
            {f.inspections.length > 0 && (
              <table className="table">
                <tbody>
                  {f.inspections.map((i) => (
                    <tr key={i.id}>
                      <td className="whitespace-nowrap">
                        {when(i.inspectedAt)}
                        <div className="text-footnote text-muted">
                          {i.jurisdiction ?? i.country} · level {i.level}
                          {i.reportNumber ? ` · ${i.reportNumber}` : ""}
                        </div>
                      </td>
                      <td>
                        {i.violations.length === 0 ? (
                          <span className="pill pill-green">clean</span>
                        ) : (
                          <ul className="text-callout space-y-0.5">
                            {i.violations.map((v, k) => (
                              <li key={k} className={v.removed ? "line-through text-faint" : ""}>
                                <span className="mono">{v.code}</span> {v.description} <span className="text-muted">· {v.basic ? `${basicLabel(v.basic)} · wt ${v.severity}` : "not in SMS"}</span> {v.oos && <span className="pill pill-red">OOS</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="text-right">{canEdit && <InspectionButton {...opts} edit={JSON.parse(JSON.stringify(i))} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <div className="card p-4">
            <div className="eyebrow mb-2">Licences & cards</div>
            <ul className="space-y-1.5 text-callout">
              {f.credentials.map((c) => (
                <li key={c.key} className="flex justify-between gap-2">
                  <span>{c.label}</span>
                  <span className={`pill ${TONE[c.status] ?? "pill-slate"}`}>{c.expiresAt ? day(c.expiresAt) : c.status === "na" ? "not on file" : c.status}</span>
                </li>
              ))}
            </ul>
            <Link href={`/settings/drivers/${d.id}#documents`} className="btn btn-sm mt-3">
              Documents
            </Link>
          </div>
          <div className="card p-4" data-testid="driver-incidents">
            <div className="eyebrow mb-2">Incidents</div>
            {f.incidents.length === 0 ? (
              <div className="text-muted text-callout">None.</div>
            ) : (
              <ul className="space-y-2 text-callout">
                {f.incidents.map((i) => (
                  <li key={i.id}>
                    <div className="flex justify-between gap-2">
                      <b className="capitalize">{i.kind.replace("_", " ")}</b>
                      <span className="text-faint">{when(i.occurredAt)}</span>
                    </div>
                    <div className="text-muted">{i.description}</div>
                    {i.postAccident && <div className="text-amber">Post-accident testing required ({i.postAccident.why})</div>}
                  </li>
                ))}
              </ul>
            )}
            <Link href="/compliance/incidents" className="btn btn-sm mt-3">
              Incident register
            </Link>
          </div>
          <div className="card p-4">
            <div className="eyebrow mb-2">Overrides (12 months)</div>
            {f.overrides.length === 0 ? (
              <div className="text-muted text-callout">None.</div>
            ) : (
              <ul className="space-y-2 text-callout">
                {f.overrides.map((o) => (
                  <li key={o.id}>
                    <div className="flex justify-between gap-2">
                      <b>{o.who}</b>
                      <span className="text-faint">{when(o.at)}</span>
                    </div>
                    <div className="text-muted">{o.what}</div>
                    <div className="italic">{o.reason}</div>
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
