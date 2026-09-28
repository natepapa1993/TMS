import { dates, type Segment, EdiError } from "./x12";

/**
 * Transaction-set bodies (004010): 214 shipment status, 210 invoice, 990 tender response,
 * and the 204 load tender parser. Builders take plain data; the domain layer supplies it.
 */

export type Party = { name: string; line1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null; code?: string | null };

function n1(role: string, p: Party | null | undefined): Segment[] {
  if (!p?.name) return [];
  const out: Segment[] = [["N1", role, p.name.slice(0, 60), ...(p.code ? ["93", p.code] : [])]];
  if (p.line1) out.push(["N3", p.line1.slice(0, 55)]);
  if (p.city || p.state || p.postalCode) out.push(["N4", p.city ?? "", p.state ?? "", (p.postalCode ?? "").replace(/\s/g, ""), p.country ?? ""]);
  return out;
}

// ---------- 214 ----------

/** Leg state → AT7 status code. Editable per partner; these are the usual ones. */
export const DEFAULT_214_MAP: Record<string, { code: string; label: string }> = {
  at_pickup: { code: "X3", label: "Arrived at pickup" },
  loaded: { code: "AF", label: "Departed pickup with shipment" },
  en_route: { code: "X6", label: "En route to delivery" },
  at_delivery: { code: "X1", label: "Arrived at delivery" },
  completed: { code: "D1", label: "Completed unloading at delivery" },
  held: { code: "SD", label: "Shipment delayed" },
  cancelled: { code: "CA", label: "Shipment cancelled" },
};

export type Status214 = {
  ourRef: string; // B10-01: our order number
  theirRef: string | null; // B10-02: customer's shipment id (rate con / PO)
  scac: string;
  refs: { qualifier: string; value: string }[]; // L11: BM bill of lading, PO purchase order, CR customer reference…
  shipper?: Party | null;
  consignee?: Party | null;
  status: { code: string; reason?: string | null; at: Date; city?: string | null; state?: string | null; country?: string | null };
  equipment?: { scac?: string | null; number?: string | null } | null;
  eta?: Date | null;
};

export function build214(s: Status214): Segment[] {
  const body: Segment[] = [["B10", s.ourRef.slice(0, 30), (s.theirRef ?? "").slice(0, 30), s.scac.slice(0, 4)]];
  for (const r of s.refs) if (r.value) body.push(["L11", r.value.slice(0, 30), r.qualifier]);
  body.push(...n1("SH", s.shipper), ...n1("CN", s.consignee));
  body.push(["LX", "1"]);
  body.push(["AT7", s.status.code, s.status.reason ?? "", "", "", dates.ccyymmdd(s.status.at), dates.hhmm(s.status.at), "UT"]);
  if (s.status.city) body.push(["MS1", s.status.city.slice(0, 30), s.status.state ?? "", s.status.country ?? ""]);
  if (s.equipment?.number) body.push(["MS2", s.equipment.scac ?? s.scac, s.equipment.number.slice(0, 10)]);
  if (s.eta) body.push(["AT7", "X2", "", "", "", dates.ccyymmdd(s.eta), dates.hhmm(s.eta), "UT"]); // X2 = estimated arrival
  return body;
}

// ---------- 210 ----------

/** Charge kind → L1 special-charge code (ID 150). Editable per partner. */
export const DEFAULT_210_CHARGE_CODES: Record<string, string> = { linehaul: "400", fuel: "405", detention: "DTL", layover: "LAY", tonu: "TNU", lumper: "LUM", border_fee: "CUS", crossing_fee: "CUS", storage: "STO", extra_stop: "ADD", accessorial: "ACC", tax: "TAX", other: "ACC" };

export type Invoice210 = {
  invoiceNumber: string;
  theirRef: string | null; // shipment id (rate con / PO)
  scac: string;
  currency: string;
  issuedAt: Date;
  deliveredAt?: Date | null;
  totalCents: number;
  refs: { qualifier: string; value: string }[];
  billTo: Party;
  shipper?: Party | null;
  consignee?: Party | null;
  lines: { description: string; kind: string; qty: number; unit: string; rateCents: number; amountCents: number; code?: string }[];
  weightLbs?: number | null;
  chargeCodes?: Record<string, string>;
};

const n2 = (cents: number) => String(Math.round(cents)); // N2 = two implied decimals

export function build210(i: Invoice210): Segment[] {
  const codes = { ...DEFAULT_210_CHARGE_CODES, ...(i.chargeCodes ?? {}) };
  const body: Segment[] = [["B3", "", i.invoiceNumber.slice(0, 22), (i.theirRef ?? i.invoiceNumber).slice(0, 30), "PP", "", dates.ccyymmdd(i.issuedAt), n2(i.totalCents), "", i.deliveredAt ? dates.ccyymmdd(i.deliveredAt) : "", "", i.scac.slice(0, 4)]];
  body.push(["C3", i.currency]);
  for (const r of i.refs) if (r.value) body.push(["N9", r.qualifier, r.value.slice(0, 30)]);
  body.push(...n1("BT", i.billTo), ...n1("SH", i.shipper), ...n1("CN", i.consignee));
  i.lines.forEach((l, idx) => {
    body.push(["LX", String(idx + 1)]);
    body.push(["L5", String(idx + 1), l.description.slice(0, 50)]);
    if (l.unit !== "flat") body.push(["L0", String(idx + 1), l.unit === "h" ? (l.qty / 100).toFixed(2) : String(l.qty), l.unit === "mi" ? "MI" : l.unit === "h" ? "HR" : "EA"]); // billed quantity + basis
    const rateQual = l.unit === "mi" ? "PM" : l.unit === "h" ? "PH" : "FR"; // per mile, per hour, flat rate
    body.push(["L1", String(idx + 1), l.unit === "flat" ? "" : (l.rateCents / 100).toFixed(2), rateQual, n2(l.amountCents), "", "", "", l.code ?? codes[l.kind] ?? "ACC", "", "", "", l.description.slice(0, 80)]);
  });
  body.push(["L3", i.weightLbs ? String(Math.round(i.weightLbs)) : "", i.weightLbs ? "G" : "", "", "", n2(i.totalCents)]);
  return body;
}

// ---------- 990 ----------

export function build990(r: { scac: string; theirRef: string; accept: boolean; at: Date; refs?: { qualifier: string; value: string }[]; note?: string | null }): Segment[] {
  const body: Segment[] = [["B1", r.scac, r.theirRef.slice(0, 30), dates.ccyymmdd(r.at), r.accept ? "A" : "D"]];
  for (const x of r.refs ?? []) if (x.value) body.push(["N9", x.qualifier, x.value.slice(0, 30)]);
  if (r.note) body.push(["K1", r.note.slice(0, 30)]);
  return body;
}

// ---------- 204 (inbound) ----------

export type Tender204 = {
  purpose: "original" | "change" | "cancel";
  theirRef: string; // B2-04 shipment id
  scac: string | null;
  payment: string | null;
  refs: Record<string, string>; // qualifier → value (BM, PO, CR, …), plus the well-known names
  equipment: { code: string | null; number: string | null; length: number | null } | null;
  parties: Record<string, Party>; // BT, SH, CN outside the stop loops
  stops: { seq: number; reason: string; type: "pickup" | "delivery"; party: Party | null; earliest: Date | null; latest: Date | null; earliestLocal: LocalTime | null; latestLocal: LocalTime | null; appointment: boolean; refs: Record<string, string>; notes: string[]; pieces: number | null; weightLbs: number | null; commodity: string | null }[];
  totalWeightLbs: number | null;
  rateCents: number | null;
  notes: string[];
  raw: Segment[];
};

const REF_NAMES: Record<string, string> = { BM: "bol", PO: "po", CR: "reference", CO: "customer_order", SI: "shipment", RC: "rate_con", ZZ: "reference", "11": "account", TN: "transaction", "2I": "tracking", MB: "master_bol" };

/** A G62 as sent: wall-clock date and time plus the zone code (G62-05: LT local, ET, CT, MT, PT, UT…), for the domain to place in the stop's zone. */
export type LocalTime = { date: string; time: string; code: string | null };

function g62Local(seg: Segment): LocalTime | null {
  const d = seg[2];
  if (!d || d.length !== 8) return null;
  return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, time: (seg[4] ?? "").padEnd(4, "0").slice(0, 4) || "0000", code: seg[5] || null };
}

function g62Date(seg: Segment): Date | null {
  const d = seg[2];
  const t = seg[4] ?? "";
  if (!d || d.length !== 8) return null;
  const hh = t.slice(0, 2) || "00";
  const mm = t.slice(2, 4) || "00";
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${hh}:${mm}:00Z`;
  const out = new Date(iso);
  return Number.isNaN(out.getTime()) ? null : out;
}

export function parse204(segments: Segment[]): Tender204 {
  const b2 = segments.find((s) => s[0] === "B2");
  if (!b2) throw new EdiError("204 without B2");
  const b2a = segments.find((s) => s[0] === "B2A");
  const purpose = b2a?.[1] === "01" ? "cancel" : b2a?.[1] === "04" || b2a?.[1] === "05" ? "change" : "original";
  const out: Tender204 = { purpose, theirRef: b2[4] ?? "", scac: b2[2] || null, payment: b2[6] || null, refs: {}, equipment: null, parties: {}, stops: [], totalWeightLbs: null, rateCents: null, notes: [], raw: segments };
  if (!out.theirRef) throw new EdiError("204 without a shipment id (B2-04)");

  let stop: Tender204["stops"][number] | null = null;
  let party: Party | null = null;
  const closeParty = () => {
    if (!party) return;
    if (stop) stop.party = party;
    else if (party.code) out.parties[party.code] = party;
    party = null;
  };
  for (const s of segments) {
    const tag = s[0];
    if (tag === "S5") {
      closeParty();
      const reason = s[2] ?? "";
      // LD load · CL complete load · PL part load → pickup; UL unload · CU complete unload · PU part unload → delivery
      const type = ["UL", "CU", "PU"].includes(reason) ? "delivery" : "pickup";
      stop = { seq: Number(s[1]) || out.stops.length + 1, reason, type, party: null, earliest: null, latest: null, earliestLocal: null, latestLocal: null, appointment: false, refs: {}, notes: [], pieces: s[5] ? Number(s[5]) : null, weightLbs: s[3] ? Number(s[3]) : null, commodity: null };
      out.stops.push(stop);
    } else if (tag === "N1") {
      closeParty();
      party = { name: s[2] ?? "", code: stop ? null : s[1] ?? null };
      if (stop) party.code = s[1] ?? null;
    } else if (tag === "N3" && party) party.line1 = s[1] ?? null;
    else if (tag === "N4" && party) {
      party.city = s[1] || null;
      party.state = s[2] || null;
      party.postalCode = s[3] || null;
      party.country = s[4] || null;
    } else if (tag === "L11") {
      const q = s[2] ?? "ZZ";
      const name = REF_NAMES[q] ?? q.toLowerCase();
      if (stop) stop.refs[name] = s[1] ?? "";
      else out.refs[name] = s[1] ?? "";
    } else if (tag === "G62" && stop) {
      const q = s[1];
      const d = g62Date(s);
      const l = g62Local(s);
      if (!d || !l) continue;
      const isLatest = ["38", "54", "70", "02"].includes(q);
      if (isLatest) {
        stop.latest = d;
        stop.latestLocal = l;
      } else {
        stop.earliest = d; // 37 / 53 / 68 / 10 / 69: requested pickup, delivery, appointment
        stop.earliestLocal = l;
      }
      if (["10", "69", "70"].includes(q)) stop.appointment = true;
    } else if (tag === "NTE") {
      if (stop) stop.notes.push(s[2] ?? "");
      else out.notes.push(s[2] ?? "");
    } else if (tag === "L5" && stop) stop.commodity = s[2] || null;
    else if (tag === "N7") out.equipment = { code: s[11] || null, number: s[2] || null, length: s[15] ? Number(s[15]) : null };
    else if (tag === "L3") {
      if (s[1]) out.totalWeightLbs = Number(s[1]);
      if (s[5]) out.rateCents = Number(s[5]);
    }
  }
  closeParty();
  if (out.stops.length === 0 && purpose !== "cancel") throw new EdiError("204 without stops (S5)");
  return out;
}
