/**
 * Minimal, strict ANSI X12 (004010) codec: enough to write 214 / 210 / 990 / 997 and read 204 / 997.
 * Pure functions — no database, no dates from the clock unless passed in.
 */

export type Segment = string[]; // [tag, e1, e2, …]
export type Delims = { element: string; segment: string; sub: string };
export const DEFAULT_DELIMS: Delims = { element: "*", segment: "~", sub: ">" };

export type Envelope = {
  senderQualifier: string; // ZZ, 01 (DUNS), 02 (SCAC), 12 (phone)…
  senderId: string;
  receiverQualifier: string;
  receiverId: string;
  usage: "P" | "T"; // production | test
  controlNumber: number; // ISA13 / GS06 / ST02 share one counter here
  functionalId: string; // GS01: QM (214), IM (210), GF (990), FA (997), SM (204)
  transactionSet: string; // ST01
  at: Date;
};

const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, "");
const ccyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const hhmm = (d: Date) => d.toISOString().slice(11, 16).replace(":", "");
export const dates = { yymmdd, ccyymmdd, hhmm };

/** Serialize segments, wrapped in ISA/GS/ST … SE/GE/IEA. */
export function wrap(body: Segment[], env: Envelope, d: Delims = DEFAULT_DELIMS): string {
  const ctl9 = String(env.controlNumber).padStart(9, "0");
  const ctl4 = String(env.controlNumber).padStart(4, "0");
  const isa: Segment = ["ISA", "00", pad("", 10), "00", pad("", 10), pad(env.senderQualifier, 2), pad(env.senderId, 15), pad(env.receiverQualifier, 2), pad(env.receiverId, 15), yymmdd(env.at), hhmm(env.at), "U", "00401", ctl9, "0", env.usage, d.sub];
  const gs: Segment = ["GS", env.functionalId, env.senderId.trim(), env.receiverId.trim(), ccyymmdd(env.at), hhmm(env.at), String(env.controlNumber), "X", "004010"];
  const st: Segment = ["ST", env.transactionSet, ctl4];
  const se: Segment = ["SE", String(body.length + 2), ctl4];
  const ge: Segment = ["GE", "1", String(env.controlNumber)];
  const iea: Segment = ["IEA", "1", ctl9];
  return [isa, gs, st, ...body, se, ge, iea].map((s) => trimTrailing(s).join(d.element) + d.segment).join("\n");
}

function trimTrailing(seg: Segment): Segment {
  const out = [...seg];
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Parse an interchange: detects delimiters from the ISA header. */
export function parse(text: string): { delims: Delims; segments: Segment[]; isa: Segment | null } {
  const t = text.replace(/^﻿/, "").trimStart();
  if (!t.startsWith("ISA")) throw new EdiError("not an X12 interchange: no ISA header");
  const element = t[3];
  const sub = t[104] ?? ">";
  const segment = t[105] ?? "~";
  const delims = { element, segment, sub };
  const raw = t.split(segment).map((s) => s.replace(/^[\r\n\s]+/, "")).filter((s) => s.length);
  const segments = raw.map((s) => s.split(element).map((e) => e.trim()));
  const isa = segments.find((s) => s[0] === "ISA") ?? null;
  const st = segments.filter((s) => s[0] === "ST").length;
  const se = segments.filter((s) => s[0] === "SE").length;
  if (st !== se) throw new EdiError(`ST/SE mismatch: ${st} ST, ${se} SE`);
  return { delims, segments, isa };
}

export class EdiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdiError";
  }
}

/** Split an interchange into its transaction sets (ST…SE), with the GS/ISA context. */
export function transactionSets(segments: Segment[]) {
  const out: { type: string; control: string; segments: Segment[] }[] = [];
  let cur: { type: string; control: string; segments: Segment[] } | null = null;
  for (const s of segments) {
    if (s[0] === "ST") cur = { type: s[1], control: s[2], segments: [] };
    else if (s[0] === "SE") {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) cur.segments.push(s);
  }
  return out;
}

export function envelopeOf(segments: Segment[]) {
  const isa = segments.find((s) => s[0] === "ISA");
  const gs = segments.find((s) => s[0] === "GS");
  if (!isa || !gs) throw new EdiError("missing ISA or GS");
  return { senderQualifier: isa[5], senderId: isa[6].trim(), receiverQualifier: isa[7], receiverId: isa[8].trim(), usage: isa[15] as "P" | "T", isaControl: isa[13], gsControl: gs[6], functionalId: gs[1], version: gs[8] };
}

// ---------- 997 functional acknowledgment ----------

export function build997(input: { ackFunctionalId: string; ackGroupControl: string; sets: { type: string; control: string; ok: boolean; note?: string }[] }): Segment[] {
  const body: Segment[] = [["AK1", input.ackFunctionalId, input.ackGroupControl]];
  let accepted = 0;
  for (const s of input.sets) {
    body.push(["AK2", s.type, s.control]);
    body.push(["AK5", s.ok ? "A" : "R", ...(s.ok ? [] : ["5"])]); // 5 = one or more segments in error
    if (s.ok) accepted++;
  }
  const all = accepted === input.sets.length;
  body.push(["AK9", all ? "A" : accepted ? "P" : "R", String(input.sets.length), String(input.sets.length), String(accepted)]);
  return body;
}

export function parse997(segments: Segment[]) {
  const ak1 = segments.find((s) => s[0] === "AK1");
  const ak9 = segments.find((s) => s[0] === "AK9");
  const sets = segments.filter((s) => s[0] === "AK2").map((s, i) => ({ type: s[1], control: s[2], status: segments.filter((x) => x[0] === "AK5")[i]?.[1] ?? "?" }));
  return { functionalId: ak1?.[1] ?? null, groupControl: ak1?.[2] ?? null, status: ak9?.[1] ?? null, sets };
}
