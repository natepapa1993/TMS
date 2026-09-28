"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The safety pages as one set of tabs. Drug & alcohol shows only to owner and Safety (confidential). */
export function SafetyNav({ role, counts }: { role: string; counts?: Record<string, number> }) {
  const path = usePathname();
  const tabs: [string, string][] = [
    ["/compliance", "Overview"],
    ["/compliance/drivers", "Driver files"],
    ...(["owner", "compliance"].includes(role) ? ([["/compliance/drug-alcohol", "Drug & alcohol"]] as [string, string][]) : []),
    ["/compliance/inspections", "Inspections"],
    ["/compliance/incidents", "Incidents"],
    ["/compliance/overrides", "Overrides"],
  ];
  return (
    <div className="px-7 pb-3 flex items-center gap-1.5 flex-wrap" data-testid="safety-nav">
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} className="stage-tab" data-active={path === href || (href !== "/compliance" && path.startsWith(href))}>
          {label}
          {counts?.[href] ? <span className="count">{counts[href]}</span> : null}
        </Link>
      ))}
    </div>
  );
}
