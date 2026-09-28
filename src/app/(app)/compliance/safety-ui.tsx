"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast, Confirm } from "@/components/ui";
import { useZone } from "@/components/zone";
import { recordDqAction, addTestAction, recordResultAction, attachTestDocumentAction, clearinghouseReportedAction, drawRandomAction, saveInspectionAction, deleteInspectionAction, signOffRepairAction, type TestForm, type InspectionForm } from "./safety-actions";
import { basicOf, BASICS, REASON_LABEL, RESULT_LABEL, lookupViolation, specimensFor, SPECIMEN_LABEL } from "@/domain/safety-rules";
import { toZoneInput, fromZoneInput, zonedDate, zoneLabel } from "@/lib/time";

type Opt = { id: string; name: string };
/**
 * Every Safety date and time is typed and read on the company's clock, whatever zone the browser is in (safety N2):
 * a post-accident deadline or a collection time reads the same for Safety in Laredo and the owner travelling.
 */
function useSafetyClock() {
  const zone = useZone();
  return {
    zone,
    /** "CDT": printed next to every date-time box */
    abbr: zoneLabel(zone),
    today: () => zonedDate(new Date(), zone),
    /** an instant as a datetime-local value on the company's clock */
    input: (d: Date | string | null | undefined = new Date()) => toZoneInput(d ?? new Date(), zone),
    /** a datetime-local value read on the company's clock → ISO */
    iso: (v: string | null | undefined) => (v ? (fromZoneInput(v, zone)?.toISOString() ?? "") : ""),
  };
}


// ---------- qualification file ----------

export function DqRecordButton({ driverId, itemKey, label, hint, primary }: { driverId: string; itemKey: string; label: string; hint: string; primary?: boolean }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [open, setOpen] = useState(false);
  const [notRequired, setNotRequired] = useState(false);
  const [pending, start] = useTransition();
  return (
    <>
      <button className={`btn btn-sm ${primary ? "btn-primary" : "btn-tinted"}`} onClick={() => { setNotRequired(false); setOpen(true); }} data-testid={`dq-record-${itemKey}`}>
        Record
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" form={`dq-form-${itemKey}`} type="submit" disabled={pending}>
              Save
            </button>
          </>
        }
      >
        <form
          id={`dq-form-${itemKey}`}
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("notRequired", notRequired ? "1" : "0");
            start(async () => {
              const r = await recordDqAction(driverId, itemKey, fd);
              if (!r.ok) return t.err(r.error);
              setOpen(false);
              t.ok(`${label} recorded`);
              router.refresh();
            });
          }}
        >
          <div className="col-span-2 help">{hint}</div>
          <label className="col-span-2 flex items-center gap-2 text-callout cursor-pointer">
            <input type="checkbox" className="accent-teal" checked={notRequired} onChange={(e) => setNotRequired(e.target.checked)} id="dq-na" /> Not required for this driver
          </label>
          {!notRequired && (
            <>
              <div>
                <label className="label" htmlFor="dq-date">
                  Done on
                </label>
                <input type="date" id="dq-date" name="completedAt" className="input" defaultValue={clock.today()} />
              </div>
              <div>
                <label className="label" htmlFor="dq-file">
                  The paper (PDF, JPG, PNG)
                </label>
                <input type="file" id="dq-file" name="file" accept="application/pdf,image/jpeg,image/png" className="input" />
              </div>
            </>
          )}
          <div className="col-span-2">
            <label className="label" htmlFor="dq-note">
              {notRequired ? "Why not (required)" : "Note"}
            </label>
            <input id="dq-note" name="note" className="input" placeholder={notRequired ? (itemKey === "pre_employment_test" ? "382.301(b): in a DOT program with a test in the last 6 months…" : "why it doesn't apply") : "reviewer, source, findings…"} />
          </div>
        </form>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

// ---------- drug & alcohol ----------

type Clock = ReturnType<typeof useSafetyClock>;
type Details = Pick<TestForm, "specimenType" | "mroVerifiedAt" | "observed" | "sapName" | "sapEvaluatedAt" | "sapEducationDoneAt" | "followUpPlanned" | "followUpMonths">;
const dayOf = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : "");

/**
 * What the custody and control form says beyond the result: the specimen, the MRO's verification, whether the
 * collection was observed — and for a return-to-duty test the SAP's name, evaluation, education done and the
 * follow-up plan. The hold stays until those are on the record.
 */
function TestDetailFields({ f, set, substance, reason, clock, file, setFile }: { f: Details; set: (k: keyof Details, v: string | boolean) => void; substance: string; reason: string; clock: Clock; file: File | null; setFile: (x: File | null) => void }) {
  const rtd = reason === "return_to_duty";
  const mustObserve = substance === "drug" && (rtd || reason === "follow_up");
  return (
    <>
      <div>
        <label className="label" htmlFor="t-specimen">
          Specimen
        </label>
        <select id="t-specimen" className="select" value={f.specimenType || (substance === "alcohol" ? "breath" : "urine")} onChange={(e) => set("specimenType", e.target.value)}>
          {specimensFor(substance).map((k) => (
            <option key={k} value={k}>
              {k === "oral_fluid" && substance === "alcohol" ? "Saliva (oral fluid)" : SPECIMEN_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {substance === "drug" && (
        <div>
          <label className="label" htmlFor="t-mro-at">
            MRO verified on
          </label>
          <input id="t-mro-at" type="date" className="input" value={f.mroVerifiedAt ?? ""} onChange={(e) => set("mroVerifiedAt", e.target.value)} max={clock.today()} />
        </div>
      )}
      {substance === "drug" && (
        <label className="flex items-center gap-2 text-callout cursor-pointer self-end pb-2">
          <input type="checkbox" className="accent-teal" checked={!!f.observed} onChange={(e) => set("observed", e.target.checked)} data-testid="t-observed" /> Directly observed{mustObserve ? " (required)" : ""}
        </label>
      )}
      {rtd && (
        <div className="col-span-3 rounded-lg border border-line p-3 grid grid-cols-3 gap-3" data-testid="sap-fields">
          <div className="col-span-3 eyebrow">SAP and the follow-up plan — the hold lifts only with these and a negative result</div>
          <div>
            <label className="label" htmlFor="t-sap">
              SAP (name)
            </label>
            <input id="t-sap" className="input" value={f.sapName ?? ""} onChange={(e) => set("sapName", e.target.value)} placeholder="Dr. R. Salinas, SAP" />
          </div>
          <div>
            <label className="label" htmlFor="t-sap-eval">
              SAP evaluation
            </label>
            <input id="t-sap-eval" type="date" className="input" value={f.sapEvaluatedAt ?? ""} onChange={(e) => set("sapEvaluatedAt", e.target.value)} max={clock.today()} />
          </div>
          <div>
            <label className="label" htmlFor="t-sap-done">
              Education / treatment done
            </label>
            <input id="t-sap-done" type="date" className="input" value={f.sapEducationDoneAt ?? ""} onChange={(e) => set("sapEducationDoneAt", e.target.value)} max={clock.today()} />
          </div>
          <div>
            <label className="label" htmlFor="t-fu">
              Follow-up tests
            </label>
            <input id="t-fu" type="number" min={6} max={60} className="input" value={f.followUpPlanned ?? ""} onChange={(e) => set("followUpPlanned", e.target.value)} placeholder="6 or more" />
          </div>
          <div>
            <label className="label" htmlFor="t-fu-months">
              Over (months)
            </label>
            <input id="t-fu-months" type="number" min={12} max={60} className="input" value={f.followUpMonths ?? ""} onChange={(e) => set("followUpMonths", e.target.value)} placeholder="12 to 60" />
          </div>
          <div className="help self-end">At least 6 in the first 12 months (40.307). Due dates show as to-dos; the actual days stay unannounced.</div>
        </div>
      )}
      <label className="col-span-3 block border-2 border-dashed border-line rounded-lg p-3 text-center cursor-pointer hover:border-teal">
        <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="t-file" />
        <div className="text-callout font-semibold">{file?.name ?? "Attach the CCF, MRO letter or breath test form (PDF, JPG, PNG)"}</div>
      </label>
    </>
  );
}

/** Upload the paper picked in a test dialog once the test is saved. */
async function uploadTestFile(testId: string, file: File | null) {
  if (!file) return null;
  const fd = new FormData();
  fd.set("file", file);
  const r = await attachTestDocumentAction(testId, fd);
  return r.ok ? null : r.error;
}

export function TestButton({ drivers, driverId, incidents, preset, label = "+ Record a test", small }: { drivers: Opt[]; driverId?: string; incidents?: { id: string; label: string }[]; preset?: Partial<TestForm>; label?: string; small?: boolean }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const blank = (): TestForm => ({ driverId: driverId ?? "", reason: "pre_employment", substance: "drug", incidentId: "", collectedAt: clock.input(), result: "pending", specimenId: "", collector: "", mro: "", followUpPlanned: "", followUpMonths: "", note: "", specimenType: "", mroVerifiedAt: "", observed: false, sapName: "", sapEvaluatedAt: "", sapEducationDoneAt: "", ...preset });
  const [f, setF] = useState<TestForm | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof TestForm, v: string | boolean) => setF((x) => (x ? { ...x, [k]: v, ...(k === "reason" && v === "return_to_duty" ? { observed: true } : {}) } : x));
  return (
    <>
      <button className={`btn ${small ? "btn-sm" : "btn-primary"}`} onClick={() => { setErr(null); setFile(null); setF(blank()); }} data-testid="add-test">
        {label}
      </button>
      {f && (
        <Modal
          open
          onClose={() => setF(null)}
          title="Record a drug or alcohol test"
          wide
          footer={
            <>
              <button className="btn" onClick={() => setF(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setErr(null);
                    const r = await addTestAction({ ...f, collectedAt: f.result === "pending" && !f.collectedAt ? "" : clock.iso(f.collectedAt) });
                    if (!r.ok) return setErr(r.error);
                    const upErr = await uploadTestFile(r.data.id, file);
                    setF(null);
                    if (upErr) t.err(`Test recorded, but the file didn't upload: ${upErr}`);
                    else t.ok("Test recorded");
                    router.refresh();
                  })
                }
              >
                Save
              </button>
            </>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="t-driver">
                Driver
              </label>
              <select id="t-driver" className="select" value={f.driverId} onChange={(e) => set("driverId", e.target.value)} disabled={!!driverId}>
                <option value="">—</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-reason">
                Reason
              </label>
              <select id="t-reason" className="select" value={f.reason} onChange={(e) => set("reason", e.target.value)}>
                {Object.entries(REASON_LABEL)
                  .filter(([k]) => k !== "random")
                  .map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-substance">
                Test
              </label>
              <select id="t-substance" className="select" value={f.substance} onChange={(e) => setF({ ...f, substance: e.target.value, specimenType: "" })}>
                <option value="drug">Drug (5-panel DOT)</option>
                <option value="alcohol">Alcohol</option>
              </select>
            </div>
            {f.reason === "post_accident" && incidents && (
              <div className="col-span-3">
                <label className="label" htmlFor="t-incident">
                  Accident
                </label>
                <select id="t-incident" className="select" value={f.incidentId} onChange={(e) => set("incidentId", e.target.value)}>
                  <option value="">—</option>
                  {incidents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="label" htmlFor="t-collected">
                Collected ({clock.abbr})
              </label>
              <input id="t-collected" type="datetime-local" className="input" value={f.collectedAt} onChange={(e) => set("collectedAt", e.target.value)} max={clock.input()} />
            </div>
            <div>
              <label className="label" htmlFor="t-result">
                Result
              </label>
              <select id="t-result" className="select" value={f.result} onChange={(e) => set("result", e.target.value)}>
                {Object.entries(RESULT_LABEL)
                  .filter(([k]) => k !== "selected")
                  .map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-ccf">
                CCF / form #
              </label>
              <input id="t-ccf" className="input" value={f.specimenId} onChange={(e) => set("specimenId", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="t-collector">
                Collection site
              </label>
              <input id="t-collector" className="input" value={f.collector} onChange={(e) => set("collector", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="t-mro">
                MRO
              </label>
              <input id="t-mro" className="input" value={f.mro} onChange={(e) => set("mro", e.target.value)} />
            </div>
            <TestDetailFields f={f} set={set} substance={f.substance} reason={f.reason} clock={clock} file={file} setFile={setFile} />
            <div className="col-span-3">
              <label className="label" htmlFor="t-note">
                Note
              </label>
              <input id="t-note" className="input" value={f.note} onChange={(e) => set("note", e.target.value)} />
            </div>
          </div>
          {err && (
            <div className="error mt-2" role="alert">
              {err}
            </div>
          )}
          <div className="help mt-2">Confidential (49 CFR 40.321): only the owner and Safety see results. A verified positive or a refusal puts the driver on a hold dispatch sees without the reason, until the SAP process is recorded and an observed return-to-duty test is negative.</div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

type ResultTest = { id: string; result: string; collectedAt: string | null; reason: string; substance: string; specimenId: string | null; followUpPlanned: number | null; followUpMonths?: number | null; specimenType?: string | null; mroVerifiedAt?: string | null; observed?: boolean; sapName?: string | null; sapEvaluatedAt?: string | null; sapEducationDoneAt?: string | null };

export function ResultButton({ test }: { test: ResultTest }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState<(Details & { collectedAt: string; result: string; specimenId: string }) | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = () => {
    setErr(null);
    setFile(null);
    setF({
      collectedAt: clock.input(test.collectedAt ?? new Date()),
      result: test.result === "selected" ? "pending" : test.result,
      specimenId: test.specimenId ?? "",
      followUpPlanned: test.followUpPlanned ? String(test.followUpPlanned) : "",
      followUpMonths: test.followUpMonths ? String(test.followUpMonths) : "",
      specimenType: test.specimenType ?? "",
      mroVerifiedAt: dayOf(test.mroVerifiedAt),
      observed: test.observed || (test.substance === "drug" && ["return_to_duty", "follow_up"].includes(test.reason)),
      sapName: test.sapName ?? "",
      sapEvaluatedAt: dayOf(test.sapEvaluatedAt),
      sapEducationDoneAt: dayOf(test.sapEducationDoneAt),
    });
  };
  return (
    <>
      <button className="btn btn-sm" onClick={open} data-testid="record-result">
        {test.result === "selected" ? "Collected" : "Result"}
      </button>
      {f && (
        <Modal
          open
          onClose={() => setF(null)}
          title="Collection and result"
          wide
          footer={
            <>
              <button className="btn" onClick={() => setF(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setErr(null);
                    const r = await recordResultAction(test.id, { ...f, collectedAt: f.result === "refusal" && !f.collectedAt ? "" : clock.iso(f.collectedAt), ...(test.reason === "return_to_duty" ? {} : { followUpPlanned: undefined, followUpMonths: undefined, sapName: undefined, sapEvaluatedAt: undefined, sapEducationDoneAt: undefined }) });
                    if (!r.ok) return setErr(r.error);
                    const upErr = await uploadTestFile(test.id, file);
                    setF(null);
                    if (upErr) t.err(`Saved, but the file didn't upload: ${upErr}`);
                    else t.ok(`Saved: ${RESULT_LABEL[f.result] ?? f.result}`);
                    router.refresh();
                  })
                }
              >
                Save
              </button>
            </>
          }
        >
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="r-collected">
                Collected ({clock.abbr})
              </label>
              <input id="r-collected" type="datetime-local" className="input" value={f.collectedAt} onChange={(e) => setF({ ...f, collectedAt: e.target.value })} max={clock.input()} />
            </div>
            <div>
              <label className="label" htmlFor="r-result">
                Result
              </label>
              <select id="r-result" className="select" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
                {Object.entries(RESULT_LABEL)
                  .filter(([k]) => k !== "selected")
                  .map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="r-ccf">
                CCF / form #
              </label>
              <input id="r-ccf" className="input" value={f.specimenId} onChange={(e) => setF({ ...f, specimenId: e.target.value })} />
            </div>
            <TestDetailFields f={f} set={(k, v) => setF((x) => (x ? { ...x, [k]: v } : x))} substance={test.substance} reason={test.reason} clock={clock} file={file} setFile={setFile} />
          </div>
          {err && (
            <div className="error mt-2" role="alert">
              {err}
            </div>
          )}
          <div className="help mt-2">A driver who doesn&rsquo;t show up after being told to test is a refusal (40.191).</div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

export function ClearinghouseButton({ testId }: { testId: string }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  return (
    <>
      <button
        className="btn btn-sm"
        disabled={pending}
        data-testid="ch-reported"
        onClick={() =>
          start(async () => {
            const r = await clearinghouseReportedAction(testId, clock.today());
            if (!r.ok) return t.err(r.error);
            t.ok("Marked reported to the Clearinghouse");
            router.refresh();
          })
        }
      >
        Reported today
      </button>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

export function DrawButton({ period, pool }: { period: string; pool: number }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState<{ period: string; drugRate: string; alcoholRate: string; drawsPerYear: string } | null>(null);
  const [result, setResult] = useState<{ drug: string[]; alcohol: string[]; poolSize: number; period: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button className="btn btn-primary" onClick={() => { setResult(null); setF({ period, drugRate: "50", alcoholRate: "10", drawsPerYear: "4" }); }} data-testid="run-draw">
        Run random draw
      </button>
      {f && (
        <Modal
          open
          onClose={() => setF(null)}
          title={result ? `Selected · ${result.period}` : "Random draw"}
          footer={
            result ? (
              <button className="btn btn-primary" onClick={() => setF(null)}>
                Done
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => setF(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await drawRandomAction(f);
                      if (!r.ok) return t.err(r.error);
                      setResult(r.data);
                      router.refresh();
                    })
                  }
                >
                  Draw from {pool} driver{pool === 1 ? "" : "s"}
                </button>
              </>
            )
          }
        >
          {result ? (
            <div className="text-body space-y-2" data-testid="draw-result">
              <div>
                Pool of {result.poolSize}. <b>Drug:</b> {result.drug.join(", ") || "none"}. <b>Alcohol:</b> {result.alcohol.join(", ") || "none"}.
              </div>
              <div className="help">Tell each driver only when they can go to the collection site right away, and record the collection or a refusal on the test.</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="dr-period">
                  Period
                </label>
                <input id="dr-period" className="input" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} placeholder="2026-Q4" />
              </div>
              <div>
                <label className="label" htmlFor="dr-per-year">
                  Draws a year
                </label>
                <select id="dr-per-year" className="select" value={f.drawsPerYear} onChange={(e) => setF({ ...f, drawsPerYear: e.target.value, period: e.target.value === "12" ? clock.today().slice(0, 7) : /Q/.test(f.period) ? f.period : period })}>
                  <option value="4">4 (quarterly)</option>
                  <option value="12">12 (monthly)</option>
                  <option value="2">2</option>
                  <option value="1">1</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="dr-drug">
                  Drug rate (% a year)
                </label>
                <input id="dr-drug" type="number" className="input" value={f.drugRate} onChange={(e) => setF({ ...f, drugRate: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="dr-alcohol">
                  Alcohol rate (% a year)
                </label>
                <input id="dr-alcohol" type="number" className="input" value={f.alcoholRate} onChange={(e) => setF({ ...f, alcoholRate: e.target.value })} />
              </div>
              <div className="col-span-2 help">FMCSA sets the minimum annual rates each year in the Federal Register (50% drug and 10% alcohol recently) — check the current notice. Each driver in the pool has an equal chance every draw; drug and alcohol are picked separately.</div>
            </div>
          )}
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

// ---------- roadside inspections ----------

type V = InspectionForm["violations"][number];
const blankV = (): V => ({ code: "", description: "", basic: "", severity: "", oos: false, unit: "", on: "", removed: false });
export type InspectionRow = { id: string; inspectedAt: string; reportNumber: string | null; country: string; jurisdiction: string | null; level: number; hazmat: boolean; driverId: string | null; truckId: string | null; trailerId: string | null; orderId: string | null; location: string | null; dataQs: string; note: string | null; driverOosUntil?: string | null; repair?: unknown; violations: { code: string; description: string; basic: string | null; severity: number; oos: boolean; unit: string; on?: string; removed?: boolean }[] };

export function InspectionButton({ drivers, trucks, trailers, edit, driverId, label = "+ Log inspection" }: { drivers: Opt[]; trucks: Opt[]; trailers: Opt[]; edit?: InspectionRow; driverId?: string; label?: string }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [removing, setRemoving] = useState(false);
  const init = (): InspectionForm =>
    edit
      ? { inspectedAt: clock.input(edit.inspectedAt), reportNumber: edit.reportNumber ?? "", country: edit.country, jurisdiction: edit.jurisdiction ?? "", level: String(edit.level), hazmat: edit.hazmat, driverId: edit.driverId ?? "", truckId: edit.truckId ?? "", trailerId: edit.trailerId ?? "", orderId: edit.orderId ?? "", location: edit.location ?? "", dataQs: edit.dataQs, note: edit.note ?? "", driverOosUntil: edit.driverOosUntil ? clock.input(edit.driverOosUntil) : "", oosReleaseReason: "", violations: edit.violations.map((v) => ({ ...v, basic: v.basic ?? "", severity: v.severity ? String(v.severity) : "", on: v.on ?? "", removed: !!v.removed })) }
      : { inspectedAt: clock.input(), reportNumber: "", country: "US", jurisdiction: "", level: "1", hazmat: false, driverId: driverId ?? "", truckId: "", trailerId: "", orderId: "", location: "", dataQs: "none", note: "", driverOosUntil: "", violations: [] };
  const [f, setF] = useState<InspectionForm | null>(null);
  const [pending, start] = useTransition();
  const setV = (i: number, patch: Partial<V>) => setF((x) => (x ? { ...x, violations: x.violations.map((v, j) => (j === i ? { ...v, ...patch } : v)) } : x));
  const us = f?.country === "US";
  const isVehicle = (v: V) => (v.unit ? v.unit === "vehicle" : ["vehicle", "hm"].includes(v.basic));
  const driverOos = !!f?.driverId && !!f?.violations.some((v) => v.oos && !v.removed && !isVehicle(v) && (v.code || v.description));
  const vehicleOos = !!(f?.truckId || f?.trailerId) && !!f?.violations.some((v) => v.oos && !v.removed && isVehicle(v) && (v.code || v.description));
  // an out-of-service finding coming off without a repair sign-off: the reason goes on the overrides log (safety N3)
  const heldOos = edit && !edit.repair ? edit.violations.filter((v) => v.oos && !v.removed).length : 0;
  const releasing = !!f && heldOos > 0 && f.violations.filter((v) => v.oos && !v.removed && (v.code || v.description)).length < heldOos;
  const sel = (id: string, l: string, k: "driverId" | "truckId" | "trailerId", opts: Opt[]) => (
    <div>
      <label className="label" htmlFor={id}>
        {l}
      </label>
      <select id={id} className="select" value={f![k]} onChange={(e) => setF({ ...f!, [k]: e.target.value })}>
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <>
      <button className={`btn ${edit ? "btn-sm btn-ghost" : "btn-primary"}`} onClick={() => setF(init())} data-testid={edit ? "edit-inspection" : "log-inspection"}>
        {edit ? "Edit" : label}
      </button>
      {f && (
        <Modal
          open
          onClose={() => setF(null)}
          title={edit ? "Roadside inspection" : "Log a roadside inspection"}
          wide
          footer={
            <>
              {edit && (
                <button
                  className="btn btn-ghost text-red mr-auto"
                  onClick={() =>
                    heldOos
                      ? setRemoving(true)
                      : start(async () => {
                          const r = await deleteInspectionAction(edit.id);
                          if (!r.ok) return t.err(r.error);
                          setF(null);
                          t.ok("Inspection removed");
                          router.refresh();
                        })
                  }
                >
                  Remove
                </button>
              )}
              <button className="btn" onClick={() => setF(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await saveInspectionAction(edit?.id ?? null, { ...f, inspectedAt: clock.iso(f.inspectedAt), driverOosUntil: clock.iso(f.driverOosUntil) });
                    if (!r.ok) return t.err(r.error);
                    setF(null);
                    t.ok(f.violations.length ? "Inspection saved" : "Clean inspection saved");
                    router.refresh();
                  })
                }
              >
                Save
              </button>
            </>
          }
        >
          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-2">
              <label className="label" htmlFor="i-at">
                When ({clock.abbr})
              </label>
              <input id="i-at" type="datetime-local" className="input" value={f.inspectedAt} onChange={(e) => setF({ ...f, inspectedAt: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="i-country">
                Country
              </label>
              <select id="i-country" className="select" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
                <option value="US">US</option>
                <option value="CA">Canada</option>
                <option value="MX">Mexico</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="i-juris">
                {f.country === "CA" ? "Province" : "State"}
              </label>
              <input id="i-juris" className="input" value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} placeholder={f.country === "CA" ? "ON" : f.country === "MX" ? "NL" : "TX"} />
            </div>
            <div>
              <label className="label" htmlFor="i-level">
                CVSA level
              </label>
              <select id="i-level" className="select" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>
                    Level {n}
                    {n === 1 ? " · full" : n === 2 ? " · walk-around" : n === 3 ? " · driver only" : n === 5 ? " · vehicle only" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="i-report">
                Report #
              </label>
              <input id="i-report" className="input" value={f.reportNumber} onChange={(e) => setF({ ...f, reportNumber: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="i-location">
                Location
              </label>
              <input id="i-location" className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="I-35 N scale, Laredo" />
            </div>
            {sel("i-driver", "Driver", "driverId", drivers)}
            {sel("i-truck", "Truck", "truckId", trucks)}
            {sel("i-trailer", "Trailer", "trailerId", trailers)}
            <div>
              <label className="label" htmlFor="i-dataqs">
                DataQs
              </label>
              <select id="i-dataqs" className="select" value={f.dataQs} onChange={(e) => setF({ ...f, dataQs: e.target.value })}>
                <option value="none">Not filed</option>
                <option value="filed">Filed</option>
                <option value="accepted">Accepted</option>
                <option value="denied">Denied</option>
              </select>
            </div>
            <label className="col-span-4 flex items-center gap-2 text-callout cursor-pointer">
              <input type="checkbox" className="accent-teal" checked={f.hazmat} onChange={(e) => setF({ ...f, hazmat: e.target.checked })} /> Hazmat load (counts toward the HM BASIC)
            </label>
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="eyebrow">Violations {f.violations.length ? `· ${f.violations.length}` : "· none = clean"}</div>
              <button className="btn btn-sm" onClick={() => setF({ ...f, violations: [...f.violations, blankV()] })} data-testid="add-violation">
                + Violation
              </button>
            </div>
            {f.violations.map((v, i) => {
              const vehicle = v.unit ? v.unit === "vehicle" : ["vehicle", "hm"].includes(v.basic);
              return (
                <div key={i} className={`grid ${us ? "grid-cols-[110px_1fr_170px_70px_auto_auto_auto_auto]" : "grid-cols-[130px_1fr_120px_auto_auto_auto_auto]"} gap-2 items-center mb-2`} data-testid="violation-row">
                  <input
                    className="input mono"
                    aria-label={`Violation ${i + 1} code`}
                    placeholder={us ? "395.8(e)" : f.country === "CA" ? "NSC / HTA §" : "NOM-068"}
                    value={v.code}
                    onChange={(e) => {
                      // the common US codes fill in their description, BASIC and SMS weight; anything typed wins
                      const k = us ? lookupViolation(e.target.value) : null;
                      setV(i, { code: e.target.value, basic: v.basic || k?.basic || basicOf(e.target.value) || "", description: v.description || k?.description || "", severity: v.severity || (k ? String(k.severity) : "") });
                    }}
                  />
                  <input className="input" aria-label={`Violation ${i + 1} description`} placeholder="What the report says" value={v.description} onChange={(e) => setV(i, { description: e.target.value })} />
                  {us ? (
                    <>
                      <select className="select" aria-label={`Violation ${i + 1} BASIC`} value={v.basic} onChange={(e) => setV(i, { basic: e.target.value })}>
                        <option value="">BASIC…</option>
                        {BASICS.filter((b) => b.key !== "crash").map((b) => (
                          <option key={b.key} value={b.key}>
                            {b.label}
                          </option>
                        ))}
                      </select>
                      <input className="input" type="number" min={1} max={10} aria-label={`Violation ${i + 1} severity`} title="SMS severity weight, 1–10" placeholder="wt" value={v.severity} onChange={(e) => setV(i, { severity: e.target.value })} />
                    </>
                  ) : (
                    <select className="select" aria-label={`Violation ${i + 1} side`} value={v.unit || "driver"} onChange={(e) => setV(i, { unit: e.target.value })}>
                      <option value="driver">Driver</option>
                      <option value="vehicle">Vehicle</option>
                    </select>
                  )}
                  <label className="flex items-center gap-1 text-footnote cursor-pointer" title="Out of service">
                    <input type="checkbox" className="accent-red" checked={v.oos} onChange={(e) => setV(i, { oos: e.target.checked })} /> OOS
                  </label>
                  {v.oos && vehicle && f.truckId && f.trailerId ? (
                    <select className="select text-footnote" aria-label={`Violation ${i + 1} found on`} value={v.on || "truck"} onChange={(e) => setV(i, { on: e.target.value })} title="Which unit the defect is on: that one goes out of service">
                      <option value="truck">on the truck</option>
                      <option value="trailer">on the trailer</option>
                    </select>
                  ) : (
                    <span />
                  )}
                  <label className="flex items-center gap-1 text-footnote cursor-pointer" title="Removed by DataQs or dismissed: leaves the measures">
                    <input type="checkbox" className="accent-teal" checked={v.removed} onChange={(e) => setV(i, { removed: e.target.checked })} /> removed
                  </label>
                  <button className="btn btn-ghost btn-sm text-muted" aria-label="Remove violation" onClick={() => setF({ ...f, violations: f.violations.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              );
            })}
            {driverOos && (
              <div className="rounded-lg border border-red/40 bg-red-soft/30 p-3 my-2 grid grid-cols-[1fr_220px] gap-3 items-end" data-testid="driver-oos">
                <div className="text-callout">
                  <b>The driver is out of service.</b> Until when does the order say? (10 hours off duty for hours of service, 34 hours for the cycle…) The driver can&rsquo;t be dispatched until then — dispatch sees it as a Safety block, not time off they can override.
                </div>
                <div>
                  <label className="label" htmlFor="i-oos-until">
                    Out of service until ({clock.abbr})
                  </label>
                  <input id="i-oos-until" type="datetime-local" className="input" value={f.driverOosUntil} onChange={(e) => setF({ ...f, driverOosUntil: e.target.value })} />
                </div>
              </div>
            )}
            {releasing && (
              <div className="rounded-lg border border-amber/50 bg-amber-soft/40 p-3 my-2" data-testid="oos-release">
                <label className="label" htmlFor="i-oos-release">
                  Why is the out-of-service finding coming off without a repair?
                </label>
                <input id="i-oos-release" className="input" list="oos-release-reasons" value={f.oosReleaseReason ?? ""} onChange={(e) => setF({ ...f, oosReleaseReason: e.target.value })} placeholder="Data entry error — it wasn't OOS on the report" />
                <datalist id="oos-release-reasons">
                  <option value="Data entry error — it wasn't OOS on the report" />
                  <option value="DataQs accepted — violation removed" />
                  <option value="Wrong unit on the inspection" />
                </datalist>
                <div className="help mt-1">The unit goes back in service with no repair sign-off. Your name and this reason go on the overrides log.</div>
              </div>
            )}
            {vehicleOos && <div className="text-callout text-red font-semibold my-2">A vehicle out-of-service order takes the {f.trailerId && !f.truckId ? "trailer" : "unit"} out of service until you sign off the repair on this inspection.</div>}
            <div className="help">{us ? <>Common codes fill in their description, BASIC and SMS weight — check them against your report. Other codes: the BASIC comes from the CFR part (395 = HOS, 393/396 = Vehicle Maintenance…) and the weight from FMCSA&rsquo;s SMS table.</> : <>Canadian and Mexican violations are kept as the report says them — no BASIC, no SMS weight — and stay out of the SMS measures.</>}</div>
          </div>
        </Modal>
      )}
      {edit && (
        <Confirm
          open={removing}
          onClose={() => setRemoving(false)}
          title="Remove this inspection?"
          body="It still holds a unit or driver out of service. Removing it puts them back to work without a repair sign-off."
          needReason="Why (logged by mistake, wrong unit…)"
          confirmLabel="Remove"
          danger
          onConfirm={async (reason) => {
            const r = await deleteInspectionAction(edit.id, reason);
            setRemoving(false);
            if (!r.ok) return t.err(r.error);
            setF(null);
            t.ok("Inspection removed");
            router.refresh();
          }}
        />
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

/** Sign off the repair after a vehicle out-of-service order: what was fixed, by whom, when, and the repair order. */
export function RepairButton({ inspectionId, unit }: { inspectionId: string; unit: string }) {
  const clock = useSafetyClock();
  const router = useRouter();
  const t = useToast();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [name, setName] = useState<string | null>(null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  return (
    <>
      <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)} data-testid="sign-off-repair">
        Sign off repair
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Repair sign-off · ${unit}`}
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setErr(null);
                  const fd = new FormData(form!);
                  // a date and time on the company's clock: a same-day roadside repair is signed off after the inspection
                  fd.set("at", clock.iso(String(fd.get("at") ?? "")));
                  const r = await signOffRepairAction(inspectionId, fd);
                  if (!r.ok) return setErr(r.error);
                  setOpen(false);
                  t.ok(`${unit} is back in service`);
                  router.refresh();
                })
              }
            >
              Back in service
            </button>
          </>
        }
      >
        <form ref={setForm} onSubmit={(e) => e.preventDefault()} className="space-y-3">
          <div>
            <label className="label" htmlFor="rp-note">
              What was repaired, by whom
            </label>
            <textarea id="rp-note" name="note" className="input" rows={3} placeholder="Slack adjusters replaced, brakes adjusted — Laredo Truck Repair, RO 5521" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="rp-at">
                Repaired at ({clock.abbr})
              </label>
              <input id="rp-at" name="at" type="datetime-local" className="input" defaultValue={clock.input()} />
            </div>
            <label className="block border-2 border-dashed border-line rounded-lg p-3 text-center cursor-pointer hover:border-teal self-end">
              <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? null)} />
              <div className="text-callout font-semibold">{name ?? "Attach the repair order"}</div>
            </label>
          </div>
          <div className="help">49 CFR 396.9(d): the out-of-service vehicle moves again only once the repair is done; this sign-off is the record — your name, the time and what was done go on the inspection.</div>
          {err && <div className="error">{err}</div>}
        </form>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
