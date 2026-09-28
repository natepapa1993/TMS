"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { respondTenderAction, counterTenderAction } from "../../actions";
import { TENDER_COPY, type Lang } from "@/lib/tender-copy";

export function TenderForm({ token, carrierName, lang = "en", askTrailer = true, currency = "USD" }: { token: string; carrierName: string; lang?: Lang; askTrailer?: boolean; currency?: string }) {
  const c = TENDER_COPY[lang];
  const [mode, setMode] = useState<"pick" | "accept" | "decline" | "counter">("pick");
  const [f, setF] = useState({ name: "", driverName: "", driverPhone: "", unitNumber: "", unitPlate: "", trailerNumber: "", note: "", rate: "" });
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
  const counter = () =>
    start(async () => {
      setErr(null);
      const r = await counterTenderAction(token, { name: f.name, rate: f.rate, note: f.note });
      if (r.ok) {
        setMode("pick");
        router.refresh();
      } else setErr({ field: r.field, message: r.error });
    });
  if (mode === "pick")
    return (
      <div>
        <div className="h2">{c.canYou(carrierName)}</div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button className="btn btn-primary btn-lg justify-center" onClick={() => setMode("accept")}>
            {c.yes}
          </button>
          <button className="btn btn-lg justify-center" onClick={() => setMode("decline")}>
            {c.no}
          </button>
        </div>
        <button className="btn w-full justify-center mt-2" onClick={() => setMode("counter")} data-testid="counter-open">
          {c.counter}
        </button>
      </div>
    );
  if (mode === "counter")
    return (
      <div className="space-y-3" data-testid="counter-form">
        <div className="h2">{c.counterTitle}</div>
        <div>
          <label className="label" htmlFor="t-name">
            {c.yourName}
          </label>
          <input id="t-name" className="input" value={f.name} onChange={(e) => set("name", e.target.value)} aria-invalid={err?.field === "name"} autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="t-rate">
            {c.yourRate(currency)}
          </label>
          <input id="t-rate" className="input" inputMode="decimal" value={f.rate} onChange={(e) => set("rate", e.target.value)} aria-invalid={err?.field === "rate"} />
        </div>
        <div>
          <label className="label" htmlFor="t-note">
            {c.note}
          </label>
          <input id="t-note" className="input" value={f.note} onChange={(e) => set("note", e.target.value)} />
        </div>
        {err && (
          <div className="error" role="alert">
            {err.message}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button className="btn" onClick={() => setMode("pick")} disabled={pending}>
            {c.back}
          </button>
          <button className="btn btn-primary btn-lg flex-1 justify-center" onClick={counter} disabled={pending}>
            {pending ? c.sending : c.sendCounter}
          </button>
        </div>
      </div>
    );
  return (
    <div className="space-y-3">
      <div className="h2">{mode === "accept" ? c.whoDrives : c.why}</div>
      <div>
        <label className="label" htmlFor="t-name">
          {c.yourName}
        </label>
        <input id="t-name" className="input" value={f.name} onChange={(e) => set("name", e.target.value)} aria-invalid={err?.field === "name"} autoFocus />
      </div>
      {mode === "accept" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="t-driver">
                {c.driverName}
              </label>
              <input id="t-driver" className="input" value={f.driverName} onChange={(e) => set("driverName", e.target.value)} aria-invalid={err?.field === "driverName"} />
            </div>
            <div>
              <label className="label" htmlFor="t-phone">
                {c.driverPhone}
              </label>
              <input id="t-phone" className="input" type="tel" value={f.driverPhone} onChange={(e) => set("driverPhone", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="t-unit">
                {c.unit}
              </label>
              <input id="t-unit" className="input" value={f.unitNumber} onChange={(e) => set("unitNumber", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="t-plates">
                {c.plates}
              </label>
              <input id="t-plates" className="input mono" value={f.unitPlate} onChange={(e) => set("unitPlate", e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="t-trailer">
                {c.trailer}
              </label>
              <input id="t-trailer" className="input mono" value={f.trailerNumber} onChange={(e) => set("trailerNumber", e.target.value)} />
              {askTrailer && <div className="help">{c.trailerHelp}</div>}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="t-note">
              {c.note}
            </label>
            <input id="t-note" className="input" value={f.note} onChange={(e) => set("note", e.target.value)} />
          </div>
        </>
      ) : (
        <div>
          <label className="label" htmlFor="t-reason">
            {c.reason}
          </label>
          <input id="t-reason" className="input" value={f.note} onChange={(e) => set("note", e.target.value)} aria-invalid={err?.field === "note"} placeholder={c.reasonPh} />
        </div>
      )}
      {err && (
        <div className="error" role="alert">
          {err.message}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button className="btn" onClick={() => setMode("pick")} disabled={pending}>
          {c.back}
        </button>
        <button className={`btn btn-lg flex-1 justify-center ${mode === "accept" ? "btn-primary" : "btn-danger"}`} onClick={() => submit(mode === "accept")} disabled={pending}>
          {pending ? c.sending : mode === "accept" ? c.confirmAccept : c.confirmDecline}
        </button>
      </div>
    </div>
  );
}
