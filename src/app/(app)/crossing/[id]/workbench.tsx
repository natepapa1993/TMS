"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { call } from "@/lib/client-call";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Pill, Toast, useToast, Spinner } from "@/components/ui";
import * as A from "../actions";
import type { CrossingState, Requirement } from "@/db/schema";

/**
 * Crossing page (spec §3.2): header above, then checklist (left) · document viewer + fields (center) ·
 * cross-checks, eligibility, packet, steps (right) · timeline (bottom).
 */

type Doc = { id: string; code: string | null; fileName: string; mimeType: string; status: string; version: number; source: string; extracted: Record<string, { value: unknown; confidence: number; source?: string }> | null; extractionAt: string | null; extractionNote: string | null; createdAt: string };
type Check = { code: string; state: string; message: string | null; values: Record<string, unknown> | null; overrideReason: string | null; overrideBy: string | null };
type Ev = { id: string; at: string; kind: string; fromState: string | null; toState: string | null; source: string; verified: boolean; userId: string | null; note: string | null };
type Data = {
  crossing: { id: string; state: CrossingState; requirements: Requirement[]; trailerNumber: string | null; sealNumber: string | null; bridge: string | null; arrivedYardAt: string | null; departedYardAt: string | null; heldReason: string | null; returnedReason: string | null; packetBuiltAt: string | null; packetSentAt: string | null; packetAckAt: string | null; packetToken: string | null; eligibility: { ok: boolean; hardBlocked: boolean; findings: { level: string; code: string; message: string; overridable: boolean }[] } | null; eligibilityOverride: { reason: string } | null; fromCountry: string; toCountry: string };
  leg: { id: string; state: string; truckId: string | null; driverId: string | null } | null;
  order: { id: string; orderNumber: string };
  checks: Check[];
  events: Ev[];
  docs: Doc[];
  truck: { unitNumber: string; mxPlateClass: string | null; usPlate: string | null; mxPlate: string | null } | null;
  driver: { name: string } | null;
  coDriver: { name: string } | null;
  customer: { name: string; knowledgeMd?: string | null } | null;
  broker: { name: string; patente: string | null } | null;
  port: { name: string; knowledgeMd?: string | null; bridges?: string[] } | null;
  people: Record<string, string>;
  docFields: Record<string, { key: string; label: string; kind?: string }[]>;
  checkLabel: Record<string, string>;
  stateOrder: CrossingState[];
  stateLabel: Record<string, string>;
  stepLabel: Record<string, string>;
  role: string;
};

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const STEP: Partial<Record<CrossingState, string>> = { departed_yard: "Departed the yard", at_mx_customs: "At Mexican customs", in_us_customs: "At US customs", cleared: "Cleared — US side" };
const NEXT: Partial<Record<CrossingState, CrossingState>> = { packet_sent: "departed_yard", departed_yard: "at_mx_customs", at_mx_customs: "in_us_customs", in_us_customs: "cleared" };

export function CrossingWorkbench({ data }: { data: Data }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const c = data.crossing;
  const [selCode, setSelCode] = useState<string | null>(c.requirements.find((r) => r.documentId)?.code ?? null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [naFor, setNaFor] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [eligOverride, setEligOverride] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [returnedOpen, setReturnedOpen] = useState(false);
  const [retiroOpen, setRetiroOpen] = useState(false);
  const [details, setDetails] = useState({ trailerNumber: c.trailerNumber ?? "", sealNumber: c.sealNumber ?? "", bridge: c.bridge ?? "" });
  const canEdit = ["owner", "dispatcher", "mx_office"].includes(data.role);
  const canOverride = ["owner", "mx_office"].includes(data.role);

  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });

  const activeDocs = useMemo(() => data.docs.filter((d) => d.status !== "superseded" && d.status !== "rejected"), [data.docs]);
  const selDoc = activeDocs.find((d) => d.code === selCode) ?? null;
  const idx = data.stateOrder.indexOf(c.state);
  const beforePacket = idx >= 0 && idx < data.stateOrder.indexOf("packet_sent");
  const next = NEXT[c.state];
  const required = c.requirements.filter((r) => r.status !== "na");
  const presentCount = required.filter((r) => r.status !== "missing").length;
  const failing = data.checks.filter((k) => k.state === "fail");

  return (
    <div className="space-y-4">
      {/* header strip: details */}
      <div className="card p-4 grid grid-cols-[120px_120px_160px_1fr_auto] gap-3 items-end">
        <div>
          <label className="label">Caja / trailer #</label>
          <input className="input mono" id="x-trailer" aria-label="Caja / trailer #" value={details.trailerNumber} onChange={(e) => setDetails({ ...details, trailerNumber: e.target.value })} disabled={!canEdit} />
        </div>
        <div>
          <label className="label">Seal #</label>
          <input className="input mono" value={details.sealNumber} onChange={(e) => setDetails({ ...details, sealNumber: e.target.value })} disabled={!canEdit} />
        </div>
        <div>
          <label className="label">Bridge</label>
          <input className="input" list="port-bridges" value={details.bridge} onChange={(e) => setDetails({ ...details, bridge: e.target.value })} placeholder={data.port?.bridges?.[0] ?? "World Trade"} disabled={!canEdit} />
          <datalist id="port-bridges">
            {(data.port?.bridges ?? []).map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
        <div className="text-[12.5px] text-muted">
          {c.departedYardAt ? `Left the yard ${fmt(c.departedYardAt)}${c.arrivedYardAt ? ` (there since ${fmt(c.arrivedYardAt)})` : ""}` : c.arrivedYardAt ? `At the yard since ${fmt(c.arrivedYardAt)}` : "Not at the border yard yet"}
          {c.fromCountry !== "MX" && c.toCountry !== "MX" ? "" : data.broker ? ` · MX broker ${data.broker.name}${data.broker.patente ? ` (patente ${data.broker.patente})` : ""}` : " · customer has no MX broker on file"}
        </div>
        <div className="flex gap-2">
          {!c.arrivedYardAt && canEdit && (
            <button className="btn" disabled={pending} onClick={() => run("Dwell clock started", () => A.arrivedYardAction(c.id))}>
              Trailer is at the yard
            </button>
          )}
          {canEdit && (
            <button className="btn btn-primary" disabled={pending || (details.trailerNumber === (c.trailerNumber ?? "") && details.sealNumber === (c.sealNumber ?? "") && details.bridge === (c.bridge ?? ""))} onClick={() => run("Saved", () => A.setDetailsAction(c.id, details))}>
              Save
            </button>
          )}
        </div>
      </div>
      {(data.port?.knowledgeMd || data.customer?.knowledgeMd) && (
        <div className="grid md:grid-cols-2 gap-3 mb-4" data-testid="knowledge">
          {data.port?.knowledgeMd && (
            <div className="rounded-lg border border-teal/30 bg-teal-soft/40 px-3 py-2 text-[13px] whitespace-pre-wrap">
              <div className="eyebrow mb-0.5">{data.port.name} · what to know</div>
              {data.port.knowledgeMd}
            </div>
          )}
          {data.customer?.knowledgeMd && (
            <div className="rounded-lg border border-teal/30 bg-teal-soft/40 px-3 py-2 text-[13px] whitespace-pre-wrap">
              <div className="eyebrow mb-0.5">{data.customer.name} · what to know</div>
              {data.customer.knowledgeMd}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-[300px_1fr_340px] gap-4 items-start">
        {/* checklist */}
        <div className="card">
          <div className="px-4 pt-3 pb-2 border-b border-line flex items-center justify-between">
            <div className="h2">Packet</div>
            <span className="text-[12px] text-muted">
              {presentCount}/{required.length}
            </span>
          </div>
          <ul className="divide-y divide-line">
            {c.requirements.map((r) => {
              const doc = activeDocs.find((d) => d.code === r.code);
              const active = selCode === r.code;
              return (
                <li key={r.code} className={`px-4 py-2.5 cursor-pointer ${active ? "bg-teal-soft/50" : "hover:bg-ground"}`} onClick={() => setSelCode(r.code)}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-[13px] truncate">{r.label}</div>
                    <Pill tone={r.status === "verified" ? "green" : r.status === "present" ? "blue" : r.status === "na" ? "slate" : "amber"}>{r.status === "na" ? "n/a" : r.status}</Pill>
                  </div>
                  <div className="text-[12px] text-muted flex items-center justify-between gap-2 mt-0.5">
                    <span className="truncate">
                      {doc ? `${doc.fileName} · v${doc.version} · ${doc.source}` : r.status === "na" ? (r.naReason === "optional" ? "not required" : r.naReason) : `from ${r.providedBy.replace("_", " ")}`}
                    </span>
                    {canEdit && beforePacket && (
                      <span className="flex gap-1 flex-none" onClick={(e) => e.stopPropagation()}>
                        {r.code === "carta_retiro" ? (
                          <button className="btn btn-sm" onClick={() => setRetiroOpen(true)}>
                            {doc ? "Regenerate" : "Generate"}
                          </button>
                        ) : (
                          <button className="btn btn-sm" onClick={() => setUploadFor(r.code)}>
                            {doc ? "Replace" : "Upload"}
                          </button>
                        )}
                        {r.status === "missing" && r.allowNa && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setNaFor(r.code)}>
                            n/a
                          </button>
                        )}
                        {r.status === "na" && r.naReason !== "optional" && (
                          <button className="btn btn-ghost btn-sm" onClick={() => run("Back on the list", () => A.undoNaAction(c.id, r.code))}>
                            undo
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {c.state === "returned" && canEdit && (
            <div className="p-3 border-t border-line">
              <div className="text-[12.5px] text-red font-semibold mb-2">Returned: {c.returnedReason}</div>
              <button className="btn btn-primary w-full justify-center" onClick={() => run("Re-verifying", () => A.reverifyAction(c.id))}>
                Docs fixed — re-verify
              </button>
            </div>
          )}
        </div>

        {/* viewer + fields */}
        <div className="card min-h-[520px] flex flex-col">
          {selDoc ? (
            <>
              <div className="px-4 pt-3 pb-2 border-b border-line flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="h2 truncate">{c.requirements.find((r) => r.code === selDoc.code)?.label ?? selDoc.code}</div>
                  <div className="text-[12px] text-muted">
                    {selDoc.fileName} · v{selDoc.version} · {selDoc.source} · {fmt(selDoc.createdAt)}
                  </div>
                </div>
                <a className="btn btn-sm" href={`/api/files/${selDoc.id}`} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
              <div className="grid grid-cols-[1fr_260px] flex-1 min-h-0">
                <iframe title="document" src={`/api/files/${selDoc.id}`} className="w-full h-[520px] border-r border-line bg-ground" />
                <FieldsPanel key={`${selDoc.id}:${selDoc.extractionAt ?? ""}`} doc={selDoc} fields={data.docFields[selDoc.code ?? ""] ?? []} canEdit={canEdit && beforePacket} onSave={(fields, confirm) => run(confirm ? "Confirmed — checks re-run" : "Saved — checks re-run", () => A.setFieldsAction(c.id, selDoc.id, fields, confirm))} onExtract={() => run("AI read the document — check the values and confirm", async () => { const r = await A.extractAction(c.id, selDoc.id); if (r.ok && !r.data.ran) return { ok: false, error: r.data.reason }; return r; })} />
              </div>
            </>
          ) : (
            <div className="flex-1 grid place-items-center text-center p-8">
              <div>
                <div className="font-bold">{selCode ? "Nothing uploaded for this yet" : "Pick a document on the left"}</div>
                <div className="text-muted text-[13px] mt-1">Upload a PDF or photo; type the numbers the checks compare (trailer, seal, plates…). The system reads what it can; you can always type.</div>
                {selCode && canEdit && beforePacket && selCode !== "carta_retiro" && (
                  <button className="btn btn-primary mt-4" onClick={() => setUploadFor(selCode)}>
                    Upload {c.requirements.find((r) => r.code === selCode)?.label}
                  </button>
                )}
                {selCode === "carta_retiro" && canEdit && beforePacket && (
                  <button className="btn btn-primary mt-4" onClick={() => setRetiroOpen(true)}>
                    Generate the Solicitud de Retiro
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* right column */}
        <div className="space-y-4">
          <div className="card">
            <div className="px-4 pt-3 pb-2 border-b border-line flex items-center justify-between">
              <div className="h2">Cross-checks</div>
              <span className={`text-[12px] font-bold ${failing.length ? "text-red" : data.checks.some((k) => k.state === "pass") ? "text-green" : "text-muted"}`}>{failing.length ? `${failing.length} failing` : data.checks.some((k) => k.state === "pass") ? "all clear" : "not checked yet"}</span>
            </div>
            <ul className="divide-y divide-line max-h-[360px] overflow-auto">
              {data.checks
                .slice()
                .sort((p, q) => rank(p.state) - rank(q.state))
                .map((k) => (
                  <li key={k.code} className="px-4 py-2">
                    <div className="flex items-start gap-2">
                      <span className={`w-2 h-2 rounded-full mt-1.5 flex-none ${k.state === "pass" ? "bg-green" : k.state === "fail" ? "bg-red" : k.state === "overridden" ? "bg-amber" : "bg-line"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">{data.checkLabel[k.code] ?? k.code}</div>
                        <div className={`text-[12px] ${k.state === "fail" ? "text-red" : "text-muted"}`}>{k.message}</div>
                        {k.state === "overridden" && (
                          <div className="text-[12px] text-amber">
                            overridden{k.overrideBy ? ` by ${data.people[k.overrideBy] ?? "someone"}` : ""}: {k.overrideReason}
                          </div>
                        )}
                      </div>
                      {k.state === "fail" && canOverride && beforePacket && (
                        <button className="btn btn-sm" onClick={() => setOverrideFor(k.code)}>
                          Override
                        </button>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="h2">Eligibility</div>
              {c.eligibility && <Pill tone={c.eligibility.ok ? "green" : c.eligibility.hardBlocked ? "red" : c.eligibilityOverride ? "amber" : "red"}>{c.eligibility.ok ? "Green" : c.eligibility.hardBlocked ? "Blocked" : c.eligibilityOverride ? "Overridden" : "Red"}</Pill>}
            </div>
            <div className="text-[12.5px] text-muted mt-1">
              {data.truck ? `Unit ${data.truck.unitNumber} · ${data.truck.mxPlateClass ?? "no MX"} plates` : "No crossing truck"} · {data.driver ? data.driver.name : "no driver"}
              {data.coDriver ? ` / ${data.coDriver.name}` : ""}
            </div>
            {c.eligibility?.findings.map((f) => (
              <div key={f.code} className={`text-[12.5px] mt-1 ${f.level === "red" ? "text-red" : "text-amber"}`}>
                {f.message}
                {!f.overridable ? " — no override" : ""}
              </div>
            ))}
            {c.eligibilityOverride && <div className="text-[12.5px] text-amber mt-1">Override: {c.eligibilityOverride.reason}</div>}
            {c.eligibility && !c.eligibility.ok && !c.eligibility.hardBlocked && !c.eligibilityOverride && canOverride && (
              <button className="btn btn-sm mt-2" onClick={() => setEligOverride(true)}>
                Override
              </button>
            )}
            {(!data.truck || !data.driver) && <div className="help mt-1">Assign the crossing unit and driver from Dispatch.</div>}
          </div>

          <div className="card p-4">
            <div className="h2">Packet</div>
            {beforePacket ? (
              <div className="mt-2 space-y-2">
                <div className="text-[12.5px] text-muted">
                  {c.state === "ready_to_cross" ? "Built and ready. Send it to the driver." : c.state === "eligibility_checked" ? "Everything checks out. Build the packet." : c.state === "docs_verified" ? "Docs verified; eligibility is not green." : c.state === "docs_complete" ? "All docs in; a cross-check is failing." : `${required.length - presentCount} document(s) still missing.`}
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <button className="btn" disabled={pending || !["eligibility_checked", "ready_to_cross"].includes(c.state)} onClick={() => run("Packet built", () => A.buildPacketAction(c.id))}>
                      {c.packetBuiltAt ? "Rebuild packet" : "Build packet"}
                    </button>
                    <button className="btn btn-primary" disabled={pending || c.state !== "ready_to_cross"} onClick={() => run("Packet sent to the driver", () => A.sendPacketAction(c.id))}>
                      Send to driver
                    </button>
                  </div>
                )}
                {c.packetBuiltAt && c.packetToken && (
                  <a className="text-[12.5px] text-teal font-semibold" href={`/p/${c.packetToken}`} target="_blank" rel="noreferrer">
                    Preview packet (built {fmt(c.packetBuiltAt)})
                  </a>
                )}
              </div>
            ) : (
              <div className="mt-2 text-[12.5px]">
                <div>
                  Sent {fmt(c.packetSentAt)} · {c.packetAckAt ? <span className="text-green font-semibold">opened {fmt(c.packetAckAt)}</span> : <span className="text-amber font-semibold">not opened yet</span>}
                </div>
                {c.packetToken && (
                  <a className="text-teal font-semibold" href={`/p/${c.packetToken}`} target="_blank" rel="noreferrer">
                    Open packet
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="card p-4">
            <div className="h2">Border</div>
            <ol className="mt-2 space-y-1">
              {(["packet_sent", "departed_yard", "at_mx_customs", "in_us_customs", "cleared"] as CrossingState[]).map((st) => {
                const i = data.stateOrder.indexOf(st);
                const done = idx >= i && c.state !== "held" && c.state !== "returned";
                const ev = data.events.find((e) => e.kind === "transition" && e.toState === st);
                return (
                  <li key={st} className="flex items-center gap-2 text-[13px]">
                    <span className={`timeline-dot ${done ? "done" : ""} ${c.state === st ? "now" : ""}`} />
                    <span className={done ? "font-semibold" : "text-muted"}>{data.stateLabel[st]}</span>
                    {ev && (
                      <span className="text-faint text-[12px] ml-auto">
                        {fmt(ev.at)} · {ev.source.replace("_", " ")}
                        {ev.verified ? " · GPS" : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            {canEdit && (
              <div className="flex flex-wrap gap-2 mt-3">
                {next && c.state !== "held" && (
                  <button className="btn btn-primary btn-sm" disabled={pending} onClick={() => run(data.stepLabel[next] ?? STEP[next] ?? next, () => A.stepAction(c.id, next))}>
                    {data.stepLabel[next] ?? STEP[next]}
                  </button>
                )}
                {c.state === "held" ? (
                  <button className="btn btn-sm" onClick={() => run("Released", () => A.releaseCrossingAction(c.id))}>
                    Release hold
                  </button>
                ) : (
                  c.state !== "cleared" &&
                  c.state !== "returned" && (
                    <button className="btn btn-sm btn-danger" onClick={() => setHoldOpen(true)}>
                      Hold
                    </button>
                  )
                )}
                {["at_mx_customs", "in_us_customs", "held"].includes(c.state) && (
                  <button className="btn btn-sm" onClick={() => setReturnedOpen(true)}>
                    Returned to MX
                  </button>
                )}
              </div>
            )}
            {c.state === "held" && <div className="text-[12.5px] text-red mt-2">Held: {c.heldReason}</div>}
          </div>
        </div>
      </div>

      {/* timeline */}
      <div className="card p-4">
        <div className="h2 mb-2">Timeline</div>
        <ul className="space-y-1 max-h-[420px] overflow-y-auto">
          {data.events.map((e) => (
            <li key={e.id} className="text-[12.5px] flex gap-2">
              <span className="text-faint whitespace-nowrap w-28">{fmt(e.at)}</span>
              <span>
                {e.kind === "transition" ? (
                  <>
                    <span className="font-semibold">{data.stateLabel[e.toState ?? ""] ?? e.toState}</span>
                    {e.fromState ? <span className="text-faint"> from {data.stateLabel[e.fromState] ?? e.fromState}</span> : null}
                  </>
                ) : (
                  <span>{e.note}</span>
                )}
                <span className="text-faint">
                  {" "}
                  · {e.source.replace("_", " ")}
                  {e.verified ? " · GPS" : ""}
                  {e.userId ? ` · ${data.people[e.userId] ?? ""}` : ""}
                </span>
                {e.kind === "transition" && e.note ? <span className="text-muted"> — {e.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* popups */}
      {uploadFor && <UploadModal crossingId={c.id} code={uploadFor} label={c.requirements.find((r) => r.code === uploadFor)?.label ?? uploadFor} fields={data.docFields[uploadFor] ?? []} onClose={() => setUploadFor(null)} onDone={() => { setUploadFor(null); setSelCode(uploadFor); t.ok("Uploaded — checks re-run"); router.refresh(); }} />}
      {retiroOpen && (
        <RetiroModal
          crossingId={c.id}
          trailer={details.trailerNumber || c.trailerNumber || ""}
          onClose={() => setRetiroOpen(false)}
          onDone={() => {
            setRetiroOpen(false);
            setSelCode("carta_retiro");
            t.ok("Solicitud de Retiro generated");
            router.refresh();
          }}
        />
      )}
      <Confirm open={!!naFor} onClose={() => setNaFor(null)} title={`Mark ${c.requirements.find((r) => r.code === naFor)?.label ?? ""} not applicable`} needReason="Why?" confirmLabel="Mark n/a" onConfirm={(reason) => { const code = naFor!; setNaFor(null); run("Marked n/a", () => A.naAction(c.id, code, reason)); }} />
      <Confirm open={!!overrideFor} onClose={() => setOverrideFor(null)} title={`Override: ${data.checkLabel[overrideFor ?? ""] ?? ""}`} body={<span>{data.checks.find((k) => k.code === overrideFor)?.message}. Your name, the time and this reason go on the crossing record.</span>} needReason="Reason" confirmLabel="Override" onConfirm={(reason) => { const code = overrideFor!; setOverrideFor(null); run("Overridden — checks re-run", () => A.overrideCheckAction(c.id, code, reason)); }} />
      <Confirm open={eligOverride} onClose={() => setEligOverride(false)} title="Override eligibility" body="Only a soft finding can be overridden. Expired legal documents and B-1 rules never can." needReason="Reason" confirmLabel="Override" onConfirm={(reason) => { setEligOverride(false); run("Eligibility overridden", () => A.overrideEligibilityAction(c.id, reason)); }} />
      <Confirm open={holdOpen} onClose={() => setHoldOpen(false)} title="Hold this crossing" needReason="Reason (CBP secondary, missing doc…)" confirmLabel="Hold" danger onConfirm={(reason) => { setHoldOpen(false); run("On hold", () => A.holdCrossingAction(c.id, reason)); }} />
      <Confirm open={returnedOpen} onClose={() => setReturnedOpen(false)} title="Truck returned to the Mexican side" body="The packet is withdrawn. Fix the documents, then re-verify." needReason="Why was it turned back?" confirmLabel="Mark returned" danger onConfirm={(reason) => { setReturnedOpen(false); run("Marked returned", () => A.returnedAction(c.id, reason)); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

const rank = (s: string) => ({ fail: 0, overridden: 1, skipped: 2, pending: 2, pass: 3 })[s] ?? 4;

function FieldsPanel({ doc, fields, canEdit, onSave, onExtract }: { doc: Doc; fields: { key: string; label: string; kind?: string }[]; canEdit: boolean; onSave: (fields: Record<string, string>, confirm: boolean) => void; onExtract: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, doc.extracted?.[f.key]?.value != null ? String(doc.extracted[f.key].value) : ""])));
  const dirty = fields.some((f) => vals[f.key] !== (doc.extracted?.[f.key]?.value != null ? String(doc.extracted[f.key].value) : ""));
  return (
    <div className="p-3 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="eyebrow">Fields</div>
        <Pill tone={doc.status === "verified" ? "green" : "blue"}>{doc.status}</Pill>
      </div>
      {fields.length === 0 && <div className="text-muted text-[12.5px]">No fields to compare on this document.</div>}
      <div className="space-y-2">
        {fields.map((f) => {
          const conf = doc.extracted?.[f.key]?.confidence;
          return (
            <div key={f.key}>
              <label className="label flex justify-between">
                {f.label}
                {doc.extracted?.[f.key]?.source === "ai" && conf != null && <span className={`normal-case font-semibold ${conf < 0.8 ? "text-amber" : "text-teal"}`}>AI {Math.round(conf * 100)}%{conf < 0.8 ? " · check" : ""}</span>}
                {doc.extracted?.[f.key]?.source !== "ai" && conf != null && conf >= 1 && <span className="normal-case text-faint">typed</span>}
              </label>
              <input className={`input h-8 text-[13px] ${f.kind === "number" ? "mono" : ""}`} type={f.kind === "datetime" ? "datetime-local" : "text"} value={f.kind === "datetime" && vals[f.key] ? vals[f.key].slice(0, 16) : vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} disabled={!canEdit} />
            </div>
          );
        })}
      </div>
      {canEdit && fields.length > 0 && (
        <div className="flex gap-2 mt-3 flex-wrap">
          <button className="btn btn-sm" disabled={!dirty} onClick={() => onSave(vals, false)}>
            Save
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => onSave(vals, true)}>
            Confirm
          </button>
          <button className="btn btn-ghost btn-sm ml-auto" onClick={onExtract} title="Read the fields from the file with the AI extractor (Settings → Integrations)">
            {doc.extractionAt ? "Re-read with AI" : "Read with AI"}
          </button>
        </div>
      )}
      {doc.extractionNote && <div className={`text-[11.5px] mt-1 ${doc.extractionNote.startsWith("failed") ? "text-red" : "text-faint"}`}>{doc.extractionNote}</div>}
      <div className="help mt-2">Confirm = a human read the document and these values are right. AI values never count until confirmed.</div>
    </div>
  );
}

function UploadModal({ crossingId, code, label, fields, onClose, onDone }: { crossingId: string; code: string; label: string; fields: { key: string; label: string; kind?: string }[]; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [name, setName] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Upload ${label}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={pending || !name}
            onClick={() =>
              start(async () => {
                setErr(null);
                const fd = new FormData(ref.current!);
                fd.set("code", code);
                const r = await call(() => A.uploadDocAction(crossingId, fd));
                if (r.ok) onDone();
                else setErr(r.error);
              })
            }
          >
            {pending ? (
              <>
                <Spinner /> Uploading…
              </>
            ) : (
              "Upload"
            )}
          </button>
        </>
      }
    >
      <form ref={ref} onSubmit={(e) => e.preventDefault()} className="space-y-3">
        <label className="block border-2 border-dashed border-line rounded-lg p-5 text-center cursor-pointer hover:border-teal">
          <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? null)} />
          <div className="font-semibold">{name ?? "Choose a PDF or photo"}</div>
          <div className="text-[12px] text-muted">From NAD, Viatpro, email or the yard. Up to 15 MB.</div>
        </label>
        <input type="hidden" name="source" value="upload" />
        {fields.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Type what the checks compare (optional now, needed before crossing)</div>
            <div className="grid grid-cols-2 gap-2">
              {fields.map((f) => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  <input name={`f_${f.key}`} className="input h-8 text-[13px]" type={f.kind === "datetime" ? "datetime-local" : "text"} />
                </div>
              ))}
            </div>
          </div>
        )}
        {err && <div className="error">{err}</div>}
      </form>
    </Modal>
  );
}

function RetiroModal({ crossingId, trailer, onClose, onDone }: { crossingId: string; trailer: string; onClose: () => void; onDone: () => void }) {
  const [yard, setYard] = useState("");
  const [by, setBy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Modal
      open
      onClose={onClose}
      title="Solicitud de Retiro"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await A.generateRetiroAction(crossingId, { yardName: yard, authorizedBy: by });
                if (r.ok) onDone();
                else setErr(r.error);
              })
            }
          >
            Generate PDF
          </button>
        </>
      }
    >
      <div className="text-[13px] text-muted mb-3">
        We are the transfer: the letter asks the yard to release caja <b className="text-ink mono">{trailer || "—"}</b> to our unit and operadores, on our letterhead. Trailer, unit, plates and drivers come from the assignment.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Yard (patio)</label>
          <input className="input" value={yard} onChange={(e) => setYard(e.target.value)} placeholder="Santa Fe Yard" />
        </div>
        <div>
          <label className="label">Autorizado por</label>
          <input className="input" value={by} onChange={(e) => setBy(e.target.value)} placeholder="name on the signature line" />
        </div>
      </div>
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}
