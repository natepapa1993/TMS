"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { saveIncidentAction } from "../actions";

type Inc = { id: string; occurredAt: string; kind: string; driverId: string | null; truckId: string | null; trailerId: string | null; location: string | null; description: string; dotRecordable: boolean; injuries: boolean; towAway: boolean; fatality: boolean; citation: boolean; preventable: string | null; policeReport: string | null; claimNumber: string | null; status: string; postAccident: { alcoholBy: string; drugBy: string; why: string } | null; tests: { alcohol: boolean; drug: boolean } | null };
type Opt = { id: string; name: string };
const KINDS = [["accident", "Accident"], ["injury", "Injury"], ["cargo", "Cargo claim"], ["roadside_inspection", "Roadside inspection (log it under Inspections)"], ["citation", "Citation"], ["near_miss", "Near miss"], ["other", "Other"]];
/** An instant as the value of a datetime-local input, in the viewer's own clock (the input has no zone). */
const toLocalInput = (iso: string | Date) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const blank = () => ({ occurredAt: toLocalInput(new Date()), kind: "accident", driverId: "", truckId: "", trailerId: "", location: "", description: "", dotRecordable: false, injuries: false, towAway: false, fatality: false, citation: false, preventable: "", policeReport: "", claimNumber: "", status: "open" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function IncidentsBoard({ rows, drivers, trucks, trailers, role }: { rows: Inc[]; drivers: Opt[]; trucks: Opt[]; trailers: Opt[]; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [edit, setEdit] = useState<{ id: string | null; f: ReturnType<typeof blank> } | null>(null);
  const [pending, start] = useTransition();
  const canEdit = ["owner", "compliance"].includes(role);
  const name = (o: Opt[], id: string | null) => o.find((x) => x.id === id)?.name ?? "";
  return (
    <>
      <div className="flex justify-end mb-3">
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setEdit({ id: null, f: blank() })}>
            + Log incident
          </button>
        )}
      </div>
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center">
            <div className="font-bold">No incidents logged</div>
            <div className="text-muted text-[13px] mt-1">Good. When something happens, log it here the same day.</div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Driver · unit</th>
                <th>What happened</th>
                <th>Flags</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => canEdit && setEdit({ id: r.id, f: { ...blank(), occurredAt: toLocalInput(r.occurredAt), kind: r.kind, driverId: r.driverId ?? "", truckId: r.truckId ?? "", trailerId: r.trailerId ?? "", location: r.location ?? "", description: r.description, dotRecordable: r.dotRecordable, injuries: r.injuries, towAway: r.towAway, fatality: r.fatality, citation: r.citation, preventable: r.preventable ?? "", policeReport: r.policeReport ?? "", claimNumber: r.claimNumber ?? "", status: r.status } })}>
                  <td className="whitespace-nowrap">{new Date(r.occurredAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td className="capitalize">{r.kind.replace("_", " ")}</td>
                  <td>
                    {name(drivers, r.driverId)} {r.truckId ? `· ${name(trucks, r.truckId)}` : ""}
                  </td>
                  <td className="max-w-md" title={r.description}>
                    <div className="truncate">
                      {r.description}
                      {r.location ? <span className="text-muted"> — {r.location}</span> : null}
                    </div>
                    {r.postAccident && (
                      <div className="text-[12px] text-amber mt-0.5" data-testid="post-accident">
                        Post-accident testing ({r.postAccident.why}): alcohol by {when(r.postAccident.alcoholBy)}, drug by {when(r.postAccident.drugBy)}
                        {r.tests && ` · ${r.tests.alcohol ? "alcohol ✓" : "alcohol not recorded"}, ${r.tests.drug ? "drug ✓" : "drug not recorded"}`}
                      </div>
                    )}
                  </td>
                  <td className="space-x-1 whitespace-nowrap">
                    {r.dotRecordable && <Pill tone="red">DOT</Pill>}
                    {r.fatality && <Pill tone="red">fatality</Pill>}
                    {r.injuries && <Pill tone="red">injury</Pill>}
                    {r.towAway && <Pill tone="amber">tow</Pill>}
                    {r.citation && <Pill tone="amber">cited</Pill>}
                    {r.preventable === "not_preventable" && <Pill tone="slate">not preventable</Pill>}
                  </td>
                  <td>
                    <Pill tone={r.status === "closed" ? "slate" : r.status === "under_review" ? "amber" : "teal"}>{r.status.replace("_", " ")}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          title={edit.id ? "Incident" : "Log incident"}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await saveIncidentAction(edit.id, { ...edit.f, occurredAt: new Date(edit.f.occurredAt).toISOString() });
                    if (r.ok) {
                      setEdit(null);
                      t.ok("Saved");
                      router.refresh();
                    } else t.err(r.error);
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
              <label className="label">When</label>
              <input type="datetime-local" className="input" value={edit.f.occurredAt} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, occurredAt: e.target.value } })} />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="select" value={edit.f.kind} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, kind: e.target.value } })}>
                {KINDS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={edit.f.status} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, status: e.target.value } })}>
                <option value="open">Open</option>
                <option value="under_review">Under review</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            {(
              [
                ["driverId", "Driver", drivers],
                ["truckId", "Truck", trucks],
                ["trailerId", "Trailer", trailers],
              ] as const
            ).map(([k, l, opts]) => (
              <div key={k}>
                <label className="label">{l}</label>
                <select className="select" value={edit.f[k]} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, [k]: e.target.value } })}>
                  <option value="">—</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="col-span-3">
              <label className="label">What happened</label>
              <textarea className="textarea" value={edit.f.description} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, description: e.target.value } })} />
            </div>
            <div>
              <label className="label">Location</label>
              <input className="input" value={edit.f.location} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, location: e.target.value } })} />
            </div>
            <div>
              <label className="label">Police report #</label>
              <input className="input" value={edit.f.policeReport} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, policeReport: e.target.value } })} />
            </div>
            <div>
              <label className="label">Claim #</label>
              <input className="input" value={edit.f.claimNumber} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, claimNumber: e.target.value } })} />
            </div>
            {edit.f.kind === "accident" && (
              <div>
                <label className="label" htmlFor="inc-prev">
                  Preventable?
                </label>
                <select id="inc-prev" className="select" value={edit.f.preventable} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, preventable: e.target.value } })}>
                  <option value="">Not decided</option>
                  <option value="preventable">Preventable</option>
                  <option value="not_preventable">Not preventable (FMCSA CPDP)</option>
                </select>
              </div>
            )}
            <div className="col-span-3 flex gap-5 flex-wrap text-[13px]">
              {(
                [
                  ["dotRecordable", "DOT recordable"],
                  ["fatality", "Fatality"],
                  ["injuries", "Injury treated away from the scene"],
                  ["towAway", "Tow-away"],
                  ["citation", "Driver cited"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="accent-teal" checked={edit.f[k]} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, [k]: e.target.checked } })} /> {l}
                </label>
              ))}
            </div>
          </div>
          {edit.f.kind === "accident" && (edit.f.fatality || (edit.f.citation && (edit.f.injuries || edit.f.towAway))) && <div className="help mt-3 text-amber">Post-accident testing is required (382.303): alcohol within 8 hours, drugs within 32. Record the tests under Drug & alcohol against this accident.</div>}
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
