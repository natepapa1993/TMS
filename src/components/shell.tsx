"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mark } from "./mark";
import { logoutAction } from "@/app/(auth)/actions";

const NAV = [
  { href: "/dispatch", label: "Dispatch", icon: "◫" },
  { href: "/orders", label: "Orders", icon: "☰" },
  { href: "/fleet", label: "Fleet", icon: "⛟" },
  { href: "/crossing", label: "Crossing", icon: "⇄" },
  { href: "/compliance", label: "Compliance", icon: "✓", soon: true },
  { href: "/billing", label: "Billing", icon: "$", soon: true },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

const ROLE_LABEL: Record<string, string> = { owner: "Owner", dispatcher: "Dispatcher", billing: "Billing", compliance: "Safety & compliance", mx_office: "Mexico office", driver: "Driver", carrier: "Carrier", customer: "Customer" };

export function Shell({ user, children }: { user: { name: string; role: string; tenantName: string }; children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="min-h-screen grid grid-cols-[224px_1fr]">
      <aside className="bg-navy text-white flex flex-col sticky top-0 h-screen">
        <div className="flex items-center gap-2.5 px-4 h-14">
          <Mark size={24} />
          <div className="leading-tight">
            <div className="font-extrabold tracking-tight">Crossline</div>
            <div className="text-[11px] text-slate-400 truncate max-w-[140px]">{user.tenantName}</div>
          </div>
        </div>
        <nav className="px-2 mt-2 space-y-0.5 flex-1">
          {NAV.map((n) => {
            const active = path === n.href || path.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.soon ? "#" : n.href} className={`rail-link ${n.soon ? "opacity-40 cursor-default" : ""}`} aria-current={active ? "page" : undefined} aria-disabled={n.soon} title={n.soon ? "Coming in a later milestone" : undefined}>
                <span className="w-5 text-center text-[15px] opacity-90">{n.icon}</span>
                {n.label}
                {n.soon && <span className="ml-auto text-[10px] font-bold tracking-wider text-slate-400">M{n.label === "Compliance" ? 3 : 4}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="px-4 py-4 border-t border-white/10">
          <div className="text-[13px] font-bold truncate">{user.name}</div>
          <div className="text-[11.5px] text-slate-400">{ROLE_LABEL[user.role] ?? user.role}</div>
          <form action={logoutAction}>
            <button className="mt-2 text-[12px] text-slate-300 hover:text-white font-semibold">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
