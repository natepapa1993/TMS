"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { useClock } from "@/components/zone";
import { inviteUserAction, resendInviteAction, cancelInviteAction } from "./invite-actions";

const ROLES: [string, string][] = [
  ["dispatcher", "Dispatcher"],
  ["billing", "Billing"],
  ["compliance", "Safety & compliance"],
  ["mx_office", "Mexico office"],
  ["owner", "Owner"],
];

function CopyLink({ link }: { link: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(link);
          setDone(true);
        } catch {
          window.prompt("Copy the link", link);
        }
      }}
    >
      {done ? "Copied" : "Copy link"}
    </button>
  );
}

/** Owner #22: invite by email. The person sets their own password from a one-time link. */
export function InviteUser({ openInitially = false }: { openInitially?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(openInitially);
  const [f, setF] = useState({ name: "", email: "", role: "dispatcher" });
  const [err, setErr] = useState<{ msg: string; field?: string } | null>(null);
  const [sent, setSent] = useState<{ link: string; emailed: boolean; email: string } | null>(null);
  const [pending, start] = useTransition();
  const close = () => {
    setOpen(false);
    setSent(null);
    setErr(null);
    setF({ name: "", email: "", role: "dispatcher" });
  };
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} data-testid="invite-user">
        Invite by email
      </button>
      <Modal
        open={open}
        onClose={close}
        title={sent ? "Invite sent" : "Invite someone"}
        footer={
          sent ? (
            <button className="btn btn-primary" onClick={close}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending || !f.name.trim() || !f.email.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await inviteUserAction(f);
                    if (r.ok) {
                      setSent({ ...r.data, email: f.email.trim() });
                      setErr(null);
                      router.refresh();
                    } else setErr({ msg: r.error, field: r.field });
                  })
                }
              >
                {pending ? "Sending…" : "Send invite"}
              </button>
            </>
          )
        }
      >
        {sent ? (
          <div className="space-y-3" data-testid="invite-sent">
            <p className="text-body">
              {sent.emailed ? (
                <>
                  We emailed <b>{sent.email}</b> a link to set their password. It works once, for 7 days.
                </>
              ) : (
                <>
                  Email isn&apos;t connected (Settings → Integrations), so nothing was emailed: the invite is in Messages. Send <b>{sent.email}</b> this link yourself. It works once, for 7 days.
                </>
              )}
            </p>
            <div className="flex items-center gap-2">
              <input className="input mono text-footnote flex-1" readOnly value={sent.link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
              <CopyLink link={sent.link} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="inv-name">
                Name
              </label>
              <input id="inv-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
            </div>
            <div>
              <label className="label" htmlFor="inv-email">
                Email
              </label>
              <input id="inv-email" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="inv-role">
                Role
              </label>
              <select id="inv-role" className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {ROLES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {f.role === "owner" && <div className="text-footnote text-amber mt-1">An owner sees everything, including money and users.</div>}
            </div>
            <p className="text-footnote text-muted">They get an email with a link to set their own password. You never see it.</p>
            {err && (
              <div className="error" role="alert">
                {err.msg}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

type Pending = { userId: string; name: string; email: string; roleLabel: string; link: string | null; expiresAt: string | null; invitedAt: string };

/** Invited, not joined yet: copy the link, send it again, or take the invite back. */
export function PendingInvites({ rows }: { rows: Pending[] }) {
  const router = useRouter();
  const clock = useClock();
  const t = useToast();
  const [pending, start] = useTransition();
  if (!rows.length) return null;
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <div className="card overflow-hidden mb-4" data-testid="pending-invites">
      <div className="px-4 pt-3 pb-2 border-b border-line text-body font-extrabold">Invited, not joined yet</div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.userId} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {r.name} <span className="text-muted font-normal">· {r.roleLabel}</span>
              </div>
              <div className="text-footnote text-muted break-all">
                {r.email} · {r.link && r.expiresAt ? `link good until ${clock.at(r.expiresAt, { style: "short" })}` : "link expired — send it again"}
              </div>
            </div>
            <div className="flex gap-2 flex-none">
              {r.link && <CopyLink link={r.link} />}
              <button className="btn btn-sm" disabled={pending} onClick={() => run("Sent again — the old link stops working", () => resendInviteAction(r.userId))}>
                Send again
              </button>
              <button className="btn btn-sm btn-ghost text-red" disabled={pending} onClick={() => run("Invite cancelled", () => cancelInviteAction(r.userId))}>
                Cancel invite
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
