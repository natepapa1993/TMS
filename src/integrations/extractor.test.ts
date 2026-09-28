// Features: F-3.4 AI document extractor — request shape, response parsing, confidence never 1, unreadable files refused
import { describe, it, expect } from "vitest";
import { buildRequest, parseResponse, extractWithModel } from "./extractor";

const fields = [
  { key: "trailer", label: "Trailer #" },
  { key: "seal", label: "Seal #" },
  { key: "grossWeight", label: "Gross weight (kg)", kind: "number" as const },
];

describe("extractor", () => {
  it("builds a Messages request with the PDF as a document block and a tool schema from the fields", () => {
    const r = buildRequest({ apiKey: "k" }, { code: "carta_porte", label: "Carta porte", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") }, fields);
    expect(r.model).toBe("claude-sonnet-4-5");
    expect(r.tool_choice).toEqual({ type: "tool", name: "record_fields" });
    const schema = r.tools[0].input_schema as { properties: Record<string, { properties: { value: { type: string[] } } }>; required: string[] };
    expect(schema.required).toEqual(["trailer", "seal", "grossWeight"]);
    expect(schema.properties.grossWeight.properties.value.type).toEqual(["number", "null"]);
    const content = r.messages[0].content as { type: string; source?: { media_type: string; data: string } }[];
    expect(content[0].type).toBe("document");
    expect(content[0].source?.data).toBe(Buffer.from("%PDF-1.4").toString("base64"));
    expect((content[1] as unknown as { text: string }).text).toContain("Carta Porte");
    const img = buildRequest({ apiKey: "k", model: "claude-opus-4-1" }, { code: "doda", label: "DODA", mimeType: "image/jpeg", bytes: Buffer.from("x") }, fields);
    expect(img.model).toBe("claude-opus-4-1");
    expect((img.messages[0].content as { type: string }[])[0].type).toBe("image");
  });

  it("parses the tool call: strings trimmed, numbers coerced, nulls skipped, confidence clamped below 1", () => {
    const json = { content: [{ type: "text", text: "Reading…" }, { type: "tool_use", name: "record_fields", input: { trailer: { value: " 10743 ", confidence: 0.97 }, seal: { value: null, confidence: 0.1 }, grossWeight: { value: "18,540 kg", confidence: 1.4 } } }] };
    expect(parseResponse(json, fields)).toEqual({ trailer: { value: "10743", confidence: 0.97, source: "ai" }, grossWeight: { value: 18540, confidence: 0.99, source: "ai" } });
    expect(() => parseResponse({ content: [{ type: "text", text: "no" }] }, fields)).toThrow(/no fields/);
  });

  it("calls the API with the key and version header; refuses files it cannot read; surfaces API errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 2100 }, content: [{ type: "tool_use", name: "record_fields", input: { trailer: { value: "10743", confidence: 0.9 } } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await extractWithModel({ apiKey: "sk-ant-x" }, { code: "doda", label: "DODA", mimeType: "application/pdf", bytes: Buffer.from("%PDF") }, fields, ok);
    expect(r.fields.trailer.value).toBe("10743");
    expect(r.inputTokens).toBe(2100);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-x");
    await expect(extractWithModel({ apiKey: "k" }, { code: "doda", label: "DODA", mimeType: "text/plain", bytes: Buffer.from("x") }, fields, ok)).rejects.toThrow(/cannot read/);
    const bad = (async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })) as unknown as typeof fetch;
    await expect(extractWithModel({ apiKey: "k" }, { code: "doda", label: "DODA", mimeType: "application/pdf", bytes: Buffer.from("%PDF") }, fields, bad)).rejects.toThrow(/401.*invalid x-api-key/);
  });
});
