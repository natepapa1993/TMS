/**
 * The standard PDF fonts (Helvetica) encode WinAnsi: ASCII, Latin-1 accents (Benjamín, Martínez, Nuevo León),
 * the middle dot, dashes, curly quotes, bullet, ellipsis and the euro sign. Anything else (emoji, arrows, CJK)
 * would make pdf-lib throw, so it becomes "?" — and only that.
 */
const OK = /[\x20-\x7E\xA0-\xFF–—‘’“”•…€™]/;
const MAP: Record<string, string> = { "→": "->", "←": "<-", "↔": "<->", " ": " ", " ": " ", " ": " ", "−": "-" };
export function pdfText(t: string | null | undefined): string {
  if (!t) return "";
  let out = "";
  for (const ch of String(t)) out += MAP[ch] ?? (OK.test(ch) ? ch : "?");
  return out;
}
