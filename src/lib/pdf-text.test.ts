// Features: F-4.1 F-12 F-3.4 PDFs keep accents and typographic marks; only what Helvetica cannot encode becomes "?"
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfText } from "./pdf-text";

describe("pdfText", () => {
  it("keeps Latin-1, the middle dot, dashes and quotes; maps arrows; replaces the rest", () => {
    expect(pdfText("Benjamín Xochihua · Nuevo León — “caja” 10743")).toBe("Benjamín Xochihua · Nuevo León — “caja” 10743");
    expect(pdfText("Laredo → Monterrey")).toBe("Laredo -> Monterrey");
    expect(pdfText("ok 📦 日本")).toBe("ok ? ??");
    expect(pdfText(null)).toBe("");
  });
  it("everything it lets through is drawable with the standard font", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage();
    expect(() => page.drawText(pdfText("Martínez · $1,800.00 — “POD” … € ™ señor"), { x: 10, y: 10, size: 10, font })).not.toThrow();
  });
});
