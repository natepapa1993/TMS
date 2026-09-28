import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { API, DEFAULT_MODEL } from "@/integrations/extractor";
import { ValidationError } from "./orders";
import { normCountry } from "./zones";

/**
 * Upload a rate confirmation in the load builder and the load fills itself: the customer, the rate,
 * the references, the freight and every stop in order with its address and times. The AI reader
 * (Settings → Integrations) reads the paper; the customer and the stops are matched to the company's
 * own records; a person reviews everything before booking. The PDF rides along and lands on the load
 * as its rate con.
 */

export type RateConStop = { type: "pickup" | "delivery"; name: string; line1: string; city: string; state: string; postalCode: string; country: string; windowStart: string; windowEnd: string; appointment: boolean; ref: string; contact: string; notes: string; locationId: string | null };
export type RateConDraft = {
  documentId: string;
  customerId: string | null;
  customerName: string | null;
  rate: string;
  currency: string;
  equipment: string | null;
  refs: Record<string, string>;
  freight: { commodity: string; pieces: string; packaging: string; weightLb: string; hazmat: boolean }[];
  stops: RateConStop[];
  notes: string;
  warnings: string[];
  /** how it was read: by the AI reader, from the PDF's own text (AI reader off), or not at all (a scan with the reader off) */
  readBy?: "ai" | "text" | "none";
  /** what was found, in words: "rate USD 2,275.00", "load # NS-8812", "1 pickup and 1 delivery" */
  read?: string[];
};

const stopSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["pickup", "delivery"], description: "pickup (freight goes on) or delivery (freight comes off)" },
    name: { type: "string", description: "shipper / consignee / facility name" },
    line1: { type: ["string", "null"], description: "street address" },
    city: { type: ["string", "null"] },
    state: { type: ["string", "null"], description: "state or province, two letters when possible" },
    postalCode: { type: ["string", "null"] },
    country: { type: ["string", "null"], description: "US, MX or CA" },
    windowStart: { type: ["string", "null"], description: "appointment or window start, ISO 8601 local time without offset (e.g. 2026-10-02T08:00)" },
    windowEnd: { type: ["string", "null"], description: "window end if a range is given, ISO 8601 local" },
    appointment: { type: ["boolean", "null"], description: "true if it is a set appointment, false for a first-come window" },
    ref: { type: ["string", "null"], description: "pickup / delivery / PO number for this stop" },
    contact: { type: ["string", "null"], description: "contact name and phone at the stop" },
    notes: { type: ["string", "null"], description: "instructions for this stop" },
  },
  required: ["type", "name"],
};

export function buildRateConRequest(cfg: { apiKey: string; model?: string }, doc: { mimeType: string; bytes: Buffer }) {
  const media = doc.mimeType === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.bytes.toString("base64") } } : { type: "image", source: { type: "base64", media_type: doc.mimeType, data: doc.bytes.toString("base64") } };
  return {
    model: cfg.model || DEFAULT_MODEL,
    max_tokens: 3000,
    tools: [
      {
        name: "record_load",
        description: "Record the load from the rate confirmation.",
        input_schema: {
          type: "object",
          properties: {
            customerName: { type: ["string", "null"], description: "the broker or customer issuing the rate confirmation (who pays)" },
            rate: { type: ["number", "null"], description: "the total line haul the carrier is paid, a number without currency symbol; if only an all-in total is given, that" },
            currency: { type: ["string", "null"], description: "USD, CAD or MXN" },
            equipment: { type: ["string", "null"], description: "one of: 53_dry, 53_reefer, 48_dry, flatbed, sprinter, straight, power_only" },
            loadNumber: { type: ["string", "null"], description: "the customer's load / order / pro number" },
            po: { type: ["string", "null"], description: "PO number if a single one for the whole load" },
            bol: { type: ["string", "null"], description: "BOL or shipment number" },
            freight: { type: "array", items: { type: "object", properties: { commodity: { type: "string" }, pieces: { type: ["number", "null"] }, packaging: { type: ["string", "null"] }, weightLb: { type: ["number", "null"], description: "weight in pounds" }, hazmat: { type: ["boolean", "null"] } }, required: ["commodity"] } },
            stops: { type: "array", description: "every pickup and delivery, in the order the truck runs them", items: stopSchema },
            notes: { type: ["string", "null"], description: "special instructions for the whole load (tracking, driver requirements, penalties)" },
          },
          required: ["stops"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_load" },
    messages: [
      {
        role: "user",
        content: [media, { type: "text", text: "This is a rate confirmation (load confirmation) a broker or shipper sent to a trucking carrier. Read the load exactly as printed: keep letters, hyphens and leading zeros in numbers; list every stop in order; never invent a value that is not on the paper — use null." }],
      },
    ],
  };
}

type Raw = { customerName?: string | null; rate?: number | string | null; currency?: string | null; equipment?: string | null; loadNumber?: string | null; po?: string | null; bol?: string | null; freight?: { commodity?: string; pieces?: number | null; packaging?: string | null; weightLb?: number | null; hazmat?: boolean | null }[]; stops?: Record<string, unknown>[]; notes?: string | null };

/** Pure: the tool call → a draft the builder can show. */
export function parseRateConResponse(json: unknown): Omit<RateConDraft, "documentId" | "customerId" | "warnings"> & { warnings: string[] } {
  const content = (json as { content?: { type: string; name?: string; input?: Raw }[] })?.content ?? [];
  const tool = content.find((c) => c.type === "tool_use" && c.name === "record_load");
  if (!tool?.input) throw new Error("the reader returned nothing");
  const r = tool.input;
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const warnings: string[] = [];
  const stops: RateConStop[] = (r.stops ?? [])
    .map((x) => ({
      type: x.type === "delivery" ? ("delivery" as const) : ("pickup" as const),
      name: str(x.name),
      line1: str(x.line1),
      city: str(x.city),
      state: str(x.state).toUpperCase().slice(0, 3),
      postalCode: str(x.postalCode),
      country: normCountry(str(x.country) || "US"),
      windowStart: localIso(str(x.windowStart)),
      windowEnd: localIso(str(x.windowEnd)),
      appointment: x.appointment === true,
      ref: str(x.ref),
      contact: str(x.contact),
      notes: str(x.notes),
      locationId: null,
    }))
    .filter((x) => x.name);
  if (!stops.some((x) => x.type === "pickup")) warnings.push("no pickup found on the paper");
  if (!stops.some((x) => x.type === "delivery")) warnings.push("no delivery found on the paper");
  const rateNum = typeof r.rate === "number" ? r.rate : Number(str(r.rate).replace(/[^0-9.]/g, ""));
  const equipment = ["53_dry", "53_reefer", "48_dry", "flatbed", "sprinter", "straight", "power_only"].includes(str(r.equipment)) ? str(r.equipment) : null;
  const refs: Record<string, string> = {};
  if (str(r.loadNumber)) refs.reference = str(r.loadNumber);
  if (str(r.po)) refs.po = str(r.po);
  if (str(r.bol)) refs.shipment = str(r.bol);
  const cur = str(r.currency).toUpperCase();
  return {
    customerName: str(r.customerName) || null,
    rate: Number.isFinite(rateNum) && rateNum > 0 ? rateNum.toFixed(2) : "",
    currency: ["USD", "CAD", "MXN"].includes(cur) ? cur : "USD",
    equipment,
    refs,
    freight: (r.freight ?? []).filter((f) => str(f.commodity)).map((f) => ({ commodity: str(f.commodity), pieces: f.pieces != null ? String(f.pieces) : "", packaging: str(f.packaging), weightLb: f.weightLb != null ? String(Math.round(f.weightLb)) : "", hazmat: !!f.hazmat })),
    stops,
    notes: str(r.notes),
    warnings,
  };
}

const CA_PROV = new Set(["ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"]);
const MX_ST = new Set(["NL", "COAH", "TAMPS", "TAM", "CHIH", "SON", "BC", "BCN", "JAL", "GTO", "QRO", "SLP", "AGS", "ZAC", "DGO", "SIN", "PUE", "MEX", "CDMX", "HGO", "MICH", "MOR", "VER", "TLAX"]);
const STOP_HEAD = /^(pick\s*-?\s*up|pu|shipper|origin|load\s+at|delivery|deliver|del|drop|consignee|receiver|destination|stop)\b\s*#?\s*\d*\s*[:.\-–]\s*(.*)$/i;
const money = (v: string) => Number(v.replace(/,/g, ""));

/**
 * Pure: a rate con's plain text (no AI) → what can be read with confidence (M26): the customer on the letterhead,
 * the rate, the load / PO / BOL numbers, the equipment, each pickup and delivery with its address, date and time,
 * and the freight. `read` says what was found; anything not found stays blank for a person to type.
 */
export function parseRateConText(text: string): Omit<RateConDraft, "documentId" | "customerId"> & { read: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const all = lines.join("\n");
  const read: string[] = [];
  const warnings: string[] = [];
  // the customer: a labelled line, else the letterhead ("NORTHSTAR BROKERAGE - LOAD CONFIRMATION")
  let customerName: string | null = null;
  const lab = /^(?:broker|bill\s*to|customer|issued\s*by)\s*[:#]\s*(.+)$/im.exec(all);
  if (lab) customerName = lab[1].split(/\s{2,}|\s+(?:MC|DOT|phone|tel)\b/i)[0].trim();
  else if (lines[0]) {
    const head = lines[0].replace(/\s*[-–—:|]?\s*(?:load|rate|carrier|freight)?\s*(?:confirmation|tender|agreement|con)\b.*$/i, "").trim();
    if (head && head.length <= 60 && /[a-z]/i.test(head) && !/^(load|rate|carrier)\b/i.test(head)) customerName = head;
  }
  if (customerName) read.push(`customer "${customerName}"`);
  // the rate
  let rate = "";
  let currency = "USD";
  const r = /\b(?:total\s+(?:carrier\s+)?(?:pay|rate|amount)|line\s*haul|carrier\s+pay|rate|all[- ]in|total)\b\s*[:#]?\s*(US|CA|MX|C|MN)?\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)\s*(USD|CAD|MXN)?/i.exec(all);
  if (r && money(r[2]) > 0) {
    rate = money(r[2]).toFixed(2);
    const code = (r[3] ?? "").toUpperCase();
    const pre = (r[1] ?? "").toUpperCase();
    currency = code || (pre === "CA" || pre === "C" ? "CAD" : pre === "MX" || pre === "MN" ? "MXN" : "USD");
    read.push(`rate ${currency} ${Number(rate).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  }
  // references
  const refs: Record<string, string> = {};
  const load = /\b(?:load|order|pro|confirmation|shipment|trip)\s*(?:#|no\.?|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(all);
  if (load) {
    refs.reference = load[1];
    read.push(`load # ${load[1]}`);
  }
  const po = /\bP\.?O\.?\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/.exec(all);
  if (po && po[1] !== refs.reference) {
    refs.po = po[1];
    read.push(`PO ${po[1]}`);
  }
  const bol = /\bB\/?O\/?L\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(all);
  if (bol) {
    refs.shipment = bol[1];
    read.push(`BOL ${bol[1]}`);
  }
  // equipment
  const eq = /\b(53|48)?'?\s*(?:ft\.?\s*)?(dry\s*van|van|reefer|refrigerated|flat\s*bed|sprinter|straight\s*truck|box\s*truck|power\s*only)\b/i.exec(all);
  let equipment: string | null = null;
  if (eq) {
    const k = eq[2].toLowerCase().replace(/\s+/g, "");
    equipment = /reefer|refrigerated/.test(k) ? "53_reefer" : /flatbed/.test(k) ? "flatbed" : k === "sprinter" ? "sprinter" : /straight|box/.test(k) ? "straight" : k === "poweronly" ? "power_only" : eq[1] === "48" ? "48_dry" : "53_dry";
    read.push(`equipment ${eq[0].trim()}`);
  }
  // stops: a "PICKUP 1: …" / "DELIVERY: …" line and the lines under it, up to the next heading
  const stops: RateConStop[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = STOP_HEAD.exec(lines[i]);
    if (!h) continue;
    const word = h[1].toLowerCase();
    const type: "pickup" | "delivery" = /^(pick|pu|shipper|origin|load)/.test(word) ? "pickup" : /^stop/.test(word) ? (stops.length ? "delivery" : "pickup") : "delivery";
    const body = [h[2]];
    for (let j = i + 1; j < lines.length && j <= i + 4 && !STOP_HEAD.test(lines[j]) && !/^(commodity|freight|equipment|rate|notes?|instructions|detention|total)\b/i.test(lines[j]); j++) body.push(lines[j]);
    const b = body.join(", ");
    const place = /([A-Za-zÀ-ÿ .'-]+?),?\s+([A-Z]{2,5})\.?,?\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/.exec(b) ?? /([A-Za-zÀ-ÿ .'-]+?),\s*([A-Z]{2,5})\b/.exec(b);
    const parts = b.split(/\s*,\s*/);
    const name = (parts[0] ?? "").replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/, "").trim();
    if (!name) continue;
    const cityRaw = place ? place[1].trim() : "";
    const city = cityRaw.split(",").pop()!.trim().replace(/^\d+\s+.*\s(?=[A-Z][a-z])/, "");
    const st = place ? place[2].toUpperCase() : "";
    const postal = place?.[3] ?? "";
    const country = CA_PROV.has(st) || /^[A-Z]\d[A-Z]/.test(postal) ? "CA" : MX_ST.has(st) && !/^\d{5}$/.test(postal) ? "MX" : "US";
    const line1 = parts.slice(1).find((x) => /^\d+\s+\S/.test(x) && !x.includes(city)) ?? "";
    const d = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(b) ?? null;
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(b);
    const day = d ? `${d[3].length === 2 ? `20${d[3]}` : d[3]}-${d[1].padStart(2, "0")}-${d[2].padStart(2, "0")}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : "";
    const tm = /\b(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})\s*(am|pm)?)?/i.exec(b.replace(/\d{4}-\d{2}-\d{2}/, ""));
    const hh = (h24: string, ap?: string) => {
      let n = Number(h24);
      if (ap && /pm/i.test(ap) && n < 12) n += 12;
      if (ap && /am/i.test(ap) && n === 12) n = 0;
      return String(n).padStart(2, "0");
    };
    const windowStart = day && tm ? `${day}T${hh(tm[1], tm[3])}:${tm[2]}` : day ? `${day}T00:00` : "";
    const windowEnd = day && tm?.[4] ? `${day}T${hh(tm[4], tm[6] ?? tm[3])}:${tm[5]}` : "";
    const ref = /\b(?:PU|DEL|PICKUP|DELIVERY|REF|APPT|CONF)\s*#\s*[:]?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(b)?.[1] ?? "";
    stops.push({ type, name, line1, city, state: st, postalCode: postal, country, windowStart, windowEnd, appointment: /\bappt\b|appointment/i.test(b), ref, contact: "", notes: "", locationId: null });
  }
  if (stops.length) read.push(`${stops.filter((x) => x.type === "pickup").length} pickup${stops.filter((x) => x.type === "pickup").length === 1 ? "" : "s"} and ${stops.filter((x) => x.type === "delivery").length} deliver${stops.filter((x) => x.type === "delivery").length === 1 ? "y" : "ies"}`);
  // freight
  const freight: RateConDraft["freight"] = [];
  const com = /\b(?:commodity|description|freight)\s*[:#]\s*([^,\n]+)/i.exec(all);
  const pcs = /\b([0-9]{1,4})\s*(pallets?|skids?|pcs|pieces|boxes|cartons|gaylords|crates|drums|totes)\b/i.exec(all);
  const wt = /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})\s*(lbs?|pounds|kgs?|kilos)\b/i.exec(all);
  if (com || pcs || wt) {
    const kg = wt && /kg|kilo/i.test(wt[2]);
    const w = wt ? money(wt[1]) * (kg ? 2.20462 : 1) : null;
    freight.push({ commodity: com?.[1].trim() ?? "", pieces: pcs?.[1] ?? "", packaging: pcs ? pcs[2].toLowerCase() : "", weightLb: w ? String(Math.round(w)) : "", hazmat: /\bhazmat\b|\bUN\s?\d{4}\b/i.test(all) });
    read.push("freight");
  }
  const notes = lines.filter((l) => /\b(detention|tonu|lumper|tracking|layover|macropoint|check calls?)\b/i.test(l)).join("\n");
  if (!stops.some((x) => x.type === "pickup")) warnings.push("no pickup found on the paper");
  if (!stops.some((x) => x.type === "delivery")) warnings.push("no delivery found on the paper");
  if (!rate) warnings.push("no rate found on the paper");
  return { customerName, rate, currency, equipment, refs, freight, stops, notes, warnings, read };
}

/** "2026-10-02T08:00:00-05:00" / "2026-10-02 08:00" → "2026-10-02T08:00" for a datetime-local input; "" when unreadable. */
export function localIso(v: string) {
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  const d = v.match(/^(\d{4}-\d{2}-\d{2})$/);
  return d ? `${d[1]}T00:00` : "";
}

const words = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["inc", "llc", "ltd", "corp", "the", "logistics", "transport", "freight"].includes(w));

/** Read the paper, keep it, and match what it names to our own records. */
export async function readRateConForBuilder(ctx: Ctx, file: { fileName: string; mimeType: string; bytes: Buffer }, fetchImpl: typeof fetch = fetch): Promise<RateConDraft> {
  assertCtx(ctx);
  requirePermission(ctx, "orders.create");
  if (!file.bytes?.length) throw new ValidationError("the file is empty", "file");
  if (file.bytes.length > 15 * 1024 * 1024) throw new ValidationError("the file is over 15 MB", "file");
  if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.mimeType)) throw new ValidationError("upload the rate con as a PDF, JPG or PNG", "file");
  const [integ] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, ctx.tenantId), eq(s.integrations.provider, "extractor"))).limit(1);
  const ai = !!integ?.enabled && !!integ.config.apiKey;
  let parsed: ReturnType<typeof parseRateConResponse> & { read?: string[] };
  let readBy: "ai" | "text" | "none" = "ai";
  if (ai) {
    const res = await fetchImpl(API, { method: "POST", headers: { "x-api-key": String(integ!.config.apiKey), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(buildRateConRequest({ apiKey: String(integ!.config.apiKey), model: integ!.config.model ? String(integ!.config.model) : undefined }, file)) });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new ValidationError(`the reader could not read it: ${json.error?.message ?? res.status}`, "file");
    parsed = parseRateConResponse(json);
  } else {
    // the AI reader is off (M26): the paper is kept anyway, and what its own text says with confidence is filled in
    const { pdfPlainText } = await import("@/lib/pdf-text");
    const text = file.mimeType === "application/pdf" ? pdfPlainText(file.bytes) : "";
    const t = text.trim() ? parseRateConText(text) : null;
    const found = !!t && (t.stops.length > 0 || !!t.rate || Object.keys(t.refs).length > 0);
    readBy = found ? "text" : "none";
    parsed = found
      ? { ...t!, warnings: ["The AI reader is off: filled from the PDF's text — check every field", ...t!.warnings] }
      : { customerName: null, rate: "", currency: "USD", equipment: null, refs: {}, freight: [], stops: [], notes: "", read: [], warnings: [file.mimeType === "application/pdf" ? "Nothing could be read from this PDF's text (a scan?) — it is attached; type the load from it, or connect the AI reader in Settings → Integrations to read rate cons" : "A photo can't be read without the AI reader — it is attached; type the load from it, or connect the AI reader in Settings → Integrations to read rate cons"] };
  }

  // keep the paper; it moves onto the load when the load is created
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  const documentId = newId();
  await db.transaction(async (tx) => {
    const [blob] = await tx.insert(s.documentBlobs).values({ id: newId(), tenantId: ctx.tenantId, sha256: sha, mimeType: file.mimeType, sizeBytes: file.bytes.length, bytes: file.bytes }).returning({ id: s.documentBlobs.id });
    await tx.insert(s.documents).values({ id: documentId, tenantId: ctx.tenantId, code: "RATE_CON", subjectKind: "draft_load", subjectId: ctx.userId ?? "system", fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: "upload", ...(readBy === "ai" ? { extracted: { rate: { value: parsed.rate ? Number(parsed.rate) : null, confidence: 0.8, source: "ai" as const } } } : { extractionNote: readBy === "text" ? "read from the PDF's text (AI reader off)" : "not read (AI reader off)" }), extractionAt: new Date(), createdBy: ctx.userId, updatedBy: ctx.userId });
  });

  // the customer: a name on file that shares the most words with what the paper says
  const customers = await db.select({ id: s.customers.id, name: s.customers.name }).from(s.customers).where(and(eq(s.customers.tenantId, ctx.tenantId), isNull(s.customers.archivedAt)));
  let customerId: string | null = null;
  const warnings = [...parsed.warnings];
  if (parsed.customerName) {
    const want = words(parsed.customerName);
    const scored = customers.map((c) => ({ c, n: words(c.name).filter((w) => want.includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (scored[0] && (scored.length === 1 || scored[0].n > scored[1].n)) customerId = scored[0].c.id;
    else warnings.push(`"${parsed.customerName}" is not a customer on file — pick or add one`);
  }
  // the stops: a saved location with the same name (and city when given)
  const locs = await db.select({ id: s.locations.id, name: s.locations.name, address: s.locations.address }).from(s.locations).where(and(eq(s.locations.tenantId, ctx.tenantId), isNull(s.locations.archivedAt)));
  const stops = parsed.stops.map((st) => {
    const hit = locs.find((l) => l.name.trim().toLowerCase() === st.name.toLowerCase() && (!st.city || !l.address?.city || l.address.city.toLowerCase() === st.city.toLowerCase()));
    return hit ? { ...st, locationId: hit.id } : st;
  });
  await writeAudit(db, ctx, "document", documentId, "create", undefined, readBy === "none" ? "rate con attached for a new load (not read)" : `rate con read for a new load (${readBy === "ai" ? "AI reader" : "PDF text"}): ${stops.length} stops`);
  return { documentId, customerId, customerName: parsed.customerName, rate: parsed.rate, currency: parsed.currency, equipment: parsed.equipment, refs: parsed.refs, freight: parsed.freight, stops, notes: parsed.notes, warnings, readBy, read: parsed.read ?? [] };
}

/** The rate con read in the builder goes onto the load that was created from it. */
export async function attachDraftRateCon(ctx: Ctx, documentId: string, orderId: string) {
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, ctx.tenantId), eq(s.documents.id, documentId), eq(s.documents.subjectKind, "draft_load"))).limit(1);
  if (!doc) return null;
  await db.update(s.documents).set({ subjectKind: "order", subjectId: orderId, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.documents.id, doc.id));
  await writeAudit(db, ctx, "order", orderId, "update", { RATE_CON: { from: null, to: doc.fileName } }, "rate con from the load builder");
  return doc.id;
}
