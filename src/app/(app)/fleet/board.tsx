"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Pill, Toast, useToast } from "@/components/ui";
import { truckOosAction, truckActiveAction, saveRecord } from "../settings/actions";
import { LEG_LABEL } from "@/domain/states";
import type { LegState } from "@/db/schema";

type Unit = { id: string; unitNumber: string; equipmentType: string; usPlate: string | null; mxPlate: string | null; mxPlateClass: string | null; status: string; oosReason: string | null; oosUntil: string | null; dotInspectionExpires: string | null; usPlateExpires: string | null; mxPlateExpires: string | null; drivers: { id: string; name: string; driverType: string }[]; loads: { orderId: string; orderNumber: string; state: string; type: string }[] };
type Driver = { id: string; name: string; driverType: string; currentTruckId: string | null };

const soon = (d: string | null) => d && new Date(d).getTime() < Date.now() + 30 * 86400_000;
const expired = (d: string | null) => d && new Date(d).getTime() < Date.now();

export function FleetBoard({ units, drivers }: { units: Unit[]; drivers: Driver[] }) {
  const router = useRouter();
  const t = useToast();
  const [oos, setOos] = useState<Unit | null>(null);
  const [assign, setAssign] = useState<Unit | null>(null);
  const [filter, setFilter] = useState<"all" | "free" | "busy" | "oos">("all");
  const [pending, start] = useTransition();
  const shown = units.filter((u) => (filter === "all" ? true : filter === "oos" ? u.status === "oos" : filter === "busy" ? u.loads.length > 0 && u.status !== "oos" : u.loads.length === 0 && u.status !== "oos"));
  return (
    <>
      <div className="flex gap-1.5 mb-3">
        {(["all", "free", "busy", "oos"] as const).map((k) => (
          <button key={k} className="stage-tab" data-active={filter === k} onClick={() => setFilter(k)}>
            {k === "all" ? "All" : k === "free" ? "Free" : k === "busy" ? "On a load" : "Out of service"}{" "}
            <span className="count">{k === "all" ? units.length : k === "oos" ? units.filter((u) => u.status === "oos").length : k === "busy" ? units.filter((u) => u.loads.length && u.status !== "oos").length : units.filter((u) => !u.loads.length && u.status !== "oos").length}</span>
          </button>
        ))}
      </div>
      <div className="card overflow-hidden">
        {shown.length === 0 ? (
          <div className="py-14 text-center">
            <div className="font-bold">{units.length ? "Nothing here" : "No trucks yet"}</div>
            <div className="text-muted text-[13px] mt-1">{units.length ? "" : "Add a truck: unit number and plates are enough to start."}</div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Plates</th>
                <th>Driver(s)</th>
                <th>Now</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/settings/trucks/${u.id}`} className="font-extrabold mono hover:text-teal">
                      {u.unitNumber}
                    </Link>
                    <div className="text-muted text-[12px] capitalize">{u.equipmentType.replace("_", " ")}</div>
                  </td>
                  <td className="text-[12.5px]">
                    <div>
                      <span className="text-faint">US</span> {u.usPlate ?? "—"} {expired(u.usPlateExpires) ? <Pill tone="red">expired</Pill> : soon(u.usPlateExpires) ? <Pill tone="amber">renew</Pill> : null}
                    </div>
                    <div>
                      <span className="text-faint">MX</span> {u.mxPlate ?? "—"} {u.mxPlateClass && <span className={`inline-block w-2 h-2 rounded-full ${u.mxPlateClass === "blue" ? "bg-blue" : "bg-amber"}`} title={`${u.mxPlateClass} plates`} />} {expired(u.mxPlateExpires) ? <Pill tone="red">expired</Pill> : soon(u.mxPlateExpires) ? <Pill tone="amber">renew</Pill> : null}
                    </div>
                  </td>
                  <td>
                    {u.drivers.length ? (
                      u.drivers.map((d) => (
                        <div key={d.id} className="text-[13px]">
                          <Link href={`/settings/drivers/${d.id}`} className="font-semibold hover:text-teal">
                            {d.name}
                          </Link>{" "}
                          <span className="text-faint">{d.driverType}</span>
                        </div>
                      ))
                    ) : (
                      <span className="text-faint">no driver</span>
                    )}
                    <button className="btn btn-ghost btn-sm -ml-2 mt-0.5 text-teal" onClick={() => setAssign(u)}>
                      {u.drivers.length ? "Change" : "Add driver"}
                    </button>
                  </td>
                  <td className="text-[12.5px]">
                    {u.loads.length ? (
                      u.loads.map((l) => (
                        <div key={l.orderId}>
                          <Link href={`/orders/${l.orderId}`} className="font-semibold mono hover:text-teal">
                            {l.orderNumber}
                          </Link>{" "}
                          <span className="text-muted">{LEG_LABEL[l.state as LegState]}</span>
                        </div>
                      ))
                    ) : (
                      <span className="text-muted">free</span>
                    )}
                  </td>
                  <td>
                    {u.status === "oos" ? (
                      <div>
                        <Pill tone="red">OOS</Pill>
                        <div className="text-[12px] text-muted mt-0.5">{u.oosReason}</div>
                      </div>
                    ) : expired(u.dotInspectionExpires) ? (
                      <Pill tone="amber" title="Annual inspection expired">
                        Inspection due
                      </Pill>
                    ) : (
                      <Pill tone="green">Active</Pill>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {u.status === "oos" ? (
                      <button className="btn btn-sm" disabled={pending} onClick={() => start(async () => { const r = await truckActiveAction(u.id); if (r.ok) { t.ok(`Unit ${u.unitNumber} back in service`); router.refresh(); } else t.err(r.error); })}>
                        Back in service
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-danger" onClick={() => setOos(u)}>
                        Unit OOS
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Confirm
        open={!!oos}
        onClose={() => setOos(null)}
        title={`Put unit ${oos?.unitNumber} out of service`}
        body={oos?.loads.length ? `It is on ${oos.loads.map((l) => l.orderNumber).join(", ")}. Planned and sent legs go back to Pending; a moving leg keeps going with a red flag.` : "It disappears from the assign picker until it's back."}
        needReason="Reason"
        confirmLabel="Unit OOS"
        danger
        onConfirm={async (reason) => {
          const u = oos!;
          setOos(null);
          const r = await truckOosAction(u.id, reason);
          if (r.ok) {
            t.ok(`Unit ${u.unitNumber} out of service${r.data.unplanned.length ? ` · ${r.data.unplanned.length} leg(s) back in Pending` : ""}`);
            router.refresh();
          } else t.err(r.error);
        }}
      />
      {assign && (
        <AssignDriver unit={assign} drivers={drivers} onClose={() => setAssign(null)} onDone={(m) => { setAssign(null); t.ok(m); router.refresh(); }} onErr={t.err} />
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

function AssignDriver({ unit, drivers, onClose, onDone, onErr }: { unit: Unit; drivers: Driver[]; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void }) {
  const [sel, setSel] = useState<string[]>(unit.drivers.map((d) => d.id));
  const [pending, start] = useTransition();
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 2 ? [s[1], id] : [...s, id]));
  return (
    <Modal
      open
      onClose={onClose}
      title={`Drivers on unit ${unit.unitNumber}`}
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
                const was = unit.drivers.map((d) => d.id);
                for (const id of was.filter((x) => !sel.includes(x))) {
                  const r = await saveRecord("driver", id, { currentTruckId: "" });
                  if (!r.ok) return onErr(r.error);
                }
                for (const id of sel.filter((x) => !was.includes(x))) {
                  const r = await saveRecord("driver", id, { currentTruckId: unit.id });
                  if (!r.ok) return onErr(r.error);
                }
                onDone(sel.length ? `${sel.length === 2 ? "Team" : "Driver"} set on unit ${unit.unitNumber}` : `Unit ${unit.unitNumber} has no driver`);
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="text-[13px] text-muted mb-2">Pick one driver, or two for a team. A driver moves off their old unit.</div>
      <div className="max-h-80 overflow-auto -mx-1">
        {drivers.map((d) => {
          const on = sel.includes(d.id);
          return (
            <label key={d.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer ${on ? "bg-teal-soft" : "hover:bg-ground"}`}>
              <input type="checkbox" className="accent-teal" checked={on} onChange={() => toggle(d.id)} />
              <span className="font-semibold">{d.name}</span>
              <span className="text-faint text-[12px]">{d.driverType}</span>
              {d.currentTruckId && d.currentTruckId !== unit.id && <span className="ml-auto text-[12px] text-muted">on another unit</span>}
            </label>
          );
        })}
        {drivers.length === 0 && (
          <div className="text-muted text-[13px] px-3 py-4">
            No drivers yet.{" "}
            <Link href="/settings/drivers?add=1" className="text-teal font-semibold">
              Add one
            </Link>
          </div>
        )}
      </div>
    </Modal>
  );
}
