"use client";

import { useRef, useState, useTransition } from "react";
import { call } from "@/lib/client-call";
import { useRouter } from "next/navigation";
import { Modal, Pill, Spinner, Toast, useToast } from "@/components/ui";
import type { ComplianceItem } from "@/db/schema";
import type { SubjectKind } from "@/domain/compliance";
import { uploadSubjectDocAction, readSubjectDocAction, reviewSubjectDocAction } from "@/app/(app)/compliance/actions";

type Doc = { id: string; documentTypeId: string | null; code: string | null; fileName: string; status: string; version: number; expiresAt: string | null; issuedAt: string | null; number: string | null; source: string; createdAt: string };
const INSPECTION = ["field:dotInspectionExpires", "field:inspectionExpires"];
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
type DocType = { id: string; name: string; tracksExpiry: boolean; required: boolean; blocksDispatch: boolean };
const tone: Record<string, "green" | "amber" | "red" | "slate"> = { ok: "green", expiring: "amber", expired: "red", missing: "amber", snoozed: "slate", na: "slate" };

/** Documents + compliance on a driver / truck / trailer / carrier record (spec §6.2 "cell click opens the subject's Documents tab"). */
/**
 * canEditCredentials: Safety or the owner — attaching a licence, medical card, plate or inspection report
 * sets the date dispatch reads, so it is theirs, like the dates on the record.
 */
export function SubjectDocuments({ kind, subjectId, docs, types, status, canEdit, canEditCredentials = false, title = "Compliance" }: { kind: SubjectKind | "company"; subjectId: string; docs: Doc[]; types: DocType[]; status: { dispatchable: boolean; items: ComplianceItem[]; override: { reason: string; expiresAt: string } | null } | null; canEdit: boolean; canEditCredentials?: boolean; title?: string }) {
  const router = useRouter();
  const t = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [read, setRead] = useState<{ note: string; err?: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [vals, setVals] = useState({ expiresAt: "", issuedAt: "", number: "" });
  const readWithAi = async () => {
    setReading(true);
    setRead(null);
    const fd = new FormData(ref.current!);
    const r = await call(() => readSubjectDocAction(kind, openType?.name ?? openCred?.label ?? "document", fd));
    setReading(false);
    if (!r.ok) return setRead({ note: r.error, err: true });
    if (!r.data.ran) return setRead({ note: r.data.reason, err: true });
    const d = r.data;
    const day = (v: { value: string } | null) => (v ? v.value.slice(0, 10) : "");
    setVals((x) => ({ expiresAt: day(d.expiresAt) || x.expiresAt, issuedAt: day(d.issuedAt) || x.issuedAt, number: d.number?.value || x.number }));
    const got = [d.expiresAt && "expiry", d.issuedAt && "issue date", d.number && "number", d.holder && `holder "${d.holder.value}"`].filter(Boolean);
    setRead({ note: got.length ? `Read by ${d.model}: ${got.join(", ")}. Check them against the document before uploading.` : `${d.model} could not read this one; type the dates.` });
  };
  const ref = useRef<HTMLFormElement>(null);
  // the built-in credentials that apply to this record (licence, medical card, plates, annual inspection…)
  const creds = (status?.items ?? []).filter((i) => i.key.startsWith("field:"));
  const credLabel = (code: string | null) => creds.find((c) => c.key === code)?.label ?? (code?.startsWith("dq:") ? "Qualification file" : "document");
  const typeName = (d: { documentTypeId: string | null; code?: string | null }) => (d.documentTypeId ? (types.find((x) => x.id === d.documentTypeId)?.name ?? "document") : credLabel(d.code ?? null));
  const active = docs.filter((d) => d.status === "present" || d.status === "verified");
  const earlier = docs.filter((d) => d.status === "superseded" || d.status === "rejected");
  const pendingDocs = docs.filter((d) => d.status === "pending");
  const openType = types.find((x) => x.id === open);
  const openCred = creds.find((c) => c.key === open);
  const inspection = !!open && INSPECTION.includes(open);
  return (
    <div className="card p-4" id="documents">
      <div className="flex items-center justify-between">
        <div className="eyebrow">{title}</div>
        {status && kind !== "company" && (status.dispatchable ? status.override ? <Pill tone="amber">override until {new Date(status.override.expiresAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" })}</Pill> : <Pill tone="green">Dispatchable</Pill> : <Pill tone="red">Blocked</Pill>)}
      </div>
      {status && status.items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {status.items.map((i) => (
            <li key={i.key} className="flex items-center justify-between text-callout">
              <span className={i.status === "expired" || (i.status === "missing" && i.blocksDispatch) ? "text-red font-semibold" : ""} title={i.level === "hard" ? "Blocks dispatch — nobody can override" : i.blocksDispatch ? "Blocks dispatch — the owner or Safety can override" : undefined}>
                {i.documentId ? (
                  <a href={`/api/files/${i.documentId}`} target="_blank" rel="noreferrer" className="hover:text-teal underline decoration-dotted">
                    {i.label}
                  </a>
                ) : (
                  i.label
                )}
                {i.blocksDispatch ? " •" : ""}
                {i.graceUntil && <span className="text-footnote text-muted font-normal"> · grace until {day(i.graceUntil)}</span>}
              </span>
              <span className="flex items-center gap-1">
                <Pill tone={tone[i.status]}>{i.expiresAt ? day(i.expiresAt) : i.status === "na" ? "not on file" : i.status}</Pill>
                {(i.key.startsWith("field:") ? canEditCredentials : canEdit && !i.key.startsWith("dq:") && !i.key.startsWith("da:")) && (
                  <button className="btn btn-ghost btn-sm text-caption px-1 text-teal" onClick={() => setOpen(i.key)} data-testid={`attach-${i.key}`}>
                    {i.documentId ? "renew" : i.key.startsWith("field:") ? "attach" : "upload"}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {status && !status.items.length && <div className="text-muted text-callout mt-1">No rules apply yet.</div>}
      {pendingDocs.length > 0 && (
        <div className="mt-4" data-testid="pending-docs">
          <div className="eyebrow mb-1">From the driver app — check and confirm</div>
          <ul className="space-y-2">
            {pendingDocs.map((d) => (
              <PendingDoc key={d.id} doc={d} typeName={typeName(d)} tracksExpiry={d.code?.startsWith("field:") ? true : (types.find((x) => x.id === d.documentTypeId)?.tracksExpiry ?? false)} canEdit={d.code?.startsWith("field:") ? canEditCredentials : canEdit} onDone={(msg) => { t.ok(msg); router.refresh(); }} />
            ))}
          </ul>
        </div>
      )}
      <div className="eyebrow mt-4 mb-1">Documents on file</div>
      {active.length === 0 ? (
        <div className="text-muted text-callout">Nothing uploaded yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {active.map((d) => (
            <li key={d.id} className="text-callout flex items-center justify-between gap-2">
              <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-teal truncate">
                {typeName(d)} <span className="text-faint font-normal">· {d.fileName}</span>
              </a>
              <span className="text-muted whitespace-nowrap">
                {d.number ? `#${d.number} · ` : ""}
                {d.expiresAt ? `exp ${day(d.expiresAt)}` : "no expiry"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {earlier.length > 0 && (
        <details className="mt-2 text-footnote text-muted" data-testid="earlier-versions">
          <summary className="cursor-pointer">Earlier versions ({earlier.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {earlier.map((d) => (
              <li key={d.id}>
                <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="hover:text-teal">
                  {typeName(d)} v{d.version} · {d.fileName}
                </a>
                {d.expiresAt ? ` · exp ${day(d.expiresAt)}` : ""} · {d.status === "rejected" ? "sent back" : "replaced"} {new Date(d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(canEdit && types.length > 0) || (canEditCredentials && creds.length > 0) ? (
        <button className="btn btn-sm mt-3" onClick={() => setOpen(types.length && canEdit ? types[0].id : creds[0].key)}>
          + Upload document
        </button>
      ) : null}
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title="Upload document"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={pending || !name}
              onClick={() =>
                start(async () => {
                  setErr(null);
                  const fd = new FormData(ref.current!);
                  const r = await call(() => uploadSubjectDocAction(kind, subjectId, fd));
                  if (r.ok) {
                    setOpen(null);
                    setName(null);
                    t.ok("Uploaded — compliance re-run");
                    router.refresh();
                  } else setErr(r.error);
                })
              }
            >
              {pending ? <Spinner /> : "Upload"}
            </button>
          </>
        }
      >
        {open && (
          <form ref={ref} onSubmit={(e) => e.preventDefault()} className="space-y-3">
            <div>
              <label className="label">Document</label>
              <select name="uploadKey" className="select" value={open} onChange={(e) => setOpen(e.target.value)}>
                {canEditCredentials && creds.length > 0 && (
                  <optgroup label="On the record (sets the date)">
                    {creds.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {canEdit && types.length > 0 && (
                  <optgroup label="Your document rules">
                    {types.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                        {x.blocksDispatch ? " • blocks dispatch" : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {openCred && <div className="help mt-1">{inspection ? "Enter the date of the inspection: it is good for 12 months, and that due date goes on the record." : `The expiry you enter goes on the record: it is the ${openCred.label.toLowerCase()} date compliance and dispatch read.`}</div>}
            </div>
            <label className="block border-2 border-dashed border-line rounded-lg p-4 text-center cursor-pointer hover:border-teal">
              <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? null)} />
              <div className="font-semibold">{name ?? "Choose a PDF or photo"}</div>
            </label>
            {name && (
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className="btn btn-sm" disabled={reading} onClick={readWithAi}>
                  {reading ? <Spinner /> : "Read with AI"}
                </button>
                {read && <span className={`text-callout ${read.err ? "text-red" : "text-teal"}`} data-testid="ai-read">{read.note}</span>}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="label">{inspection ? "Or due" : "Expires"}{openType?.tracksExpiry || (openCred && !inspection) ? " *" : ""}</label>
                <input type="date" name="expiresAt" className="input" value={vals.expiresAt} onChange={(e) => setVals({ ...vals, expiresAt: e.target.value })} />
              </div>
              <div>
                <label className="label">{inspection ? "Inspected on *" : "Issued"}</label>
                <input type="date" name="issuedAt" className="input" value={vals.issuedAt} onChange={(e) => setVals({ ...vals, issuedAt: e.target.value })} />
              </div>
              <div>
                <label className="label">Number</label>
                <input name="number" className="input" value={vals.number} onChange={(e) => setVals({ ...vals, number: e.target.value })} />
              </div>
            </div>
            <input name="notes" className="input" placeholder="Note (optional)" />
            {err && <div className="error">{err}</div>}
          </form>
        )}
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}

/** A photo the driver sent: open it, fix the dates if needed, confirm it onto the file or send it back with a reason. */
function PendingDoc({ doc, typeName, tracksExpiry, canEdit, onDone }: { doc: Doc; typeName: string; tracksExpiry: boolean; canEdit: boolean; onDone: (msg: string) => void }) {
  const [expiresAt, setExpiresAt] = useState(doc.expiresAt ? doc.expiresAt.slice(0, 10) : "");
  const [number, setNumber] = useState(doc.number ?? "");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <li className="rounded-lg border border-teal/40 bg-teal-soft/30 p-3 text-callout">
      <div className="flex items-center justify-between gap-2">
        <a href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-teal truncate">
          {typeName} <span className="text-faint font-normal">· {doc.fileName}</span>
        </a>
        <span className="text-muted whitespace-nowrap">sent {new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      </div>
      {canEdit && (
        <div className="mt-2 grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
          <div>
            <label className="label">Expires{tracksExpiry ? " *" : ""}</label>
            <input type="date" className="input" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expires" />
          </div>
          <div>
            <label className="label">Number</label>
            <input className="input" value={number} onChange={(e) => setNumber(e.target.value)} aria-label="Number" />
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await reviewSubjectDocAction(doc.id, "confirm", { expiresAt, number });
                if (r.ok) onDone("Confirmed — on file, compliance re-run");
                else setErr(r.error);
              })
            }
          >
            {pending ? <Spinner /> : "Confirm"}
          </button>
          <button className="btn btn-sm" disabled={pending} onClick={() => setRejecting((x) => !x)}>
            Send back
          </button>
        </div>
      )}
      {rejecting && (
        <div className="mt-2 flex gap-2">
          <input className="input flex-1" placeholder="What is wrong? The driver sees this." value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <button
            className="btn btn-danger btn-sm"
            disabled={pending || !reason.trim()}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await reviewSubjectDocAction(doc.id, "reject", { reason });
                if (r.ok) onDone("Sent back to the driver");
                else setErr(r.error);
              })
            }
          >
            Reject
          </button>
        </div>
      )}
      {err && <div className="error mt-1">{err}</div>}
    </li>
  );
}
