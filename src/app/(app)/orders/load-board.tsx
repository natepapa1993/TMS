"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid, type GridView, type QuickFilter, type ViewConfig } from "@/components/data-grid";
import { Pill, Toast, useToast } from "@/components/ui";
import type { LoadRow } from "@/domain/load-grid";
import { saveLoadViewAction, deleteLoadViewAction, bulkBookAction } from "./actions";

const STATE_LABEL: Record<string, string> = { draft: "Draft", booked: "Booked", dispatched: "Dispatched", in_transit: "In transit", exception: "On hold", delivered: "Delivered", ready_to_bill: "Ready to bill", invoiced: "Invoiced", paid: "Paid", cancelled: "Cancelled" };
const STATE_TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue" | "navy"> = { draft: "slate", booked: "blue", dispatched: "amber", in_transit: "teal", exception: "red", delivered: "green", ready_to_bill: "green", invoiced: "navy", paid: "slate", cancelled: "slate" };
const EQUIPMENT: Record<string, string> = { "53_dry": "53' van", "53_reefer": "53' reefer", "48_dry": "48' van", flatbed: "Flatbed", sprinter: "Sprinter", straight: "Straight", power_only: "Power only" };

const money = (c: number | null, cur = "USD") => (c == null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(c / 100));
const money0 = (c: number | null, cur = "USD") => (c == null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(c / 100));
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
/** "Toronto, ON · CA" — or the stop's name when it has no city. */
const place = (city: string | null, st: string | null, country: string | null, name?: string | null) => {
  const where = [city, st].filter(Boolean).join(", ") || name || "";
  return [where, country && country !== "US" ? country : ""].filter(Boolean).join(" · ");
};
const sameDay = (s: string | null, d: Date) => !!s && new Date(s).toDateString() === d.toDateString();
const OPEN = ["draft", "booked", "dispatched", "in_transit", "exception"];

const col = (c: ColumnDef<LoadRow, unknown>) => c;

const COLUMNS: ColumnDef<LoadRow, unknown>[] = [
  col({ id: "orderNumber", accessorFn: (r) => r.orderNumber, size: 150, meta: { label: "Load #", mono: true }, header: "Load #", cell: ({ row }) => (
      <>
        {row.original.orderNumber}
        {row.original.kind !== "order" && (
          <span className="ml-1.5">
            <Pill tone={row.original.kind === "trip" ? "navy" : "teal"}>{row.original.kind}</Pill>
          </span>
        )}
      </>
    ) }),
  col({ id: "state", accessorFn: (r) => STATE_LABEL[r.state] ?? r.state, size: 116, filterFn: "select" as never, meta: { label: "Status", filter: "select" }, header: "Status", cell: ({ row }) => <Pill tone={STATE_TONE[row.original.state] ?? "slate"}>{STATE_LABEL[row.original.state] ?? row.original.state}</Pill> }),
  col({ id: "customer", accessorFn: (r) => r.customer ?? "", size: 170, filterFn: "select" as never, meta: { label: "Customer", filter: "select" }, header: "Customer" }),
  col({ id: "broker", accessorFn: (r) => r.broker ?? "", size: 150, filterFn: "select" as never, meta: { label: "Broker", filter: "select" }, header: "Broker" }),
  col({ id: "origin", accessorFn: (r) => place(r.pickupCity, r.pickupState, r.pickupCountry, r.pickupName), size: 160, meta: { label: "Origin" }, header: "Origin", cell: ({ row }) => <span title={row.original.pickupName ?? ""}>{place(row.original.pickupCity, row.original.pickupState, row.original.pickupCountry, row.original.pickupName)}</span> }),
  col({ id: "shipper", accessorFn: (r) => r.pickupName ?? "", size: 170, meta: { label: "Shipper" }, header: "Shipper" }),
  col({ id: "pickupAt", accessorFn: (r) => r.pickupAt ?? "", size: 132, meta: { label: "Pickup", filter: "none", csv: (r) => r.pickupAt ?? "" }, header: "Pickup", cell: ({ row }) => when(row.original.pickupAt) }),
  col({ id: "destination", accessorFn: (r) => place(r.deliveryCity, r.deliveryState, r.deliveryCountry, r.deliveryName), size: 160, meta: { label: "Destination" }, header: "Destination", cell: ({ row }) => <span title={row.original.deliveryName ?? ""}>{place(row.original.deliveryCity, row.original.deliveryState, row.original.deliveryCountry, row.original.deliveryName)}</span> }),
  col({ id: "consignee", accessorFn: (r) => r.deliveryName ?? "", size: 170, meta: { label: "Consignee" }, header: "Consignee" }),
  col({ id: "deliveryAt", accessorFn: (r) => r.deliveryAt ?? "", size: 132, meta: { label: "Delivery", filter: "none", csv: (r) => r.deliveryAt ?? "" }, header: "Delivery", cell: ({ row }) => when(row.original.deliveryAt) }),
  col({ id: "stops", accessorFn: (r) => r.stops, size: 70, meta: { label: "Stops", align: "right", filter: "none" }, header: "Stops" }),
  col({ id: "legs", accessorFn: (r) => r.legs, size: 150, meta: { label: "Legs" }, header: "Legs", cell: ({ row }) => <span className="text-muted">{row.original.legs}</span> }),
  col({ id: "equipment", accessorFn: (r) => EQUIPMENT[r.equipment] ?? r.equipment, size: 104, filterFn: "select" as never, meta: { label: "Equipment", filter: "select" }, header: "Equipment" }),
  col({ id: "truck", accessorFn: (r) => r.truck ?? "", size: 90, meta: { label: "Truck", mono: true }, header: "Truck" }),
  col({ id: "driver", accessorFn: (r) => r.driver ?? "", size: 150, meta: { label: "Driver" }, header: "Driver" }),
  col({ id: "carrier", accessorFn: (r) => r.carrier ?? "", size: 160, filterFn: "select" as never, meta: { label: "Carrier", filter: "select" }, header: "Carrier" }),
  col({ id: "rate", accessorFn: (r) => r.rateCents ?? -1, size: 104, meta: { label: "Rate", align: "right", filter: "none", csv: (r) => (r.rateCents == null ? "" : (r.rateCents / 100).toFixed(2)) }, header: "Rate", cell: ({ row }) => (row.original.rateCents == null ? <span className="text-faint">TBD</span> : money(row.original.rateCents, row.original.currency)) }),
  col({ id: "cost", accessorFn: (r) => r.carrierCostCents, size: 104, meta: { label: "Carrier cost", align: "right", filter: "none", csv: (r) => (r.carrierCostCents / 100).toFixed(2) }, header: "Cost", cell: ({ row }) => (row.original.carrierCostCents ? money(row.original.carrierCostCents, row.original.currency) : <span className="text-faint">—</span>) }),
  col({ id: "margin", accessorFn: (r) => r.marginCents ?? -Infinity, size: 104, meta: { label: "Margin", align: "right", filter: "none", csv: (r) => (r.marginCents == null ? "" : (r.marginCents / 100).toFixed(2)) }, header: "Margin", cell: ({ row }) => (row.original.marginCents == null ? "" : <span className={row.original.marginCents < 0 ? "text-red font-semibold" : ""}>{money(row.original.marginCents, row.original.currency)}</span>) }),
  col({ id: "marginPct", accessorFn: (r) => (r.rateCents ? (r.marginCents ?? 0) / r.rateCents : -Infinity), size: 84, meta: { label: "Margin %", align: "right", filter: "none", csv: (r) => (r.rateCents ? (((r.marginCents ?? 0) / r.rateCents) * 100).toFixed(1) : "") }, header: "Margin %", cell: ({ row }) => (row.original.rateCents ? `${(((row.original.marginCents ?? 0) / row.original.rateCents) * 100).toFixed(0)}%` : "") }),
  col({ id: "miles", accessorFn: (r) => r.miles ?? -1, size: 84, meta: { label: "Miles", align: "right", filter: "none", csv: (r) => r.miles ?? "" }, header: "Miles", cell: ({ row }) => (row.original.miles == null ? <span className="text-faint">—</span> : row.original.miles.toLocaleString("en-US")) }),
  col({ id: "rpm", accessorFn: (r) => r.rpmCents ?? -1, size: 80, meta: { label: "Rate / mile", align: "right", filter: "none", csv: (r) => (r.rpmCents == null ? "" : (r.rpmCents / 100).toFixed(2)) }, header: "RPM", cell: ({ row }) => (row.original.rpmCents == null ? "" : `$${(row.original.rpmCents / 100).toFixed(2)}`) }),
  col({ id: "refs", accessorFn: (r) => r.refs, size: 200, meta: { label: "References" }, header: "References", cell: ({ row }) => <span className="text-muted">{row.original.refs}</span> }),
  col({ id: "po", accessorFn: (r) => r.po ?? "", size: 120, meta: { label: "PO", mono: true }, header: "PO" }),
  col({ id: "reference", accessorFn: (r) => r.reference ?? "", size: 130, meta: { label: "Customer load #", mono: true }, header: "Cust. load #" }),
  col({ id: "rateCon", accessorFn: (r) => r.rateCon ?? "", size: 120, meta: { label: "Rate con #", mono: true }, header: "Rate con #" }),
  col({ id: "bol", accessorFn: (r) => r.bol ?? "", size: 120, meta: { label: "BOL / shipment #", mono: true }, header: "BOL #" }),
  col({ id: "crossing", accessorFn: (r) => r.crossing ?? "", size: 150, filterFn: "select" as never, meta: { label: "Crossing", filter: "select" }, header: "Crossing" }),
  col({ id: "flags", accessorFn: (r) => r.flags, size: 72, meta: { label: "Flags", align: "right", filter: "none" }, header: "Flags", cell: ({ row }) => (row.original.flags ? <Pill tone={row.original.redFlags ? "red" : "amber"}>{row.original.flags}</Pill> : "") }),
  col({ id: "source", accessorFn: (r) => r.source, size: 96, filterFn: "select" as never, meta: { label: "Source", filter: "select" }, header: "Source" }),
  col({ id: "enteredBy", accessorFn: (r) => r.enteredBy ?? "", size: 130, filterFn: "select" as never, meta: { label: "Entered by", filter: "select" }, header: "Entered by" }),
  col({ id: "createdAt", accessorFn: (r) => r.createdAt, size: 124, meta: { label: "Created", filter: "none", csv: (r) => r.createdAt }, header: "Created", cell: ({ row }) => when(row.original.createdAt) }),
  col({ id: "deliveredAt", accessorFn: (r) => r.deliveredAt ?? "", size: 124, meta: { label: "Delivered", filter: "none", csv: (r) => r.deliveredAt ?? "" }, header: "Delivered", cell: ({ row }) => when(row.original.deliveredAt) }),
];

const DEFAULT: ViewConfig = {
  columns: ["orderNumber", "state", "customer", "origin", "pickupAt", "destination", "deliveryAt", "legs", "truck", "driver", "carrier", "rate", "margin", "miles", "rpm", "refs", "flags"],
  hidden: ["broker", "shipper", "consignee", "stops", "equipment", "cost", "marginPct", "po", "reference", "rateCon", "bol", "crossing", "source", "enteredBy", "createdAt", "deliveredAt"],
  sort: [{ id: "createdAt", desc: true }],
  quick: "all",
  pageSize: 50,
};

function Totals({ rows }: { rows: LoadRow[] }) {
  const byCur = new Map<string, { rev: number; cost: number; margin: number; marginRev: number; miles: number; revMiles: number }>();
  let miles = 0;
  for (const r of rows) {
    const t = byCur.get(r.currency) ?? { rev: 0, cost: 0, margin: 0, marginRev: 0, miles: 0, revMiles: 0 };
    if (r.rateCents != null) {
      t.rev += r.rateCents;
      if (r.marginCents != null) {
        t.margin += r.marginCents;
        t.marginRev += r.rateCents;
      }
      if (r.miles) {
        t.revMiles += r.rateCents;
        t.miles += r.miles;
      }
    }
    t.cost += r.carrierCostCents;
    byCur.set(r.currency, t);
    miles += r.miles ?? 0;
  }
  const main = byCur.get("USD") ?? { rev: 0, cost: 0, margin: 0, marginRev: 0, miles: 0, revMiles: 0 };
  const others = [...byCur.entries()].filter(([c]) => c !== "USD");
  const cells: [string, string][] = [
    ["Loads", rows.length.toLocaleString("en-US")],
    ["Loaded miles", miles.toLocaleString("en-US")],
    ["Revenue", money0(main.rev)],
    ["Carrier cost", money0(main.cost)],
    ["Margin (covered)", main.marginRev ? money0(main.margin) : "—"],
    ["Margin %", main.marginRev ? `${((main.margin / main.marginRev) * 100).toFixed(1)}%` : "—"],
    ["Avg rate / mile", main.miles ? `$${(main.revMiles / main.miles / 100).toFixed(2)}` : "—"],
    ...others.map(([c, t]) => [`Revenue ${c}`, money0(t.rev, c)] as [string, string]),
  ];
  return (
    <>
      {cells.map(([k, v]) => (
        <div key={k} className="tot" data-testid={`total-${k}`}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
        </div>
      ))}
    </>
  );
}

export function LoadBoard({ rows, views, role }: { rows: LoadRow[]; views: GridView[]; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [pending, start] = useTransition();
  const today = new Date();
  const quick: QuickFilter<LoadRow>[] = [
    { id: "open", label: "Open", test: (r) => OPEN.includes(r.state) },
    { id: "uncovered", label: "Needs a truck", test: (r) => OPEN.includes(r.state) && r.uncoveredLegs > 0 },
    { id: "today", label: "Picking up today", test: (r) => sameDay(r.pickupAt, today) },
    { id: "transit", label: "In transit", test: (r) => r.state === "in_transit" || r.state === "dispatched" },
    { id: "tobill", label: "To bill", test: (r) => r.state === "delivered" || r.state === "ready_to_bill" },
    { id: "border", label: "Cross-border", test: (r) => r.crossBorder },
    { id: "flags", label: "Flagged", test: (r) => r.flags > 0 },
  ];
  const canBook = ["owner", "dispatcher"].includes(role);
  return (
    <>
      <DataGrid<LoadRow>
        data={rows}
        columns={COLUMNS}
        defaultConfig={DEFAULT}
        quickFilters={quick}
        views={views}
        onSaveView={async (v) => {
          const r = await saveLoadViewAction(v);
          if (r.ok) router.refresh();
          return r;
        }}
        onDeleteView={async (id) => {
          const r = await deleteLoadViewAction(id);
          if (r.ok) router.refresh();
          return r;
        }}
        rowHref={(r) => (r.kind === "trip" ? `/trips/${r.id}` : `/orders/${r.id}`)}
        totals={(r) => <Totals rows={r} />}
        exportName="loads"
        searchPlaceholder="Search load #, customer, city, PO, driver…"
        empty={
          <div>
            <div className="font-bold">No loads yet</div>
            <div className="text-muted text-[13px] mt-1">
              <Link href="/orders/new" className="text-teal font-semibold">
                Build the first one
              </Link>{" "}
              — or press n on Dispatch.
            </div>
          </div>
        }
        bulk={
          canBook
            ? (sel, clear) => {
                const drafts = sel.filter((r) => r.state === "draft");
                return (
                  <button
                    type="button"
                    className="font-semibold text-[12.5px] hover:underline disabled:opacity-40"
                    disabled={!drafts.length || pending}
                    onClick={() =>
                      start(async () => {
                        const r = await bulkBookAction(drafts.map((d) => d.id));
                        if (!r.ok) return t.err(r.error);
                        clear();
                        router.refresh();
                        if (r.data.failed.length) t.err(`Booked ${r.data.booked}; ${r.data.failed.length} could not be booked: ${r.data.failed[0]}`);
                        else t.ok(`Booked ${r.data.booked}`);
                      })
                    }
                  >
                    Book {drafts.length ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"}` : "drafts"}
                  </button>
                );
              }
            : undefined
        }
      />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
