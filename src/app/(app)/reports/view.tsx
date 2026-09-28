"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Spinner } from "@/components/ui";
import { formatCents } from "@/data/fields";
import type { Dashboard, BreakdownRow, Breakdown, Period } from "@/domain/reports";
import { orderDetailAction } from "./actions";

const BY: [Breakdown, string][] = [
  ["truck", "By truck"],
  ["driver", "By driver"],
  ["customer", "By customer"],
  ["lane", "By lane"],
  ["carrier", "By carrier"],
  ["week", "By week"],
];
const PRESETS: [string, string][] = [
  ["week", "This week"],
  ["mtd", "Month to date"],
  ["last_month", "Last month"],
  ["custom", "Custom"],
];

type Detail = { orderId: string; orderNumber: string; revenue: number; carrierCost: number; driverPay: number; fuel: number; extra: number; miles: number; margin: number; deliveredAt: string | null };

export function ReportsView({ dash, rows, by, preset, period, entityId, entities }: { dash: Dashboard; rows: BreakdownRow[]; by: Breakdown; preset: string; period: Period; entityId: string | null; entities: { id: string; name: string }[] }) {
  const zone = useZone();
  const router = useRouter();
  const [custom, setCustom] = useState(period);
  const [open, setOpen] = useState<BreakdownRow | null>(null);
  const [detail, setDetail] = useState<Detail[] | null>(null);
  const [pending, start] = useTransition();
  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams({ range: preset, by, ...(entityId ? { entity: entityId } : {}), ...(preset === "custom" ? { from: period.from, to: period.to } : {}) });
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) p.delete(k);
      else p.set(k, v);
    }
    router.push(`/reports?${p.toString()}`);
  };
  const drill = (r: BreakdownRow) => {
    setOpen(r);
    setDetail(null);
    start(async () => {
      const x = await orderDetailAction(period, entityId, r.orderIds);
      setDetail(x.ok ? (JSON.parse(JSON.stringify(x.data)) as Detail[]) : []);
    });
  };
  const csv = `/api/reports?by=${by}&from=${period.from}&to=${period.to}${entityId ? `&entity=${entityId}` : ""}`;
  const cards: { label: string; value: string; sub: string; href: string; tone?: "red" | "amber" }[] = [
    { label: "Revenue per truck", value: formatCents(dash.revenuePerTruckCents), sub: `${formatCents(dash.revenueCents)} on ${dash.loads} load${dash.loads === 1 ? "" : "s"} · ${dash.activeTrucks} active unit${dash.activeTrucks === 1 ? "" : "s"}`, href: "?by=truck" },
    { label: "Empty miles", value: `${dash.emptyPct}%`, sub: "equipment moves over all planned miles on our trucks", href: "?by=truck" },
    { label: "Margin", value: `${dash.marginPct}%`, sub: `${formatCents(dash.marginCents)} after carriers, driver pay, fuel and tolls`, href: "?by=customer" },
    { label: "Loads at risk", value: String(dash.atRisk.count), sub: dash.atRisk.count ? dash.atRisk.orders.slice(0, 3).map((o) => o.orderNumber).join(", ") : "no red flags on moving loads", href: "/dispatch", tone: dash.atRisk.count ? "red" : undefined },
    { label: "Crossings pending", value: String(dash.crossingsPending.count), sub: Object.entries(dash.crossingsPending.byBucket).map(([k, n]) => `${n} ${k}`).join(" · ") || "nothing at the border", href: "/crossing", tone: dash.crossingsPending.byBucket.held ? "red" : undefined },
    { label: "Expiring documents", value: String(dash.expiringDocs.count), sub: `${dash.expiringDocs.expired} expired · ${dash.expiringDocs.expiring} expiring · ${dash.expiringDocs.missing} missing`, href: "/compliance", tone: dash.expiringDocs.expired ? "red" : dash.expiringDocs.count ? "amber" : undefined },
  ];
  return (
    <>
      <div className="flex items-end gap-2 flex-wrap mb-4">
        <div className="flex gap-1.5">
          {PRESETS.map(([k, l]) => (
            <button key={k} className="stage-tab" data-active={preset === k} onClick={() => go({ range: k, ...(k === "custom" ? { from: custom.from, to: custom.to } : { from: null, to: null }) })}>
              {l}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-end gap-2">
            <input type="date" className="input" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <input type="date" className="input" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
            <button className="btn" onClick={() => go({ range: "custom", from: custom.from, to: custom.to })}>
              Apply
            </button>
          </div>
        )}
        <div className="text-callout text-muted mono">
          {period.from} → {period.to}
        </div>
        {entities.length > 1 && (
          <select className="select w-56 ml-auto" value={entityId ?? ""} onChange={(e) => go({ entity: e.target.value || null })} aria-label="Entity">
            <option value="">All entities</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5" data-testid="six">
        {cards.map((c) => (
          <Link key={c.label} href={c.href.startsWith("?") ? `/reports?range=${preset}&by=${c.href.slice(4)}${entityId ? `&entity=${entityId}` : ""}` : c.href} className="card p-4 hover:border-teal transition-colors">
            <div className="eyebrow">{c.label}</div>
            <div className={`text-title2 font-extrabold mono mt-1 ${c.tone === "red" ? "text-red" : c.tone === "amber" ? "text-amber" : ""}`}>{c.value}</div>
            <div className="text-footnote text-muted mt-1 leading-snug">{c.sub}</div>
          </Link>
        ))}
      </div>
      <div className="text-footnote text-muted mb-3" data-testid="reports-fx">
        All figures in US dollars{dash.fxNote ? ` — converted: ${dash.fxNote}` : ""}. Revenue is net of credit memos{dash.creditedCents ? ` (${formatCents(dash.creditedCents)} credited)` : ""}.
        {dash.fxRealizedCents ? ` Realized exchange ${dash.fxRealizedCents > 0 ? "gain" : "loss"} on pesos / Canadian dollars received: ${formatCents(Math.abs(dash.fxRealizedCents))} (the day's rate against the invoice's; not in the margin).` : ""}
      </div>
      {dash.arOpenCents > 0 && (
        <div className="text-callout text-muted mb-4">
          Receivables open {formatCents(dash.arOpenCents)}
          {dash.arOverdueCents > 0 && (
            <>
              {" "}
              · <span className="text-red font-semibold">{formatCents(dash.arOverdueCents)} past due</span>
            </>
          )}{" "}
          —{" "}
          <Link href="/billing/ar" className="text-teal font-semibold">
            aging
          </Link>
        </div>
      )}

      <div className="flex items-center gap-1.5 mb-3">
        {BY.map(([k, l]) => (
          <button key={k} className="stage-tab" data-active={by === k} onClick={() => go({ by: k })}>
            {l}
          </button>
        ))}
        <a className="btn btn-sm ml-auto" href={csv}>
          Export CSV
        </a>
      </div>
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center font-bold">No delivered loads in this period</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{BY.find(([k]) => k === by)?.[1].replace("By ", "")}</th>
                <th className="text-right">Loads</th>
                <th className="text-right">Revenue</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Margin</th>
                <th className="text-right">Margin %</th>
                <th className="text-right">Miles</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="cursor-pointer" onClick={() => drill(r)} title="Open the loads behind this number">
                  <td className="font-bold">{r.label}</td>
                  <td className="text-right mono">{r.loads}</td>
                  <td className="text-right mono font-semibold">{formatCents(r.revenueCents)}</td>
                  <td className="text-right mono text-muted">{formatCents(r.costCents)}</td>
                  <td className={`text-right mono font-extrabold ${r.marginCents < 0 ? "text-red" : ""}`}>{formatCents(r.marginCents)}</td>
                  <td className="text-right">
                    <Pill tone={r.marginPct < 0 ? "red" : r.marginPct < 15 ? "amber" : "green"}>{r.marginPct}%</Pill>
                  </td>
                  <td className="text-right mono text-muted">{r.miles ? r.miles.toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-extrabold">
                <td>Total</td>
                <td className="text-right mono" title="Each load counted once, even when it is split between rows">{new Set(rows.flatMap((r) => r.orderIds)).size}</td>
                <td className="text-right mono">{formatCents(rows.reduce((a, r) => a + r.revenueCents, 0))}</td>
                <td className="text-right mono">{formatCents(rows.reduce((a, r) => a + r.costCents, 0))}</td>
                <td className="text-right mono">{formatCents(rows.reduce((a, r) => a + r.marginCents, 0))}</td>
                <td></td>
                <td className="text-right mono">{rows.reduce((a, r) => a + r.miles, 0).toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {open && (
        <Modal open onClose={() => setOpen(null)} wide title={`${open.label} · ${open.loads} load${open.loads === 1 ? "" : "s"}`} footer={<button className="btn" onClick={() => setOpen(null)}>Close</button>}>
          {pending || !detail ? (
            <div className="py-6 text-center">
              <Spinner />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Delivered</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Carrier</th>
                  <th className="text-right">Driver pay</th>
                  <th className="text-right">Fuel</th>
                  <th className="text-right">Tolls</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((d) => (
                  <tr key={d.orderId}>
                    <td>
                      <Link href={`/orders/${d.orderId}#charges`} className="font-extrabold mono text-teal">
                        {d.orderNumber}
                      </Link>
                    </td>
                    <td className="text-muted text-callout">{d.deliveredAt ? fmtWhen(d.deliveredAt, zone, { style: "date" }) : "—"}</td>
                    <td className="text-right mono">{formatCents(d.revenue)}</td>
                    <td className="text-right mono text-muted">{d.carrierCost ? formatCents(d.carrierCost) : "—"}</td>
                    <td className="text-right mono text-muted">{d.driverPay ? formatCents(d.driverPay) : "—"}</td>
                    <td className="text-right mono text-muted">{d.fuel ? `${formatCents(d.fuel)} (${d.miles} mi)` : "—"}</td>
                    <td className="text-right mono text-muted">{d.extra ? formatCents(d.extra) : "—"}</td>
                    <td className={`text-right mono font-extrabold ${d.margin < 0 ? "text-red" : ""}`}>{formatCents(d.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="help mt-2">Driver pay is what the statement paid, or — until one has — an estimate from the driver&rsquo;s pay rule (a percent is of the leg&rsquo;s share of the load). Fuel is the miles on our trucks (typed, else estimated from the stops) × the company cost per mile. Carrier cost is the bill (or the tender rate until one exists). A load split between trucks, drivers or carriers is shared by its legs&rsquo; miles, so every table adds up to the tiles.</div>
        </Modal>
      )}
    </>
  );
}
