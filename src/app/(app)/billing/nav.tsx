"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/billing", "Ready to bill"],
  ["/billing/invoices", "Invoices"],
  ["/billing/ar", "Receivables"],
  ["/billing/carriers", "Carrier bills"],
  ["/billing/settlements", "Driver pay"],
];

export function BillingNav({ counts }: { counts?: Record<string, number> }) {
  const path = usePathname();
  return (
    <div className="px-7 pb-3 flex items-center gap-1.5 flex-wrap">
      {TABS.map(([href, label]) => (
        <Link key={href} href={href} className="stage-tab" data-active={path === href || (href !== "/billing" && path.startsWith(href))}>
          {label}
          {counts?.[href] != null && <span className="count">{counts[href]}</span>}
        </Link>
      ))}
    </div>
  );
}
