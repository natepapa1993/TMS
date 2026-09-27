"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCompanyAction } from "../actions";
import { Toast, useToast } from "@/components/ui";

const ZONES = ["America/Detroit", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Monterrey", "America/Mexico_City", "America/Matamoros", "America/Ciudad_Juarez", "America/Tijuana"];

export function CompanyForm({ initial, canEdit }: { initial: { name: string; timeZone: string; fuelCostPerMile: string; closedThrough: string | null }; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ name: initial.name, timeZone: initial.timeZone, fuelCostPerMile: initial.fuelCostPerMile });
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="card p-5">
      <fieldset disabled={!canEdit} className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="c-name">
            Company name
          </label>
          <input id="c-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={err?.field === "name"} />
        </div>
        <div>
          <label className="label" htmlFor="c-tz">
            Time zone
          </label>
          <input id="c-tz" className="input" list="tz-list" value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} aria-invalid={err?.field === "timeZone"} />
          <datalist id="tz-list">
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <div className="help">Digests, today on the boards and month-end close use this.</div>
        </div>
        <div>
          <label className="label" htmlFor="c-fuel">
            Fuel cost per mile
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
            <input id="c-fuel" className="input pl-7" inputMode="decimal" value={f.fuelCostPerMile} onChange={(e) => setF({ ...f, fuelCostPerMile: e.target.value })} aria-invalid={err?.field === "fuelCostPerMile"} />
          </div>
          <div className="help">Estimated fuel in the order P&amp;L for legs on our trucks · blank = $0.65</div>
        </div>
        <div className="col-span-2 text-[13px] text-muted">
          Books closed through: <b className="text-ink">{initial.closedThrough ?? "not closed yet"}</b> — set from Billing → Invoices → Close period.
        </div>
      </fieldset>
      {canEdit && (
        <div className="flex items-center justify-end gap-3 mt-4">
          {err && <span className="error m-0">{err.message}</span>}
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await saveCompanyAction(f);
                if (r.ok) {
                  t.ok("Saved");
                  router.refresh();
                } else setErr({ message: r.error, field: r.field });
              })
            }
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
