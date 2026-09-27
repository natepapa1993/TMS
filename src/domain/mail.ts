import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import type { MailKind, MailProposal, MailExtracted, MailAttachment } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { fmtIn } from "@/lib/time";
import { parseEmail, openImap, type ParsedEmail, type MailBox, type ImapConfig } from "@/integrations/mail";
import { API, DEFAULT_MODEL } from "@/integrations/extractor";
import { NotFoundError, ValidationError, createOrder, getOrder } from "./orders";
import { normCountry } from "./zones";

/**
 * The inbox agent (spec Module 12): every email to dispatch@ is classified, its fields read, matched
 * deterministically to an open order, and turned into one proposal card — what it found, what it will
 * do. Nothing runs without a tap; the email is the source on whatever the tap touches.
 *
 * With the AI reader connected (Settings → Integrations) the model classifies and reads; without it,
 * rules do what rules can (a rate con is still a rate con; an order number in the subject still
 * matches). A correction on the card is a person's, and always wins.
 */

const ORDER_RE = /\b(\d{2}-\d{5})\b/g;

// ---------- classification by rules ----------

type Rule = { kind: MailKind; re: RegExp; confidence: number };
const RULES: Rule[] = [
  { kind: "broker_doc", re: /\b(doda|pedimento|e-?manifest|ace manifest|entry summary|7501|nad (monitor|confirmation)|pre-?alert|carta porte|despacho aduanal)\b/i, confidence: 75 },
  { kind: "remittance", re: /\b(remittance|payment advice|ach (payment|transfer)|check #|cheque|has been paid|we have paid|paid invoice|remit(ted|tance))\b/i, confidence: 70 },
  { kind: "rate_con", re: /\b(rate con(firmation)?|load confirmation|carrier confirmation|confirmaci[oó]n de tarifa)\b/i, confidence: 75 },
  { kind: "dispute", re: /\b(detention|accessorial|lumper|tonu|layover|dispute|short[- ]?pay|estad[ií]a)\b/i, confidence: 65 },
  { kind: "status_request", re: /\b(where is|where's|eta|status|update on|location of|tracking|any update|d[oó]nde (est[aá]|va)|ubicaci[oó]n)\b/i, confidence: 60 },
  { kind: "tender", re: /\b(tender|load offer|available load|can you cover|need a truck|necesito (una|un) (unidad|cami[oó]n))\b/i, confidence: 60 },
  { kind: "carrier_quote", re: /\b(quote|rate request|rfq|how much|cotizaci[oó]n)\b/i, confidence: 55 },
];

export function classifyByRules(m: { subject: string; text: string; attachments: { fileName: string }[] }): { kind: MailKind; confidence: number } {
  const hay = `${m.subject}\n${m.attachments.map((a) => a.fileName).join(" ")}\n${m.text.slice(0, 4000)}`;
  const subjectHay = `${m.subject} ${m.attachments.map((a) => a.fileName).join(" ")}`;
  for (const r of RULES) {
    if (r.re.test(subjectHay)) return { kind: r.kind, confidence: r.confidence };
  }
  for (const r of RULES) {
    if (r.re.test(hay)) return { kind: r.kind, confidence: Math.max(40, r.confidence - 15) };
  }
  return { kind: "noise", confidence: 50 };
}

/** What rules can read off the text: references, amounts, trailer, seal — with modest confidence. */
export function extractByRules(m: { subject: string; text: string }): MailExtracted {
  const hay = `${m.subject}\n${m.text}`;
  const out: MailExtracted = {};
  const one = (key: string, re: RegExp, conf = 0.6, map: (v: string) => string | number | null = (v) => v) => {
    const hit = hay.match(re);
    if (hit?.[1]) out[key] = { value: map(hit[1].trim()), confidence: conf };
  };
  const orders = [...hay.matchAll(ORDER_RE)].map((x) => x[1]);
  if (orders.length) out.orderNumber = { value: orders[0], confidence: 0.8 };
  one("po", /\bP\.?O\.?\s*(?:#|no\.?|number|:)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i, 0.6);
  one("rate", /(?:rate|total|amount|pay)\s*[:=]?\s*(?:USD|US\$|\$)\s?([\d,]+(?:\.\d{2})?)/i, 0.6, (v) => Number(v.replace(/,/g, "")));
  if (!out.rate) one("rate", /(?:USD|US\$|\$)\s?([\d,]{4,}(?:\.\d{2})?)/, 0.4, (v) => Number(v.replace(/,/g, "")));
  one("trailer", /\b(?:trailer|caja|tlr)\s*(?:#|no\.?|:)?\s*([A-Z0-9-]{3,})/i, 0.6);
  one("seal", /\b(?:seal|sello)\s*(?:#|no\.?|:)?\s*([A-Z0-9-]{3,})/i, 0.6);
  one("amount", /(?:payment|paid|amount|total|remit\w*|sent)[^$\n]{0,60}(?:USD|US\$|\$)\s?([\d,]+(?:\.\d{2})?)/i, 0.6, (v) => Number(v.replace(/,/g, "")));
  if (!out.amount) one("amount", /(?:USD|US\$|\$)\s?([\d,]+\.\d{2})\b/, 0.4, (v) => Number(v.replace(/,/g, "")));
  one("invoiceNumber", /\b(?:invoice|factura|inv)\s*(?:#|no\.?|:)?\s*([A-Z0-9]{2,6}-\d{3,})/i, 0.7);
  one("pickupName", /\b(?:pick\s*up|pickup|origin|shipper|origen)\s*[:\-]\s*([^\n]{3,80})/i, 0.5);
  one("deliveryName", /\b(?:deliver(?:y|s)?(?: to)?|destination|consignee|destino|drop)\s*[:\-]\s*([^\n]{3,80})/i, 0.5);
  one("equipment", /\b(53'? ?(?:dry|van|reefer)|48'? ?dry|flatbed|sprinter|straight truck)\b/i, 0.5);
  // which country an end is in, from how people write addresses: "Apodaca NL MX", "Monterrey, N.L.", "Laredo, TX", "Windsor, ON"
  const MX_NAMES = /\b(M[eé]xico|Nuevo Le[oó]n|Coahuila|Tamaulipas|Chihuahua|Sonora|Jalisco|Guanajuato|Quer[eé]taro|San Luis Potos[ií]|Aguascalientes|Puebla|Durango|Zacatecas|CDMX|EDOMEX)\b/i;
  const MX_CODES = /(?:,|\s)(NL|N\.L\.|COAH|TAMPS|CHIH|SON|JAL|GTO|QRO|SLP|AGS|ZAC|DGO|PUE|VER|MICH|SIN|MX|MEX)\b/;
  const CA_NAMES = /\b(Canada|Ontario|Qu[eé]bec|Alberta|Manitoba|Saskatchewan|British Columbia|Nova Scotia|New Brunswick)\b/i;
  const CA_CODES = /(?:,|\s)(ON|QC|AB|MB|SK|NS|NB|PE|CAN)\b/;
  const US_CODES = /(?:,|\s)(USA?|TX|MI|OH|IL|IN|TN|KY|GA|AL|SC|NC|CA(?!N)|AZ|NM|LA|MS|MO|OK|KS|AR|FL|PA|NY|NJ|WI|MN|IA|VA|WV|MD)\b/;
  const side = (v: string | null) => (v == null ? null : CA_NAMES.test(v) || CA_CODES.test(v) ? "CA" : MX_NAMES.test(v) || MX_CODES.test(v) ? "MX" : US_CODES.test(v) ? "US" : null);
  for (const [end, key] of [["pickup", "pickupName"], ["delivery", "deliveryName"]] as const) {
    const c = side(out[key]?.value != null ? String(out[key].value) : null);
    if (c) out[`${end}Country`] = { value: c, confidence: 0.55 };
  }
  return out;
}

// ---------- classification by the model ----------

const AI_FIELDS = [
  ["kind", "one of: rate_con (a customer or broker confirming a load and its rate), tender (a load offered without a rate con yet), status_request (asking where a load is / an ETA), broker_doc (a customs broker or NAD document: DODA, pedimento, e-manifest, entry, pre-alert), dispute (detention, accessorial, short pay), remittance (a payment or payment advice), carrier_quote (a carrier quoting or asking for work), noise (anything else)"],
  ["orderNumber", "our order number if the email cites one, format YY-NNNNN"],
  ["po", "the customer's PO number"],
  ["reference", "any other customer reference (shipment id, release, trip)"],
  ["customerName", "the customer or broker company sending or being billed"],
  ["rate", "the linehaul rate as a number, no currency symbol"],
  ["currency", "USD or MXN"],
  ["equipment", "equipment: 53 dry, 53 reefer, 48 dry, flatbed, sprinter, straight"],
  ["pickupName", "pickup: shipper or location name"],
  ["pickupCity", "pickup city"],
  ["pickupState", "pickup state, two letters"],
  ["pickupCountry", "pickup country: US or MX"],
  ["pickupAt", "pickup date/time as ISO 8601 if stated"],
  ["deliveryName", "delivery: consignee or location name"],
  ["deliveryCity", "delivery city"],
  ["deliveryState", "delivery state, two letters"],
  ["deliveryCountry", "delivery country: US or MX"],
  ["deliveryAt", "delivery date/time as ISO 8601 if stated"],
  ["trailer", "trailer / caja number"],
  ["seal", "seal number"],
  ["cargo", "what the freight is, in a few words, with weight and pieces if stated"],
  ["invoiceNumber", "our invoice number the email refers to (e.g. 247-000123)"],
  ["amount", "the amount paid or disputed as a number"],
  ["documentType", "for a broker document: doda, entry, ace_manifest, carta_porte, invoice, packing_list"],
] as const;

export function buildClassifyRequest(cfg: { apiKey: string; model?: string }, m: { subject: string; from: string; text: string; attachments: { fileName: string; mimeType: string; bytes: Buffer }[] }) {
  const properties: Record<string, unknown> = {};
  for (const [key, label] of AI_FIELDS) properties[key] = { type: "object", properties: { value: { type: ["string", "null"], description: label }, confidence: { type: "number", description: "0 to 1" } }, required: ["value", "confidence"] };
  const att = m.attachments.find((a) => a.mimeType === "application/pdf") ?? m.attachments[0];
  const media = att ? [att.mimeType === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: att.bytes.toString("base64") } } : { type: "image", source: { type: "base64", media_type: att.mimeType, data: att.bytes.toString("base64") } }] : [];
  return {
    model: cfg.model || DEFAULT_MODEL,
    max_tokens: 1500,
    tools: [{ name: "classify_email", description: "Classify the email and record the fields it carries.", input_schema: { type: "object", properties, required: ["kind"] } }],
    tool_choice: { type: "tool", name: "classify_email" },
    messages: [
      {
        role: "user",
        content: [
          ...media,
          { type: "text", text: `An email to the dispatch mailbox of a US–Mexico expedite trucking carrier.\nFrom: ${m.from}\nSubject: ${m.subject}\nAttachments: ${m.attachments.map((a) => a.fileName).join(", ") || "none"}\n\n${m.text.slice(0, 12000)}\n\nClassify it and read the fields exactly as written (keep letters, hyphens and leading zeros; never guess a value that is not there — use null with low confidence).` },
        ],
      },
    ],
  };
}

export function parseClassifyResponse(json: unknown): { kind: MailKind; confidence: number; extracted: MailExtracted } {
  const content = (json as { content?: { type: string; name?: string; input?: Record<string, { value?: unknown; confidence?: unknown }> }[] })?.content ?? [];
  const tool = content.find((c) => c.type === "tool_use" && c.name === "classify_email");
  if (!tool?.input) throw new Error("the model returned nothing");
  const extracted: MailExtracted = {};
  for (const [key] of AI_FIELDS) {
    const r = tool.input[key];
    if (!r || r.value == null || r.value === "") continue;
    const conf = typeof r.confidence === "number" ? Math.max(0, Math.min(0.99, r.confidence)) : 0.5;
    extracted[key] = { value: ["rate", "amount"].includes(key) ? Number(String(r.value).replace(/[^0-9.\-]/g, "")) : String(r.value).trim(), confidence: conf };
    if (["rate", "amount"].includes(key) && !Number.isFinite(extracted[key].value as number)) delete extracted[key];
  }
  const kindRaw = String(extracted.kind?.value ?? "noise");
  const kind = (s.MAIL_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as MailKind) : "noise";
  const confidence = Math.round((extracted.kind?.confidence ?? 0.5) * 100);
  delete extracted.kind;
  return { kind, confidence, extracted };
}

export async function classifyWithModel(cfg: { apiKey: string; model?: string }, m: { subject: string; from: string; text: string; attachments: { fileName: string; mimeType: string; bytes: Buffer }[] }, fetchImpl: typeof fetch = fetch) {
  const body = buildClassifyRequest(cfg, m);
  const res = await fetchImpl(API, { method: "POST", headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(`model ${res.status}: ${json?.error?.message ?? "request failed"}`);
  return { ...parseClassifyResponse(json), model: body.model };
}

// ---------- matching ----------

async function matchOrder(tenantId: string, m: { subject: string; text: string; from: string }, ex: MailExtracted) {
  const hay = `${m.subject}\n${m.text}`;
  const numbers = [...new Set([...[...hay.matchAll(ORDER_RE)].map((x) => x[1]), ...(ex.orderNumber?.value ? [String(ex.orderNumber.value)] : [])])];
  if (numbers.length) {
    const rows = await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber, state: s.orders.state }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), inArray(s.orders.orderNumber, numbers)));
    const live = rows.filter((r) => r.state !== "cancelled");
    if (live.length === 1) return { orderId: live[0].id, orderNumber: live[0].orderNumber, reason: `order number ${live[0].orderNumber} in the email` };
    if (live.length > 1) return { orderId: null, orderNumber: null, reason: `more than one order cited (${live.map((r) => r.orderNumber).join(", ")}) — pick one` };
  }
  const po = ex.po?.value ? String(ex.po.value) : null;
  if (po && po.length >= 4) {
    const rows = await db.select({ id: s.orders.id, orderNumber: s.orders.orderNumber }).from(s.orders).where(and(eq(s.orders.tenantId, tenantId), sql`${s.orders.refs}->>'po' = ${po}`, sql`${s.orders.state} not in ('cancelled','paid')`));
    if (rows.length === 1) return { orderId: rows[0].id, orderNumber: rows[0].orderNumber, reason: `PO ${po} on ${rows[0].orderNumber}` };
    if (rows.length > 1) return { orderId: null, orderNumber: null, reason: `PO ${po} is on ${rows.length} open orders — pick one` };
  }
  const trailer = ex.trailer?.value ? String(ex.trailer.value) : null;
  if (trailer) {
    const rows = await db.select({ orderId: s.crossings.orderId, orderNumber: s.orders.orderNumber }).from(s.crossings).innerJoin(s.orders, eq(s.orders.id, s.crossings.orderId)).where(and(eq(s.crossings.tenantId, tenantId), sql`upper(${s.crossings.trailerNumber}) = ${trailer.toUpperCase()}`, sql`${s.crossings.state} not in ('cleared','cancelled')`));
    if (rows.length === 1) return { orderId: rows[0].orderId, orderNumber: rows[0].orderNumber, reason: `trailer ${trailer} on the live crossing of ${rows[0].orderNumber}` };
  }
  return { orderId: null, orderNumber: null, reason: null };
}

/** The customer behind a sender: the billing address's domain, or a contact's address, or the company name the model read. */
async function matchCustomer(tenantId: string, from: string, ex: MailExtracted) {
  const customers = await db.select({ id: s.customers.id, name: s.customers.name, billingEmail: s.customers.billingEmail, contacts: s.customers.contacts }).from(s.customers).where(and(eq(s.customers.tenantId, tenantId), sql`${s.customers.archivedAt} is null`));
  const domain = from.split("@")[1]?.toLowerCase();
  const generic = /^(gmail|outlook|hotmail|yahoo|icloud|live|proton|protonmail)\./i;
  for (const c of customers) {
    const emails = [c.billingEmail, ...((c.contacts as { email?: string }[] | null) ?? []).map((x) => x.email)].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    if (emails.includes(from)) return { id: c.id, name: c.name, reason: `sender ${from} is on ${c.name}` };
  }
  if (domain && !generic.test(domain)) {
    for (const c of customers) {
      const domains = [c.billingEmail, ...((c.contacts as { email?: string }[] | null) ?? []).map((x) => x.email)].filter((x): x is string => !!x).map((x) => x.split("@")[1]?.toLowerCase());
      if (domains.includes(domain)) return { id: c.id, name: c.name, reason: `sender domain ${domain} is ${c.name}'s` };
    }
  }
  const name = ex.customerName?.value ? String(ex.customerName.value).toLowerCase() : null;
  if (name) {
    const c = customers.find((x) => x.name.toLowerCase() === name || name.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(name));
    if (c) return { id: c.id, name: c.name, reason: `"${ex.customerName!.value}" is ${c.name}` };
  }
  return null;
}

// ---------- proposals ----------

const EQUIP: [RegExp, string][] = [[/reefer/i, "53_reefer"], [/48/, "48_dry"], [/flat/i, "flatbed"], [/sprinter/i, "sprinter"], [/straight/i, "straight"], [/53|dry|van/i, "53_dry"]];
const str = (ex: MailExtracted, k: string) => (ex[k]?.value != null && ex[k].value !== "" ? String(ex[k].value) : null);

async function propose(tenantId: string, m: ParsedEmail, kind: MailKind, ex: MailExtracted, match: { orderId: string | null; orderNumber: string | null; reason: string | null }, attachments: MailAttachment[]): Promise<MailProposal> {
  const ctx = systemCtx(tenantId);
  if ((kind === "rate_con" || kind === "tender") && !match.orderId) {
    const cust = await matchCustomer(tenantId, m.from, ex);
    const pc = normCountry((str(ex, "pickupCountry") ?? "US").toUpperCase());
    const dc = normCountry((str(ex, "deliveryCountry") ?? "US").toUpperCase());
    const template = ""; // the legs are cut from the stops; dispatch adds any yard or hand-off stops
    const ends = { pickup: { type: "pickup", name: str(ex, "pickupName") ?? ([str(ex, "pickupCity"), str(ex, "pickupState")].filter(Boolean).join(", ") || "Pickup"), city: str(ex, "pickupCity") ?? undefined, state: str(ex, "pickupState") ?? undefined, country: pc, windowStart: str(ex, "pickupAt") }, delivery: { type: "delivery", name: str(ex, "deliveryName") ?? ([str(ex, "deliveryCity"), str(ex, "deliveryState")].filter(Boolean).join(", ") || "Delivery"), city: str(ex, "deliveryCity") ?? undefined, state: str(ex, "deliveryState") ?? undefined, country: dc, windowEnd: str(ex, "deliveryAt") } };
    const stops = [ends.pickup, ends.delivery];
    const rate = typeof ex.rate?.value === "number" ? Math.round(ex.rate.value * 100) : null;
    const eq = str(ex, "equipment");
    const equipment = eq ? (EQUIP.find(([re]) => re.test(eq))?.[1] ?? null) : null;
    const refs: Record<string, string> = {};
    if (str(ex, "po")) refs.po = str(ex, "po")!;
    if (str(ex, "reference")) refs.reference = str(ex, "reference")!;
    const rc = attachments.find((a) => /rate|con|rc|confirm/i.test(a.fileName)) ?? attachments.find((a) => a.mimeType === "application/pdf") ?? null;
    return { action: "create_order", summary: `New ${kind === "rate_con" ? "order from this rate con" : "order from this tender"}: ${cust?.name ?? "customer to pick"} · ${ends.pickup.name} (${pc}) → ${ends.delivery.name} (${dc})${rate != null ? ` · $${(rate / 100).toLocaleString("en-US")}` : " · rate TBD"} — a draft for dispatch to check and book`, customerId: cust?.id ?? null, customerName: cust?.name ?? null, template, stops, rateCents: rate, currency: (str(ex, "currency") ?? "USD").toUpperCase() === "MXN" ? "MXN" : "USD", equipment, refs, cargoNote: str(ex, "cargo"), attachAs: rc ? "RATE_CON" : null };
  }
  if ((kind === "rate_con" || kind === "tender") && match.orderId) {
    const o = await getOrder(ctx, match.orderId);
    const rate = typeof ex.rate?.value === "number" ? Math.round(ex.rate.value * 100) : null;
    const diff = rate != null && o.order.rateCents != null && Math.abs(rate - o.order.rateCents) >= 100 ? ` · the paper says $${(rate / 100).toLocaleString("en-US")}, the order $${(o.order.rateCents / 100).toLocaleString("en-US")}` : "";
    return { action: "attach_document", summary: `Attach this rate con to ${o.order.orderNumber} (${match.reason})${diff}`, orderId: o.order.id, orderNumber: o.order.orderNumber, code: "RATE_CON" };
  }
  if (kind === "broker_doc" && match.orderId) {
    const [x] = await db.select({ id: s.crossings.id, state: s.crossings.state }).from(s.crossings).where(and(eq(s.crossings.tenantId, tenantId), eq(s.crossings.orderId, match.orderId))).limit(1);
    const dt = str(ex, "documentType") ?? (/\bdoda\b/i.test(`${m.subject} ${m.text}`) ? "doda" : /e-?manifest|ace/i.test(`${m.subject} ${m.text}`) ? "ace_manifest" : /entry|7501/i.test(`${m.subject} ${m.text}`) ? "entry" : /carta porte/i.test(`${m.subject} ${m.text}`) ? "carta_porte" : "doda");
    if (x && attachments.length) return { action: "attach_document", summary: `Attach ${attachments[0].fileName} to the crossing of ${match.orderNumber} as ${dt.replace("_", " ")} (${match.reason})`, orderId: match.orderId, orderNumber: match.orderNumber!, code: dt, crossingId: x.id };
    if (attachments.length) return { action: "attach_document", summary: `Attach ${attachments[0].fileName} to ${match.orderNumber} (${match.reason})`, orderId: match.orderId, orderNumber: match.orderNumber!, code: dt.toUpperCase() };
    return { action: "none", summary: `A broker note about ${match.orderNumber} with nothing attached — read it on the order` };
  }
  if (kind === "status_request" && match.orderId) {
    const reply = await draftStatusReply(tenantId, match.orderId, m);
    return { action: "reply", summary: `Reply to ${m.fromName ?? m.from} with where ${match.orderNumber} is (${match.reason})`, orderId: match.orderId, orderNumber: match.orderNumber!, to: m.from, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || match.orderNumber}`, body: reply };
  }
  if (kind === "dispute" && match.orderId) return { action: "detention", summary: `Compute detention on ${match.orderNumber} from the stop clocks and the customer's free time, as a charge line to review (${match.reason})`, orderId: match.orderId, orderNumber: match.orderNumber! };
  if (kind === "remittance") {
    const nums = [...new Set([...`${m.subject}\n${m.text}`.matchAll(/\b([A-Z0-9]{2,6}-\d{4,})\b/g)].map((x) => x[1]).concat(str(ex, "invoiceNumber") ? [str(ex, "invoiceNumber")!] : []))];
    if (nums.length) {
      const inv = await db.select().from(s.invoices).where(and(eq(s.invoices.tenantId, tenantId), inArray(s.invoices.number, nums), inArray(s.invoices.state, ["issued", "sent", "partially_paid", "disputed"]))).limit(1);
      if (inv[0]) {
        const open = inv[0].totalCents - inv[0].paidCents - inv[0].creditedCents;
        const amount = typeof ex.amount?.value === "number" ? Math.round(ex.amount.value * 100) : open;
        return { action: "receipt", summary: `Record $${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} received on invoice ${inv[0].number}${amount < open ? ` (leaves $${((open - amount) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} open)` : ""}`, invoiceId: inv[0].id, invoiceNumber: inv[0].number!, amountCents: amount, reference: str(ex, "reference") };
      }
    }
    return { action: "none", summary: "A payment notice, but no open invoice number in it — match it under Billing → AR" };
  }
  if (attachments.length && match.orderId) {
    const code = attachments.some((a) => /pod|proof|delivery/i.test(a.fileName)) ? "POD" : attachments.some((a) => /bol|lading/i.test(a.fileName)) ? "BOL" : null;
    if (code) return { action: "attach_document", summary: `Attach ${attachments[0].fileName} to ${match.orderNumber} as ${code} (${match.reason})`, orderId: match.orderId, orderNumber: match.orderNumber!, code };
  }
  if (match.orderId) return { action: "none", summary: `About ${match.orderNumber} (${match.reason}); nothing for the agent to do — read it` };
  return { action: "none", summary: kind === "noise" ? "Nothing for dispatch in this one" : `No order matched; ${kind.replace("_", " ")} to handle by hand` };
}

/** "Where is my truck": from verified tracking, in the customer's language, for a person to send. */
export async function draftStatusReply(tenantId: string, orderId: string, m: { fromName: string | null; text: string; subject: string }) {
  const { trackingView, orderEtas } = await import("./tracking");
  const { tenantZone } = await import("./company");
  const [v, etas, zone] = await Promise.all([trackingView(tenantId, orderId), orderEtas(tenantId, orderId), tenantZone(tenantId)]);
  const es = /[¿¡]|\b(d[oó]nde|estatus|unidad|embarque|gracias|saludos|hola|por favor)\b/i.test(`${m.subject} ${m.text}`);
  const fmt = (d: Date | null | undefined) => fmtIn(d, zone);
  const here = v.stops.find((st) => st.arrivedAt && !st.departedAt);
  const lastDone = [...v.stops].reverse().find((st) => st.departedAt);
  const next = v.stops.find((st) => !st.arrivedAt);
  const eta = Object.values(etas)[0];
  const name = m.fromName?.split(" ")[0];
  const lines: string[] = [];
  lines.push(es ? `Hola${name ? ` ${name}` : ""},` : `Hi${name ? ` ${name}` : ""},`);
  lines.push("");
  if (v.order.deliveredAt) lines.push(es ? `El embarque ${v.order.orderNumber} se entregó el ${fmt(v.order.deliveredAt)}.` : `Load ${v.order.orderNumber} was delivered ${fmt(v.order.deliveredAt)}.`);
  else if (here) lines.push(es ? `El embarque ${v.order.orderNumber} está en ${here.name} desde las ${fmt(here.arrivedAt)}.` : `Load ${v.order.orderNumber} is at ${here.name}, arrived ${fmt(here.arrivedAt)}.`);
  else if (lastDone) lines.push(es ? `El embarque ${v.order.orderNumber} salió de ${lastDone.name} a las ${fmt(lastDone.departedAt)}${next ? ` rumbo a ${next.name}` : ""}.` : `Load ${v.order.orderNumber} left ${lastDone.name} at ${fmt(lastDone.departedAt)}${next ? `, heading to ${next.name}` : ""}.`);
  else lines.push(es ? `El embarque ${v.order.orderNumber} está programado; aún no sale de ${v.stops[0]?.name ?? "origen"}.` : `Load ${v.order.orderNumber} is booked; it has not left ${v.stops[0]?.name ?? "the origin"} yet.`);
  if (v.lastPosition) lines.push(es ? `Última posición GPS: ${v.lastPosition.place ?? `${Number(v.lastPosition.lat).toFixed(2)}, ${Number(v.lastPosition.lng).toFixed(2)}`} a las ${fmt(v.lastPosition.at)}.` : `Last GPS position: ${v.lastPosition.place ?? `${Number(v.lastPosition.lat).toFixed(2)}, ${Number(v.lastPosition.lng).toFixed(2)}`} at ${fmt(v.lastPosition.at)}.`);
  if (eta && !v.order.deliveredAt) lines.push(es ? `Llegada estimada a ${eta.stopName}: ${fmt(eta.at)} (${eta.miles} mi por recorrer).` : `ETA at ${eta.stopName}: ${fmt(eta.at)} (${eta.miles} mi to go).`);
  else if (next?.windowStart && !v.order.deliveredAt) lines.push(es ? `Cita en ${next.name}: ${fmt(next.windowStart)}.` : `Appointment at ${next.name}: ${fmt(next.windowStart)}.`);
  lines.push("");
  lines.push(es ? `Saludos,\n${v.carrier}` : `Regards,\n${v.carrier}`);
  return lines.join("\n");
}

// ---------- receive ----------

function guessCode(fileName: string) {
  if (/pod|proof|delivery/i.test(fileName)) return "POD";
  if (/bol|lading/i.test(fileName)) return "BOL";
  if (/rate|ratecon|confirm/i.test(fileName)) return "RATE_CON";
  if (/doda/i.test(fileName)) return "doda";
  if (/manifest|ace/i.test(fileName)) return "ace_manifest";
  if (/carta/i.test(fileName)) return "carta_porte";
  if (/invoice|factura/i.test(fileName)) return "invoice";
  return null;
}

/** One email in: stored, classified, read, matched, proposed. Twice the same Message-ID is once. */
export async function receiveEmail(tenantId: string, parsed: ParsedEmail, source: "imap" | "http" = "http", fetchImpl?: typeof fetch) {
  const ctx = systemCtx(tenantId);
  const [dupe] = await db.select({ id: s.mailMessages.id }).from(s.mailMessages).where(and(eq(s.mailMessages.tenantId, tenantId), eq(s.mailMessages.messageId, parsed.messageId))).limit(1);
  if (dupe) return { id: dupe.id, duplicate: true as const };
  const id = newId();
  // attachments become documents on the email itself; approval copies them where they belong
  const attachments: MailAttachment[] = [];
  for (const a of parsed.attachments) {
    const sha = createHash("sha256").update(a.bytes).digest("hex");
    const [blob] = await db.insert(s.documentBlobs).values({ id: newId(), tenantId, sha256: sha, mimeType: a.mimeType, sizeBytes: a.bytes.length, bytes: a.bytes }).returning({ id: s.documentBlobs.id });
    const [doc] = await db.insert(s.documents).values({ id: newId(), tenantId, code: guessCode(a.fileName), subjectKind: "email", subjectId: id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.bytes.length, storageKey: `blob:${blob.id}`, sha256: sha, source: "email", status: "present", version: 1, createdBy: null, updatedBy: null }).returning({ id: s.documents.id });
    attachments.push({ documentId: doc.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.bytes.length });
  }
  // classify: rules always; the model when connected, and it wins when it is sure
  let { kind, confidence } = classifyByRules(parsed);
  let extracted = extractByRules(parsed);
  let classifier = "rules";
  const [integ] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, tenantId), eq(s.integrations.provider, "extractor"))).limit(1);
  if (integ?.enabled && integ.config.apiKey) {
    try {
      const ai = await classifyWithModel({ apiKey: integ.config.apiKey, model: integ.config.model || undefined }, parsed, fetchImpl);
      if (ai.confidence >= 60 || kind === "noise") {
        kind = ai.kind;
        confidence = ai.confidence;
      }
      extracted = { ...extracted, ...ai.extracted };
      classifier = ai.model;
      await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: null }).where(eq(s.integrations.id, integ.id));
    } catch (e) {
      await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: (e as Error).message.slice(0, 300) }).where(eq(s.integrations.id, integ.id));
    }
  }
  const match = await matchOrder(tenantId, parsed, extracted);
  const proposal = await propose(tenantId, parsed, kind, extracted, match, attachments).catch((e) => ({ action: "none", summary: `Could not build a proposal: ${(e as Error).message}` }) as MailProposal);
  const [row] = await db
    .insert(s.mailMessages)
    .values({ id, tenantId, messageId: parsed.messageId, source, from: parsed.from, fromName: parsed.fromName, to: parsed.to, subject: parsed.subject, receivedAt: parsed.date, text: parsed.text.slice(0, 50_000), attachments, kind, confidence, classifier, extracted, orderId: match.orderId, matchReason: match.reason, proposal, state: kind === "noise" && proposal.action === "none" ? "ignored" : "proposed", result: kind === "noise" && proposal.action === "none" ? "filed as noise" : null })
    .returning();
  if (match.orderId) {
    const [leg] = await db.select({ id: s.legs.id }).from(s.legs).where(eq(s.legs.orderId, match.orderId)).orderBy(s.legs.seq).limit(1);
    if (leg) await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: leg.id, orderId: match.orderId, kind: "message", source: "system", verified: false, note: `Email from ${parsed.fromName ?? parsed.from}: ${parsed.subject || "(no subject)"} · ${kind.replace("_", " ")}` });
  }
  void ctx;
  return { id: row.id, duplicate: false as const, kind, proposal };
}

export async function receiveRawEmail(tenantId: string, raw: Buffer | string, source: "imap" | "http" = "http", fetchImpl?: typeof fetch) {
  return receiveEmail(tenantId, await parseEmail(raw), source, fetchImpl);
}

// ---------- the mailbox ----------

export type MailboxConfig = ImapConfig & { inboundToken?: string; lastUid?: string };

export async function mailboxIntegration(tenantId: string) {
  const [row] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, tenantId), eq(s.integrations.provider, "mailbox"))).limit(1);
  return row ?? null;
}

export async function integrationByInboundToken(token: string) {
  const rows = await db.select().from(s.integrations).where(and(eq(s.integrations.provider, "mailbox"), sql`${s.integrations.config}->>'inboundToken' = ${token}`)).limit(1);
  return rows[0] ?? null;
}

/** Pull what is new in the company's IMAP folder through the pipeline; remembers the last UID. */
export async function pollMail(tenantId: string, box?: MailBox, fetchImpl?: typeof fetch) {
  const integ = await mailboxIntegration(tenantId);
  if (!integ?.enabled && !box) return { skipped: true as const };
  const cfg = (integ?.config ?? {}) as unknown as MailboxConfig;
  if (!box && !cfg.host) return { skipped: true as const, reason: "inbound URL only — no IMAP host" }; // forwarding to the URL needs no polling
  let opened: MailBox | null = null;
  try {
    opened = box ?? (await openImap({ host: cfg.host, port: cfg.port ? Number(cfg.port) : undefined, user: cfg.user, password: cfg.password, folder: cfg.folder || undefined }));
    const sinceUid = Number(cfg.lastUid ?? 0) || 0;
    const msgs = await opened.fetchNew(sinceUid);
    let received = 0;
    let duplicates = 0;
    let lastUid = sinceUid;
    for (const m of msgs) {
      const r = await receiveRawEmail(tenantId, m.raw, "imap", fetchImpl);
      if (r.duplicate) duplicates++;
      else received++;
      lastUid = Math.max(lastUid, m.uid);
    }
    if (integ) await db.update(s.integrations).set({ config: { ...integ.config, lastUid: String(lastUid) }, lastRunAt: new Date(), lastError: null, lastResult: `${received} received, ${duplicates} already seen` }).where(eq(s.integrations.id, integ.id));
    return { received, duplicates, lastUid };
  } catch (e) {
    if (integ) await db.update(s.integrations).set({ lastRunAt: new Date(), lastError: (e as Error).message.slice(0, 300) }).where(eq(s.integrations.id, integ.id));
    throw e;
  } finally {
    if (opened && !box) await opened.close();
  }
}

/** Job: every enabled mailbox, every couple of minutes. */
export async function pollAllMail(now = new Date()) {
  const rows = await db.select({ tenantId: s.integrations.tenantId }).from(s.integrations).where(and(eq(s.integrations.provider, "mailbox"), eq(s.integrations.enabled, true)));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) out.push({ tenantId: r.tenantId, ...(await pollMail(r.tenantId).catch((e) => ({ error: String(e) }))) });
  void now;
  return out;
}

// ---------- the cards ----------

export async function mailInbox(ctx: Ctx, opts: { limit?: number; all?: boolean } = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.view");
  return db
    .select()
    .from(s.mailMessages)
    .where(and(eq(s.mailMessages.tenantId, ctx.tenantId), opts.all ? sql`true` : eq(s.mailMessages.state, "proposed")))
    .orderBy(desc(s.mailMessages.receivedAt))
    .limit(opts.limit ?? 100);
}

export async function mailMessage(ctx: Ctx, id: string) {
  assertCtx(ctx);
  const [row] = await db.select().from(s.mailMessages).where(and(eq(s.mailMessages.tenantId, ctx.tenantId), eq(s.mailMessages.id, id))).limit(1);
  if (!row) throw new NotFoundError("email", id);
  return row;
}

export async function ignoreMail(ctx: Ctx, id: string, why?: string | null) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const row = await mailMessage(ctx, id);
  if (row.state !== "proposed") throw new ValidationError(`this email is already ${row.state}`);
  await db.update(s.mailMessages).set({ state: "ignored", reviewedBy: ctx.userId, reviewedAt: new Date(), result: why?.trim() || "ignored" }).where(eq(s.mailMessages.id, id));
  await writeAudit(db, ctx, "email", id, "update", { state: { from: "proposed", to: "ignored" } }, why?.trim() || undefined);
}

/** A correction on the card before approval: a person's word replaces the agent's. */
export type MailEdits = { customerId?: string | null; rateCents?: number | null; orderId?: string | null; amountCents?: number | null; body?: string; code?: string };

async function blobBytes(tenantId: string, documentId: string) {
  const [doc] = await db.select().from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.id, documentId))).limit(1);
  if (!doc) throw new NotFoundError("attachment", documentId);
  const [blob] = await db.select().from(s.documentBlobs).where(eq(s.documentBlobs.id, doc.storageKey.replace(/^blob:/, ""))).limit(1);
  if (!blob) throw new NotFoundError("attachment bytes", documentId);
  return { doc, bytes: Buffer.from(blob.bytes) };
}

/** The tap. Runs the proposal (with the person's edits), logs the email as the source, and says what happened. */
export async function approveMail(ctx: Ctx, id: string, edits: MailEdits = {}) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const row = await mailMessage(ctx, id);
  if (row.state !== "proposed") throw new ValidationError(`this email is already ${row.state}`);
  const p = row.proposal;
  const source = `email from ${row.fromName ?? row.from}: ${row.subject || "(no subject)"}`;
  try {
    let result = "";
    let orderId: string | null = row.orderId;
    if (p.action === "create_order") {
      const customerId = edits.customerId !== undefined ? edits.customerId : p.customerId;
      if (!customerId) throw new ValidationError("pick the customer before creating the order", "customerId");
      const rateCents = edits.rateCents !== undefined ? edits.rateCents : p.rateCents;
      const o = await createOrder(ctx, {
        customerId,
        rateCents,
        rateTbd: rateCents == null,
        currency: p.currency,
        equipment: p.equipment ?? undefined,
        refs: p.refs,
        cargoNote: p.cargoNote,
        source: "email",
        template: p.template || undefined,
        stops: p.stops.map((st) => ({ type: st.type as s.StopType, name: st.name, country: st.country, address: st.city || st.state ? { city: st.city, state: st.state } : undefined, windowStart: st.windowStart ? new Date(st.windowStart) : undefined, windowEnd: st.windowEnd ? new Date(st.windowEnd) : undefined })),
        book: false,
      });
      orderId = o.order.id;
      if (p.attachAs && row.attachments[0]) {
        const { bytes, doc } = await blobBytes(ctx.tenantId, row.attachments[0].documentId);
        const { uploadOrderDocument } = await import("./billing");
        await uploadOrderDocument(ctx, o.order.id, { code: p.attachAs, fileName: doc.fileName, mimeType: doc.mimeType, bytes, source: "email" });
      }
      result = `draft order ${o.order.orderNumber} created${p.attachAs ? " with the rate con attached" : ""}`;
    } else if (p.action === "attach_document") {
      const target = edits.orderId ?? p.orderId;
      const code = edits.code ?? p.code;
      if (!row.attachments.length) throw new ValidationError("nothing attached to this email");
      const { bytes, doc } = await blobBytes(ctx.tenantId, row.attachments[0].documentId);
      if (p.crossingId) {
        const X = await import("./crossing");
        await X.uploadDocument(ctx, p.crossingId, { code, fileName: doc.fileName, mimeType: doc.mimeType, bytes, source: "email", notes: source });
        result = `${doc.fileName} attached to the crossing of ${p.orderNumber} as ${code.replace("_", " ")}`;
      } else {
        const { uploadOrderDocument } = await import("./billing");
        await uploadOrderDocument(ctx, target, { code, fileName: doc.fileName, mimeType: doc.mimeType, bytes, source: "email" });
        result = `${doc.fileName} attached to ${p.orderNumber} as ${code.replace("_", " ")}`;
      }
      orderId = target;
    } else if (p.action === "reply") {
      const { enqueue, deliverQueued, canSendEmail } = await import("@/lib/outbox");
      const body = edits.body ?? p.body;
      const can = await canSendEmail(ctx.tenantId);
      const m = await enqueue(ctx, { channel: "email", to: p.to, subject: p.subject, body, subjectKind: "mail_reply", subjectId: row.id });
      await deliverQueued(5).catch(() => null);
      result = can ? `reply sent to ${p.to}` : `reply to ${p.to} logged — connect an email sender under Settings → Integrations to deliver it (outbox ${m.id})`;
    } else if (p.action === "detention") {
      const B = await import("./billing");
      const r = await B.computeDetention(ctx, p.orderId);
      const n = r.length;
      result = n ? `${n} detention line${n === 1 ? "" : "s"} added to ${p.orderNumber} for billing to review` : `no detention on ${p.orderNumber}: nothing sat past the free time`;
    } else if (p.action === "receipt") {
      const B = await import("./billing");
      const amount = edits.amountCents ?? p.amountCents;
      await B.recordReceipt(ctx, p.invoiceId, { amountCents: amount, method: "ach", reference: p.reference, note: source });
      result = `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} recorded on ${p.invoiceNumber}`;
    } else {
      result = "nothing to run";
    }
    await db.update(s.mailMessages).set({ state: "executed", reviewedBy: ctx.userId, reviewedAt: new Date(), result, orderId }).where(eq(s.mailMessages.id, id));
    await writeAudit(db, ctx, "email", id, "update", { state: { from: "proposed", to: "executed" } }, result);
    if (orderId) {
      const [leg] = await db.select({ id: s.legs.id }).from(s.legs).where(eq(s.legs.orderId, orderId)).orderBy(s.legs.seq).limit(1);
      if (leg) await db.insert(s.legEvents).values({ id: newId(), tenantId: ctx.tenantId, legId: leg.id, orderId, kind: "note", source: "dispatcher", verified: false, userId: ctx.userId, note: `${result} · ${source}` });
    }
    return { result, orderId };
  } catch (e) {
    const msg = (e as Error).message;
    await db.update(s.mailMessages).set({ state: "failed", reviewedBy: ctx.userId, reviewedAt: new Date(), result: msg }).where(eq(s.mailMessages.id, id));
    throw e;
  }
}

/** Failed once (a missing customer, say): back to proposed so the person can fix and tap again. */
export async function retryMail(ctx: Ctx, id: string) {
  assertCtx(ctx);
  requirePermission(ctx, "orders.edit");
  const row = await mailMessage(ctx, id);
  if (row.state !== "failed") throw new ValidationError(`this email is ${row.state}`);
  await db.update(s.mailMessages).set({ state: "proposed", result: null }).where(eq(s.mailMessages.id, id));
}
