"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { previewLoadsAction, importLoadsAction } from "../actions";

type Preview = { layout: "per_load" | "per_stop"; loads: { key: string; customer: string; rateCents: number | null; currency: string; stops: { type: string; name: string; city: string | null; state: string | null; country: string; at: string | null }[]; errors: string[] }[] };

const EXAMPLE = [
  "Customer,Rate,PO,Equipment,Pickup Name,Pickup City,Pickup State,Pickup Country,Pickup Date,Pickup Time,Delivery Name,Delivery City,Delivery State,Delivery Country,Delivery Date,Delivery Time,Commodity,Weight",
  "Your customer,1850,PO-123,53 dry,Shipper name,Canton,MI,US,2026-11-02,08:00,Consignee name,Toronto,ON,CA,2026-11-03,06:30,Auto parts,18000",
].join("\n");
const place = (s: Preview["loads"][number]["stops"][number]) => [[s.city, s.state].filter(Boolean).join(", ") || s.name, s.country !== "US" ? s.country : ""].filter(Boolean).join(" · ");

export function ImportLoads() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [book, setBook] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: { key: string; orderNumber: string; orderId: string }[]; skipped: { key: string; errors: string[] }[] } | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const read = (f: File) =>
    start(async () => {
      setErr(null);
      setDone(null);
      setFile(f);
      const fd = new FormData();
      fd.set("file", f);
      const r = await previewLoadsAction(fd);
      if (r.ok) setPreview(r.data as Preview);
      else {
        setPreview(null);
        setErr(r.error);
      }
    });
  const ok = preview?.loads.filter((l) => !l.errors.length).length ?? 0;
  return (
    <div className="space-y-5">
      <div className="card p-6 flex items-center gap-4 flex-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) read(f); }}>
        <div className="flex-1 min-w-[240px]">
          <div className="font-bold">{file ? file.name : "Drop the sheet here or choose it"}</div>
          <div className="text-callout text-muted mt-0.5">
            Headers are matched by name (Customer, Rate, PO, Pickup City, Pickup Date, Delivery Name…).{" "}
            <a className="text-teal font-semibold" href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE)}`} download="loads-example.csv">
              Download an example
            </a>
          </div>
          {err && (
            <div className="error mt-1" role="alert">
              {err}
            </div>
          )}
        </div>
        <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" aria-label="Sheet file" onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ""; }} />
        <button type="button" className="btn" disabled={pending} onClick={() => input.current?.click()}>
          {pending && !preview ? "Reading…" : file ? "Choose another" : "Choose file"}
        </button>
      </div>

      {preview && !done && (
        <div className="card overflow-hidden" data-testid="import-preview">
          <div className="px-5 py-4 flex items-center gap-4 flex-wrap border-b border-line">
            <div className="font-bold">
              {preview.loads.length} load{preview.loads.length === 1 ? "" : "s"} found · <span className="text-green">{ok} ready</span>
              {preview.loads.length - ok ? <span className="text-red"> · {preview.loads.length - ok} with problems (skipped)</span> : null}
            </div>
            <div className="text-callout text-muted">{preview.layout === "per_stop" ? "one row per stop, grouped by load" : "one row per load"}</div>
            <label className="ml-auto flex items-center gap-2 text-callout cursor-pointer">
              <input type="checkbox" className="accent-teal w-4 h-4" checked={book} onChange={(e) => setBook(e.target.checked)} /> Book them (those with a rate)
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || !ok}
              onClick={() =>
                file &&
                start(async () => {
                  const fd = new FormData();
                  fd.set("file", file);
                  fd.set("book", book ? "1" : "0");
                  const r = await importLoadsAction(fd);
                  if (r.ok) setDone(r.data);
                  else setErr(r.error);
                })
              }
            >
              {pending ? "Importing…" : `Import ${ok} load${ok === 1 ? "" : "s"}`}
            </button>
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Customer</th>
                  <th>Lane</th>
                  <th>Pickup</th>
                  <th>Rate</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {preview.loads.map((l) => (
                  <tr key={l.key} data-testid="import-row" className={l.errors.length ? "bg-red-soft/40" : ""}>
                    <td className="mono">{l.key}</td>
                    <td>{l.customer || <span className="text-faint">—</span>}</td>
                    <td className="text-callout">
                      {l.stops.length ? `${place(l.stops[0])} → ${place(l.stops[l.stops.length - 1])}` : "—"}
                      {l.stops.length > 2 ? <span className="text-muted"> · {l.stops.length} stops</span> : null}
                    </td>
                    <td className="text-callout text-muted">{l.stops[0]?.at ? new Date(l.stops[0].at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                    <td className="tabular-nums">{l.rateCents == null ? <span className="text-faint">TBD</span> : new Intl.NumberFormat("en-US", { style: "currency", currency: l.currency }).format(l.rateCents / 100)}</td>
                    <td className="text-callout text-red">{l.errors.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {done && (
        <div className="card p-6" data-testid="import-done">
          <div className="font-bold text-headline">
            {done.created.length} load{done.created.length === 1 ? "" : "s"} created{done.skipped.length ? `, ${done.skipped.length} skipped` : ""}
          </div>
          <div className="text-callout mt-2 flex flex-wrap gap-2">
            {done.created.map((c) => (
              <Link key={c.orderId} href={`/orders/${c.orderId}`} className="mono text-teal font-semibold">
                {c.orderNumber}
              </Link>
            ))}
          </div>
          {done.skipped.length > 0 && (
            <ul className="mt-3 text-callout text-red space-y-1">
              {done.skipped.map((x) => (
                <li key={x.key}>
                  {x.key}: {x.errors.join("; ")}
                </li>
              ))}
            </ul>
          )}
          <Link href="/orders" className="btn mt-4">
            See them on Loads
          </Link>
        </div>
      )}
    </div>
  );
}
