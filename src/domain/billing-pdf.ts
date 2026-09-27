import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText } from "@/lib/pdf-text";
import type { InvoiceSnapshot } from "@/db/schema";

const money = (c: number, cur: string) => `${cur === "MXN" ? "MX$" : "$"}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Invoice PDF from the locked snapshot only (spec 7.4 "never from current master data"). */
export async function buildInvoicePdf(inv: { number: string; issuedAt: Date; dueAt: Date; snapshot: InvoiceSnapshot; subtotalCents: number; totalCents: number; creditedCents?: number; notes?: string | null }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const line = rgb(0.89, 0.91, 0.94);
  const s = inv.snapshot;
  let page = doc.addPage([612, 792]);
  const draw = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });

  // header
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.06, 0.09, 0.16) });
  draw(s.entity.dba || s.entity.legalName, 54, 760, 18, bold, rgb(1, 1, 1));
  draw("INVOICE", 470, 760, 18, bold, rgb(0.6, 0.96, 0.89));
  draw(`# ${inv.number}`, 470, 748, 9, font, rgb(0.8, 0.85, 0.9));

  // entity / bill to
  let y = 712;
  draw(s.entity.legalName, 54, y, 10, bold);
  const remit = s.entity.remitTo ?? {};
  const remitLines = [remit.line1, [remit.city, remit.state, remit.postalCode].filter(Boolean).join(", "), remit.country].filter(Boolean) as string[];
  remitLines.forEach((l, i) => draw(l, 54, y - 13 * (i + 1), 9, font, muted));
  const ids = [s.entity.mc && `MC ${s.entity.mc}`, s.entity.dot && `DOT ${s.entity.dot}`, s.entity.taxId && `Tax ID ${s.entity.taxId}`].filter(Boolean).join(" · ");
  if (ids) draw(ids, 54, y - 13 * (remitLines.length + 1), 8, font, muted);

  draw("BILL TO", 330, y, 8, bold, muted);
  draw(s.billTo.name, 330, y - 13, 10, bold);
  if (s.billTo.email) draw(s.billTo.email, 330, y - 26, 9, font, muted);
  draw("DATE", 470, y, 8, bold, muted);
  draw(inv.issuedAt.toISOString().slice(0, 10), 470, y - 13, 9);
  draw("DUE", 470, y - 30, 8, bold, muted);
  draw(inv.dueAt.toISOString().slice(0, 10), 470, y - 43, 9);
  draw("TERMS", 470, y - 60, 8, bold, muted);
  draw(s.terms, 470, y - 73, 9);

  // refs & route
  y = 610;
  const refs = Object.entries(s.refs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join("   ");
  if (refs) {
    draw(refs, 54, y, 9, font, muted);
    y -= 16;
  }
  if (s.stops.length) {
    const first = s.stops[0];
    const last = s.stops[s.stops.length - 1];
    const p = (st: typeof first) => `${st.name}${st.city ? `, ${st.city}` : ""}${st.state ? ` ${st.state}` : ""}`;
    draw(`${p(first)}  to  ${p(last)}`, 54, y, 10, bold);
    const when = [first.departedAt && `picked up ${first.departedAt.slice(0, 10)}`, last.arrivedAt && `delivered ${last.arrivedAt.slice(0, 10)}`].filter(Boolean).join(" · ");
    if (when) draw(when, 54, y - 13, 9, font, muted);
    y -= 34;
  }

  // lines
  y -= 6;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.8, color: ink });
  y -= 14;
  draw("DESCRIPTION", 54, y, 8, bold, muted);
  draw("QTY", 380, y, 8, bold, muted);
  draw("RATE", 430, y, 8, bold, muted);
  draw("AMOUNT", 500, y, 8, bold, muted);
  y -= 8;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.4, color: line });
  y -= 16;
  for (const l of s.lines) {
    if (y < 120) {
      page = doc.addPage([612, 792]);
      y = 740;
    }
    draw(l.description.slice(0, 70), 54, y, 10);
    if (s.lines.length > 1 && l.orderNumber) draw(l.orderNumber, 54, y - 11, 8, font, muted);
    const qty = l.unit === "flat" ? "1" : l.unit === "h" ? (l.qty / 100).toFixed(2) : String(l.qty);
    draw(l.unit === "flat" ? "" : `${qty} ${l.unit}`, 380, y, 9);
    draw(l.unit === "flat" ? "" : money(l.rateCents, s.currency), 430, y, 9);
    draw(money(l.amountCents, s.currency), 500, y, 10, bold);
    y -= s.lines.length > 1 && l.orderNumber ? 26 : 18;
  }
  y -= 4;
  page.drawLine({ start: { x: 380, y }, end: { x: 558, y }, thickness: 0.4, color: line });
  y -= 16;
  draw("Subtotal", 380, y, 9, font, muted);
  draw(money(inv.subtotalCents, s.currency), 500, y, 9);
  if (inv.creditedCents) {
    y -= 14;
    draw("Credits", 380, y, 9, font, muted);
    draw(`-${money(inv.creditedCents, s.currency)}`, 500, y, 9);
  }
  y -= 18;
  draw("TOTAL DUE", 380, y, 10, bold);
  draw(money(inv.totalCents - (inv.creditedCents ?? 0), s.currency), 500, y, 12, bold);
  if (s.currency === "MXN" && s.exchangeRate) {
    y -= 14;
    draw(`Exchange rate at issue: ${s.exchangeRate.toFixed(4)} MXN / USD`, 380, y, 8, font, muted);
  }
  y -= 40;
  draw("Remit to", 54, y, 8, bold, muted);
  draw(s.entity.legalName, 54, y - 13, 9);
  remitLines.forEach((l, i) => draw(l, 54, y - 13 * (i + 2), 9, font, muted));
  if (inv.notes) draw(inv.notes.slice(0, 200), 54, y - 13 * (remitLines.length + 3), 9, font, muted);
  draw(`Invoice ${inv.number} · generated by Crossline`, 54, 40, 8, font, muted);
  return doc.save();
}

/** Simple customer statement: open invoices with aging. */
export async function buildStatementPdf(input: { entityName: string; customerName: string; asOf: Date; rows: { number: string; issuedAt: string; dueAt: string; totalCents: number; openCents: number; daysPastDue: number }[]; currency: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  page.drawText(pdfText(input.entityName), { x: 54, y: 740, size: 16, font: bold, color: ink });
  page.drawText(`Statement for ${input.customerName} · as of ${input.asOf.toISOString().slice(0, 10)}`, { x: 54, y: 720, size: 10, font, color: muted });
  let y = 680;
  for (const [x, h] of [[54, "INVOICE"], [150, "ISSUED"], [230, "DUE"], [320, "TOTAL"], [410, "OPEN"], [500, "DAYS LATE"]] as const) page.drawText(pdfText(h), { x, y, size: 8, font: bold, color: muted });
  y -= 16;
  let open = 0;
  for (const r of input.rows) {
    page.drawText(pdfText(r.number), { x: 54, y, size: 9, font: bold, color: ink });
    page.drawText(r.issuedAt.slice(0, 10), { x: 150, y, size: 9, font, color: ink });
    page.drawText(r.dueAt.slice(0, 10), { x: 230, y, size: 9, font, color: ink });
    page.drawText(money(r.totalCents, input.currency), { x: 320, y, size: 9, font, color: ink });
    page.drawText(money(r.openCents, input.currency), { x: 410, y, size: 9, font: bold, color: ink });
    page.drawText(pdfText(r.daysPastDue > 0 ? String(r.daysPastDue) : "—"), { x: 500, y, size: 9, font, color: r.daysPastDue > 0 ? rgb(0.7, 0.1, 0.1) : muted });
    open += r.openCents;
    y -= 16;
  }
  y -= 10;
  page.drawText(`TOTAL OPEN ${money(open, input.currency)}`, { x: 410, y, size: 11, font: bold, color: ink });
  return doc.save();
}
