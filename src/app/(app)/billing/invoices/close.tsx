"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Toast, useToast } from "@/components/ui";
import { closePeriodAction } from "../actions";

export function CloseButton() {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState("");
  const router = useRouter();
  const t = useToast();
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Close period
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Month-end close"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={!through}
              onClick={async () => {
                const r = await closePeriodAction(through);
                setOpen(false);
                if (r.ok) {
                  t.ok(`Closed through ${through}`);
                  router.refresh();
                } else t.err(r.error);
              }}
            >
              Close
            </button>
          </>
        }
      >
        <div className="text-callout text-muted mb-3">Nothing dated on or before this day can be issued, voided or credited afterwards. This cannot be undone from here.</div>
        <label className="label">Close through</label>
        <input type="date" className="input" value={through} onChange={(e) => setThrough(e.target.value)} />
      </Modal>
      <Toast message={t.toast?.message ?? null} tone={t.toast?.tone} onDone={t.clear} />
    </>
  );
}
