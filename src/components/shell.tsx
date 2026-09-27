"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "./mark";
import { logoutAction } from "@/app/(auth)/actions";

const NAV = [
  { href: "/dispatch", label: "Dispatch", icon: "◫" },
  { href: "/orders", label: "Orders", icon: "☰" },
  { href: "/fleet", label: "Fleet", icon: "⛟" },
  { href: "/crossing", label: "Crossing", icon: "⇄" },
  { href: "/compliance", label: "Compliance", icon: "✓" },
  { href: "/billing", label: "Billing", icon: "$", roles: ["owner", "dispatcher", "billing"] },
  { href: "/reports", label: "Reports", icon: "▤" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

const ROLE_LABEL: Record<string, string> = { owner: "Owner", dispatcher: "Dispatcher", billing: "Billing", compliance: "Safety & compliance", mx_office: "Mexico office", driver: "Driver", carrier: "Carrier", customer: "Customer" };

export function Shell({ user, children }: { user: { name: string; role: string; tenantName: string }; children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // the drawer closes when a link is tapped (phone) and on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const current = NAV.find((n) => path === n.href || path.startsWith(n.href + "/"));
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[224px_1fr]">
      {/* phone / tablet top bar */}
      <header className="lg:hidden sticky top-0 z-30 bg-navy text-white h-12 flex items-center gap-3 px-3">
        <button className="w-9 h-9 -ml-1 rounded-md hover:bg-white/10 text-xl leading-none" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          ☰
        </button>
        <Mark size={22} />
        <div className="font-extrabold tracking-tight">{current?.label ?? "Crossline"}</div>
        <div className="ml-auto text-[11px] text-slate-400 truncate max-w-[40%]">{user.tenantName}</div>
      </header>
      {open && <div className="lg:hidden fixed inset-0 z-30 bg-navy/60" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`bg-navy text-white flex flex-col fixed lg:sticky top-0 h-screen w-[224px] z-40 transition-transform lg:transition-none ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`} aria-label="Main navigation">
        <div className="flex items-center gap-2.5 px-4 h-14">
          <Mark size={24} />
          <div className="leading-tight">
            <div className="font-extrabold tracking-tight">Crossline</div>
            <div className="text-[11px] text-slate-400 truncate max-w-[140px]">{user.tenantName}</div>
          </div>
          <button className="lg:hidden ml-auto w-8 h-8 rounded-md hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Close menu">
            ×
          </button>
        </div>
        <nav className="px-2 mt-2 space-y-0.5 flex-1">
          {NAV.filter((n) => !("roles" in n) || (n.roles as string[]).includes(user.role)).map((n) => {
            const active = path === n.href || path.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.href} className="rail-link" aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                <span className="w-5 text-center text-[15px] opacity-90">{n.icon}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-4 py-4 border-t border-white/10">
          <div className="text-[13px] font-bold truncate">{user.name}</div>
          <div className="text-[11.5px] text-slate-400">{ROLE_LABEL[user.role] ?? user.role}</div>
          <div className="mt-2 flex gap-3 text-[12px] font-semibold">
            <Link href="/help" className="text-slate-300 hover:text-white" onClick={() => setOpen(false)}>
              Help
            </Link>
            <form action={logoutAction}>
              <button className="text-slate-300 hover:text-white font-semibold">Sign out</button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
