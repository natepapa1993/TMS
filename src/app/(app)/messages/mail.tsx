"use client";

import { fmtWhen } from "@/lib/time";
import { useZone } from "@/components/zone";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal, Pill, Toast, useToast } from "@/components/ui";
import type { MailProposal, MailExtracted, MailAttachment, MailKind } from "@/db/schema";
import { approveMailAction, ignoreMailAction, retryMailAction } from "./actions";

/** One card per email (spec Module 12 "Propose one card"): what it found, what it will do, Approve / Edit / Ignore. */

type Row = { id: string; from: string; fromName: string | null; subject: string | null; receivedAt: string; text: string; attachments: MailAttachment[]; kind: MailKind; confidence: number; classifier: string; extracted: MailExtracted; orderId: string | null; matchReason: string | null; proposal: MailProposal; state: string; result: string | null; reviewedAt: string | null };
type Customer = { id: string; name: string; kind: string };

const KIND: Record<MailKind, string> = { rate_con: "Rate confirmation", tender: "Load tender", status_request: "Status question", broker_doc: "Broker document", dispute: "Detention / accessorial", remittance: "Payment", carrier_quote: "Quote request", noise: "Other" };
const TONE: Record<MailKind, "teal" | "blue" | "amber" | "slate" | "green" | "red"> = { rate_con: "teal", tender: "teal", status_request: "blue", broker_doc: "amber", dispute: "amber", remittance: "green", carrier_quote: "slate", noise: "slate" };
const ACTION: Record<MailProposal["action"], string> = { create_order: "Create draft order", attach_document: "Attach document", reply: "Send reply", detention: "Compute detention", receipt: "Record receipt", none: "Nothing to run" };
/** Messages are not tied to a stop: the company's clock, labelled. */
const when = (d: string, zone: string) => fmtWhen(d, zone, { style: "short" }) ?? "";

export function MailCards({ rows, customers, canAct }: { rows: Row[]; customers: Customer[]; canAct: boolean }) {
  const zone = useZone();
  const router = useRouter();
  const t = useToast();
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Row | null>(null);
  const [edit, setEdit] = useState<{ customerId: string; rate: string; body: string; amount: string }>({ customerId: "", rate: "", body: "", amount: "" });
  const [pending, start] = useTransition();
  const shown = rows.filter((r) => showAll || r.state === "proposed");
  const openCard = (r: Row) => {
    setOpen(r);
    const p = r.proposal;
    setEdit({ customerId: p.action === "create_order" ? (p.customerId ?? "") : "", rate: p.action === "create_order" && p.rateCents != null ? (p.rateCents / 100).toFixed(2) : "", body: p.action === "reply" ? p.body : "", amount: p.action === "receipt" ? (p.amountCents / 100).toFixed(2) : "" });
  };
  const approve = (r: Row, withEdits: boolean) =>
    start(async () => {
      const p = r.proposal;
      const edits = withEdits
        ? { customerId: p.action === "create_order" ? edit.customerId || null : undefined, rateCents: p.action === "create_order" ? (edit.rate.trim() ? Math.round(Number(edit.rate.replace(/[$,\s]/g, "")) * 100) : null) : undefined, body: p.action === "reply" ? edit.body : undefined, amountCents: p.action === "receipt" ? Math.round(Number(edit.amount.replace(/[$,\s]/g, "")) * 100) : undefined }
        : {};
      const x = await approveMailAction(r.id, edits);
      if (x.ok) {
        t.ok(x.data.result);
        setOpen(null);
        router.refresh();
      } else t.err(x.error);
    });
  const ignore = (r: Row) =>
    start(async () => {
      const x = await ignoreMailAction(r.id);
      if (x.ok) {
        t.ok("Ignored");
        setOpen(null);
        router.refresh();
      } else t.err(x.error);
    });
  return (
    <div className="mb-6" data-testid="mail-cards">
      <div className="flex items-center justify-between mb-2">
        <div className="h2">
          Email <span className="text-muted font-normal text-callout">· {rows.filter((r) => r.state === "proposed").length} waiting for a tap</span>
        </div>
        <label className="flex items-center gap-2 text-callout cursor-pointer">
          <input type="checkbox" className="accent-teal" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show handled
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="card p-5 text-callout text-muted">
          {rows.length ? "Nothing waiting." : "Nothing yet. Connect the dispatch mailbox (or forward it to the inbound URL) under Settings → Integrations and every email becomes a card here: what it is, what it says, what the agent will do — on your tap."}
        </div>
      ) : (
        <div className="grid gap-2">
          {shown.map((r) => (
            <div key={r.id} className={`card p-4 ${r.state !== "proposed" ? "opacity-70" : ""}`} data-testid="mail-card">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Pill tone={TONE[r.kind]}>{KIND[r.kind]}</Pill>
                    <span className="text-footnote text-faint" title={`${r.classifier} · ${r.confidence}% sure`}>
                      {r.confidence}%{r.classifier === "rules" ? " · rules" : ""}
                    </span>
                    {r.orderId && (
                      <Link href={`/orders/${r.orderId}`} className="font-bold mono text-teal text-callout">
                        {"orderNumber" in r.proposal ? r.proposal.orderNumber : "order"}
                      </Link>
                    )}
                    {r.state !== "proposed" && <Pill tone={r.state === "executed" ? "green" : r.state === "failed" ? "red" : "slate"}>{r.state}</Pill>}
                  </div>
                  <div className="font-bold text-body mt-1 truncate">{r.subject || "(no subject)"}</div>
                  <div className="text-callout text-muted">
                    {r.fromName ? `${r.fromName} · ` : ""}
                    {r.from} · {when(r.receivedAt, zone)}
                    {r.attachments.length ? ` · ${r.attachments.map((a) => a.fileName).join(", ")}` : ""}
                  </div>
                  <div className="text-callout mt-1.5">
                    <span className="font-semibold">{ACTION[r.proposal.action]}:</span> {r.proposal.summary}
                  </div>
                  {r.result && <div className={`text-callout mt-1 ${r.state === "failed" ? "text-red" : "text-muted"}`}>{r.result}</div>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button className="btn btn-sm" onClick={() => openCard(r)}>
                    {r.state === "proposed" ? "Open" : "Read"}
                  </button>
                  {canAct && r.state === "proposed" && r.proposal.action !== "none" && (
                    <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => approve(r, false)}>
                      Approve
                    </button>
                  )}
                  {canAct && r.state === "proposed" && (
                    <button className="btn btn-sm" disabled={pending} onClick={() => ignore(r)}>
                      Ignore
                    </button>
                  )}
                  {canAct && r.state === "failed" && (
                    <button className="btn btn-sm" disabled={pending} onClick={() => start(async () => { const x = await retryMailAction(r.id); if (x.ok) { t.ok("Back on the board"); router.refresh(); } else t.err(x.error); })}>
                      Retry
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `${KIND[open.kind]} · ${open.subject || "(no subject)"}` : ""}
        footer={
          open && (
            <>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
              {canAct && open.state === "proposed" && (
                <button className="btn" disabled={pending} onClick={() => ignore(open)}>
                  Ignore
                </button>
              )}
              {canAct && open.state === "proposed" && open.proposal.action !== "none" && (
                <button className="btn btn-primary" disabled={pending} onClick={() => approve(open, true)} data-testid="approve-edited">
                  {ACTION[open.proposal.action]}
                </button>
              )}
            </>
          )
        }
      >
        {open && (
          <div className="space-y-3 text-callout">
            <div className="rounded-lg border border-line p-3">
              <div className="eyebrow mb-1">What it will do</div>
              <div>{open.proposal.summary}</div>
              {open.matchReason && <div className="text-muted mt-1">Matched: {open.matchReason}</div>}
              {open.proposal.action === "create_order" && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="label">Customer</label>
                    <select className="select" value={edit.customerId} onChange={(e) => setEdit({ ...edit, customerId: e.target.value })} aria-label="Customer">
                      <option value="">— pick —</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.kind})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Rate (blank = TBD)</label>
                    <input className="input" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} aria-label="Rate" />
                  </div>
                  <div className="col-span-2 text-muted text-callout">
                    {open.proposal.stops.map((st) => `${st.name} (${st.country})`).join(" → ")}
                    {open.proposal.equipment ? ` · ${open.proposal.equipment.replace("_", " ")}` : ""}
                    {Object.entries(open.proposal.refs).map(([k, v]) => ` · ${k.toUpperCase()} ${v}`)}
                    {open.proposal.cargoNote ? ` · ${open.proposal.cargoNote}` : ""}
                    {open.proposal.attachAs ? ` · the PDF goes on as ${open.proposal.attachAs.replace("_", " ")}` : ""}
                  </div>
                </div>
              )}
              {open.proposal.action === "reply" && (
                <div className="mt-2">
                  <label className="label">
                    To {open.proposal.to} · {open.proposal.subject}
                  </label>
                  <textarea className="w-full mono" rows={9} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} aria-label="Reply body" />
                  <div className="help">Drafted from verified tracking, never the carrier&apos;s number. Edit anything; you send it.</div>
                </div>
              )}
              {open.proposal.action === "receipt" && (
                <div className="mt-2 w-48">
                  <label className="label">Amount received</label>
                  <input className="input" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} aria-label="Amount" />
                </div>
              )}
            </div>
            {Object.keys(open.extracted).length > 0 && (
              <div>
                <div className="eyebrow mb-1">What it read</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(open.extracted).map(([k, v]) => (
                    <span key={k} className="pill pill-slate" title={`${Math.round(v.confidence * 100)}% sure`}>
                      {k}: {String(v.value)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="eyebrow mb-1">
                The email · {open.fromName ? `${open.fromName} · ` : ""}
                {open.from} · {when(open.receivedAt, zone)}
              </div>
              <pre className="whitespace-pre-wrap text-callout bg-ground rounded-lg p-3 max-h-64 overflow-y-auto font-sans">{open.text || "(no text)"}</pre>
              {open.attachments.length > 0 && (
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {open.attachments.map((a) => (
                    <a key={a.documentId} className="btn btn-sm" href={`/api/files/${a.documentId}`} target="_blank" rel="noreferrer">
                      {a.fileName}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
