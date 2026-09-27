import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText } from "@/lib/pdf-text";

/** PDF work for the crossing (spec §3.2 Build packet, §11.14 Solicitud de Retiro). Pure: bytes in, bytes out. */

export type PacketPart = { name: string; mimeType: string; bytes: Uint8Array };

/** One PDF: a cover page listing the contents, then every document in packet order. Images become a page each. */
export async function buildPacketPdf(input: { title: string; parts: PacketPart[] }): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const body = await out.embedFont(StandardFonts.Helvetica);
  const cover = out.addPage([612, 792]);
  cover.drawText(pdfText(input.title), { x: 54, y: 720, size: 20, font, color: rgb(0.06, 0.09, 0.16) });
  cover.drawText(`Built ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`, { x: 54, y: 696, size: 10, font: body, color: rgb(0.4, 0.45, 0.55) });
  let y = 650;
  input.parts.forEach((p, i) => {
    cover.drawText(pdfText(`${i + 1}.  ${p.name}`), { x: 54, y, size: 12, font: body, color: rgb(0.06, 0.09, 0.16) });
    y -= 20;
  });
  for (const p of input.parts) {
    if (p.mimeType === "application/pdf") {
      let src: PDFDocument;
      try {
        src = await PDFDocument.load(p.bytes, { ignoreEncryption: true });
      } catch {
        const page = out.addPage([612, 792]);
        page.drawText(pdfText(`${p.name}: file could not be read as a PDF`), { x: 54, y: 720, size: 12, font: body, color: rgb(0.7, 0.1, 0.1) });
        continue;
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const pg of pages) out.addPage(pg);
    } else if (p.mimeType === "image/jpeg" || p.mimeType === "image/png") {
      const img = p.mimeType === "image/jpeg" ? await out.embedJpg(p.bytes) : await out.embedPng(p.bytes);
      const page = out.addPage([612, 792]);
      const scale = Math.min(540 / img.width, 720 / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawText(pdfText(p.name), { x: 36, y: 760, size: 10, font: body, color: rgb(0.4, 0.45, 0.55) });
      page.drawImage(img, { x: (612 - w) / 2, y: (752 - h) / 2, width: w, height: h });
    }
  }
  return out.save();
}

export type SolicitudInput = {
  companyName: string;
  legalName: string;
  date: Date;
  yardName: string;
  trailerNumber: string;
  transfer: string;
  drivers: string[];
  unitNumber: string;
  usPlate: string;
  mxPlate: string;
  orderNumber: string;
  authorizedBy: string;
};

/**
 * Solicitud de Retiro — the letter the crossing carrier writes to the border yard so the caja is
 * released to its transfer truck (Nate: "we make the carta de retiro, we being the crossing carrier").
 * Same fields as the real one: caja, patio, transfer, operadores, unidad, placas, autorizado por.
 */
export async function buildSolicitudRetiro(d: SolicitudInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const teal = rgb(0.06, 0.46, 0.43);
  // letterhead
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.06, 0.09, 0.16) });
  page.drawText(pdfText(d.companyName), { x: 54, y: 760, size: 18, font: bold, color: rgb(1, 1, 1) });
  page.drawText(pdfText("Transfer / crossing carrier"), { x: 54, y: 748, size: 8, font, color: rgb(0.8, 0.85, 0.9) });
  const fecha = d.date.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Chicago" });
  page.drawText(`Nuevo Laredo, Tamaulipas, a ${fecha}`, { x: 54, y: 700, size: 11, font, color: ink });
  page.drawText(pdfText("SOLICITUD DE RETIRO"), { x: 54, y: 660, size: 16, font: bold, color: teal });
  page.drawText(pdfText(`A quien corresponda — ${d.yardName}`), { x: 54, y: 636, size: 11, font: bold, color: ink });

  const lines = [
    `Por medio de la presente solicito de la manera más atenta el retiro de la caja`,
    `${d.trailerNumber} que se encuentra en ${d.yardName}, la cual será retirada por la`,
    `transfer ${d.transfer} con los siguientes datos:`,
  ];
  let y = 606;
  for (const l of lines) {
    page.drawText(pdfText(l), { x: 54, y, size: 11, font, color: ink });
    y -= 17;
  }
  y -= 12;
  const rows: [string, string][] = [
    ["Caja", d.trailerNumber],
    ["Transfer", d.transfer],
    [d.drivers.length > 1 ? "Operadores" : "Operador", d.drivers.join(" / ")],
    ["Unidad", d.unitNumber],
    ["Placas", [d.usPlate, d.mxPlate].filter(Boolean).join(" / ")],
    ["Referencia", d.orderNumber],
  ];
  for (const [k, v] of rows) {
    page.drawText(pdfText(k.toUpperCase()), { x: 54, y, size: 8, font: bold, color: muted });
    page.drawText(pdfText(v || "—"), { x: 160, y: y - 1, size: 12, font: bold, color: ink });
    page.drawLine({ start: { x: 54, y: y - 8 }, end: { x: 558, y: y - 8 }, thickness: 0.5, color: rgb(0.89, 0.91, 0.94) });
    y -= 26;
  }
  y -= 10;
  page.drawText("Sin más por el momento, agradezco su atención.", { x: 54, y, size: 11, font, color: ink });
  y -= 70;
  page.drawLine({ start: { x: 54, y }, end: { x: 300, y }, thickness: 0.8, color: ink });
  page.drawText(pdfText("Autorizado por"), { x: 54, y: y - 14, size: 9, font: bold, color: muted });
  if (d.authorizedBy) page.drawText(pdfText(d.authorizedBy), { x: 54, y: y + 6, size: 11, font, color: ink });
  page.drawText(pdfText(d.legalName), { x: 54, y: y - 28, size: 9, font, color: muted });
  page.drawText(pdfText(`Generado por Crossline · ${d.orderNumber}`), { x: 54, y: 40, size: 8, font, color: muted });
  return doc.save();
}
