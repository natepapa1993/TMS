"use client";

import { useState, useTransition } from "react";
import { overrideApprovalSettingAction } from "../../today/actions";

/** Company setting (owner #18): a dispatcher's override takes effect at once (reviewed on Today), or waits for the owner. */
export function OverrideApprovalSetting({ on, canEdit }: { on: boolean; canEdit: boolean }) {
  const [v, setV] = useState(on);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="card p-5 mt-6" data-testid="override-approval-card">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="accent-teal mt-1"
          checked={v}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.checked;
            start(async () => {
              const r = await overrideApprovalSettingAction(next);
              if (r.ok) {
                setV(next);
                setErr(null);
              } else setErr(r.error);
            });
          }}
        />
        <span>
          <span className="font-bold text-body block">Overrides need the owner&apos;s approval first</span>
          <span className="text-callout text-muted">
            Off: when a dispatcher overrides a schedule, paperwork, rate-con or crossing block, it takes effect at once and waits on your Today page for review. On: it is only a request until you approve it there.
          </span>
        </span>
      </label>
      {err && <div className="error mt-2">{err}</div>}
    </div>
  );
}
