"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, Pill, Spinner, Toast, useToast } from "@/components/ui";
import type { ComplianceItem } from "@/db/schema";
import type { SubjectKind } from "@/domain/compliance";
import { uploadSubjectDocAction } from "@/app/(app)/compliance/actions";

type Doc = { id: string; documentTypeId: string | null; fileName: string; status: string; version: number; expiresAt: string | null; issuedAt: string | null; number: string | null; source: string; createdAt: string };
type DocType = { id: string; name: string; tracksExpiry: boolean; required: boolean; blocksDispatch: boolean };
const tone: Record<string, "green" | "amber" | "red" | "slate"> = { ok: "green", expiring: "amber", expired: "red", missing: "amber", snoozed: "slate" };

/** Documents + compliance on a driver / truck / trailer / carrier record (spec §6.2 "cell click opens the subject's Documents tab"). */
export function SubjectDocuments({ kind, subjectId, docs, types, status, canEdit }: { kind: SubjectKind; subjectId: string; docs: Doc[]; types: DocType[]; status: { dispatchable: boolean; items: ComplianceItem[]; override: { reason: string; expiresAt: string } | null } | null; canEdit: boolean }) {
  const router = useRouter();
  const t = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const typeName = (id: string | null) => types.find((x) => x.id === id)?.name ?? "document";
  const active = docs.filter((d) => d.status !== "superseded");
  const openType = types.find((x) => x.id === open);
  return (
    <div className="card p-4" id="documents">
      <div className="flex items-center justify-between">
        <div className="eyebrow">Compliance</div>
        {status && (status.dispatchable ? status.override ? <Pill tone="amber">override until {new Date(status.override.expiresAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" })}</Pill> : <Pill tone="green">Dispatchable</Pill> : <Pill tone="red">Blocked</Pill>)}
      </div>
      {status && status.items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {status.items.map((i) => (
            <li key={i.key} className="flex items-center justify-between text-[12.5px]">
              <span className={i.status === "expired" || (i.status === "missing" && i.blocksDispatch) ? "text-red font-semibold" : ""}>
                {i.label}
                {i.blocksDispatch ? " •" : ""}
              </span>
              <span className="flex items-center gap-1">
                <Pill tone={tone[i.status]}>{i.expiresAt ? new Date(i.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : i.status}</Pill>
                {canEdit && !i.key.startsWith("field:") && (
                  <button className="btn btn-ghost btn-sm text-[11px] px-1 text-teal" onClick={() => setOpen(i.key)}>
                    {i.documentId ? "renew" : "upload"}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {status && !status.items.length && <div className="text-muted text-[12.5px] mt-1">No rules apply yet.</div>}
      <div className="eyebrow mt-4 mb-1">Documents on file</div>
      {active.length === 0 ? (
        <div className="text-muted text-[12.5px]">Nothing uploaded yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {active.map((d) => (
            <li key={d.id} className="text-[12.5px] flex items-center justify-between gap-2">
              <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-teal truncate">
                {typeName(d.documentTypeId)} <span className="text-faint font-normal">· {d.fileName}</span>
              </a>
              <span className="text-muted whitespace-nowrap">
                {d.number ? `#${d.number} · ` : ""}
                {d.expiresAt ? `exp ${new Date(d.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}` : "no expiry"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && types.length > 0 && (
        <button className="btn btn-sm mt-3" onClick={() => setOpen(types[0].id)}>
          + Upload document
        </button>
      )}
      {canEdit && types.length === 0 && <div className="help mt-2">Add document types under Settings → Document types to upload against them.</div>}
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
                  const r = await uploadSubjectDocAction(kind, subjectId, fd);
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
              <label className="label">Document type</label>
              <select name="documentTypeId" className="select" value={open} onChange={(e) => setOpen(e.target.value)}>
                {types.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.blocksDispatch ? " • blocks dispatch" : ""}
                  </option>
                ))}
              </select>
            </div>
            <label className="block border-2 border-dashed border-line rounded-lg p-4 text-center cursor-pointer hover:border-teal">
              <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? null)} />
              <div className="font-semibold">{name ?? "Choose a PDF or photo"}</div>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="label">Expires{openType?.tracksExpiry ? " *" : ""}</label>
                <input type="date" name="expiresAt" className="input" />
              </div>
              <div>
                <label className="label">Issued</label>
                <input type="date" name="issuedAt" className="input" />
              </div>
              <div>
                <label className="label">Number</label>
                <input name="number" className="input" />
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
