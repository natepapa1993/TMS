"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "./mark";
import { ArrowLeftRight, BarChart3, Building2, Cable, CalendarRange, FileText, HandCoins, Handshake, Landmark, LayoutGrid, Map as MapIcon, MapPin, MessageSquare, Package, Plug, Receipt, Route, Settings, ShieldCheck, SlidersHorizontal, Fuel, Scale, TriangleAlert, Truck, Users, Wallet, type LucideIcon } from "lucide-react";
import { logoutAction } from "@/app/(auth)/actions";
import { GlobalSearch } from "./global-search";

type NavItem = { href: string; label: string; icon: LucideIcon; roles?: string[] };
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Operations",
    items: [
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
    section: "Accounting",
    items: [
      { href: "/billing", label: "Billing", icon: Receipt, roles: ["owner", "dispatcher", "billing"] },
      { href: "/billing/invoices", label: "Invoices", icon: FileText, roles: ["owner", "billing"] },
      { href: "/billing/ar", label: "Receivables", icon: Landmark, roles: ["owner", "billing"] },
      { href: "/billing/carriers", label: "Carrier pay", icon: HandCoins, roles: ["owner", "billing"] },
      { href: "/billing/settlements", label: "Driver pay", icon: Wallet, roles: ["owner", "billing"] },
      { href: "/billing/pay-plans", label: "Pay plans", icon: SlidersHorizontal, roles: ["owner", "billing"] },
      { href: "/billing/fuel", label: "Fuel surcharge", icon: Fuel, roles: ["owner", "billing"] },
      { href: "/billing/ifta", label: "IFTA", icon: Scale, roles: ["owner", "billing"] },
    ],
  },
  {
    section: "Safety",
    items: [
      { href: "/compliance", label: "Compliance", icon: ShieldCheck },
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
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[224px_1fr]">
      {/* phone / tablet top bar */}
      <header className="lg:hidden sticky top-0 z-30 bg-navy text-white h-12 flex items-center gap-3 px-3">
        <button className="w-9 h-9 -ml-1 rounded-md hover:bg-white/10 text-xl leading-none" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          ☰
        </button>
        <Mark size={22} />
        <div className="font-semibold tracking-tight">{current?.label ?? "Crossline"}</div>
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
        <div className="px-3 pb-2">
          <GlobalSearch />
        </div>
        <nav className="px-2 pb-3 flex-1 overflow-y-auto">
          {NAV.map((g) => {
            const items = g.items.filter((n) => !n.roles || n.roles.includes(user.role));
            if (!items.length) return null;
            return (
              <div key={g.section}>
                <div className="rail-section">{g.section}</div>
                <div className="space-y-px">
                  {items.map((n) => {
                    const active = current?.href === n.href;
                    const Icon = n.icon;
                    return (
                      <Link key={n.href} href={n.href} className="rail-link" aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                        <Icon size={16} strokeWidth={1.8} className="shrink-0 opacity-90" aria-hidden />
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
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
