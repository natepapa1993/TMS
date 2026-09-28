"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { searchAllAction } from "@/app/(app)/search-actions";
import type { SearchHit } from "@/domain/search";

const KIND: Record<SearchHit["kind"], string> = { load: "Load", truck: "Unit", trailer: "Trailer", driver: "Driver", customer: "Customer", carrier: "Carrier" };

/** ⌘K / Ctrl+K anywhere: find a load by any number on it (PO, BOL, customer ref), a unit, a driver, a partner. */
export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 10);
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      const r = await searchAllAction(q);
      if (!live) return;
      setBusy(false);
      setHits(r.ok ? r.data : []);
      setI(0);
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open]);
  const close = () => {
    setOpen(false);
    setQ("");
    setHits([]);
  };
  const go = (h: SearchHit) => {
    close();
    router.push(h.href);
  };
  const shown = q.trim().length < 2 ? [] : hits;
  return (
    <>
      <button className="global-search-btn" onClick={() => setOpen(true)} aria-label="Search everything" data-testid="global-search-open">
        <Search size={14} aria-hidden /> Search <span className="ml-auto text-caption opacity-70">⌘K</span>
      </button>
      {open && (
        <div className="overlay fixed inset-0 z-50 bg-navy/40 flex items-start justify-center pt-[12vh] px-4" onClick={close}>
          <div className="w-full max-w-[620px] bg-white rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search everything">
            <div className="flex items-center gap-2 px-4 border-b border-line">
              <Search size={16} className="text-muted" aria-hidden />
              <input
                ref={input}
                id="global-search"
                className="flex-1 h-12 outline-none text-headline bg-transparent"
                placeholder="Load #, PO, BOL, customer ref, unit, trailer, driver, customer, carrier…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setI((x) => Math.min(shown.length - 1, x + 1));
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setI((x) => Math.max(0, x - 1));
                  }
                  if (e.key === "Enter" && shown[i]) go(shown[i]);
                }}
              />
              {busy && <span className="text-footnote text-faint">searching…</span>}
            </div>
            <ul className="max-h-[420px] overflow-y-auto" data-testid="global-search-results">
              {shown.map((h, k) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button className={`w-full text-left px-4 py-2.5 flex items-center gap-3 ${k === i ? "bg-teal-soft" : "hover:bg-ground"}`} onMouseEnter={() => setI(k)} onClick={() => go(h)}>
                    <span className="text-caption font-bold text-faint w-16 shrink-0">{KIND[h.kind]}</span>
                    <span className="min-w-0">
                      <span className={`block font-semibold ${h.kind === "load" ? "mono" : ""}`}>{h.title}</span>
                      <span className="block text-footnote text-muted truncate">{h.sub}</span>
                    </span>
                  </button>
                </li>
              ))}
              {q.trim().length >= 2 && !busy && !shown.length && <li className="px-4 py-6 text-center text-muted text-callout">Nothing found for “{q}”.</li>}
              {q.trim().length < 2 && <li className="px-4 py-5 text-callout text-muted">Type at least two characters. ↑ ↓ to move, Enter to open, Esc to close.</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
