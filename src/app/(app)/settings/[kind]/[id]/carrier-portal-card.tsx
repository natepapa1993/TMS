"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Confirm, Toast, useToast } from "@/components/ui";
import { revokeCarrierPortalAction } from "../../actions";

type Score = { days: number; offered: number; answered: number; accepted: number; declined: number; expired: number; acceptancePct: number | null; loads: number; onTimePct: number | null; onTimeOf: number; trackedPct: number | null };

export function CarrierPortalCard({ carrierId, url, whatsapp, email, score, canEdit }: { carrierId: string; url: string; whatsapp: string | null; email: string | null; score: Score; canEdit: boolean }) {
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
  const wa = whatsapp ? `https://wa.me/${whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(`Your loads with us, offers and pay in one place: ${url}`)}` : null;
  return (
    <div className="card p-4">
      <div className="eyebrow mb-2">Carrier portal</div>
      <div className="text-[12px] mono break-all select-all bg-ground rounded p-2 border border-line" data-testid="portal-url">
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
        {email && (
          <a className="btn btn-sm" href={`mailto:${email}?subject=${encodeURIComponent("Your carrier portal")}&body=${encodeURIComponent(`Offers, loads, pay and documents in one place: ${url}`)}`}>
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
      <div className="help mt-1">Offers, their loads with one-tap steps and driver details, rate cons, invoicing against the leg, COI / W-9 uploads straight into compliance, and their score.</div>
      <div className="eyebrow mt-4 mb-1">Scorecard · last {score.days} days</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[18px] font-extrabold mono">{score.acceptancePct == null ? "—" : `${score.acceptancePct}%`}</div>
          <div className="text-[11px] text-muted">
            accepted · {score.accepted}/{score.answered} answered
          </div>
        </div>
        <div>
          <div className="text-[18px] font-extrabold mono">{score.onTimePct == null ? "—" : `${score.onTimePct}%`}</div>
          <div className="text-[11px] text-muted">on time · of {score.onTimeOf}</div>
        </div>
        <div>
          <div className="text-[18px] font-extrabold mono">{score.trackedPct == null ? "—" : `${score.trackedPct}%`}</div>
          <div className="text-[11px] text-muted">tracked · {score.loads} loads</div>
        </div>
      </div>
      {score.expired > 0 && <div className="text-[12px] text-amber mt-1">{score.expired} offer{score.expired === 1 ? "" : "s"} expired unanswered</div>}
      <Confirm open={confirm} onClose={() => setConfirm(false)} title="Revoke the portal link?" body="The link they have stops working. Open this page again to issue a new one." confirmLabel="Revoke" danger onConfirm={() => { setConfirm(false); start(async () => { const r = await revokeCarrierPortalAction(carrierId); if (r.ok) { t.ok("Revoked — a new link is ready below"); router.refresh(); } else t.err(r.error); }); }} />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
      {pending && null}
    </div>
  );
}
