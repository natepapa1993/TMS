/** Pure delivery wording (the browser uses it too). */

/** What an email "sent" with no email provider connected says, everywhere it shows. */
export const NOT_EMAILED = "Logged — not emailed (connect email in Settings → Integrations)";

type Delivered = { state: string; sentAt?: string | Date | null; deliveries?: { logged?: boolean; method: string }[] | null };

/** An invoice that is issued but never reached the customer: every "send" so far only went to the log. */
export function notEmailed(inv: Delivered) {
  return ["issued", "partially_paid", "disputed"].includes(inv.state) && !inv.sentAt && (inv.deliveries ?? []).some((d) => d.logged);
}

/** The toast after a send: honest when it only went to the log. */
export function sendOutcome(inv: Delivered | null | undefined, sentLabel = "Sent") {
  const last = inv?.deliveries?.[inv.deliveries.length - 1];
  return last?.logged ? NOT_EMAILED : sentLabel;
}
