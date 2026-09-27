"use client";

import { useState, useTransition } from "react";
import { call } from "@/lib/client-call";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Confirm, Modal, Pill, Toast, useToast } from "@/components/ui";
import { formatCents } from "@/data/fields";
import { createInvoiceAction, acceptMismatchAction, uploadOrderDocAction } from "./actions";

type Row = { order: { id: string; orderNumber: string; state: string; currency: string; deliveredAt: string | null }; customerName: string | null; entityName: string | null; chargesCents: number; rateConCents: number | null; mismatch: boolean; requiredDocs: { code: string; present: boolean }[]; docsComplete: boolean; ageDays: number; invoiceId: string | null; paperSays: string | null };

export function Queue({ rows, role }: { rows: Row[]; role: string }) {
  const router = useRouter();
  const t = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [mismatchFor, setMismatchFor] = useState<Row | null>(null);
  const [uploadFor, setUploadFor] = useState<{ orderId: string; code: string } | null>(null);
  const [pending, start] = useTransition();
  const canBill = ["owner", "billing"].includes(role);
  const eligible = rows.filter((r) => r.docsComplete && !r.mismatch && !r.invoiceId);
  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        t.ok(label);
        router.refresh();
      } else t.err(r.error ?? "Could not do that");
    });
  return (
    <>
      {canBill && (
        <div className="flex items-center gap-2 mb-3">
          <button className="btn btn-primary" disabled={!sel.length || pending} onClick={() => start(async () => { let made = 0; const skipped: string[] = []; for (const id of sel) { const r = await createInvoiceAction([id]); if (r.ok) made++; else skipped.push(`${rows.find((x) => x.order.id === id)?.order.orderNumber}: ${r.error}`); } setSel([]); if (skipped.length) t.err(`${made} invoice(s) created; skipped ${skipped.join(" · ")}`); else t.ok(`${made} invoice(s) created`); router.refresh(); })}>
            Create invoices ({sel.length})
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSel(eligible.map((r) => r.order.id))}>
            Select all eligible ({eligible.length})
          </button>
        </div>
      )}
      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-14 text-center">
            <div className="font-bold">Nothing to bill</div>
            <div className="text-muted text-[13px] mt-1">Delivered orders land here.</div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>Order</th>
                <th>Customer</th>
                <th>Bill from</th>
                <th>Charges</th>
                <th>Rate con</th>
                <th>Docs</th>
                <th>Age</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ok = r.docsComplete && !r.mismatch && !r.invoiceId;
                return (
                  <tr key={r.order.id}>
                    <td>{canBill && <input type="checkbox" className="accent-teal" disabled={!ok} checked={sel.includes(r.order.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.order.id] : sel.filter((x) => x !== r.order.id))} />}</td>
                    <td>
                      <Link href={`/orders/${r.order.id}#charges`} className="font-extrabold mono hover:text-teal">
                        {r.order.orderNumber}
                      </Link>
                    </td>
                    <td>{r.customerName ?? <span className="text-faint">—</span>}</td>
                    <td className="text-muted text-[12.5px]">{r.entityName ?? "—"}</td>
                    <td className="mono font-semibold">{formatCents(r.chargesCents, r.order.currency)}</td>
                    <td>
                      {r.rateConCents == null ? (
                        <span className="text-faint">TBD</span>
                      ) : r.mismatch ? (
                        <button className="pill pill-red" onClick={() => canBill && setMismatchFor(r)} title="Charges differ from the rate confirmation">
                          {formatCents(r.rateConCents, r.order.currency)} ≠
                        </button>
                      ) : (
                        <Pill tone="green">{formatCents(r.rateConCents, r.order.currency)}</Pill>
                      )}
                      {r.paperSays && (
                        <div className="text-[11.5px] text-amber font-semibold mt-0.5 max-w-[220px]" title="Read from the uploaded rate confirmation by the AI extractor">
                          {r.paperSays}
                        </div>
                      )}
                    </td>
                    <td className="space-x-1">
                      {r.requiredDocs.map((d) => (
                        <button key={d.code} className={`pill ${d.present ? "pill-green" : "pill-red"}`} onClick={() => !d.present && setUploadFor({ orderId: r.order.id, code: d.code })} title={d.present ? "on file" : "missing — click to upload"}>
                          {d.code.replace("_", " ")}
                        </button>
                      ))}
                    </td>
                    <td className={r.ageDays > 7 ? "text-red font-semibold" : "text-muted"}>{r.ageDays} d</td>
                    <td className="text-right whitespace-nowrap">
                      {r.invoiceId ? (
                        <Link href={`/billing/invoices/${r.invoiceId}`} className="btn btn-sm">
                          Open draft
                        </Link>
                      ) : (
                        canBill && (
                          <button className="btn btn-sm btn-primary" disabled={!ok || pending} onClick={() => run("Draft invoice created", () => createInvoiceAction([r.order.id]))}>
                            Create invoice
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Confirm open={!!mismatchFor} onClose={() => setMismatchFor(null)} title={`Charges ${formatCents(mismatchFor?.chargesCents ?? 0)} vs rate con ${formatCents(mismatchFor?.rateConCents ?? 0)}`} body="Accept ours only with the customer's approval on file (email, revised rate con). Or open the order and fix the charges." needReason="Why the difference is billable" confirmLabel="Accept our charges" onConfirm={(note) => { const r = mismatchFor!; setMismatchFor(null); run("Accepted — the note is on the order", () => acceptMismatchAction(r.order.id, note)); }} />
      {uploadFor && (
        <UploadDoc orderId={uploadFor.orderId} code={uploadFor.code} onClose={() => setUploadFor(null)} onDone={() => { setUploadFor(null); t.ok("Uploaded"); router.refresh(); }} />
      )}
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}

export function UploadDoc({ orderId, code, onClose, onDone }: { orderId: string; code: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Upload ${code.replace("_", " ")}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!file || pending}
            onClick={() =>
              start(async () => {
                const fd = new FormData();
                fd.set("file", file!);
                fd.set("code", code);
                const r = await call(() => uploadOrderDocAction(orderId, fd));
                if (r.ok) onDone();
                else setErr(r.error);
              })
            }
          >
            Upload
          </button>
        </>
      }
    >
      <label className="block border-2 border-dashed border-line rounded-lg p-5 text-center cursor-pointer hover:border-teal">
        <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="font-semibold">{file?.name ?? "Choose a PDF or photo"}</div>
      </label>
      {err && <div className="error mt-2">{err}</div>}
    </Modal>
  );
}
