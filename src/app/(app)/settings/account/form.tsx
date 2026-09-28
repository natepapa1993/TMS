"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Toast, useToast } from "@/components/ui";
import { saveMyAccountAction, changeMyPasswordAction } from "./actions";

export function AccountForm({ initial }: { initial: { name: string; phone: string } }) {
  const router = useRouter();
  const t = useToast();
  const [f, setF] = useState(initial);
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [pwErr, setPwErr] = useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-6">
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          start(async () => {
            const r = await saveMyAccountAction(f);
            if (r.ok) {
              t.ok("Saved");
              router.refresh();
            } else setErr({ message: r.error, field: r.field });
          });
        }}
      >
        <div>
          <label className="label" htmlFor="me-name">
            Name
          </label>
          <input id="me-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={err?.field === "name"} />
        </div>
        <div>
          <label className="label" htmlFor="me-phone">
            Phone
          </label>
          <input id="me-phone" className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        {err && (
          <div className="col-span-2 text-red text-callout font-semibold" role="alert">
            {err.message}
          </div>
        )}
        <div className="col-span-2 flex justify-end">
          <button className="btn btn-primary" disabled={pending}>
            Save
          </button>
        </div>
      </form>
      <form
        className="grid grid-cols-3 gap-3 pt-5 border-t border-line"
        onSubmit={(e) => {
          e.preventDefault();
          setPwErr(null);
          if (pw.next !== pw.again) return setPwErr({ message: "The two new passwords don't match.", field: "again" });
          start(async () => {
            const r = await changeMyPasswordAction({ current: pw.current, next: pw.next });
            if (r.ok) {
              t.ok("Password changed");
              setPw({ current: "", next: "", again: "" });
            } else setPwErr({ message: r.error, field: r.field });
          });
        }}
      >
        <div className="col-span-3 eyebrow">Change your password</div>
        <div>
          <label className="label" htmlFor="me-pw-current">
            Current password
          </label>
          <input id="me-pw-current" type="password" autoComplete="current-password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-invalid={pwErr?.field === "current"} />
        </div>
        <div>
          <label className="label" htmlFor="me-pw-next">
            New password
          </label>
          <input id="me-pw-next" type="password" autoComplete="new-password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-invalid={pwErr?.field === "next"} />
        </div>
        <div>
          <label className="label" htmlFor="me-pw-again">
            New password again
          </label>
          <input id="me-pw-again" type="password" autoComplete="new-password" className="input" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} aria-invalid={pwErr?.field === "again"} />
        </div>
        <div className="col-span-3 help">At least 10 characters.</div>
        {pwErr && (
          <div className="col-span-3 text-red text-callout font-semibold" role="alert">
            {pwErr.message}
          </div>
        )}
        <div className="col-span-3 flex justify-end">
          <button className="btn" disabled={pending || !pw.current || !pw.next}>
            Change password
          </button>
        </div>
      </form>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
