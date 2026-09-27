"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Toast, useToast } from "@/components/ui";
import { revokeCustomerPortalAction } from "../../actions";

export function CustomerPortalCard({ customerId, url, email, canEdit }: { customerId: string; url: string; email: string | null; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      t.ok("Portal link copied — send it once; it stays theirs");
    } catch {
      t.ok(url);
    }
  };
  return (
    <div className="card p-4">
      <div className="eyebrow mb-2">Customer portal</div>
      <div className="text-[12px] mono break-all select-all bg-ground rounded p-2 border border-line" data-testid="customer-portal-url">
        {url}
      </div>
      <div className="flex gap-2 mt-2 flex-wrap">
        <button className="btn btn-sm" onClick={copy}>
          Copy link
        </button>
        {email && (
          <a className="btn btn-sm" href={`mailto:${email}?subject=${encodeURIComponent("Your loads, tracking and invoices")}&body=${encodeURIComponent(`Every load with us, live tracking, PODs and your invoices in one place: ${url}`)}`}>
            Email
          </a>
        )}
        <a className="btn btn-sm btn-ghost" href={url} target="_blank" rel="noreferrer">
          Preview
        </a>
        {canEdit && (
          <button className="btn btn-sm btn-ghost text-red ml-auto" onClick={() => setConfirm(true)}>
            Revoke
          </button>
        )}
      </div>
      <div className="help mt-1">Their loads with live tracking, PODs and rate cons once delivered, invoices with the balance, and a form to request a load that lands on Dispatch as a draft. Never rates you pay, never driver phones.</div>
      <Confirm open={confirm} onClose={() => setConfirm(false)} title="Revoke the portal link?" body="The link they have stops working. Open this page again to issue a new one." confirmLabel="Revoke" danger onConfirm={() => { setConfirm(false); start(async () => { const r = await revokeCustomerPortalAction(customerId); if (r.ok) { t.ok("Revoked — a new link is ready below"); router.refresh(); } else t.err(r.error); }); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
      {pending && null}
    </div>
  );
}
