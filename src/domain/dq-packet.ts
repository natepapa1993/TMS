import { and, eq, inArray } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { pdfText } from "@/lib/pdf-text";
import { fmtWhen } from "@/lib/time";
import { driverSafetyFile } from "./safety";
import { tenantZone } from "./company";

/**
 * The driver qualification file as one PDF for an auditor (safety #19): a summary of every 391.51 item with its
 * date, due date and status, the licences and cards with their expiry, then every paper on file — the latest
 * one per item — in that order. Drug & alcohol records stay out: they are kept apart (40.321).
 */

export type PacketLine = { label: string; cite: string; status: string; done: string; due: string; note: string; file: string };
export type PacketSummary = { company: string; driver: string; detail: string; hired: string; builtAt: string; dispatchable: boolean; lines: PacketLine[]; credentials: { label: string; status: string; expires: string }[] };
export type PacketPart = { name: string; mimeType: string; bytes: Uint8Array };

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.4, 0.45, 0.55);
const RED = rgb(0.7, 0.1, 0.1);

/** Cut a line to fit a width in a font. */
function fit(text: string, font: PDFFont, size: number, width: number) {
  let t = pdfText(text);
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + "…";
  return t;
}

/** Pure: the summary pages and the papers → PDF bytes. */
export async function buildDqPacketPdf(sum: PacketSummary, parts: PacketPart[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const body = await out.embedFont(StandardFonts.Helvetica);
  let page: PDFPage = out.addPage([612, 792]);
  let y = 740;
  const line = (text: string, opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; width?: number } = {}) => page.drawText(fit(text, opts.font ?? body, opts.size ?? 9, opts.width ?? 504), { x: opts.x ?? 54, y, size: opts.size ?? 9, font: opts.font ?? body, color: opts.color ?? INK });
  const next = (dy: number) => {
    y -= dy;
    if (y < 60) {
      page = out.addPage([612, 792]);
      y = 740;
    }
  };
  line("Driver qualification file", { size: 18, font: bold });
  next(22);
  line(`${sum.driver} · ${sum.detail}`, { size: 12, font: bold });
  next(16);
  line(`${sum.company} · hired ${sum.hired} · ${sum.dispatchable ? "dispatchable" : "blocked from dispatch"} · built ${sum.builtAt}`, { color: MUTED });
  next(26);
  line("49 CFR 391.51 and the Clearinghouse", { size: 11, font: bold });
  next(16);
  const cols = [54, 250, 305, 370, 435, 490];
  ["Item", "Cite", "Status", "Done", "Due", "Paper"].forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 8, font: bold, color: MUTED }));
  next(13);
  for (const l of sum.lines) {
    const tone = l.status === "overdue" || l.status === "missing" ? RED : INK;
    page.drawText(fit(l.label, body, 9, 190), { x: cols[0], y, size: 9, font: body, color: INK });
    page.drawText(fit(l.cite, body, 8, 52), { x: cols[1], y, size: 8, font: body, color: MUTED });
    page.drawText(fit(l.status, bold, 8, 62), { x: cols[2], y, size: 8, font: bold, color: tone });
    page.drawText(fit(l.done, body, 8, 62), { x: cols[3], y, size: 8, font: body, color: INK });
    page.drawText(fit(l.due, body, 8, 52), { x: cols[4], y, size: 8, font: body, color: INK });
    page.drawText(fit(l.file || "—", body, 8, 68), { x: cols[5], y, size: 8, font: body, color: l.file ? INK : MUTED });
    if (l.note) {
      next(11);
      page.drawText(fit(`— ${l.note}`, body, 8, 480), { x: cols[0] + 8, y, size: 8, font: body, color: MUTED });
    }
    next(14);
  }
  next(10);
  line("Licences and cards", { size: 11, font: bold });
  next(16);
  for (const c of sum.credentials) {
    page.drawText(fit(c.label, body, 9, 240), { x: 54, y, size: 9, font: body, color: INK });
    page.drawText(fit(c.status, bold, 8, 80), { x: 305, y, size: 8, font: bold, color: c.status === "expired" || c.status === "missing" ? RED : INK });
    page.drawText(fit(c.expires, body, 8, 120), { x: 390, y, size: 8, font: body, color: INK });
    next(14);
  }
  next(10);
  line(parts.length ? `Papers on file (${parts.length}), in the order above:` : "No papers attached to the file yet.", { font: bold, size: 10 });
  next(14);
  parts.forEach((p, i) => {
    line(`${i + 1}. ${p.name}`);
    next(12);
  });
  for (const p of parts) {
    if (p.mimeType === "application/pdf") {
      try {
        const src = await PDFDocument.load(p.bytes, { ignoreEncryption: true });
        for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
      } catch {
        const pg = out.addPage([612, 792]);
        pg.drawText(pdfText(`${p.name}: the file could not be read as a PDF`), { x: 54, y: 720, size: 12, font: body, color: RED });
      }
    } else if (p.mimeType === "image/jpeg" || p.mimeType === "image/png") {
      try {
        const img = p.mimeType === "image/jpeg" ? await out.embedJpg(p.bytes) : await out.embedPng(p.bytes);
        const pg = out.addPage([612, 792]);
        const scale = Math.min(540 / img.width, 720 / img.height, 1);
        pg.drawText(pdfText(p.name), { x: 36, y: 760, size: 10, font: body, color: MUTED });
        pg.drawImage(img, { x: (612 - img.width * scale) / 2, y: (752 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
      } catch {
        const pg = out.addPage([612, 792]);
        pg.drawText(pdfText(`${p.name}: the image could not be read`), { x: 54, y: 720, size: 12, font: body, color: RED });
      }
    }
  }
  return out.save();
}

const STATUS: Record<string, string> = { ok: "on file", expiring: "due soon", expired: "overdue", missing: "missing", snoozed: "snoozed", na: "not on file" };

/** One driver's packet: gather, render, log that it was produced (who handed the file out, and when). */
export async function driverDqPacket(ctx: Ctx, driverId: string, now = new Date()) {
  assertCtx(ctx);
  requirePermission(ctx, "compliance.view");
  const f = await driverSafetyFile(ctx, driverId);
  const zone = await tenantZone(ctx.tenantId);
  const [t] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, ctx.tenantId)).limit(1);
  const date = (v: string | Date | null | undefined) => fmtWhen(v, zone, { style: "date" }) ?? "";
  const d = f.driver;
  // the latest paper per item, then the credential scans (licence, medical card…)
  const wanted = f.dq.map((l) => ({ label: l.label, id: l.history.find((h) => h.file)?.file?.id ?? null })).filter((x): x is { label: string; id: string } => !!x.id);
  const credDocs = await db
    .select({ id: s.documents.id, code: s.documents.code, fileName: s.documents.fileName, createdAt: s.documents.createdAt })
    .from(s.documents)
    .where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.subjectKind, "driver"), eq(s.documents.subjectId, driverId), inArray(s.documents.status, ["present", "verified"])));
  for (const c of f.credentials) {
    const doc = credDocs.filter((x) => x.code === c.key).sort((p, q) => q.createdAt.getTime() - p.createdAt.getTime())[0];
    if (doc) wanted.push({ label: c.label, id: doc.id });
  }
  const docs = wanted.length ? await db.select({ id: s.documents.id, fileName: s.documents.fileName, mimeType: s.documents.mimeType, storageKey: s.documents.storageKey }).from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), inArray(s.documents.id, wanted.map((w) => w.id)))) : [];
  const parts: PacketPart[] = [];
  for (const w of wanted) {
    const doc = docs.find((x) => x.id === w.id);
    if (!doc) continue;
    const blobId = doc.storageKey.replace(/^blob:/, "");
    const [b] = await db.select({ bytes: s.documentBlobs.bytes, mimeType: s.documentBlobs.mimeType }).from(s.documentBlobs).where(and(eq(s.documentBlobs.tenantId, ctx.tenantId), eq(s.documentBlobs.id, blobId))).limit(1);
    if (b) parts.push({ name: `${w.label} — ${doc.fileName}`, mimeType: b.mimeType ?? doc.mimeType, bytes: new Uint8Array(b.bytes as Buffer) });
  }
  const summary: PacketSummary = {
    company: t?.name ?? "",
    driver: d.name,
    detail: d.driverType === "B1" ? `B1 · licencia federal ${d.mxLicenseNumber ?? "—"}` : `${d.driverType} · licence ${d.licenseNumber ?? "—"} ${d.licenseState ?? ""}`.trim(),
    hired: d.hireDate ? date(d.hireDate) : "no hire date on the record",
    builtAt: fmtWhen(now, zone, { style: "short", year: true }) ?? "",
    dispatchable: f.dispatchable,
    lines: f.dq.map((l) => ({ label: l.label, cite: l.cite, status: l.notRequired ? "not required" : l.status === "ok" && !l.completedAt ? "not due yet" : (STATUS[l.status] ?? l.status), done: date(l.completedAt), due: date(l.dueAt), note: l.note ?? "", file: l.history.find((h) => h.file)?.file?.fileName ?? "" })),
    credentials: f.credentials.map((c) => ({ label: c.label, status: STATUS[c.status] ?? c.status, expires: c.expiresAt ? date(c.expiresAt) : "" })),
  };
  const bytes = await buildDqPacketPdf(summary, parts);
  await writeAudit(db, ctx, "driver", driverId, "update", undefined, "Qualification file packet (PDF) produced");
  return { bytes, fileName: `dq-file-${d.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}-${now.toISOString().slice(0, 10)}.pdf`, summary, parts: parts.map((p) => p.name) };
}
