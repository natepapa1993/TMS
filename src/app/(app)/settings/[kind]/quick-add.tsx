"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { RecordForm, type RefOptions } from "@/components/record-form";
import type { Field } from "@/data/fields";
import type { RecordKind } from "@/data/records";
import { saveRecord } from "../actions";

/** The quick-add popup: essentials only, saves, offers "add another" (spec §1.1 ease rule). */
/** openAfter: the list path — after "Add" the new record opens, so the rest can be filled in without finding the row. */
export function QuickAdd({ kind, fields, refs, label, openInitially, onSaved, buttonClass = "btn btn-primary", openAfter }: { kind: RecordKind; fields: Field[]; refs: RefOptions; label: string; openInitially?: boolean; onSaved?: (id: string) => void; buttonClass?: string; openAfter?: string }) {
  const [open, setOpen] = useState(!!openInitially);
  const [key, setKey] = useState(0);
  const router = useRouter();
  const t = useToast();
  return (
    <>
      <button className={buttonClass} onClick={() => setOpen(true)}>
        + {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <RecordForm
          key={key}
          fields={fields}
          refs={refs}
          mode="quick"
          submitLabel="Add"
          onCancel={() => setOpen(false)}
          onSubmit={async (raw) => {
            const r = await saveRecord(kind, null, raw);
            if (r.ok) {
              setKey((k) => k + 1);
              setOpen(false);
              onSaved?.(r.data.id);
              if (openAfter) return router.push(`${openAfter}/${r.data.id}`), r;
              t.ok(`Added. Open it any time to fill in the rest.`);
              router.refresh();
            }
            return r;
          }}
        />
        {kind === "documentType" && <div className="help mt-3" data-testid="rule-grace-note">A rule that blocks starts with 14 days&rsquo; grace — shown on the board but not blocking — so the fleet doesn&rsquo;t stop at once. Change or clear the date on the rule.</div>}
        <div className="help mt-3">Only the essentials. Everything else lives on the record and can be filled in later.</div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
