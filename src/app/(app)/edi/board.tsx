"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Pill, Empty, Toast, useToast } from "@/components/ui";
import { respondTenderAction, receivePastedAction, emit214NowAction } from "./actions";

type Msg = { id: string; direction: string; type: string; controlNumber: string | null; orderId: string | null; invoiceId: string | null; summary: string; state: string; error: string | null; ackedAt: string | null; createdAt: string };
type Local = { date: string; time: string; code: string | null };
type Stop = { seq: number; type: string; party: { name: string; line1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null } | null; earliest: string | null; latest: string | null; earliestLocal: Local | null; latestLocal: Local | null; appointment: boolean; commodity: string | null; pieces: number | null; weightLbs: number | null; notes: string[] };
type Tender = { purpose: string; theirRef: string; refs: Record<string, string>; equipment: { code: string | null; number: string | null; length: number | null } | null; stops: Stop[]; totalWeightLbs: number | null; rateCents: number | null; notes: string[] };
type InboxRow = { m: Msg; theirId: string; customer: string; orderNumber: string | null; tender: Tender | null };
type LogRow = { m: Msg; theirId: string; customer: string; orderNumber: string | null };

const TONE: Record<string, "slate" | "teal" | "amber" | "red" | "green"> = { queued: "amber", sent: "green", logged: "teal", received: "amber", accepted: "green", rejected: "slate", error: "red" };
const money = (c: number | null) => (c == null ? "TBD" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const when = (s: string | null, zone: string) => fmtWhen(s, zone, { style: "short" }) ?? "—";
/** A tender's wall-clock time as the customer wrote it (the stop's local time). */
const local = (l: Local | null) => {
  if (!l) return "—";
  const h = Number(l.time.slice(0, 2));
  const m = l.time.slice(2, 4);
  const d = new Date(`${l.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${d}, ${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}${l.code ? ` ${l.code}` : ""}`;
};

export function EdiBoard({ inbox, log, partners, role }: { inbox: InboxRow[]; log: LogRow[]; partners: { id: string; label: string }[]; role: string }) {
  const zone = useZone();
  const router = useRouter();
  const t = useToast();
  const [tab, setTab] = useState<"inbox" | "log">(inbox.length ? "inbox" : "log");
  const [open, setOpen] = useState<InboxRow | null>(null);
  const [declining, setDeclining] = useState<InboxRow | null>(null);
  const [paste, setPaste] = useState(false);
  const [pending, start] = useTransition();
  const can = ["owner", "dispatcher"].includes(role);
  const accept = (row: InboxRow) =>
    start(async () => {
      const r = await respondTenderAction(row.m.id, true);
      if (r.ok) {
        t.ok(`Accepted — draft order created, 990 sent`);
        setOpen(null);
        router.refresh();
      } else t.err(r.error);
    });
  return (
    <>
      <div className="flex items-center gap-1.5 mb-4">
        <button className="stage-tab" data-active={tab === "inbox"} onClick={() => setTab("inbox")}>
          Inbox {inbox.length > 0 && <span className="count">{inbox.length}</span>}
        </button>
        <button className="stage-tab" data-active={tab === "log"} onClick={() => setTab("log")}>
          Log
        </button>
        <div className="ml-auto flex gap-2">
          {can && (
            <button className="btn" onClick={() => setPaste(true)}>
              Paste an interchange
            </button>
          )}
          {can && (
            <button className="btn" disabled={pending} title="The ticker does this every minute; press to not wait" onClick={() => start(async () => { const r = await emit214NowAction(); if (r.ok) { t.ok(`${r.data.sent} message(s) generated`); router.refresh(); } else t.err(r.error); })}>
              Send milestones now
            </button>
          )}
        </div>
      </div>

      {tab === "inbox" ? (
        inbox.length === 0 ? (
          <Empty title="No tenders waiting" hint="Tenders that need a person land here: partners set to manual, changes to a load you already have, and tenders we could not turn into an order." />
        ) : (
          <div className="grid gap-3">
            {inbox.map((r) => (
              <div key={r.m.id} className="card p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold">{r.customer}</span>
                    <span className="mono text-callout text-muted">{r.tender?.theirRef ?? r.m.summary}</span>
                    <Pill tone={r.m.state === "error" ? "red" : r.m.summary.startsWith("CHANGE") ? "amber" : r.m.summary.startsWith("DUPLICATE") ? "slate" : "teal"}>{r.m.summary.split(" ")[0].toLowerCase()}</Pill>
                    {r.orderNumber && (
                      <Link href={`/orders/${r.m.orderId}`} className="text-teal font-bold text-callout">
                        {r.orderNumber}
                      </Link>
                    )}
                  </div>
                  {r.tender ? (
                    <div className="text-callout mt-1">
                      {r.tender.stops.map((s) => `${s.party?.name ?? s.type}${s.party?.city ? ` (${s.party.city}${s.party.state ? `, ${s.party.state}` : ""})` : ""}`).join(" → ")} · {money(r.tender.rateCents)}
                      {r.tender.stops[0]?.earliestLocal && <span className="text-muted"> · pickup {local(r.tender.stops[0].earliestLocal)} local</span>}
                    </div>
                  ) : (
                    <div className="text-callout mt-1 text-red">{r.m.error ?? "could not be read"}</div>
                  )}
                  {r.m.error && r.tender && <div className="text-callout text-red mt-0.5">{r.m.error}</div>}
                  <div className="text-footnote text-faint mt-0.5">received {when(r.m.createdAt, zone)}</div>
                </div>
                <div className="flex gap-2 flex-none">
                  <button className="btn btn-sm" onClick={() => setOpen(r)}>
                    Details
                  </button>
                  {can && r.tender && !r.m.summary.startsWith("CHANGE") && (
                    <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => accept(r)}>
                      Accept
                    </button>
                  )}
                  {can && r.tender && (
                    <button className="btn btn-sm btn-danger" onClick={() => setDeclining(r)}>
                      Decline
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : log.length === 0 ? (
        <Empty title="No EDI traffic yet" hint="Add a partner under Settings → EDI partners. Tenders can be POSTed to the partner's inbound URL or pasted here." />
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th></th>
                <th>Type</th>
                <th>Partner</th>
                <th>What</th>
                <th>Order</th>
                <th>Control #</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {log.map((r) => (
                <tr key={r.m.id}>
                  <td className="text-muted text-callout whitespace-nowrap">{when(r.m.createdAt, zone)}</td>
                  <td className="text-faint">{r.m.direction === "in" ? "⇦ in" : "⇨ out"}</td>
                  <td className="font-extrabold mono">{r.m.type}</td>
                  <td>{r.customer}</td>
                  <td className="text-callout">
                    {r.m.summary}
                    {r.m.error && <div className="text-red text-footnote">{r.m.error}</div>}
                  </td>
                  <td>
                    {r.orderNumber && (
                      <Link href={`/orders/${r.m.orderId}`} className="font-bold mono text-teal">
                        {r.orderNumber}
                      </Link>
                    )}
                  </td>
                  <td className="mono text-muted">{r.m.controlNumber ?? "—"}</td>
                  <td>
                    <Pill tone={TONE[r.m.state] ?? "slate"} title={r.m.ackedAt ? `acknowledged ${when(r.m.ackedAt, zone)}` : undefined}>
                      {r.m.state}
                      {r.m.ackedAt ? " · 997" : ""}
                    </Pill>
                  </td>
                  <td className="text-right">
                    <a className="btn btn-ghost btn-sm" href={`/api/edi/messages/${r.m.id}`} title="Download the X12 file">
                      .edi
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Modal open onClose={() => setOpen(null)} wide title={`Tender ${open.tender?.theirRef ?? ""} · ${open.customer}`} footer={<><button className="btn" onClick={() => setOpen(null)}>Close</button>{can && open.tender && !open.m.summary.startsWith("CHANGE") && <button className="btn btn-primary" disabled={pending} onClick={() => accept(open)}>Accept — create the order</button>}</>}>
          {open.tender ? (
            <div className="space-y-3 text-callout">
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <div className="eyebrow">Rate</div>
                  <div className="font-extrabold">{money(open.tender.rateCents)}</div>
                </div>
                <div>
                  <div className="eyebrow">Equipment</div>
                  <div>{open.tender.equipment ? `${open.tender.equipment.code ?? ""} ${open.tender.equipment.length ? `${open.tender.equipment.length}'` : ""} ${open.tender.equipment.number ?? ""}`.trim() || "—" : "—"}</div>
                </div>
                <div>
                  <div className="eyebrow">Weight</div>
                  <div>{open.tender.totalWeightLbs ? `${open.tender.totalWeightLbs.toLocaleString()} lb` : "—"}</div>
                </div>
                <div>
                  <div className="eyebrow">References</div>
                  <div className="mono text-footnote">{Object.entries(open.tender.refs).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</div>
                </div>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Stop</th>
                    <th>Where</th>
                    <th>Window</th>
                    <th>Freight</th>
                  </tr>
                </thead>
                <tbody>
                  {open.tender.stops.map((s) => (
                    <tr key={s.seq}>
                      <td className="mono">{s.seq}</td>
                      <td className="font-bold capitalize">{s.type}</td>
                      <td>
                        {s.party?.name}
                        <div className="text-muted text-footnote">{[s.party?.line1, s.party?.city, s.party?.state, s.party?.postalCode, s.party?.country].filter(Boolean).join(", ")}</div>
                      </td>
                      <td className="text-callout">
                        {local(s.earliestLocal)}
                        {s.latestLocal ? ` – ${local(s.latestLocal)}` : ""}
                        {(s.earliestLocal || s.latestLocal) && <span className="text-faint"> local</span>}
                        {s.appointment && <Pill tone="teal">appt</Pill>}
                      </td>
                      <td className="text-callout">
                        {[s.commodity, s.pieces && `${s.pieces} pcs`, s.weightLbs && `${s.weightLbs} lb`].filter(Boolean).join(" · ")}
                        {s.notes.length > 0 && <div className="text-muted">{s.notes.join(" · ")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {open.tender.notes.length > 0 && <div className="text-muted">{open.tender.notes.join(" · ")}</div>}
              {open.m.summary.startsWith("CHANGE") && <div className="help">This is a change to a load you already have. Apply it on the order, then decline this message with a note so the customer gets a 990.</div>}
            </div>
          ) : (
            <pre className="text-footnote whitespace-pre-wrap">{open.m.error}</pre>
          )}
        </Modal>
      )}
      <Confirm open={!!declining} onClose={() => setDeclining(null)} title={`Decline ${declining?.tender?.theirRef ?? ""}`} body="A 990 with your reason goes back to the customer." needReason="Reason (the customer sees it)" confirmLabel="Decline" danger onConfirm={(reason) => { const row = declining!; setDeclining(null); start(async () => { const r = await respondTenderAction(row.m.id, false, reason); if (r.ok) { t.ok("Declined — 990 sent"); router.refresh(); } else t.err(r.error); }); }} />
      {paste && <PasteModal partners={partners} onClose={() => setPaste(false)} onDone={(msg) => { setPaste(false); t.ok(msg); router.refresh(); }} />}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

function PasteModal({ partners, onClose, onDone }: { partners: { id: string; label: string }[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Modal open onClose={onClose} wide title="Receive an interchange" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={pending || !partnerId || !text.trim()} onClick={() => start(async () => { setErr(null); const r = await receivePastedAction(partnerId, text); if (r.ok) onDone(r.data.sets.map((s) => `${s.type}: ${s.note}`).join(" · ")); else setErr(r.error); })}>Receive</button></>}>
      <label className="label">Partner</label>
      <select className="select mb-2" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
        {partners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <label className="label">X12 text (ISA … IEA)</label>
      <textarea className="textarea mono text-footnote" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="ISA*00*          *00*          *ZZ*RXO …" />
      {err && <div className="error mt-2">{err}</div>}
      <div className="help mt-2">For go-live the partner POSTs to the inbound URL on their partner record; this box is for testing and for files they email.</div>
    </Modal>
  );
}
