"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveIntegrationAction, testMotiveAction, testWhatsAppAction, pollMailboxNowAction } from "./actions";
import { Pill, Toast, useToast } from "@/components/ui";

type Field = { key: string; label: string; secret: boolean; set: boolean; value?: string; placeholder?: string };

export function IntegrationCard({ provider, title, blurb, enabled, fields, status, testable, extra }: { provider: "motive" | "resend" | "whatsapp" | "extractor" | "mailbox"; title: string; blurb: string; enabled: boolean; fields: Field[]; status: { lastRunAt: string | null; lastError: string | null; lastResult: string | null } | null; testable?: boolean; extra?: React.ReactNode }) {
  const zone = useZone();
  const router = useRouter();
  const t = useToast();
  const [on, setOn] = useState(enabled);
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.secret ? "" : (f.value ?? "")])));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="h2 flex items-center gap-2">
            {title} {enabled ? <Pill tone="green">On</Pill> : <Pill tone="slate">Off</Pill>}
          </div>
          <p className="text-muted text-callout mt-0.5 max-w-xl">{blurb}</p>
        </div>
        <label className="flex items-center gap-2 text-callout cursor-pointer whitespace-nowrap">
          <input type="checkbox" className="accent-teal w-4 h-4" checked={on} onChange={(e) => setOn(e.target.checked)} /> Enabled
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="label">
              {f.label} {f.secret && f.set && <span className="text-green">· on file</span>}
            </label>
            <input className="input" type={f.secret ? "password" : "text"} autoComplete="off" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} placeholder={f.secret ? (f.set ? "leave blank to keep" : "paste key") : f.placeholder} />
          </div>
        ))}
      </div>
      {status && (
        <div className="mt-3 text-callout text-muted">
          {status.lastRunAt ? `Last run ${fmtWhen(status.lastRunAt, zone, { style: "short" })}` : "Never run"}
          {status.lastResult ? ` · ${status.lastResult}` : ""}
          {status.lastError ? <span className="text-red"> · {status.lastError}</span> : null}
        </div>
      )}
      {extra}
      {result && <div className="mt-2 text-callout font-semibold text-teal">{result}</div>}
      <div className="flex justify-end gap-2 mt-4">
        {provider === "whatsapp" && (
          <>
            <input className="input w-48" placeholder="+1 313 555 0100" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test number" />
            <button className="btn" disabled={pending || !testTo.trim()} onClick={() => start(async () => { const r = await testWhatsAppAction(testTo); if (r.ok) setResult(`Sent · message id ${r.data.id}`); else t.err(r.error); router.refresh(); })}>
              Send test
            </button>
          </>
        )}
        {provider === "mailbox" && (
          <button
            className="btn"
            disabled={pending}
            data-testid="poll-mail"
            onClick={() =>
              start(async () => {
                const r = await pollMailboxNowAction();
                if (r.ok) setResult(`Pulled the mailbox · ${r.data.received} new, ${r.data.duplicates} already seen`);
                else t.err(r.error);
                router.refresh();
              })
            }
          >
            Pull now
          </button>
        )}
        {testable && (
          <button
            className="btn"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await testMotiveAction();
                if (r.ok) setResult(`Pulled ${r.data.vehicles} vehicles · ${r.data.recorded} new positions · ${r.data.unmatched} not matched to a unit`);
                else t.err(r.error);
                router.refresh();
              })
            }
          >
            Pull now
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveIntegrationAction(provider, on, vals);
              if (r.ok) {
                t.ok("Saved");
                setVals((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fields.find((f) => f.key === k)?.secret ? "" : x])));
                router.refresh();
              } else t.err(r.error);
            })
          }
        >
          Save
        </button>
      </div>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
