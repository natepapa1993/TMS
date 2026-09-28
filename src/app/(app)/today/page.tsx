import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { ownerToday, type MoneyLine } from "@/domain/today";
import { PageHeader } from "@/components/page-header";
import { formatCents } from "@/data/fields";
import { approvalsQueue, overridesNeedOwner } from "@/domain/approvals";
import { Approvals } from "./approvals";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

type Tile = { label: string; value: string; sub: string; href: string; tone?: "red" | "amber" | "green"; testid: string };

/** "$12,400.00 · MX$53,100.00" — one figure per currency, never added together. */
const perCurrency = (lines: MoneyLine[]) => (lines.length ? lines.map((l) => formatCents(l.cents, l.currency)).join(" · ") : "$0");
const count = (lines: MoneyLine[]) => lines.reduce((a, l) => a + l.count, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The owner's morning (owner top-15 #6): cash coming in and going out this week, what waits for their
 * approval, loads in trouble, trucks with nothing to do tomorrow, papers about to run out. Every number is
 * a link to the list behind it.
 */
export default async function TodayPage() {
  const ctx = await requireCtx();
  const d = await ownerToday(ctx);
  const [approvals, needOwner] = ctx.role === "owner" ? await Promise.all([approvalsQueue(ctx), overridesNeedOwner(ctx.tenantId)]) : [null, false];
  const week = `${new Date(d.week.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(new Date(d.week.end).getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const groups: { title: string; tiles: Tile[] }[] = [];
  if (d.cashIn && d.cashOut) {
    groups.push({
      title: "Cash this week",
      tiles: [
        { label: "Coming in this week", value: perCurrency(d.cashIn.dueThisWeek), sub: `${plural(count(d.cashIn.dueThisWeek), "invoice")} due ${week}`, href: "/billing/ar", testid: "cash-due", tone: undefined },
        { label: "Overdue", value: perCurrency(d.cashIn.overdue), sub: count(d.cashIn.overdue) ? `${plural(count(d.cashIn.overdue), "invoice")} past due — call them` : "nothing past due", href: "/billing/ar", tone: count(d.cashIn.overdue) ? "red" : "green", testid: "cash-overdue" },
        { label: "Carrier bills to pay", value: perCurrency(d.cashOut.carrierBills), sub: count(d.cashOut.carrierBills) ? `${plural(count(d.cashOut.carrierBills), "bill")} approved, due by the end of the week` : "no approved bills due", href: "/billing/carriers", testid: "cash-carriers" },
        { label: "Driver pay due", value: perCurrency(d.cashOut.driverPay), sub: count(d.cashOut.driverPay) ? `${plural(count(d.cashOut.driverPay), "statement")} reviewed or approved, not paid` : "no statements waiting", href: "/billing/settlements", testid: "cash-drivers" },
      ],
    });
  }
  groups.push({
    title: "Waiting on you",
    tiles: [
      { label: "Extras to approve", value: String(d.approvals.accessorials), sub: d.approvals.accessorials ? "detention, lumper and other extras waiting for the customer's OK" : "none waiting", href: "/billing", tone: d.approvals.accessorials ? "amber" : undefined, testid: "approve-extras" },
      { label: "Overrides this week", value: String(d.approvals.overrides), sub: d.approvals.overrides ? "paperwork and schedule blocks someone waved through — review them" : "nobody overrode a block", href: "/compliance/overrides", tone: d.approvals.overrides ? "amber" : undefined, testid: "approve-overrides" },
      { label: "Renewals to check", value: String(d.approvals.renewals), sub: d.approvals.renewals ? "documents drivers sent from their phones" : "nothing sent in", href: "/compliance", tone: d.approvals.renewals ? "amber" : undefined, testid: "approve-renewals" },
      ...(d.billing ? [{ label: "Ready to bill", value: String(d.billing.readyToBill), sub: d.billing.missingPod ? `${d.billing.missingPod} more delivered without a POD` : "delivered with the POD on file", href: "/billing", tone: d.billing.missingPod ? ("amber" as const) : undefined, testid: "ready-to-bill" }] : []),
    ],
  });
  groups.push({
    title: "Loads and trucks",
    tiles: [
      { label: "Late", value: String(d.loads.late), sub: d.loads.late ? "ETA past the appointment, or the appointment passed" : "nothing late", href: "/dispatch?chip=late", tone: d.loads.late ? "red" : "green", testid: "loads-late" },
      { label: "At risk", value: String(d.loads.atRisk), sub: d.loads.atRisk ? "ETA within an hour of the appointment, or a tender about to expire" : "nothing at risk", href: "/dispatch?chip=at_risk", tone: d.loads.atRisk ? "amber" : undefined, testid: "loads-risk" },
      { label: "No truck < 24 h", value: String(d.loads.noTruckSoon), sub: d.loads.noTruckSoon ? "picks up within a day and a leg still needs a truck" : "everything picking up soon is covered", href: "/dispatch?chip=uncovered_soon", tone: d.loads.noTruckSoon ? "red" : "green", testid: "loads-uncovered" },
      { label: "Trucks empty tomorrow", value: String(d.trucksEmptyTomorrow), sub: d.trucksEmptyTomorrow ? "free by tomorrow night with no next load" : "every truck has its next load", href: "/dispatch/planner", tone: d.trucksEmptyTomorrow ? "amber" : undefined, testid: "trucks-empty" },
      { label: "Expiring documents", value: String(d.documents.expiring + d.documents.expired), sub: `${d.documents.expired} expired · ${d.documents.expiring} expiring soon`, href: "/compliance", tone: d.documents.expired ? "red" : d.documents.expiring ? "amber" : undefined, testid: "docs-expiring" },
    ],
  });
  return (
    <div>
      <PageHeader eyebrow={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} title="Today">
        What needs you this morning. Every number opens the list behind it. Money is shown per currency.
      </PageHeader>
      <div className="px-gutter pb-10 space-y-6" data-testid="today">
        {approvals && <Approvals rows={approvals} needOwner={needOwner} />}
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <div className="eyebrow mb-2">{g.title}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {g.tiles.map((c) => (
                <Link key={c.label} href={c.href} className="card p-4 hover:border-teal transition-colors min-w-0" data-testid={c.testid}>
                  <div className="eyebrow">{c.label}</div>
                  <div className={`text-title2 font-extrabold mono mt-1 break-words ${c.tone === "red" ? "text-red" : c.tone === "amber" ? "text-amber" : c.tone === "green" ? "text-green" : ""}`}>{c.value}</div>
                  <div className="text-footnote text-muted mt-1 leading-snug">{c.sub}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
