/** Pure cash-application helpers (the payment dialog runs them in the browser too). */

export type OpenInvoice = { id: string; number: string; openCents: number; loads: { orderNumber: string; refs: string[] }[] };

/**
 * Spread an amount over open invoices. When the remittance names invoices (invoice number, load number or a load
 * reference found in the text) the money goes to those only; otherwise oldest due first. What doesn't fit stays on account.
 */
export function suggest(invoices: OpenInvoice[], amountCents: number, remittance = "") {
  const text = remittance.toLowerCase();
  const named = (i: (typeof invoices)[number]) => !!text && ((i.number && text.includes(i.number.toLowerCase())) || i.loads.some((l) => text.includes(l.orderNumber.toLowerCase()) || l.refs.some((r) => r.length >= 4 && text.includes(r.toLowerCase()))));
  const anyNamed = invoices.some(named);
  const order = [...invoices.filter(named), ...invoices.filter((i) => !named(i))];
  let left = amountCents;
  return order.map((i) => {
    const apply = anyNamed && !named(i) ? 0 : Math.max(0, Math.min(i.openCents, left));
    left -= apply;
    return { invoiceId: i.id, number: i.number, openCents: i.openCents, applyCents: apply, named: named(i) };
  });
}

