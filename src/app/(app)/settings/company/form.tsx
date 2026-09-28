"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCompanyAction } from "../actions";
import { Toast, useToast } from "@/components/ui";

/** The company's clock, in words a dispatcher picks from (owner #23): no typing "America/Detroit". */
const ZONES: [string, string][] = [
  ["America/Detroit", "Eastern — Detroit, Michigan"],
  ["America/New_York", "Eastern — New York, Atlanta"],
  ["America/Toronto", "Eastern — Toronto, Ontario"],
  ["America/Chicago", "Central — Chicago, Dallas, Laredo"],
  ["America/Matamoros", "Central, US daylight time — Nuevo Laredo, Reynosa, Piedras Negras"],
  ["America/Monterrey", "Central, no daylight time — Monterrey, Saltillo"],
  ["America/Mexico_City", "Central, no daylight time — Mexico City, Querétaro"],
  ["America/Denver", "Mountain — Denver, El Paso"],
  ["America/Ciudad_Juarez", "Mountain, US daylight time — Ciudad Juárez"],
  ["America/Phoenix", "Mountain, no daylight time — Phoenix"],
  ["America/Los_Angeles", "Pacific — Los Angeles"],
  ["America/Tijuana", "Pacific — Tijuana"],
];

const QB_FIELDS: [string, string, string][] = [
  ["arAccount", "Accounts receivable", "invoices post here"],
  ["apAccount", "Accounts payable", "carrier bills and driver settlements post here"],
  ["bankAccount", "Bank account", "receipts and payments"],
  ["incomeAccount", "Line-haul income", ""],
  ["fuelIncomeAccount", "Fuel surcharge income", ""],
  ["accessorialIncomeAccount", "Accessorial income", "detention, lumper, everything else billed"],
  ["carrierExpenseAccount", "Purchased transportation", "partner carrier bills"],
  ["depositAccount", "Deposits go to", "customer payments land here first (Undeposited Funds), then you deposit them"],
  ["driverPayAccount", "Driver pay expense", "settlement earnings lines"],
  ["reimbursementAccount", "Driver reimbursements", "per diem and receipts paid back to drivers"],
  ["deductionAccount", "Driver deductions", "insurance and other deductions taken off the statement"],
  ["advanceAccount", "Driver advances (asset)", "advances paid out; recovered from later statements"],
  ["escrowAccount", "Driver escrow (liability)", "escrow held for drivers"],
  ["factorReserveAccount", "Factor reserve (asset)", "the part of factored invoices the factor holds until the customer pays"],
  ["factoringFeeAccount", "Factoring fees (expense)", "the factor's fees"],
  ["fxGainLossAccount", "Exchange gain or loss", "pesos or Canadian dollars received at a different rate than the invoice's"],
];

export function CompanyForm({ initial, canEdit }: { initial: { name: string; timeZone: string; fuelCostPerMile: string; closedThrough: string | null; qb: Record<string, string>; dispatchPhone: string; fx: Record<string, string>; fxAt: Record<string, string> }; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState({ name: initial.name, timeZone: initial.timeZone, fuelCostPerMile: initial.fuelCostPerMile, qb: { ...initial.qb }, dispatchPhone: initial.dispatchPhone, fx: { ...initial.fx } });
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
          <select id="c-tz" className="select" value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} aria-invalid={err?.field === "timeZone"}>
            {(ZONES.some(([z]) => z === f.timeZone) ? ZONES : [[f.timeZone, f.timeZone] as [string, string], ...ZONES]).map(([z, l]) => (
              <option key={z} value={z}>
                {l}
              </option>
            ))}
          </select>
          <div className="help">Times not tied to a stop (sent, history, digests, today on the boards, month-end close) are on this clock. Stop times are always on the stop&apos;s own clock.</div>
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
        <div className="col-span-2">
          <label className="label" htmlFor="c-dispatch">
            Dispatch phone / WhatsApp
          </label>
          <input id="c-dispatch" className="input" placeholder="+1 313 555 0100" value={f.dispatchPhone} onChange={(e) => setF({ ...f, dispatchPhone: e.target.value })} aria-invalid={err?.field === "dispatchPhone"} />
          <div className="help">Drivers and partner carriers&apos; drivers get a Call / WhatsApp button to this number in their app.</div>
        </div>
        <div className="col-span-2 text-callout text-muted">
          Books closed through: <b className="text-ink">{initial.closedThrough ?? "not closed yet"}</b> — set from Billing → Invoices → Close period.
        </div>
        <div className="col-span-2 eyebrow mt-3">Exchange rates</div>
        <div className="col-span-2 help -mt-1">Reports, margins and RPM are in US dollars. An invoiced load converts at the rate stored on its invoice; a load not invoiced yet (and a carrier paid in pesos or Canadian dollars) converts at these. Issuing a MXN or CAD invoice updates them to the rate you typed.</div>
        {(["MXN", "CAD"] as const).map((c) => (
          <div key={c}>
            <label className="label" htmlFor={`fx-${c}`}>
              {c} per 1 USD
            </label>
            <input id={`fx-${c}`} className="input" inputMode="decimal" placeholder={c === "MXN" ? "18.4500" : "1.3700"} value={f.fx[c] ?? ""} onChange={(e) => setF({ ...f, fx: { ...f.fx, [c]: e.target.value } })} aria-invalid={err?.field === `fx${c}`} />
            <div className="help">{initial.fxAt[c] ? `last set ${initial.fxAt[c]}` : `not set — a default of ${c === "MXN" ? "18.00" : "1.37"} is used and labelled`}</div>
          </div>
        ))}
        <div className="col-span-2 eyebrow mt-3">QuickBooks account names</div>
        <div className="col-span-2 help -mt-1">Exactly as they read in your chart of accounts; the export files post to these. Customer and vendor names live on each customer, carrier and driver record.</div>
        {QB_FIELDS.map(([key, label, help]) => (
          <div key={key}>
            <label className="label" htmlFor={`qb-${key}`}>
              {label}
            </label>
            <input id={`qb-${key}`} className="input" value={f.qb[key] ?? ""} onChange={(e) => setF({ ...f, qb: { ...f.qb, [key]: e.target.value } })} aria-invalid={err?.field === key} />
            {help && <div className="help">{help}</div>}
          </div>
        ))}
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
