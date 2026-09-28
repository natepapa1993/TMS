"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/billing", "Ready to bill"],
  ["/billing/invoices", "Invoices"],
  ["/billing/ar", "Receivables"],
  ["/billing/payments", "Payments"],
  ["/billing/factoring", "Factoring"],
  ["/billing/carriers", "Carrier bills"],
  ["/billing/settlements", "Driver pay"],
  ["/billing/pay-plans", "Pay plans"],
  ["/billing/fuel", "Fuel surcharge"],
  ["/billing/ifta", "IFTA"],
  ["/billing/exports", "QuickBooks"],
];

export function BillingNav({ counts }: { counts?: Record<string, number> }) {
  const path = usePathname();
  return (
    <nav className="subnav">
      {TABS.map(([href, label]) => (
        <Link key={href} href={href} className="stage-tab" aria-current={path === href || (href !== "/billing" && href !== "/compliance" && path.startsWith(href)) ? "page" : undefined} data-active={path === href || (href !== "/billing" && path.startsWith(href))}>
          {label}
          {counts?.[href] != null && <span className="count">{counts[href]}</span>}
        </Link>
      ))}
    </nav>
  );
}
