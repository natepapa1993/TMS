"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { respondTenderAction } from "../../actions";

export function TenderForm({ token, carrierName }: { token: string; carrierName: string }) {
  const [mode, setMode] = useState<"pick" | "accept" | "decline">("pick");
  const [f, setF] = useState({ name: "", driverName: "", driverPhone: "", unitNumber: "", trailerNumber: "", note: "" });
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const submit = (accept: boolean) =>
    start(async () => {
      setErr(null);
      const r = await respondTenderAction(token, { accept, ...f });
      if (r.ok) router.refresh();
      else setErr({ field: r.field, message: r.error });
    });
  if (mode === "pick")
    return (
      <div>
        <div className="h2">{carrierName}, can you cover this?</div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button className="btn btn-primary btn-lg justify-center" onClick={() => setMode("accept")}>
            Yes, accept
          </button>
          <button className="btn btn-lg justify-center" onClick={() => setMode("decline")}>
            No, decline
          </button>
        </div>
      </div>
    );
  return (
    <div className="space-y-3">
      <div className="h2">{mode === "accept" ? "Accept — who's driving?" : "Decline — why?"}</div>
      <div>
        <label className="label">Your name</label>
        <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} aria-invalid={err?.field === "name"} autoFocus />
      </div>
      {mode === "accept" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Driver name</label>
              <input className="input" value={f.driverName} onChange={(e) => set("driverName", e.target.value)} aria-invalid={err?.field === "driverName"} />
            </div>
            <div>
              <label className="label">Driver phone</label>
              <input className="input" type="tel" value={f.driverPhone} onChange={(e) => set("driverPhone", e.target.value)} />
            </div>
            <div>
              <label className="label">Unit #</label>
              <input className="input" value={f.unitNumber} onChange={(e) => set("unitNumber", e.target.value)} />
            </div>
            <div>
              <label className="label">Trailer #</label>
              <input className="input" value={f.trailerNumber} onChange={(e) => set("trailerNumber", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Note (optional)</label>
            <input className="input" value={f.note} onChange={(e) => set("note", e.target.value)} />
          </div>
        </>
      ) : (
        <div>
          <label className="label">Reason</label>
          <input className="input" value={f.note} onChange={(e) => set("note", e.target.value)} aria-invalid={err?.field === "note"} placeholder="no trucks until Tuesday" />
        </div>
      )}
      {err && (
        <div className="error" role="alert">
          {err.message}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button className="btn" onClick={() => setMode("pick")} disabled={pending}>
          Back
        </button>
        <button className={`btn btn-lg flex-1 justify-center ${mode === "accept" ? "btn-primary" : "btn-danger"}`} onClick={() => submit(mode === "accept")} disabled={pending}>
          {pending ? "Sending…" : mode === "accept" ? "Confirm — we'll take it" : "Confirm decline"}
        </button>
      </div>
    </div>
  );
}
