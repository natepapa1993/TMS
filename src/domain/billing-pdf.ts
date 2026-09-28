import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText } from "@/lib/pdf-text";
import type { InvoiceSnapshot } from "@/db/schema";

import { money as fmt } from "./fx-rules";

/** "$1,234.00", "MX$53,100.00", "CA$2,590.00": the currency's own symbol on every line (never a bare "$" on pesos). */
const money = (c: number, cur: string) => fmt(c, cur);
/** Totals carry the ISO code too on non-USD documents: "CA$2,590.00 CAD". */
const moneyCode = (c: number, cur: string) => fmt(c, cur, { code: true });
const REF_LABEL: Record<string, string> = { po: "PO #", rate_con: "Rate con #", asn: "ASN #", shipment: "Shipment #", reference: "Ref #", bol: "BOL #", pro: "PRO #", pickup: "Pickup #", delivery: "Delivery #", sylectus_load: "Load #" };
const refLabel = (k: string) => REF_LABEL[k] ?? `${k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} #`;
const day = (d: Date, tz?: string) => (tz ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : d.toISOString().slice(0, 10));
const addrLines = (a: Record<string, string | undefined> | null | undefined) => (a ? ([a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(", "), a.country].filter(Boolean) as string[]) : []);

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
  draw(s.supplementOf ? "SUPPLEMENTAL" : "INVOICE", s.supplementOf ? 430 : 470, 760, s.supplementOf ? 15 : 18, bold, rgb(0.6, 0.96, 0.89));
  draw(`# ${inv.number}`, 470, 748, 9, font, rgb(0.8, 0.85, 0.9));
  if (s.loadNumbers?.length) draw(`${s.loadNumbers.length === 1 ? "Load" : "Loads"} ${s.loadNumbers.length > 3 ? `${s.loadNumbers.slice(0, 3).join(", ")} +${s.loadNumbers.length - 3}` : s.loadNumbers.join(", ")}`, 54, 748, 9, font, rgb(0.8, 0.85, 0.9));

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
  const ba = s.billTo.address ?? {};
  const billLines = [ba.line1, ba.line2, [ba.city, ba.state, ba.postalCode].filter(Boolean).join(", "), ba.country && ba.country !== "US" ? ba.country : "", s.billTo.email].filter(Boolean) as string[];
  billLines.slice(0, 5).forEach((l, i) => draw(l.length > 30 ? `${l.slice(0, 28)}...` : l, 330, y - 26 - 12 * i, 9, font, muted)); // stays clear of the date column
  draw("DATE", 470, y, 8, bold, muted);
  draw(day(inv.issuedAt, s.timeZone), 470, y - 13, 9);
  draw("DUE", 470, y - 30, 8, bold, muted);
  draw(day(inv.dueAt, s.timeZone), 470, y - 43, 9);
  draw("TERMS", 470, y - 60, 8, bold, muted);
  draw(s.terms, 470, y - 73, 9);

  // what this invoice points back to: a supplemental adds to an invoice, a rebill replaces a voided one
  y = 624;
  const back = [s.supplementOf && `Supplemental to invoice ${s.supplementOf} — additional charges for the same load${s.loadNumbers && s.loadNumbers.length > 1 ? "s" : ""}, not a duplicate`, s.replaces && `Replaces invoice ${s.replaces} (voided)`].filter(Boolean) as string[];
  for (const b of back) {
    draw(b, 54, y, 9.5, bold);
    y -= 14;
  }
  // refs & route
  y = Math.min(y, 610);
  const refs = Object.entries(s.refs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${refLabel(k)} ${v}`)
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
    const when = [first.departedAt && `picked up ${first.departedDate ?? first.departedAt.slice(0, 10)}`, last.arrivedAt && `delivered ${last.arrivedDate ?? last.arrivedAt.slice(0, 10)}`].filter(Boolean).join(" · ");
    if (when) draw(when, 54, y - 13, 9, font, muted);
    y -= 34;
  }

  // a summary invoice: the loads first
  if (s.loads?.length) {
    draw(`${s.loads.length} loads`, 54, y, 10, bold);
    y -= 16;
    const cols: [number, string][] = [[54, "LOAD"], [124, "REFERENCES"], [250, "LANE"], [440, "DELIVERED"], [500, "AMOUNT"]];
    for (const [x, h] of cols) draw(h, x, y, 8, bold, muted);
    y -= 6;
    page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.4, color: line });
    y -= 13;
    for (const l of s.loads) {
      if (y < 120) {
        page = doc.addPage([612, 792]);
        y = 740;
      }
      draw(l.orderNumber, 54, y, 9, bold);
      draw(l.refs.slice(0, 22), 124, y, 8.5, font, muted);
      draw(`${l.from} - ${l.to}`.slice(0, 36), 250, y, 8.5);
      draw(l.delivered ?? "", 440, y, 8.5);
      draw(money(l.amountCents, s.currency), 500, y, 9, bold);
      y -= 14;
    }
    y -= 14;
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
  const due = moneyCode(inv.totalCents - (inv.creditedCents ?? 0), s.currency);
  draw(due, Math.min(500, 558 - bold.widthOfTextAtSize(pdfText(due), 12)), y, 12, bold);
  if (s.currency !== "USD") {
    y -= 14;
    draw(`Amounts in ${s.currency === "MXN" ? "Mexican pesos (MXN)" : s.currency === "CAD" ? "Canadian dollars (CAD)" : s.currency}${s.exchangeRate ? ` · rate at issue ${s.exchangeRate.toFixed(4)} ${s.currency} per USD` : ""}`, 300, y, 8, font, muted);
  }
  y -= 40;
  if (y < 150) {
    page = doc.addPage([612, 792]);
    y = 700;
  }
  if (s.factor) {
    const words = s.factor.notice.split(/\s+/);
    const rows: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > 95) {
        rows.push(cur.trim());
        cur = w;
      } else cur += ` ${w}`;
    }
    if (cur.trim()) rows.push(cur.trim());
    const h = 22 + rows.length * 12;
    page.drawRectangle({ x: 50, y: y - h + 12, width: 508, height: h, borderColor: ink, borderWidth: 1 });
    draw("NOTICE OF ASSIGNMENT", 58, y, 8, bold);
    rows.forEach((r, i) => draw(r, 58, y - 13 - i * 12, 9));
    y -= h + 14;
  }
  draw("Remit to", 54, y, 8, bold, muted);
  draw(s.factor ? s.factor.name : s.entity.legalName, 54, y - 13, 9);
  // a factored invoice prints the factor's own address, never ours under the factor's name
  const payLines = s.factor ? (s.factor.remitTo ? addrLines(s.factor.remitTo) : ["(the factor's payment address is missing — ask us before paying)"]) : remitLines;
  payLines.forEach((l, i) => draw(l, 54, y - 13 * (i + 2), 9, font, muted));
  if (inv.notes) draw(inv.notes.slice(0, 200), 54, y - 13 * (payLines.length + 3), 9, font, muted);
  draw(`Invoice ${inv.number} · generated by Crossline`, 54, 40, 8, font, muted);
  return doc.save();
}

/** Customer statement: open invoices with aging, subtotalled per currency (pesos are never added to dollars). */
export async function buildStatementPdf(input: { entityName: string; remitTo?: Record<string, string | undefined> | null; customerName: string; asOf: Date; timeZone?: string; rows: { number: string; currency: string; issuedAt: Date | null; dueAt: Date | null; totalCents: number; openCents: number; daysPastDue: number; disputed?: boolean }[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const draw = (t: string, x: number, y: number, size = 9, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  draw(input.entityName, 54, 740, 16, bold);
  draw(`Statement for ${input.customerName} · as of ${day(input.asOf, input.timeZone)}`, 54, 720, 10, font, muted);
  const remit = addrLines(input.remitTo);
  if (remit.length) draw(`Remit to: ${input.entityName}, ${remit.join(", ")}`, 54, 706, 8.5, font, muted);
  let y = 676;
  const currencies = [...new Set(input.rows.map((r) => r.currency))].sort((a, b) => ["USD", "MXN", "CAD"].indexOf(a) - ["USD", "MXN", "CAD"].indexOf(b));
  if (!input.rows.length) draw("Nothing open. Thank you.", 54, y, 11, bold);
  for (const cur of currencies) {
    const rows = input.rows.filter((r) => r.currency === cur);
    if (y < 140) {
      page = doc.addPage([612, 792]);
      y = 740;
    }
    draw(cur === "USD" ? "US DOLLARS (USD)" : cur === "MXN" ? "MEXICAN PESOS (MXN)" : cur === "CAD" ? "CANADIAN DOLLARS (CAD)" : cur, 54, y, 9, bold);
    y -= 16;
    for (const [x, h] of [[54, "INVOICE"], [150, "ISSUED"], [230, "DUE"], [310, "TOTAL"], [400, "OPEN"], [490, "DAYS LATE"]] as const) draw(h, x, y, 8, bold, muted);
    y -= 16;
    let open = 0;
    for (const r of rows) {
      if (y < 90) {
        page = doc.addPage([612, 792]);
        y = 740;
      }
      draw(r.number + (r.disputed ? " (disputed)" : ""), 54, y, 9, bold);
      draw(r.issuedAt ? day(r.issuedAt, input.timeZone) : "", 150, y);
      draw(r.dueAt ? day(r.dueAt, input.timeZone) : "", 230, y);
      draw(money(r.totalCents, cur), 310, y);
      draw(money(r.openCents, cur), 400, y, 9, bold);
      draw(r.daysPastDue > 0 ? String(r.daysPastDue) : "—", 490, y, 9, font, r.daysPastDue > 0 ? rgb(0.7, 0.1, 0.1) : muted);
      open += r.openCents;
      y -= 16;
    }
    y -= 4;
    draw(`TOTAL OPEN ${moneyCode(open, cur)}`, 360, y, 11, bold);
    y -= 30;
  }
  if (currencies.length > 1) draw("Each currency is totalled on its own: pay each in the currency of its invoices.", 54, Math.max(y, 60), 8.5, font, muted);
  return doc.save();
}

/** A credit memo: what is credited on which invoice, why, and what the invoice has open after it. */
export async function buildCreditMemoPdf(m: { number: string; issuedAt: Date; invoiceNumber: string; reason: string; lines: { description: string; amountCents: number }[]; amountCents: number; currency: string; entity: InvoiceSnapshot["entity"]; billTo: InvoiceSnapshot["billTo"]; invoiceTotalCents: number; openAfterCents: number | null; timeZone?: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const rule = rgb(0.89, 0.91, 0.94);
  const page = doc.addPage([612, 792]);
  const draw = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: ink });
  draw(m.entity.dba || m.entity.legalName, 54, 760, 18, bold, rgb(1, 1, 1));
  draw("CREDIT MEMO", 430, 760, 16, bold, rgb(0.6, 0.96, 0.89));
  draw(`# ${m.number}`, 430, 748, 9, font, rgb(0.8, 0.85, 0.9));
  let y = 712;
  draw(m.entity.legalName, 54, y, 10, bold);
  addrLines(m.entity.remitTo).forEach((l, i) => draw(l, 54, y - 13 * (i + 1), 9, font, muted));
  draw("CREDIT TO", 330, y, 8, bold, muted);
  draw(m.billTo.name, 330, y - 13, 10, bold);
  addrLines(m.billTo.address ?? null).slice(0, 4).forEach((l, i) => draw(l.length > 30 ? `${l.slice(0, 28)}...` : l, 330, y - 26 - 12 * i, 9, font, muted));
  draw("DATE", 480, y, 8, bold, muted);
  draw(day(m.issuedAt, m.timeZone), 480, y - 13, 9);
  draw("INVOICE", 480, y - 30, 8, bold, muted);
  draw(m.invoiceNumber, 480, y - 43, 9);
  y = 610;
  draw(`Credit on invoice ${m.invoiceNumber} (${money(m.invoiceTotalCents, m.currency)})`, 54, y, 11, bold);
  draw(`Reason: ${m.reason}`.slice(0, 100), 54, y - 15, 9.5, font, muted);
  y -= 44;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.8, color: ink });
  y -= 14;
  draw("DESCRIPTION", 54, y, 8, bold, muted);
  draw("CREDIT", 480, y, 8, bold, muted);
  y -= 8;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.4, color: rule });
  y -= 16;
  for (const l of m.lines) {
    draw(l.description.slice(0, 80), 54, y, 10);
    draw(`-${money(l.amountCents, m.currency)}`, 480, y, 10, bold);
    y -= 18;
  }
  y -= 6;
  page.drawLine({ start: { x: 330, y }, end: { x: 558, y }, thickness: 0.4, color: rule });
  y -= 18;
  draw("TOTAL CREDIT", 330, y, 10, bold);
  draw(`-${moneyCode(m.amountCents, m.currency)}`, 450, y, 12, bold);
  if (m.openAfterCents != null) {
    y -= 18;
    draw(`Invoice ${m.invoiceNumber} open after this credit`, 250, y, 9, font, muted);
    draw(moneyCode(m.openAfterCents, m.currency), 450, y, 9, bold);
  }
  draw(`Credit memo ${m.number} · not an invoice · generated by Crossline`, 54, 40, 8, font, muted);
  return doc.save();
}

/** Schedule of accounts to the factoring company: the invoices being assigned, with their total. */
export async function buildFactorSchedulePdf(input: { entity: string; factor: string; number: number; date: Date; currency: string; rows: { number: string; customer: string; issuedAt: string; loads: number; amountCents: number }[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  let page = doc.addPage([612, 792]);
  const draw = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  draw("SCHEDULE OF ACCOUNTS", 54, 740, 18, bold);
  draw(`#${input.number} · ${input.date.toISOString().slice(0, 10)}`, 54, 720, 10, font, muted);
  draw(`From: ${input.entity}`, 54, 696, 10, bold);
  draw(`To: ${input.factor}`, 54, 682, 10);
  let y = 648;
  const head = () => {
    for (const [x, h] of [[54, "INVOICE"], [150, "CUSTOMER"], [360, "ISSUED"], [430, "LOADS"], [490, "AMOUNT"]] as const) draw(h, x, y, 8, bold, muted);
    y -= 16;
  };
  head();
  let total = 0;
  for (const r of input.rows) {
    if (y < 90) {
      page = doc.addPage([612, 792]);
      y = 740;
      head();
    }
    draw(r.number, 54, y, 9, bold);
    draw(r.customer.slice(0, 34), 150, y, 9);
    draw(r.issuedAt, 360, y, 9);
    draw(String(r.loads), 430, y, 9);
    draw(money(r.amountCents, input.currency), 490, y, 9, bold);
    total += r.amountCents;
    y -= 15;
  }
  y -= 8;
  draw(`${input.rows.length} invoice${input.rows.length === 1 ? "" : "s"}`, 54, y, 10, bold);
  draw(`TOTAL ${money(total, input.currency)}`, 430, y, 11, bold);
  y -= 50;
  draw("The invoices listed are assigned to the factor above. Invoices and supporting documents follow.", 54, y, 9, font, muted);
  y -= 40;
  draw("Signed: ______________________________", 54, y, 10);
  return doc.save();
}

/** A driver's pay statement: earnings, reimbursements, deductions, net, how it was paid, and the year to date. */
export async function buildSettlementPdf(p: { company: string; driver: string; periodStart: Date; periodEnd: Date; state: string; lines: { kind: string; description: string; amountCents: number }[]; grossCents: number; deductionsCents: number; netCents: number; paidAt: Date | null; method: string | null; reference: string | null; ytd: { grossCents: number; deductionsCents: number; netCents: number }; /** false: an open statement, not in the year to date yet */ ytdIncludesThis?: boolean; /** after this statement: advances left to recover, escrow held */ balances?: { label: string; cents: number }[]; timeZone: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const rule = rgb(0.89, 0.91, 0.94);
  let page = doc.addPage([612, 792]);
  const draw = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  const right = (t: string, xr: number, y: number, size = 10, f = font, color = ink) => draw(t, xr - f.widthOfTextAtSize(pdfText(t), size), y, size, f, color);
  const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: p.timeZone });
  const last = new Date(p.periodEnd.getTime() - 1);

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: ink });
  draw(p.company, 54, 760, 18, bold, rgb(1, 1, 1));
  draw("PAY STATEMENT", 430, 760, 14, bold, rgb(0.6, 0.96, 0.89));
  let y = 712;
  draw(p.driver, 54, y, 13, bold);
  draw(`Week ${day(p.periodStart)} - ${day(last)}`, 54, y - 16, 10, font, muted);
  draw(p.state === "paid" && p.paidAt ? `Paid ${day(p.paidAt)}${p.method ? ` by ${p.method.toUpperCase()}` : ""}${p.reference ? ` · ${p.reference}` : ""}` : `Status: ${p.state}`, 54, y - 30, 10, font, muted);
  right(money(p.netCents, "USD"), 558, y - 4, 22, bold);
  right("NET PAY", 558, y + 16, 8, bold, muted);
  y = 650;

  const section = (title: string, rows: typeof p.lines) => {
    if (!rows.length) return;
    draw(title, 54, y, 9, bold, muted);
    y -= 6;
    page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.4, color: rule });
    y -= 14;
    for (const l of rows) {
      if (y < 110) {
        page = doc.addPage([612, 792]);
        y = 740;
      }
      // a long line wraps onto a second one rather than cutting off what is still owed
      const words = pdfText(l.description).split(" ");
      const rows: string[] = [""];
      for (const w of words) {
        const next = rows[rows.length - 1] ? `${rows[rows.length - 1]} ${w}` : w;
        if (font.widthOfTextAtSize(next, 9.5) > 400 && rows[rows.length - 1]) rows.push(w);
        else rows[rows.length - 1] = next;
      }
      right(money(l.amountCents, "USD"), 558, y, 9.5, l.amountCents < 0 ? font : bold);
      for (const r of rows) {
        draw(r, 54, y, 9.5);
        y -= 12;
      }
      y -= 3;
    }
    y -= 10;
  };
  section("EARNINGS", p.lines.filter((l) => l.kind === "leg" || l.kind === "accessorial" || (l.kind === "adjustment" && l.amountCents >= 0)));
  section("REIMBURSEMENTS", p.lines.filter((l) => l.kind === "reimbursement"));
  section("DEDUCTIONS", p.lines.filter((l) => l.kind === "deduction" || (l.kind === "adjustment" && l.amountCents < 0)));

  if (y < 170) {
    page = doc.addPage([612, 792]);
    y = 740;
  }
  page.drawLine({ start: { x: 330, y: y + 4 }, end: { x: 558, y: y + 4 }, thickness: 0.6, color: ink });
  for (const [label, v, b] of [["Gross", p.grossCents, false], ["Deductions", -p.deductionsCents, false], ["Net pay", p.netCents, true]] as const) {
    y -= 14;
    draw(label, 330, y, 10, b ? bold : font);
    right(money(v, "USD"), 558, y, 10, b ? bold : font);
  }
  if (p.balances?.length) {
    y -= 30;
    draw("BALANCES AFTER THIS STATEMENT", 54, y, 9, bold, muted);
    for (const b of p.balances) {
      y -= 15;
      draw(b.label.length > 80 ? `${b.label.slice(0, 78)}...` : b.label, 54, y, 9.5);
      right(money(b.cents, "USD"), 558, y, 9.5, bold);
    }
  }
  y -= 34;
  draw(`YEAR TO DATE (${p.periodStart.getUTCFullYear()})${p.ytdIncludesThis === false ? " — paid statements; this one counts once approved" : ""}`, 54, y, 9, bold, muted);
  y -= 16;
  draw(`Gross ${money(p.ytd.grossCents, "USD")}    Deductions ${money(-p.ytd.deductionsCents, "USD")}    Net ${money(p.ytd.netCents, "USD")}`, 54, y, 10);
  draw("Questions about a line? Dispute it in the driver app and dispatch will answer there.", 54, 60, 8.5, font, muted);
  return doc.save();
}
