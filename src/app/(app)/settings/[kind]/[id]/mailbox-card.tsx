"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill, Toast, useToast } from "@/components/ui";
import { saveMailboxAction, testMailboxAction, pollMailboxAction } from "../../actions";

type Pub = { enabled: boolean; host: string; port: number; username: string; inbox: string; outbox: string; extension?: string | null; lastPollAt?: string | null; lastError?: string | null; lastPulled?: number; lastPushed?: number; hasPassword: boolean; hasPrivateKey: boolean } | null;

/** The VAN mailbox (SFTP) on an EDI partner: host, folders, credentials that are never shown back, test and poll. */
export function MailboxCard({ partnerId, mailbox, delivery, canEdit }: { partnerId: string; mailbox: Pub; delivery: string; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [f, setF] = useState({ enabled: mailbox?.enabled ?? false, host: mailbox?.host ?? "", port: String(mailbox?.port ?? 22), username: mailbox?.username ?? "", password: "", privateKey: "", inbox: mailbox?.inbox ?? "/inbox", outbox: mailbox?.outbox ?? "/outbox", extension: mailbox?.extension ?? ".edi" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string; field?: string; data?: unknown }>, after?: (data: unknown) => string) =>
    start(async () => {
      setErr(null);
      const r = await fn();
      if (r.ok) {
        t.ok(after ? after(r.data) : label);
        router.refresh();
      } else setErr({ message: r.error ?? "failed", field: r.field });
    });
  const when = (d?: string | null) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
  return (
    <div className="card p-4" data-testid="mailbox-card">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="eyebrow m-0">VAN mailbox (SFTP)</div>
        {mailbox?.enabled ? <Pill tone={mailbox.lastError ? "red" : "green"}>{mailbox.lastError ? "Problem" : mailbox.lastPollAt ? `Polled ${when(mailbox.lastPollAt)}` : "On · not polled yet"}</Pill> : <Pill tone="slate">Off</Pill>}
      </div>
      <div className="text-[12.5px] text-muted mb-3">
        Their VAN drops 204s in the inbox; we pull every five minutes and answer with a 997. {delivery === "sftp" ? "Our 214 / 210 / 990 go to the outbox." : "Outbound delivery is set to " + (delivery === "email" ? "email" : "pickup") + " — switch it to VAN mailbox above for our files to go here too."}
      </div>
      {mailbox?.lastError && <div className="text-[12.5px] text-red font-semibold mb-2 break-words">{mailbox.lastError}</div>}
      {mailbox?.lastPollAt && !mailbox.lastError && <div className="text-[12px] text-muted mb-2">Last poll: {mailbox.lastPulled ?? 0} pulled · {mailbox.lastPushed ?? 0} pushed</div>}
      <fieldset disabled={!canEdit || pending} className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">Host</label>
          <input id="mb-host" className="input" value={f.host} onChange={set("host")} placeholder="sftp.van.example.com" aria-invalid={err?.field === "host"} />
        </div>
        <div>
          <label className="label">Port</label>
          <input id="mb-port" className="input" inputMode="numeric" value={f.port} onChange={set("port")} aria-invalid={err?.field === "port"} />
        </div>
        <div>
          <label className="label">Username</label>
          <input id="mb-user" className="input" value={f.username} onChange={set("username")} aria-invalid={err?.field === "username"} />
        </div>
        <div className="col-span-2">
          <label className="label">Password</label>
          <input id="mb-password" type="password" autoComplete="new-password" className="input" value={f.password} onChange={set("password")} placeholder={mailbox?.hasPassword ? "saved · leave blank to keep" : ""} />
        </div>
        <div className="col-span-2">
          <label className="label">Private key (instead of a password)</label>
          <textarea id="mb-key" className="input h-16 font-mono text-[11px]" value={f.privateKey} onChange={set("privateKey")} placeholder={mailbox?.hasPrivateKey ? "saved · leave blank to keep" : "-----BEGIN OPENSSH PRIVATE KEY-----"} />
        </div>
        <div>
          <label className="label">Inbox (theirs → us)</label>
          <input id="mb-inbox" className="input" value={f.inbox} onChange={set("inbox")} aria-invalid={err?.field === "inbox"} />
        </div>
        <div>
          <label className="label">Outbox (us → them)</label>
          <input id="mb-outbox" className="input" value={f.outbox} onChange={set("outbox")} aria-invalid={err?.field === "outbox"} />
        </div>
        <div>
          <label className="label">File suffix</label>
          <input id="mb-ext" className="input" value={f.extension} onChange={set("extension")} placeholder=".edi" />
        </div>
        <label className="flex items-end gap-2 pb-2 text-[13px] cursor-pointer">
          <input id="mb-enabled" type="checkbox" className="accent-teal" checked={f.enabled} onChange={set("enabled")} /> Enabled
        </label>
      </fieldset>
      {err && <div className="error mt-2">{err.message}</div>}
      {canEdit && (
        <div className="flex gap-2 mt-3 flex-wrap">
          <button className="btn btn-primary btn-sm" disabled={pending} onClick={() => run("Mailbox saved", async () => { const r = await saveMailboxAction(partnerId, { ...f, port: Number(f.port) }); if (r.ok) setF((x) => ({ ...x, password: "", privateKey: "" })); return r; })}>
            Save mailbox
          </button>
          <button className="btn btn-sm" disabled={pending || !mailbox} onClick={() => run("", () => testMailboxAction(partnerId), (d) => `Connected · ${(d as { waiting: number }).waiting} file${(d as { waiting: number }).waiting === 1 ? "" : "s"} waiting in the inbox`)}>
            Test connection
          </button>
          <button className="btn btn-sm" disabled={pending || !mailbox?.enabled} onClick={() => run("", () => pollMailboxAction(partnerId), (d) => { const r = d as { pulled: number; failed: number; pushed: number; errors: string[] }; return `Polled · ${r.pulled} pulled, ${r.pushed} pushed${r.failed ? `, ${r.failed} failed` : ""}${r.errors.length ? ` — ${r.errors[0]}` : ""}`; })}>
            Poll now
          </button>
        </div>
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
