import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText } from "@/lib/pdf-text";
import type { InvoiceSnapshot } from "@/db/schema";

const money = (c: number, cur: string) => `${c < 0 ? "-" : ""}${cur === "MXN" ? "MX$" : "$"}${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  draw(money(inv.totalCents - (inv.creditedCents ?? 0), s.currency), 500, y, 12, bold);
  if (s.currency === "MXN" && s.exchangeRate) {
    y -= 14;
    draw(`Exchange rate at issue: ${s.exchangeRate.toFixed(4)} MXN / USD`, 380, y, 8, font, muted);
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
  const fr = s.factor?.remitTo ?? null;
  const payLines = fr ? ([fr.line1, [fr.city, fr.state, fr.postalCode].filter(Boolean).join(", "), fr.country].filter(Boolean) as string[]) : remitLines;
  payLines.forEach((l, i) => draw(l, 54, y - 13 * (i + 2), 9, font, muted));
  if (inv.notes) draw(inv.notes.slice(0, 200), 54, y - 13 * (payLines.length + 3), 9, font, muted);
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
export async function buildSettlementPdf(p: { company: string; driver: string; periodStart: Date; periodEnd: Date; state: string; lines: { kind: string; description: string; amountCents: number }[]; grossCents: number; deductionsCents: number; netCents: number; paidAt: Date | null; method: string | null; reference: string | null; ytd: { grossCents: number; deductionsCents: number; netCents: number }; timeZone: string }): Promise<Uint8Array> {
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
      draw(l.description.length > 80 ? `${l.description.slice(0, 78)}...` : l.description, 54, y, 9.5);
      right(money(l.amountCents, "USD"), 558, y, 9.5, l.amountCents < 0 ? font : bold);
      y -= 15;
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
  y -= 34;
  draw(`YEAR TO DATE (${p.periodStart.getUTCFullYear()})`, 54, y, 9, bold, muted);
  y -= 16;
  draw(`Gross ${money(p.ytd.grossCents, "USD")}    Deductions ${money(-p.ytd.deductionsCents, "USD")}    Net ${money(p.ytd.netCents, "USD")}`, 54, y, 10);
  draw("Questions about a line? Dispute it in the driver app and dispatch will answer there.", 54, 60, 8.5, font, muted);
  return doc.save();
}
