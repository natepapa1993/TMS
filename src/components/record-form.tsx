"use client";

import { useState, useTransition, useMemo } from "react";
import { fieldDisplay, type Field } from "@/data/fields";

/**
 * One form for every record type. `mode="quick"` shows only the essentials (spec §1.1: add a
 * truck in four fields); `mode="full"` shows everything, grouped. Field errors come back from
 * the server and land under the field they belong to.
 */

export type RefOptions = Record<string, { id: string; label: string }[]>;

function toInputValue(f: Field, v: unknown): string {
  if (v == null) return "";
  if (f.type === "date") {
    const d = typeof v === "string" ? new Date(v) : (v as Date);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  if (f.type === "cents") return typeof v === "number" ? (v / 100).toFixed(2) : String(v);
  if (f.type === "boolean") return v ? "true" : "";
  if (f.type === "list") return Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v);
  if (f.type === "contacts") return fieldDisplay(f, v);
  if (f.type === "address") {
    const a = v as { line1?: string; city?: string; state?: string; postalCode?: string; country?: string };
    return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");
  }
  return String(v);
}

export function RecordForm({
  fields,
  initial,
  refs,
  mode,
  onSubmit,
  submitLabel = "Save",
  onCancel,
  extra,
}: {
  fields: Field[];
  initial?: Record<string, unknown>;
  refs: RefOptions;
  mode: "quick" | "full";
  onSubmit: (raw: Record<string, string>) => Promise<{ ok: boolean; error?: string; errors?: Record<string, string>; field?: string }>;
  submitLabel?: string;
  onCancel?: () => void;
  extra?: React.ReactNode;
}) {
  const shown = useMemo(() => (mode === "quick" ? fields.filter((f) => f.quick) : fields), [fields, mode]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      shown.map((f) => {
        const v = toInputValue(f, initial?.[f.name]);
        // a required select always holds a real value, so what the user sees is what gets saved
        if (!v && f.type === "select" && f.required) return [f.name, f.options?.find((o) => o.value)?.value ?? ""];
        return [f.name, v];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [top, setTop] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const groups = useMemo(() => {
    const g = new Map<string, Field[]>();
    for (const f of shown) g.set(f.group, [...(g.get(f.group) ?? []), f]);
    return [...g.entries()];
  }, [shown]);

  const set = (name: string, v: string) => {
    setValues((s) => ({ ...s, [name]: v }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: "" }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTop(null);
    const missing: Record<string, string> = {};
    const editing = !!initial?.id;
    for (const f of shown) if (f.required && !values[f.name]?.trim() && !(f.type === "password" && editing)) missing[f.name] = `${f.label} is required`;
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    start(async () => {
      const r = await onSubmit(values);
      if (!r.ok) {
        if (r.errors) setErrors(r.errors);
        else if (r.field) setErrors({ [r.field]: r.error ?? "Check this field" });
        else setTop(r.error ?? "Could not save");
      }
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      {top && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-soft text-red text-[13px] font-semibold" role="alert">
          {top}
        </div>
      )}
      <div className="space-y-5">
        {groups.map(([group, gf]) => (
          <div key={group}>
            {mode === "full" && groups.length > 1 && <div className="eyebrow mb-2">{group}</div>}
            <div className={`grid gap-3 ${mode === "full" ? "grid-cols-2" : "grid-cols-1"}`}>
              {gf.map((f) => (
                <FieldInput key={f.name} f={f} value={values[f.name] ?? ""} onChange={(v) => set(f.name, v)} error={errors[f.name]} refs={refs} span={f.type === "textarea" || f.type === "address"} autoFocus={f === shown[0]} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {extra}
      <div className="flex justify-end gap-2 mt-5">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function FieldInput({ f, value, onChange, error, refs, span, autoFocus }: { f: Field; value: string; onChange: (v: string) => void; error?: string; refs: RefOptions; span?: boolean; autoFocus?: boolean }) {
  const id = `f-${f.name}`;
  const common = { id, "aria-invalid": !!error, autoFocus };
  let input: React.ReactNode;
  switch (f.type) {
    case "select":
      input = (
        <select {...common} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {!f.required && !f.options?.some((o) => o.value === "") && <option value="">—</option>}
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "ref": {
      const opts = refs[f.ref ?? ""] ?? [];
      input = (
        <select {...common} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "boolean":
      input = (
        <label className="flex items-center gap-2 h-9 cursor-pointer select-none">
          <input id={id} type="checkbox" className="w-4 h-4 accent-teal" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} />
          <span className="text-[13.5px]">{f.help ?? "Yes"}</span>
        </label>
      );
      break;
    case "textarea":
      input = <textarea {...common} className="textarea" value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />;
      break;
    case "date":
      input = <input {...common} type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
      input = <input {...common} type="number" inputMode="numeric" className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />;
      break;
    case "cents":
      input = (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
          <input {...common} inputMode="decimal" className="input pl-7" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" />
        </div>
      );
      break;
    case "contacts":
      input = <textarea {...common} className="input h-24 font-mono text-[12px]" value={value} onChange={(e) => onChange(e.target.value)} placeholder={"Ana Ruiz | ops | ana@example.com | +52 844 000 0000 | +52 844 000 0000"} />;
      break;
    case "password":
      input = <input {...common} type="password" autoComplete="new-password" className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="at least 10 characters" />;
      break;
    default:
      input = <input {...common} type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder ?? (f.type === "address" ? "Street, City, ST 00000, US" : undefined)} />;
  }
  return (
    <div className={span ? "col-span-full" : ""}>
      <label className="label" htmlFor={id}>
        {f.label}
        {f.required && <span className="text-red"> *</span>}
      </label>
      {input}
      {error ? <div className="error">{error}</div> : f.help && f.type !== "boolean" ? <div className="help">{f.help}</div> : null}
    </div>
  );
}
