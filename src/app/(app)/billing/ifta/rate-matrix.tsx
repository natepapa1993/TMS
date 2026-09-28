"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui";
import { previewRateMatrixAction, importRateMatrixAction } from "./actions";

type Preview = { quarter: string; column: string; rows: { jurisdiction: string; rate: number; surcharge: number | null; currentRate: number | null; currentSurcharge: number | null; change: "new" | "changed" | "same" }[]; skipped: { line: number; text: string; reason: string }[]; warnings: string[]; missing: string[] };

const r4 = (n: number | null) => (n == null ? "—" : n.toFixed(4));

/** Owner #21: import the quarter's IFTA tax rate matrix (the CSV IFTA, Inc. publishes), with a preview first. */
export function RateMatrixImport({ quarter, onDone }: { quarter: string; onDone: (msg: string) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fd = () => {
    const f = new FormData();
    f.set("file", file!);
    return f;
  };
  const close = () => {
    setPreview(null);
    setFile(null);
    setErr(null);
    if (input.current) input.current.value = "";
  };
  const changed = preview?.rows.filter((r) => r.change !== "same").length ?? 0;
  return (
    <>
      <label className="btn btn-sm cursor-pointer" data-testid="ifta-matrix-import">
        Import rate matrix (CSV)…
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFile(f);
            setErr(null);
            start(async () => {
              const form = new FormData();
              form.set("file", f);
              const r = await previewRateMatrixAction(quarter, form);
              if (r.ok) setPreview(r.data as Preview);
              else {
                setErr(r.error);
                setPreview({ quarter, column: "", rows: [], skipped: [], warnings: [], missing: [] });
              }
            });
          }}
        />
      </label>
      <Modal
        open={!!preview}
        onClose={close}
        wide
        title={`IFTA rates for ${quarter.replace("Q", " Q")} from ${file?.name ?? "the matrix"}`}
        footer={
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !preview?.rows.length}
              onClick={() =>
                start(async () => {
                  const r = await importRateMatrixAction(quarter, fd());
                  if (r.ok) {
                    close();
                    onDone(`${r.data.saved} rate(s) saved from the matrix${r.data.changed ? ` · ${r.data.changed} changed` : ""}`);
                    router.refresh();
                  } else setErr(r.error);
                })
              }
            >
              {pending ? "Saving…" : `Save ${preview?.rows.length ?? 0} rates`}
            </button>
          </>
        }
      >
        {err && (
          <div className="error mb-3" role="alert">
            {err}
          </div>
        )}
        {preview && preview.rows.length > 0 && (
          <div className="space-y-3" data-testid="ifta-matrix-preview">
            <p className="text-callout text-muted">
              {preview.rows.length} jurisdictions from the <b>{preview.column}</b> column, in US $ per gallon. {changed ? `${changed} differ from what's on file for this quarter.` : "Same as what's on file."} Nothing is saved until you press Save.
            </p>
            {preview.warnings.map((w) => (
              <div key={w} className="text-footnote text-amber">
                {w}
              </div>
            ))}
            <div className="max-h-[50vh] overflow-auto border border-line rounded-lg">
              <table className="table">
                <thead>
                  <tr>
                    <th>Jurisdiction</th>
                    <th className="text-right">Now</th>
                    <th className="text-right">From the matrix</th>
                    <th className="text-right">Surcharge</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.jurisdiction}>
                      <td className="font-semibold">{r.jurisdiction}</td>
                      <td className="text-right mono text-muted">{r4(r.currentRate)}</td>
                      <td className={`text-right mono ${r.change === "changed" ? "font-bold text-amber" : r.change === "new" ? "font-semibold" : ""}`}>{r4(r.rate)}</td>
                      <td className="text-right mono">{r.surcharge != null ? r4(r.surcharge) : ""}</td>
                      <td className="text-footnote text-muted">{r.change === "new" ? "new" : r.change === "changed" ? "changed" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.missing.length > 0 && <div className="text-footnote text-muted">Not in the file (kept as they are): {preview.missing.join(", ")}</div>}
            {preview.skipped.length > 0 && (
              <details className="text-footnote">
                <summary className="cursor-pointer text-muted">{preview.skipped.length} line(s) skipped</summary>
                <ul className="mt-1 space-y-0.5">
                  {preview.skipped.map((x, i) => (
                    <li key={i}>
                      {x.line ? `Line ${x.line}: ` : ""}
                      {x.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
