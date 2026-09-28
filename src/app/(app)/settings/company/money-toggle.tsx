"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Toast, useToast } from "@/components/ui";
import { setHideMoneyAction } from "./money-actions";

/** The owner's switch: dispatchers work loads without seeing the customer's rate or the margin. */
export function HideMoneyToggle({ initial, canEdit }: { initial: boolean; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <div className="card p-5" data-testid="hide-money">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="accent-teal mt-1"
          checked={on}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.checked;
            start(async () => {
              const r = await setHideMoneyAction(next);
              if (!r.ok) return t.err(r.error);
              setOn(next);
              t.ok(next ? "Dispatchers no longer see rates and margins" : "Dispatchers see rates and margins again");
              router.refresh();
            });
          }}
        />
        <span>
          <span className="font-extrabold block">Hide money from dispatchers</span>
          <span className="text-muted text-callout">The customer&rsquo;s rate, rate per mile and margin disappear from the dispatch board, the planner and the load page for dispatcher logins. Carrier rates stay — they tender at the rate they agree. Owner, billing and Safety are not affected.</span>
        </span>
      </label>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
