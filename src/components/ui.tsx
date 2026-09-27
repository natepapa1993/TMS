"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Small, dependency-free primitives. Everything the screens need to feel like one product. */

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="presentation">
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line">
          <div className="h2">{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Pill({ tone = "slate", children, title }: { tone?: "slate" | "teal" | "amber" | "red" | "green" | "blue" | "navy"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="py-14 text-center">
      <div className="font-bold text-ink">{title}</div>
      {hint && <div className="text-muted mt-1 text-[13px]">{hint}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Toast({ message, tone = "ok", onDone }: { message: string | null; tone?: "ok" | "err"; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, tone === "err" ? 6000 : 2600);
    return () => clearTimeout(t);
  }, [message, tone, onDone]);
  if (!message) return null;
  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-lg shadow-lg text-[13px] font-semibold ${tone === "err" ? "bg-red text-white" : "bg-navy text-white"}`} role="status">
      {message}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  return {
    toast,
    ok: (message: string) => setToast({ message, tone: "ok" }),
    err: (message: string) => setToast({ message, tone: "err" }),
    clear: () => setToast(null),
  };
}

export function Confirm({ open, onClose, onConfirm, title, body, confirmLabel = "Confirm", danger, needReason }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => void | Promise<void>; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; needReason?: string }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason("");
    onClose();
  };
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy || (!!needReason && !reason.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                setReason("");
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {body && <div className="text-[13.5px] text-muted mb-3">{body}</div>}
      {needReason && (
        <div>
          <label className="label">{needReason}</label>
          <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reason.trim() && onConfirm(reason.trim())} />
        </div>
      )}
    </Modal>
  );
}

export function Spinner() {
  return <span className="inline-block w-3.5 h-3.5 border-2 border-line border-t-teal rounded-full animate-spin align-middle" aria-hidden />;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-[13px]">
      <span className="text-muted">{k}</span>
      <span className="font-semibold text-right">{v || <span className="text-faint">—</span>}</span>
    </div>
  );
}
