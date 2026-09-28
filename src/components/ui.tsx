"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { createPortal } from "react-dom";

/** Small, dependency-free primitives. Everything the screens need to feel like one product. */

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="presentation">
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} aria-labelledby={typeof title === "string" ? undefined : titleId}>
        <div className="modal-head">
          <div className="h2" id={titleId}>
            {title}
          </div>
          <button className="modal-close shrink-0" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
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

export function Empty({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
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
    <div className={`toast ${tone === "err" ? "toast-err" : ""}`} role="status">
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
            className={`btn ${danger ? "btn-danger-fill" : "btn-primary"}`}
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
      {body && <div className="text-body text-muted mb-3">{body}</div>}
      {needReason && (
        <div>
          <label className="label">{needReason}</label>
          <input className="input w-full" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reason.trim() && onConfirm(reason.trim())} />
        </div>
      )}
    </Modal>
  );
}

export function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-line border-t-teal rounded-full animate-spin align-middle" aria-hidden />;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-callout">
      <span className="text-muted">{k}</span>
      <span className="font-semibold text-right">{v || <span className="text-faint">—</span>}</span>
    </div>
  );
}

/** Apple-style segmented control for switching views or filters (links or buttons as children get the look). */
export function Segmented({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** "•••" menu for secondary actions: keeps one obvious primary on screen and the rest a tap away. */
export function MoreMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest?.("[data-more-menu]")) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="relative" data-more-menu>
      <button className="btn btn-icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={20} aria-hidden />
      </button>
      {open && (
        <div className="menu absolute right-0 top-[calc(100%+6px)] z-40 min-w-[220px]" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
