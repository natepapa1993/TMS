/**
 * AI document extractor (spec F-3.4): reads the fields a crossing document must carry (trailer, seal,
 * folio fiscal, pedimento, weights…) from the PDF or photo, with a confidence per field. A human always
 * confirms before the values count. Per-company Anthropic key under Settings → Integrations.
 * Docs: POST https://api.anthropic.com/v1/messages (document / image content blocks + tool use for structure).
 */

export type ExtractorConfig = { apiKey: string; model?: string };
export const DEFAULT_MODEL = "claude-sonnet-4-5";
export const API = "https://api.anthropic.com/v1/messages";

export type FieldSpec = { key: string; label: string; kind?: "text" | "number" | "datetime" };
export type Extracted = Record<string, { value: string | number | null; confidence: number; source: "ai" }>;

const DOC_HINTS: Record<string, string> = {
  carta_porte: "Mexican CFDI con complemento Carta Porte. The folio fiscal is the 36-character UUID. Weights are usually in kilograms. Plates may be listed as 'placas'.",
  doda: "Mexican DODA (Documento de Operación para Despacho Aduanero) / PITA. Contains pedimento number(s), patente, and the transport's caja/placas.",
  entry: "US CBP entry summary (CBP 7501) or broker entry document.",
  ace_manifest: "US CBP ACE e-Manifest (truck) cover sheet: trip number, SCN, driver, tractor and trailer, crossing port.",
  carta_retiro: "Spanish letter 'Solicitud de Retiro' authorizing pickup of a caja (trailer) from a yard: operadores, unidad, placas.",
  bol: "Bill of lading.",
  invoice: "Commercial invoice.",
  packing_list: "Packing list.",
  dtops: "US DTOPS decal / receipt for the tractor.",
};

export function buildRequest(cfg: ExtractorConfig, doc: { code: string; label: string; mimeType: string; bytes: Buffer }, fields: FieldSpec[]) {
  const isPdf = doc.mimeType === "application/pdf";
  const media = isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.bytes.toString("base64") } } : { type: "image", source: { type: "base64", media_type: doc.mimeType, data: doc.bytes.toString("base64") } };
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f.key] = {
      type: "object",
      properties: {
        value: { type: f.kind === "number" ? ["number", "null"] : ["string", "null"], description: `${f.label}${f.kind === "datetime" ? " as ISO 8601" : ""}; null when not on the document` },
        confidence: { type: "number", description: "0 to 1: how sure you are this is the right value, read exactly as printed" },
      },
      required: ["value", "confidence"],
    };
  }
  return {
    model: cfg.model || DEFAULT_MODEL,
    max_tokens: 1024,
    tools: [{ name: "record_fields", description: "Record the fields read from the document.", input_schema: { type: "object", properties, required: fields.map((f) => f.key) } }],
    tool_choice: { type: "tool", name: "record_fields" },
    messages: [
      {
        role: "user",
        content: [
          media,
          { type: "text", text: `This is a ${doc.label} (${doc.code}) for a US–Mexico truck crossing. ${DOC_HINTS[doc.code] ?? ""}\nRead these fields exactly as printed (keep letters, hyphens and leading zeros; do not guess): ${fields.map((f) => `${f.key} = ${f.label}`).join("; ")}. Use null for anything not on the document, with a low confidence.` },
        ],
      },
    ],
  };
}

/** Pure: the tool call's input → our extracted map, clamped and typed. */
export function parseResponse(json: unknown, fields: FieldSpec[]): Extracted {
  const content = (json as { content?: { type: string; name?: string; input?: Record<string, { value?: unknown; confidence?: unknown }> }[] })?.content ?? [];
  const tool = content.find((c) => c.type === "tool_use" && c.name === "record_fields");
  if (!tool?.input) throw new Error("the model returned no fields");
  const out: Extracted = {};
  for (const f of fields) {
    const r = tool.input[f.key];
    if (!r || r.value == null || r.value === "") continue;
    let value: string | number | null = null;
    if (f.kind === "number") {
      const n = typeof r.value === "number" ? r.value : Number(String(r.value).replace(/[^0-9.\-]/g, ""));
      if (!Number.isFinite(n)) continue;
      value = n;
    } else value = String(r.value).trim();
    const c = typeof r.confidence === "number" ? Math.max(0, Math.min(0.99, r.confidence)) : 0.5; // never 1: only a person confirms
    out[f.key] = { value, confidence: c, source: "ai" };
  }
  return out;
}

export async function extractWithModel(cfg: ExtractorConfig, doc: { code: string; label: string; mimeType: string; bytes: Buffer }, fields: FieldSpec[], fetchImpl: typeof fetch = fetch): Promise<{ fields: Extracted; model: string; inputTokens: number | null }> {
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(doc.mimeType)) throw new Error(`cannot read ${doc.mimeType}; upload a PDF, JPEG or PNG`);
  if (doc.bytes.length > 30 * 1024 * 1024) throw new Error("file over 30 MB");
  const body = buildRequest(cfg, doc, fields);
  const res = await fetchImpl(API, { method: "POST", headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; usage?: { input_tokens?: number }; model?: string };
  if (!res.ok) throw new Error(`extractor ${res.status}: ${json.error?.message ?? "request failed"}`);
  return { fields: parseResponse(json, fields), model: json.model ?? body.model, inputTokens: json.usage?.input_tokens ?? null };
}
