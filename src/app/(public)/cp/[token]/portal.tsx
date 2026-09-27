"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui";
import { portalRequestLoadAction } from "../../actions";

/** The customer's page: their loads with live tracking, delivered loads with the POD, invoices and balance, and a load request form. */

type Stop = { id: string; seq: number; type: string; name: string; city: string | null; state: string | null; country: string; windowStart: string | null; windowEnd: string | null; arrivedAt: string | null; departedAt: string | null };
type Load = { id: string; orderNumber: string; state: string; stateLabel: string; step: string | null; equipment: string; refs: { po: string | null; shipment: string | null; reference: string | null; rate_con: string | null }; cargoNote: string | null; stops: Stop[]; deliveredAt: string | null; createdAt: string; source: string; trackingUrl: string | null; docs: { id: string; code: string; fileName: string; createdAt: string }[]; invoice: { id: string; number: string | null; state: string; totalCents: number; url: string | null } | null };
type Invoice = { id: string; number: string | null; state: string; issuedAt: string | null; dueAt: string | null; totalCents: number; openCents: number; pastDueDays: number; currency: string; orders: string[]; url: string | null };
type Data = { company: string; customer: { id: string; name: string; kind: string; termsDays: number | null }; active: Load[]; requested: Load[]; delivered: Load[]; cancelled: Load[]; invoices: Invoice[]; balance: { openCents: number; pastDueCents: number; currency: string } };

const money = (c: number, cur = "USD") => `${cur === "USD" ? "$" : cur + " "}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT" : null);
const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const placeOf = (s: Stop) => `${s.name}${s.city ? ` · ${s.city}` : ""}${s.state ? `, ${s.state}` : ""}`;
const DOC_LABEL: Record<string, string> = { POD: "Proof of delivery", BOL: "Bill of lading", RATE_CON: "Rate confirmation", carta_porte: "Carta porte", invoice: "Commercial invoice", packing_list: "Packing list" };
const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { draft: "blue", booked: "slate", dispatched: "teal", in_transit: "teal", exception: "red", delivered: "green", ready_to_bill: "green", invoiced: "green", paid: "green", cancelled: "slate" };
const INV_TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green" | "blue"> = { issued: "amber", sent: "amber", partially_paid: "amber", paid: "green", closed: "green", void: "slate", disputed: "red" };
const EQUIPMENT: [string, string][] = [["53_dry", "53' dry van"], ["53_reefer", "53' reefer"], ["48_dry", "48' dry van"], ["flatbed", "Flatbed"], ["sprinter", "Sprinter"], ["straight", "Straight truck"]];

export function CustomerPortal({ token, data }: { token: string; data: Data }) {
  const [tab, setTab] = useState<"loads" | "delivered" | "invoices" | "request">(data.active.length || data.requested.length ? "loads" : data.delivered.length ? "delivered" : "request");
  const counts = { loads: data.active.length + data.requested.length, delivered: data.delivered.length, invoices: data.invoices.filter((i) => i.openCents > 0).length, request: 0 };
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">{data.company} · customer portal</div>
          <div className="h1">{data.customer.name}</div>
          <div className="text-[12.5px] text-muted mt-0.5">Your loads with {data.company}: where they are, the paperwork, and your invoices. Keep this link — it is yours.</div>
        </div>
        {data.balance.pastDueCents > 0 ? <Pill tone="red">{money(data.balance.pastDueCents, data.balance.currency)} past due</Pill> : data.balance.openCents > 0 ? <Pill tone="amber">{money(data.balance.openCents, data.balance.currency)} open</Pill> : <Pill tone="green">Nothing owed</Pill>}
      </div>

      <div className="flex gap-1.5 mt-4 flex-wrap">
        {(
          [
            ["loads", "Loads"],
            ["delivered", "Delivered"],
            ["invoices", "Invoices"],
            ["request", "Request a load"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className="stage-tab" data-active={tab === k} onClick={() => setTab(k)}>
            {l} {counts[k] > 0 && <span className="count">{counts[k]}</span>}
          </button>
        ))}
      </div>

      {tab === "loads" && (
        <div className="mt-4 space-y-3">
          {data.active.length + data.requested.length === 0 && (
            <div className="card p-5 text-center text-muted">
              Nothing moving right now.{" "}
              <button className="text-teal font-semibold" onClick={() => setTab("request")}>
                Request a load →
              </button>
            </div>
          )}
          {data.requested.map((l) => (
            <LoadCard key={l.id} l={l} token={token} />
          ))}
          {data.active.map((l) => (
            <LoadCard key={l.id} l={l} token={token} />
          ))}
        </div>
      )}

      {tab === "delivered" && (
        <div className="mt-4 space-y-3">
          {data.delivered.length === 0 && <div className="card p-5 text-center text-muted">No deliveries in the last 90 days.</div>}
          {data.delivered.map((l) => (
            <LoadCard key={l.id} l={l} token={token} />
          ))}
        </div>
      )}

      {tab === "invoices" && (
        <div className="mt-4">
          <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="eyebrow">Balance</div>
              <div className="text-[22px] font-extrabold mono">{money(data.balance.openCents, data.balance.currency)}</div>
              <div className="text-[12px] text-muted">
                {data.balance.pastDueCents > 0 ? `${money(data.balance.pastDueCents, data.balance.currency)} of it past due` : "nothing past due"}
                {data.customer.termsDays ? ` · terms net ${data.customer.termsDays}` : ""}
              </div>
            </div>
          </div>
          <div className="card mt-3 overflow-x-auto">
            {data.invoices.length === 0 ? (
              <div className="p-5 text-center text-muted">No invoices yet.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Loads</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Open</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="font-bold mono">{i.number ?? "—"}</div>
                        <Pill tone={INV_TONE[i.state] ?? "slate"}>{i.state === "partially_paid" ? "partly paid" : i.state}</Pill>
                      </td>
                      <td className="text-[12.5px] mono">{i.orders.join(", ")}</td>
                      <td className="text-[12.5px]">{day(i.issuedAt)}</td>
                      <td className="text-[12.5px]">
                        {day(i.dueAt)}
                        {i.pastDueDays > 0 && <div className="text-red text-[11.5px] font-semibold">{i.pastDueDays} d past due</div>}
                      </td>
                      <td className="text-right mono">{money(i.totalCents, i.currency)}</td>
                      <td className="text-right mono font-bold">{i.openCents ? money(i.openCents, i.currency) : "—"}</td>
                      <td className="text-right">
                        {i.url && (
                          <a className="btn btn-sm" href={i.url} target="_blank" rel="noreferrer">
                            PDF
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "request" && <RequestForm token={token} company={data.company} onDone={() => setTab("loads")} />}
    </div>
  );
}

function LoadCard({ l, token }: { l: Load; token: string }) {
  const [open, setOpen] = useState(false);
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const next = l.stops.find((s) => !s.departedAt);
  return (
    <div className="card p-4" data-testid="load-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold mono">{l.orderNumber}</span>
            <Pill tone={TONE[l.state] ?? "slate"}>{l.stateLabel}</Pill>
            {l.step && ["dispatched", "in_transit", "exception"].includes(l.state) && <span className="text-[12px] text-muted">{l.step}</span>}
          </div>
          <div className="font-bold text-[14px] mt-1 truncate">
            {first ? placeOf(first) : "—"} → {last ? placeOf(last) : "—"}
          </div>
          <div className="text-[12.5px] text-muted mt-0.5">
            {[l.refs.po && `PO ${l.refs.po}`, l.refs.shipment && `Shipment ${l.refs.shipment}`, l.refs.reference && `Ref ${l.refs.reference}`, l.equipment.replace("_", " ")].filter(Boolean).join(" · ")}
          </div>
          {l.state === "draft" && <div className="text-[12.5px] text-blue mt-1">Received. Dispatch will price it and confirm with you before it moves.</div>}
          {["booked", "dispatched", "in_transit", "exception"].includes(l.state) && next && (
            <div className="text-[12.5px] mt-1">
              Next stop: <b>{next.name}</b>
              {next.windowStart ? ` · ${when(next.windowStart)}${next.windowEnd ? ` – ${when(next.windowEnd)}` : ""}` : ""}
              {next.arrivedAt ? ` · arrived ${when(next.arrivedAt)}` : ""}
            </div>
          )}
          {l.deliveredAt && <div className="text-[12.5px] text-green mt-1">Delivered {when(l.deliveredAt)}</div>}
        </div>
        <div className="flex flex-col gap-1.5 items-end shrink-0">
          {l.trackingUrl && ["booked", "dispatched", "in_transit", "exception"].includes(l.state) && (
            <a className="btn btn-sm btn-primary" href={l.trackingUrl} target="_blank" rel="noreferrer">
              Track
            </a>
          )}
          {l.docs.map((d) => (
            <a key={d.id} className="btn btn-sm" href={`/cp/${token}/doc/${d.id}`} target="_blank" rel="noreferrer">
              {DOC_LABEL[d.code] ?? d.code}
            </a>
          ))}
          {l.invoice?.url && (
            <a className="btn btn-sm" href={l.invoice.url} target="_blank" rel="noreferrer">
              Invoice {l.invoice.number}
            </a>
          )}
        </div>
      </div>
      <button className="text-[12px] text-muted mt-2 font-semibold" onClick={() => setOpen(!open)}>
        {open ? "Hide stops ▴" : `${l.stops.length} stops ▾`}
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5">
          {l.stops.map((s, i) => (
            <li key={s.id} className="flex gap-2 text-[13px]">
              <span className="mono text-faint w-4">{i + 1}</span>
              <div>
                <div className="font-semibold">
                  {placeOf(s)} <span className="text-faint font-normal">· {s.type.replace("_", " ")}</span>
                </div>
                <div className="text-[12px] text-muted">
                  {s.windowStart ? `window ${when(s.windowStart)}${s.windowEnd ? ` – ${when(s.windowEnd)}` : ""}` : ""}
                  {s.arrivedAt ? `${s.windowStart ? " · " : ""}in ${when(s.arrivedAt)}` : ""}
                  {s.departedAt ? ` · out ${when(s.departedAt)}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RequestForm({ token, company, onDone }: { token: string; company: string; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [f, setF] = useState({ pName: "", pCity: "", pState: "", pCountry: "US", pWhen: "", dName: "", dCity: "", dState: "", dCountry: "US", dWhen: "", equipment: "53_dry", po: "", reference: "", cargo: "", contact: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = () =>
    start(async () => {
      setErr(null);
      const r = await portalRequestLoadAction(token, {
        pickup: { name: f.pName, city: f.pCity, state: f.pState, country: f.pCountry, windowStart: f.pWhen ? new Date(f.pWhen) : null },
        delivery: { name: f.dName, city: f.dCity, state: f.dState, country: f.dCountry, windowStart: f.dWhen ? new Date(f.dWhen) : null },
        equipment: f.equipment,
        po: f.po,
        reference: f.reference,
        cargoNote: f.cargo,
        contact: f.contact,
      });
      if (r.ok) {
        setDone(r.data.orderNumber);
        router.refresh();
      } else setErr({ message: r.error, field: r.field });
    });
  if (done)
    return (
      <div className="card p-6 mt-4 text-center">
        <div className="h2">Request received</div>
        <p className="text-muted mt-1">
          It is <b className="mono">{done}</b> with {company}. Dispatch will price it and confirm with you before it moves.
        </p>
        <button className="btn btn-primary mt-4" onClick={onDone}>
          See your loads
        </button>
      </div>
    );
  return (
    <div className="card p-5 mt-4">
      <div className="h2">Request a load</div>
      <div className="text-[12.5px] text-muted mt-0.5 mb-3">Two ends and what it is. {company} prices it and confirms with you; nothing moves until then.</div>
      <div className="eyebrow mb-1">Pickup</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">Shipper / location</label>
          <input className="input" value={f.pName} onChange={set("pName")} placeholder="Magna Ramos Arizpe" aria-invalid={err?.field === "pickup"} />
        </div>
        <div>
          <label className="label">City</label>
          <input className="input" value={f.pCity} onChange={set("pCity")} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">State</label>
            <input className="input" value={f.pState} onChange={set("pState")} placeholder="TX" />
          </div>
          <div>
            <label className="label">Country</label>
            <select className="select" value={f.pCountry} onChange={set("pCountry")}>
              <option value="US">US</option>
              <option value="MX">MX</option>
            </select>
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">Ready when</label>
          <input type="datetime-local" className="input" value={f.pWhen} onChange={set("pWhen")} />
        </div>
      </div>
      <div className="eyebrow mb-1 mt-4">Delivery</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">Consignee / location</label>
          <input className="input" value={f.dName} onChange={set("dName")} placeholder="Magna Arlington" aria-invalid={err?.field === "delivery"} />
        </div>
        <div>
          <label className="label">City</label>
          <input className="input" value={f.dCity} onChange={set("dCity")} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">State</label>
            <input className="input" value={f.dState} onChange={set("dState")} />
          </div>
          <div>
            <label className="label">Country</label>
            <select className="select" value={f.dCountry} onChange={set("dCountry")}>
              <option value="US">US</option>
              <option value="MX">MX</option>
            </select>
          </div>
        </div>
        <div className="col-span-2">
          <label className="label">Deliver by</label>
          <input type="datetime-local" className="input" value={f.dWhen} onChange={set("dWhen")} />
        </div>
      </div>
      <div className="eyebrow mb-1 mt-4">The load</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Equipment</label>
          <select className="select" value={f.equipment} onChange={set("equipment")}>
            {EQUIPMENT.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">PO #</label>
          <input className="input" value={f.po} onChange={set("po")} />
        </div>
        <div>
          <label className="label">Your reference</label>
          <input className="input" value={f.reference} onChange={set("reference")} />
        </div>
        <div>
          <label className="label">Who to call</label>
          <input className="input" value={f.contact} onChange={set("contact")} placeholder="Ana · +52 844 000 0000" />
        </div>
        <div className="col-span-2">
          <label className="label">What is it</label>
          <input className="input" value={f.cargo} onChange={set("cargo")} placeholder="26 pallets seats · 38,000 lb · no hazmat" />
        </div>
      </div>
      {err && <div className="error mt-3">{err.message}</div>}
      <button className="btn btn-primary w-full justify-center mt-4" style={{ height: 48 }} disabled={pending} onClick={submit}>
        {pending ? "Sending…" : "Send the request"}
      </button>
    </div>
  );
}
