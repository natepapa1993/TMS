import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { inspectionsBoard } from "@/domain/safety";
import { BASICS, roadsideOos } from "@/domain/safety-rules";
import { list } from "@/data/records";
import { PageHeader } from "@/components/page-header";
import { SafetyNav } from "../nav";
import { InspectionButton, RepairButton } from "../safety-ui";

export const metadata = { title: "Inspections" };
export const dynamic = "force-dynamic";

const day = (v: string | Date) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
const COUNTRY: Record<string, string> = { US: "United States · SMS", CA: "Canada · CVOR / NSC", MX: "Mexico · SCT" };

export default async function InspectionsPage() {
  const ctx = await requireCtx();
  const canEdit = can(ctx, "compliance.edit");
  const [b, drivers, trucks, trailers] = await Promise.all([inspectionsBoard(ctx), list(ctx, "driver", { limit: 2000 }), list(ctx, "truck", { limit: 2000 }), list(ctx, "trailer", { limit: 2000 })]);
  const opts = { drivers: drivers.map((d) => ({ id: d.id, name: String(d.name) })), trucks: trucks.map((t) => ({ id: t.id, name: String(t.unitNumber) })), trailers: trailers.map((t) => ({ id: t.id, name: String(t.unitNumber) })) };
  const name = (o: { id: string; name: string }[], id: string | null) => (id ? (o.find((x) => x.id === id)?.name ?? "") : "");
  const maxMeasure = Math.max(1, ...b.measures.map((m) => m.measure));
  return (
    <div>
      <PageHeader eyebrow="Safety & compliance" title="Roadside inspections" actions={canEdit ? <InspectionButton {...opts} /> : undefined}>
        Every inspection with its violations, the BASICs they fall in, out-of-service rates by country, and who picks up the points. The measures follow FMCSA&rsquo;s SMS method (24 months, time-weighted, severity-weighted) on your US inspections; your official percentiles need the national peer group — check them on the FMCSA SMS site.
      </PageHeader>
      <SafetyNav role={ctx.role} />
      <div className="px-gutter pb-10 space-y-5">
        <section data-testid="basics">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {b.measures.map((m) => (
              <div key={m.key} className="card p-4">
                <div className="eyebrow">{m.label}</div>
                <div className="flex items-baseline gap-2 mt-1">
                  <div className={`text-title2 font-extrabold ${m.measure ? "text-ink" : "text-faint"}`}>{m.measure.toFixed(2)}</div>
                  <div className="text-footnote text-muted">measure</div>
                </div>
                <div className="h-1.5 rounded bg-ground mt-2 overflow-hidden">
                  <div className="h-full bg-amber" style={{ width: `${(m.measure / maxMeasure) * 100}%` }} />
                </div>
                <div className="text-footnote text-muted mt-2">
                  {m.key === "crash" ? `${m.inspections} recordable crash${m.inspections === 1 ? "" : "es"} · per ${b.powerUnits} power unit${b.powerUnits === 1 ? "" : "s"}` : `${m.withViolations} of ${m.inspections} relevant inspections with violations${m.oos ? ` · ${m.oos} OOS` : ""}`}
                </div>
              </div>
            ))}
            <div className="card p-4 text-footnote text-muted">
              <div className="eyebrow mb-1">How it&rsquo;s counted</div>
              Severity per inspection per BASIC = the violation weights, +2 each when out of service, capped at 30; × 3 (last 6 months), 2 (6–12) or 1 (12–24); ÷ time-weighted relevant inspections, or ÷ power units for Unsafe Driving and Crash. Crashes you marked not preventable are left out.
            </div>
          </div>
        </section>

        <div className="grid lg:grid-cols-2 gap-5 [&>*]:min-w-0">
          <section className="card overflow-auto" data-testid="oos-rates">
            <div className="px-5 py-4 border-b border-line h2">Out-of-service rates · 24 months</div>
            <table className="table">
              <thead>
                <tr>
                  <th>Where</th>
                  <th>Inspections</th>
                  <th>Clean</th>
                  <th>Driver OOS</th>
                  <th>Vehicle OOS</th>
                </tr>
              </thead>
              <tbody>
                {b.oos.map((o) => (
                  <tr key={o.country}>
                    <td className="font-semibold">{COUNTRY[o.country]}</td>
                    <td>{o.inspections}</td>
                    <td>{o.clean}</td>
                    <td>
                      {pct(o.driver.rate)} <span className="text-faint text-footnote">({o.driver.oos}/{o.driver.inspections})</span>
                    </td>
                    <td>
                      {pct(o.vehicle.rate)} <span className="text-faint text-footnote">({o.vehicle.oos}/{o.vehicle.inspections})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card overflow-auto" data-testid="driver-points">
            <div className="px-5 py-4 border-b border-line h2">Drivers by points · 24 months</div>
            {b.drivers.length === 0 ? (
              <div className="px-5 py-6 text-muted text-callout">No driver inspections yet.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Inspections</th>
                    <th>Clean</th>
                    <th>OOS</th>
                    <th>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {b.drivers.slice(0, 15).map((d) => (
                    <tr key={d.driverId}>
                      <td>
                        <Link href={`/compliance/drivers/${d.driverId}`} className="font-semibold hover:text-teal">
                          {name(opts.drivers, d.driverId) || "?"}
                        </Link>
                      </td>
                      <td>{d.inspections}</td>
                      <td>{d.clean}</td>
                      <td>{d.oos}</td>
                      <td className="font-bold">{d.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <section className="card overflow-auto">
          <div className="px-5 py-4 border-b border-line h2">Inspections · 3 years</div>
          {b.list.length === 0 ? (
            <div className="py-12 text-center">
              <div className="font-bold">No inspections logged</div>
              <div className="text-muted text-callout mt-1">Log each one the day it happens — clean ones too: they bring the measures down.</div>
            </div>
          ) : (
            <table className="table" data-testid="inspections-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Where</th>
                  <th>Driver · unit</th>
                  <th>Violations</th>
                  <th>DataQs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {b.list.map((i) => (
                  <tr key={i.id}>
                    <td className="whitespace-nowrap">{day(i.inspectedAt)}</td>
                    <td className="whitespace-nowrap">
                      {i.jurisdiction ?? i.country} · L{i.level}
                      {i.hazmat ? " · HM" : ""}
                      <div className="text-footnote text-muted">{i.reportNumber ?? ""}</div>
                    </td>
                    <td>
                      {i.driverId ? (
                        <Link href={`/compliance/drivers/${i.driverId}`} className="hover:text-teal">
                          {name(opts.drivers, i.driverId)}
                        </Link>
                      ) : null}
                      {i.truckId ? ` · ${name(opts.trucks, i.truckId)}` : ""}
                      {i.trailerId ? ` · ${name(opts.trailers, i.trailerId)}` : ""}
                    </td>
                    <td>
                      {i.violations.length === 0 ? (
                        <span className="pill pill-green">clean</span>
                      ) : (
                        <ul className="text-callout space-y-0.5">
                          {i.violations.map((v, k) => (
                            <li key={k} className={v.removed ? "line-through text-faint" : ""}>
                              <span className="mono">{v.code}</span> {v.description} <span className="text-muted">· {v.basic ? `${BASICS.find((x) => x.key === v.basic)?.label} · wt ${v.severity}` : "not in SMS"}</span> {v.oos && <span className="pill pill-red">OOS</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {(() => {
                        const o = roadsideOos(i);
                        const units = [o.truck.length ? name(opts.trucks, i.truckId) : "", o.trailer.length ? name(opts.trailers, i.trailerId) : ""].filter(Boolean).join(" and ");
                        return (
                          <>
                            {o.driver.length > 0 && i.driverOosUntil && <div className="text-footnote text-red mt-1">Driver out of service until {new Date(i.driverOosUntil).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
                            {units && !i.repair && (
                              <div className="mt-1.5 flex items-center gap-2" data-testid="unit-oos">
                                <span className="text-footnote text-red font-semibold">{units} out of service until the repair is signed off</span>
                                {canEdit && <RepairButton inspectionId={i.id} unit={units} />}
                              </div>
                            )}
                            {units && i.repair && (
                              <div className="text-footnote text-muted mt-1" data-testid="repair-signed">
                                Repair signed off by {i.repair.byName}, {day(i.repair.at)}: {i.repair.note}
                                {i.repair.documentId && (
                                  <>
                                    {" · "}
                                    <a href={`/api/files/${i.repair.documentId}`} target="_blank" rel="noreferrer" className="text-teal">
                                      repair order
                                    </a>
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td className="capitalize">{i.dataQs === "none" ? "—" : i.dataQs}</td>
                    <td className="text-right">{canEdit && <InspectionButton {...opts} edit={JSON.parse(JSON.stringify(i))} />}</td>
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
