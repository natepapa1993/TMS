"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "./mark";
import { Sun, ArrowLeftRight, Banknote, BarChart3, ClipboardCheck, FolderCheck, Menu, X, Building2, Cable, CalendarRange, FileText, Handshake, Landmark, LayoutGrid, Map as MapIcon, MapPin, MessageSquare, Package, Plug, Receipt, Route, Settings, ShieldCheck, TriangleAlert, Truck, Users, Wallet, type LucideIcon } from "lucide-react";
import { logoutAction } from "@/app/(auth)/actions";
import { GlobalSearch } from "./global-search";

type NavItem = { href: string; label: string; icon: LucideIcon; roles?: string[] };
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Operations",
    items: [
      { href: "/today", label: "Today", icon: Sun, roles: ["owner"] },
      { href: "/dispatch", label: "Dispatch board", icon: LayoutGrid },
      { href: "/dispatch/planner", label: "Planner", icon: CalendarRange },
      { href: "/orders", label: "Loads", icon: Package },
      { href: "/trips", label: "Tailgate trips", icon: Route },
      { href: "/fleet/map", label: "Map", icon: MapIcon },
      { href: "/crossing", label: "Crossings", icon: ArrowLeftRight },
      { href: "/messages", label: "Messages", icon: MessageSquare },
    ],
  },
  {
    section: "Assets & partners",
    items: [
      { href: "/fleet", label: "Fleet", icon: Truck },
      { href: "/settings/drivers", label: "Drivers", icon: Users },
      { href: "/settings/customers", label: "Customers", icon: Building2 },
      { href: "/settings/carriers", label: "Carriers", icon: Handshake },
      { href: "/settings/locations", label: "Locations", icon: MapPin },
    ],
  },
  {
    section: "Money",
    items: [
      { href: "/billing", label: "Billing", icon: Receipt, roles: ["owner", "dispatcher", "billing"] },
      { href: "/billing/invoices", label: "Invoices", icon: FileText, roles: ["owner", "billing"] },
      { href: "/billing/ar", label: "Receivables", icon: Landmark, roles: ["owner", "billing"] },
      { href: "/billing/payments", label: "Payments", icon: Banknote, roles: ["owner", "billing"] },
      { href: "/billing/settlements", label: "Driver pay", icon: Wallet, roles: ["owner", "billing"] },
    ],
  },
  {
    section: "Safety",
    items: [
      { href: "/compliance", label: "Compliance", icon: ShieldCheck },
      { href: "/compliance/drivers", label: "Driver files", icon: FolderCheck },
      { href: "/compliance/inspections", label: "Inspections", icon: ClipboardCheck },
      { href: "/compliance/incidents", label: "Incidents", icon: TriangleAlert },
    ],
  },
  {
    section: "Company",
    items: [
      { href: "/reports", label: "Reports", icon: BarChart3 },
      { href: "/edi", label: "EDI", icon: Cable, roles: ["owner", "dispatcher", "billing"] },
      { href: "/settings/integrations", label: "Integrations", icon: Plug, roles: ["owner"] },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];
const ALL = NAV.flatMap((g) => g.items);

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
  // the most specific link that matches the path is the current one
  const current = ALL.filter((n) => path === n.href || path.startsWith(n.href + "/")).sort((p, q) => q.href.length - p.href.length)[0];
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]">
      {/* phone / tablet top bar */}
      <header className="topbar lg:hidden sticky top-0 z-30 flex items-center gap-2 px-2">
        <button className="btn btn-ghost btn-icon" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Menu size={22} aria-hidden />
        </button>
        <Mark size={24} />
        <div className="font-semibold text-headline tracking-tight truncate">{current?.label ?? "Crossline"}</div>
        <div className="ml-auto text-footnote text-muted truncate max-w-[40%] pr-2">{user.tenantName}</div>
      </header>
      {open && <div className="lg:hidden fixed inset-0 z-30 bg-black/30" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`sidebar flex flex-col fixed lg:sticky top-0 h-dvh w-[min(300px,85vw)] lg:w-[var(--sidebar-w)] z-40 transition-transform lg:transition-none ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`} aria-label="Main navigation">
        <div className="flex items-center gap-3 px-5 h-16 shrink-0">
          <Mark size={28} />
          <div className="leading-tight min-w-0">
            <div className="text-headline font-semibold tracking-tight">Crossline</div>
            <div className="text-caption text-muted truncate">{user.tenantName}</div>
          </div>
          <button className="lg:hidden ml-auto btn btn-ghost btn-icon" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className="px-4 pb-2 shrink-0">
          <GlobalSearch />
        </div>
        <nav className="px-3 pb-4 flex-1 overflow-y-auto">
          {NAV.map((g) => {
            const items = g.items.filter((n) => !n.roles || n.roles.includes(user.role));
            if (!items.length) return null;
            return (
              <div key={g.section}>
                <div className="rail-section">{g.section}</div>
                <div className="space-y-0.5">
                  {items.map((n) => {
                    const active = current?.href === n.href;
                    const Icon = n.icon;
                    return (
                      <Link key={n.href} href={n.href} className="rail-link" aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                        <Icon size={18} strokeWidth={1.8} className="shrink-0" aria-hidden />
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="px-4 py-4 border-t border-line shrink-0 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-fill grid place-items-center text-footnote font-semibold text-ink-2 shrink-0" aria-hidden>
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <Link href="/settings/account" className="text-callout font-semibold truncate block hover:text-teal" title="My account" onClick={() => setOpen(false)}>
              {user.name}
            </Link>
            <div className="text-caption text-muted truncate">{ROLE_LABEL[user.role] ?? user.role}</div>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-footnote">
            <Link href="/help" className="text-teal font-medium" onClick={() => setOpen(false)}>
              Help
            </Link>
            <form action={logoutAction}>
              <button className="text-muted hover:text-ink font-medium">Sign out</button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
