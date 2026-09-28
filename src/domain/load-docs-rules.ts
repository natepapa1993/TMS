/**
 * One document, counted everywhere (owner #8). Pure rules, no database (the browser uses them too).
 *
 * A document is one record, filed on the most specific thing it came in on: the load, one leg (a carrier's
 * invoice for that leg) or one crossing. Whatever screen it came in on, it is the same paper: the crossing's
 * "bol" is the load's "BOL". So every place that asks for a document asks by its key (the code, upper-case)
 * across the whole load: the billing docs gate, the invoice packet, the crossing checklist, the carrier bill's
 * three-way match and the customer portal.
 */

export const docKey = (code: string | null | undefined) => (code ?? "").trim().toUpperCase();

/** Paper that belongs to one crossing: a load that crosses twice has two DODAs. Everything else is the load's. */
export const CROSSING_ONLY = new Set(["CARTA_RETIRO", "CARTA_PORTE", "DODA", "ENTRY", "ACE_MANIFEST", "DTOPS", "PARS", "ACI_EMANIFEST"]);
/** Paper that belongs to one leg: each carrier sends its own invoice. */
export const LEG_ONLY = new Set(["CARRIER_INVOICE"]);

export const DOC_LABEL: Record<string, string> = {
  RATE_CON: "Rate confirmation",
  BOL: "Bill of lading",
  POD: "Proof of delivery",
  LUMPER: "Lumper receipt",
  SCALE: "Scale ticket",
  INVOICE: "Commercial invoice",
  PACKING_LIST: "Packing list",
  CARRIER_INVOICE: "Carrier's invoice",
  SEAL_PHOTO: "Seal / caja photo",
  CARTA_RETIRO: "Carta de retiro",
  CARTA_PORTE: "Carta porte",
  DODA: "DODA",
  ENTRY: "US entry / pedimento",
  ACE_MANIFEST: "ACE e-Manifest",
  DTOPS: "DTOPS",
  PARS: "PARS",
  ACI_EMANIFEST: "ACI eManifest",
  CCI: "Canada customs invoice",
  OTHER: "Other",
};

export const docLabel = (code: string | null | undefined) => DOC_LABEL[docKey(code)] ?? (code ? code.replace(/_/g, " ") : "Document");

/** Codes the customer can open on their portal. */
export const CUSTOMER_DOC_KEYS = new Set(["POD", "BOL", "RATE_CON", "CARTA_PORTE", "INVOICE", "PACKING_LIST"]);

/** Which document an upload replaces: on the same crossing, the same leg, or anywhere on the load. */
export function supersedeScope(key: string): "crossing" | "leg" | "load" {
  if (CROSSING_ONLY.has(key)) return "crossing";
  if (LEG_ONLY.has(key)) return "leg";
  return "load";
}

export type CountsContext = {
  /** the customer's "needed to bill" list */
  billing: string[];
  /** documents that go out with the invoice (customer's list, else billing's) */
  packet?: string[];
  /** requirement codes on the load's crossings */
  crossing: string[];
  /** a carrier runs a leg of this load (the three-way match looks at the POD and their invoice) */
  carrierLeg: boolean;
};

/** Where one document counts, in plain words, for the load's Documents tab. */
export function whereItCounts(code: string | null | undefined, c: CountsContext): string[] {
  const k = docKey(code);
  const out: string[] = [];
  const up = (xs: string[]) => xs.map(docKey);
  if (up(c.billing).includes(k)) out.push("Billing");
  if (up(c.packet ?? c.billing).includes(k)) out.push("Invoice packet");
  if (up(c.crossing).includes(k)) out.push("Crossing checklist");
  if (c.carrierLeg && (k === "POD" || k === "CARRIER_INVOICE")) out.push("Carrier bill");
  if (CUSTOMER_DOC_KEYS.has(k)) out.push("Customer portal");
  return out;
}

type Latest = { key: string; createdAt: Date | string; version?: number };
/** The newest live document with this key (the upload that replaced the others). */
export function latestOf<T extends Latest>(docs: T[], key: string): T | null {
  const k = docKey(key);
  return docs.filter((d) => d.key === k).sort((p, q) => new Date(q.createdAt).getTime() - new Date(p.createdAt).getTime() || (q.version ?? 0) - (p.version ?? 0))[0] ?? null;
}
