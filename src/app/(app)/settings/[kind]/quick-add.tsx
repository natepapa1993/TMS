"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { RecordForm, type RefOptions } from "@/components/record-form";
import type { Field } from "@/data/fields";
import type { RecordKind } from "@/data/records";
import { saveRecord } from "../actions";

/** The quick-add popup: essentials only, saves, offers "add another" (spec §1.1 ease rule). */
export function QuickAdd({ kind, fields, refs, label, openInitially, onSaved, buttonClass = "btn btn-primary" }: { kind: RecordKind; fields: Field[]; refs: RefOptions; label: string; openInitially?: boolean; onSaved?: (id: string) => void; buttonClass?: string }) {
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
              t.ok(`Added. Open it any time to fill in the rest.`);
              setKey((k) => k + 1);
              setOpen(false);
              onSaved?.(r.data.id);
              router.refresh();
            }
            return r;
          }}
        />
        <div className="help mt-3">Only the essentials. Everything else lives on the record and can be filled in later.</div>
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
