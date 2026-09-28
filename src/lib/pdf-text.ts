import { inflateSync } from "node:zlib";

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

// ---------- reading the text out of a PDF (no AI, no outside library) ----------


function ascii85(s: string): Buffer {
  const src = s.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>[^]*$/, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of src) {
    if (ch === "z" && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, k - 1));
  }
  return Buffer.from(out);
}

function decodeStream(dict: string, raw: Buffer): Buffer | null {
  const filters = [...dict.matchAll(/\/(ASCII85Decode|ASCIIHexDecode|FlateDecode|A85|AHx|Fl|LZWDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode)\b/g)].map((m) => m[1]);
  let data = raw;
  for (const f of filters) {
    if (f === "ASCII85Decode" || f === "A85") data = ascii85(data.toString("latin1"));
    else if (f === "ASCIIHexDecode" || f === "AHx") data = Buffer.from(data.toString("latin1").replace(/[^0-9a-fA-F]/g, ""), "hex");
    else if (f === "FlateDecode" || f === "Fl") {
      try {
        data = inflateSync(data);
      } catch {
        return null;
      }
    } else return null; // images and the rest: not text
  }
  return data;
}

const WIN_ANSI_HIGH: Record<number, string> = { 0x80: "€", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x85: "…", 0x99: "™" };
const winAnsi = (bytes: number[]) => bytes.map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b)).join("");

/** A PDF string literal "(...)" starting at i: its bytes and where it ends. */
function literal(s: string, i: number): { bytes: number[]; end: number } {
  const bytes: number[] = [];
  let depth = 1;
  let j = i + 1;
  while (j < s.length && depth > 0) {
    const ch = s[j];
    if (ch === "\\") {
      const n = s[j + 1];
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (n in esc) {
        bytes.push(esc[n]);
        j += 2;
      } else if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(s.slice(j + 1))![0];
        bytes.push(parseInt(m, 8) & 255);
        j += 1 + m.length;
      } else {
        // a line continuation is dropped; any other escaped character stands for itself
        if (n !== "\n" && n !== "\r" && n !== undefined) bytes.push(n.charCodeAt(0) & 255);
        j += 2;
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (!depth) break;
    }
    bytes.push(ch.charCodeAt(0) & 255);
    j++;
  }
  return { bytes, end: j + 1 };
}

/** The text drawn by one content stream, a line per text line (Td / T* / Tm / ET break lines). */
export function textFromContent(content: string): string {
  const lines: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) lines.push(cur.replace(/\s+/g, " ").trim());
    cur = "";
  };
  let pending: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") {
      const l = literal(content, i);
      pending.push(winAnsi(l.bytes));
      i = l.end;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      const hex = content.slice(i + 1, end).replace(/\s+/g, "");
      const bytes = (hex.length % 2 ? hex + "0" : hex).match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
      pending.push(winAnsi(bytes));
      i = end + 1;
      continue;
    }
    if (ch === "[") {
      pending = [];
      i++;
      continue;
    }
    if (ch === "]") {
      i++;
      continue;
    }
    if (/[-0-9.]/.test(ch)) {
      // a kerning number inside a TJ array: a big gap is a space
      const m = /^-?[0-9.]+/.exec(content.slice(i));
      if (m && pending.length && Number(m[0]) < -200) pending.push(" ");
      i += m ? m[0].length : 1;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      const m = /^[A-Za-z'"*]+/.exec(content.slice(i))![0];
      if (m === "Tj" || m === "TJ") cur += pending.join("");
      else if (m === "'" || m === '"') {
        flush();
        cur += pending.join("");
      } else if (m === "Td" || m === "TD" || m === "T*" || m === "Tm" || m === "ET" || m === "BT") flush();
      pending = [];
      i += m.length;
      continue;
    }
    i++;
  }
  flush();
  return lines.join("\n");
}

/**
 * The plain text of a PDF, page content in order, for reading a rate con when the AI reader is off. Works for PDFs
 * written with standard fonts (most broker systems, ReportLab, pdf-lib, Word "save as PDF" with Latin text);
 * scanned papers and embedded-font PDFs give little or nothing — the caller says so. Never throws.
 */
export function pdfPlainText(bytes: Buffer): string {
  try {
    const s = bytes.toString("latin1");
    const out: string[] = [];
    const re = /(<<(?:[^<>]|<<[^]*?>>|<[^<>]*>)*?>>)\s*stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const dict = m[1];
      const start = m.index + m[0].length;
      const end = s.indexOf("endstream", start);
      if (end < 0) break;
      re.lastIndex = end;
      if (/\/(Subtype\s*\/Image|Type\s*\/XObject|Length1|FontFile)/.test(dict) && !/\/Subtype\s*\/Form/.test(dict)) continue;
      let raw = bytes.subarray(start, end);
      while (raw.length && (raw[raw.length - 1] === 10 || raw[raw.length - 1] === 13)) raw = raw.subarray(0, raw.length - 1);
      const data = decodeStream(dict, Buffer.from(raw));
      if (!data) continue;
      const text = data.toString("latin1");
      if (!/\b(Tj|TJ)\b/.test(text)) continue;
      const t = textFromContent(text);
      if (t) out.push(t);
    }
    return out.join("\n");
  } catch {
    return "";
  }
}
