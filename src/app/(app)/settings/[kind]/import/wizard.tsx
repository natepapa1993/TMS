"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecordKind } from "@/data/records";
import type { ImportPreview } from "@/data/import";
import { previewImportAction, commitImportAction } from "../../actions";
import { Pill } from "@/components/ui";

export function ImportWizard({ kind, fields, template, listPath }: { kind: RecordKind; fields: { name: string; label: string; required: boolean }[]; template: string; listPath: string }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("pasted.csv");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState<{ inserted: number; updated: number; errors: { row: number; message: string }[] } | null>(null);
  const router = useRouter();

  const run = (mapping?: Record<string, string>) =>
    start(async () => {
      setError(null);
      const r = await previewImportAction(kind, text, mapping);
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    });

  if (done)
    return (
      <div className="card p-6 max-w-2xl">
        <div className="h2">Import finished</div>
        <div className="mt-2 text-[14px]">
          <span className="font-bold text-teal">{done.inserted} added</span>, <span className="font-bold">{done.updated} updated</span>, <span className={`font-bold ${done.errors.length ? "text-amber" : ""}`}>{done.errors.length} skipped</span>.
        </div>
        {done.errors.length > 0 && (
          <ul className="mt-3 text-[13px] text-muted space-y-1 max-h-60 overflow-auto">
            {done.errors.map((e) => (
              <li key={e.row}>
                Row {e.row}: {e.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex gap-2">
          <button className="btn btn-primary" onClick={() => router.push(listPath)}>
            Open the list
          </button>
          <button
            className="btn"
            onClick={() => {
              setDone(null);
              setPreview(null);
              setText("");
            }}
          >
            Import another file
          </button>
        </div>
      </div>
    );

  return (
    <div className="grid lg:grid-cols-[1fr_300px] gap-5 items-start [&>*]:min-w-0">
      <div className="space-y-4">
        {!preview ? (
          <div className="card p-5">
            <div className="flex items-center justify-between mb-2">
              <label className="label m-0">CSV</label>
              <label className="btn btn-sm cursor-pointer">
                Upload file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setFileName(f.name);
                    setText(await f.text());
                  }}
                />
              </label>
            </div>
            <textarea className="textarea font-mono text-[12.5px]" style={{ minHeight: 240 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Unit #,US plate,MX plate,MX plate class\n2117,RC59022,35ES3A,brown"} />
            {error && <div className="error">{error}</div>}
            <div className="mt-3 flex justify-end">
              <button className="btn btn-primary" disabled={!text.trim() || pending} onClick={() => run()}>
                {pending ? "Reading…" : "Preview"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <div className="h2">Columns</div>
                <button className="btn btn-sm" onClick={() => setPreview(null)}>
                  ← Back to file
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-3">
                {preview.headers.map((h) => (
                  <div key={h} className="flex items-center gap-2 text-[13px]">
                    <span className="w-40 truncate font-semibold" title={h}>
                      {h}
                    </span>
                    <span className="text-faint">→</span>
                    <select
                      className="select h-8 text-[13px]"
                      value={preview.mapping[h] ?? ""}
                      onChange={(e) => {
                        const mapping = { ...preview.mapping, [h]: e.target.value };
                        run(mapping);
                      }}
                    >
                      <option value="">Ignore</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label}
                          {f.required ? " *" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-line flex items-center gap-3 text-[13px]">
                <span className="font-bold">{preview.summary.total} rows</span>
                <Pill tone="teal">{preview.summary.insert} new</Pill>
                <Pill tone="blue">{preview.summary.update} update existing</Pill>
                <Pill tone={preview.summary.skip ? "amber" : "slate"}>{preview.summary.skip} skipped</Pill>
                <span className="ml-auto text-muted">Rows matching an existing unique key update it; blanks never wipe data.</span>
              </div>
              <div className="max-h-[420px] overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Record</th>
                      <th>Action</th>
                      <th>Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row}>
                        <td className="text-muted mono">{r.row}</td>
                        <td className="font-semibold">{r.label}</td>
                        <td>{r.action === "insert" ? <Pill tone="teal">Add</Pill> : r.action === "update" ? <Pill tone="blue">Update</Pill> : <Pill tone="amber">Skip</Pill>}</td>
                        <td className="text-[12.5px] text-red">{Object.values(r.errors).join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-line flex justify-end gap-2">
                <button
                  className="btn btn-primary"
                  disabled={pending || preview.summary.insert + preview.summary.update === 0}
                  onClick={() =>
                    start(async () => {
                      const r = await commitImportAction(kind, fileName, text, preview.mapping);
                      if (r.ok) setDone(r.data);
                      else setError(r.error);
                    })
                  }
                >
                  {pending ? "Writing…" : `Import ${preview.summary.insert + preview.summary.update} rows`}
                </button>
              </div>
              {error && <div className="px-5 pb-3 error">{error}</div>}
            </div>
          </>
        )}
      </div>
      <aside className="card p-4 text-[13px] space-y-3">
        <div className="font-extrabold">Template</div>
        <p className="text-muted">Headers we recognise, with one example row. Extra columns are ignored; columns can be in any order.</p>
        <a className="btn btn-sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`} download={`${kind}-template.csv`}>
          Download template
        </a>
        <div className="font-extrabold pt-2">Columns</div>
        <ul className="text-muted space-y-0.5 max-h-72 overflow-auto">
          {fields.map((f) => (
            <li key={f.name}>
              {f.label}
              {f.required && <span className="text-red"> *</span>}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
