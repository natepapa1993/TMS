"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RecordForm, type RefOptions } from "@/components/record-form";
import { Confirm, Toast, useToast } from "@/components/ui";
import type { Field } from "@/data/fields";
import type { RecordKind } from "@/data/records";
import { saveRecord, archiveRecord, restoreRecord } from "../../actions";

export function RecordEditor({ kind, id, fields, refs, initial, archived, blockers, listPath }: { kind: RecordKind; id: string; fields: Field[]; refs: RefOptions; initial: Record<string, unknown>; archived: boolean; blockers: string[]; listPath: string }) {
  const router = useRouter();
  const t = useToast();
  const [confirm, setConfirm] = useState(false);
  const opened = String(initial.updatedAt ?? "");
  return (
    <div>
      {archived && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-amber-soft text-amber text-[13px] font-semibold flex items-center justify-between">
          <span>This record is archived and read-only.</span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              const r = await restoreRecord(kind, id);
              if (r.ok) {
                t.ok("Restored");
                router.refresh();
              } else t.err(r.error);
            }}
          >
            Restore
          </button>
        </div>
      )}
      <fieldset disabled={archived} className="contents">
        <RecordForm
          fields={fields}
          refs={refs}
          initial={initial}
          mode="full"
          submitLabel="Save changes"
          onSubmit={async (raw) => {
            const r = await saveRecord(kind, id, raw, opened);
            if (r.ok) {
              t.ok("Saved");
              router.refresh();
            } else if (r.code === "conflict") t.err(r.error);
            return r;
          }}
          extra={
            !archived && (
              <div className="mt-6 pt-4 border-t border-line flex items-center justify-between text-[13px]">
                <div className="text-muted">
                  {blockers.length ? (
                    <span>
                      In use: <span className="font-semibold text-ink">{blockers.slice(0, 3).join(", ")}</span>
                      {blockers.length > 3 ? ` +${blockers.length - 3}` : ""}. Finish or reassign those first.
                    </span>
                  ) : (
                    "Archiving hides it from pickers; history is kept."
                  )}
                </div>
                <button type="button" className="btn btn-danger btn-sm" disabled={blockers.length > 0} onClick={() => setConfirm(true)}>
                  Archive
                </button>
              </div>
            )
          }
        />
      </fieldset>
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Archive this record?"
        body="It disappears from pickers and lists. You can restore it from the archived view."
        confirmLabel="Archive"
        danger
        onConfirm={async () => {
          const r = await archiveRecord(kind, id);
          setConfirm(false);
          if (r.ok) router.push(listPath);
          else t.err(r.error);
        }}
      />
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </div>
  );
}
