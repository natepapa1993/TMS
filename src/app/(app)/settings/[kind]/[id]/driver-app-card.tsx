"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Toast, useToast } from "@/components/ui";
import { revokeDriverAppAction } from "../../actions";

/** The driver's permanent app link on their record: copy it, WhatsApp it, preview it, revoke it when they leave. */
export function DriverAppCard({ driverId, url, whatsapp, phone, canEdit }: { driverId: string; url: string; whatsapp: string | null; phone: string | null; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [confirm, setConfirm] = useState(false);
  const [, start] = useTransition();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      t.ok("App link copied — send it once; it stays theirs");
    } catch {
      t.ok(url);
    }
  };
  const number = whatsapp ?? phone;
  const wa = number ? `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(`Your loads, one button per step: ${url}`)}` : null;
  return (
    <div className="card p-4" data-testid="driver-app-card">
      <div className="eyebrow mb-2">Driver app</div>
      <div className="text-footnote mono break-all select-all bg-ground rounded p-2 border border-line" data-testid="driver-app-url">
        {url}
      </div>
      <div className="flex gap-2 mt-2 flex-wrap">
        <button className="btn btn-sm" onClick={copy}>
          Copy link
        </button>
        {wa && (
          <a className="btn btn-sm" href={wa} target="_blank" rel="noreferrer">
            WhatsApp
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
      <div className="help mt-1">Their loads with one button per step and GPS, the packet, seal and POD photos, their documents with renewals from the phone, their pay, and a line to dispatch. Revoke it the day they leave; a new one is issued on the next open.</div>
      <Confirm
        open={confirm}
        title="Revoke this driver's app link?"
        body="The link stops working right away. Opening this record again issues a fresh one to send."
        confirmLabel="Revoke"
        danger
        onClose={() => setConfirm(false)}
        onConfirm={() =>
          start(async () => {
            const r = await revokeDriverAppAction(driverId);
            if (r.ok) {
              setConfirm(false);
              t.ok("Link revoked");
              router.refresh();
            } else t.err(r.error);
          })
        }
      />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
