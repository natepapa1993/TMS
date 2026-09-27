"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import { saveIncidentAction } from "../actions";

type Inc = { id: string; occurredAt: string; kind: string; driverId: string | null; truckId: string | null; trailerId: string | null; location: string | null; description: string; dotRecordable: boolean; injuries: boolean; towAway: boolean; policeReport: string | null; claimNumber: string | null; status: string };
type Opt = { id: string; name: string };
const KINDS = [["accident", "Accident"], ["injury", "Injury"], ["cargo", "Cargo claim"], ["roadside_inspection", "Roadside inspection"], ["citation", "Citation"], ["near_miss", "Near miss"], ["other", "Other"]];
const blank = () => ({ occurredAt: new Date().toISOString().slice(0, 16), kind: "accident", driverId: "", truckId: "", trailerId: "", location: "", description: "", dotRecordable: false, injuries: false, towAway: false, policeReport: "", claimNumber: "", status: "open" });

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
                <tr key={r.id} className="cursor-pointer" onClick={() => canEdit && setEdit({ id: r.id, f: { ...blank(), ...r, occurredAt: new Date(r.occurredAt).toISOString().slice(0, 16), driverId: r.driverId ?? "", truckId: r.truckId ?? "", trailerId: r.trailerId ?? "", location: r.location ?? "", policeReport: r.policeReport ?? "", claimNumber: r.claimNumber ?? "" } })}>
                  <td className="whitespace-nowrap">{new Date(r.occurredAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td className="capitalize">{r.kind.replace("_", " ")}</td>
                  <td>
                    {name(drivers, r.driverId)} {r.truckId ? `· ${name(trucks, r.truckId)}` : ""}
                  </td>
                  <td className="max-w-md truncate" title={r.description}>
                    {r.description}
                    {r.location ? <span className="text-muted"> — {r.location}</span> : null}
                  </td>
                  <td className="space-x-1">
                    {r.dotRecordable && <Pill tone="red">DOT</Pill>}
                    {r.injuries && <Pill tone="red">injury</Pill>}
                    {r.towAway && <Pill tone="amber">tow</Pill>}
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
                    const r = await saveIncidentAction(edit.id, edit.f);
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
            <div className="col-span-3 flex gap-5 text-[13px]">
              {(
                [
                  ["dotRecordable", "DOT recordable"],
                  ["injuries", "Injuries"],
                  ["towAway", "Tow-away"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="accent-teal" checked={edit.f[k]} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, [k]: e.target.checked } })} /> {l}
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
