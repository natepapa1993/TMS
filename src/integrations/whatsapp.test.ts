// Features: F-4.2 WhatsApp Business — phone normalization, Cloud API payloads, webhook parsing, signatures
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { normalizePhone, messagePayload, sendWhatsApp, parseWebhook, verifySignature } from "./whatsapp";

describe("whatsapp", () => {
  it("normalizes US and Mexican numbers to digits WhatsApp accepts", () => {
    expect(normalizePhone("+1 (313) 555-0100")).toBe("13135550100");
    expect(normalizePhone("313.555.0100")).toBe("13135550100");
    expect(normalizePhone("+52 867 111 2222")).toBe("528671112222");
    expect(normalizePhone("+52 1 867 111 2222")).toBe("528671112222");
    expect(normalizePhone("driver")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("plain text inside the window, an approved template with body params outside it", () => {
    expect(messagePayload("13135550100", "hi")).toEqual({ messaging_product: "whatsapp", to: "13135550100", type: "text", text: { preview_url: true, body: "hi" } });
    const p = messagePayload("13135550100", "ignored", { name: "load_offer", params: ["Garza", "MTY → Laredo", "USD 450.00", "https://x/t/abc"] }, "es_MX");
    expect(p.type).toBe("template");
    expect(p.template).toEqual({ name: "load_offer", language: { code: "es_MX" }, components: [{ type: "body", parameters: [{ type: "text", text: "Garza" }, { type: "text", text: "MTY → Laredo" }, { type: "text", text: "USD 450.00" }, { type: "text", text: "https://x/t/abc" }] }] });
  });

  it("sends through the Graph API with the bearer token and returns the message id; API errors surface", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchOk = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.HBg" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendWhatsApp({ phoneNumberId: "1234", accessToken: "tok" }, "+1 313 555 0100", "hello", null, fetchOk);
    expect(r.id).toBe("wamid.HBg");
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/1234/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body as string).to).toBe("13135550100");
    const fetchBad = (async () => new Response(JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030 } }), { status: 400 })) as unknown as typeof fetch;
    await expect(sendWhatsApp({ phoneNumberId: "1234", accessToken: "tok" }, "+1 313 555 0100", "hello", null, fetchBad)).rejects.toThrow(/131030/);
    await expect(sendWhatsApp({ phoneNumberId: "1234", accessToken: "tok" }, "driver", "hello", null, fetchOk)).rejects.toThrow(/not a phone number/);
  });

  it("parses statuses and inbound messages (text, button, location) out of a webhook body; skips junk", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "528671112222", profile: { name: "Benjamín" } }],
                messages: [
                  { id: "wamid.in1", from: "528671112222", timestamp: "1790000000", type: "text", text: { body: "cargado, saliendo" } },
                  { id: "wamid.in2", from: "528671112222", timestamp: "1790000100", type: "location", location: { latitude: 27.5, longitude: -99.5 } },
                  { from: "x" },
                ],
                statuses: [
                  { id: "wamid.out1", status: "delivered", timestamp: "1790000050" },
                  { id: "wamid.out2", status: "failed", timestamp: "1790000060", errors: [{ title: "Message undeliverable", message: "number not on WhatsApp" }] },
                  { id: "wamid.out3", status: "weird" },
                ],
              },
            },
          ],
        },
      ],
    };
    const p = parseWebhook(body);
    expect(p.messages.map((m) => [m.providerId, m.name, m.text])).toEqual([
      ["wamid.in1", "Benjamín", "cargado, saliendo"],
      ["wamid.in2", "Benjamín", "location 27.5,-99.5"],
    ]);
    expect(p.messages[0].at.toISOString()).toBe("2026-09-21T14:13:20.000Z");
    expect(p.statuses.map((s) => [s.providerId, s.status, s.error])).toEqual([
      ["wamid.out1", "delivered", null],
      ["wamid.out2", "failed", "number not on WhatsApp"],
    ]);
    expect(parseWebhook(null)).toEqual({ statuses: [], messages: [] });
    expect(parseWebhook({ entry: "nope" })).toEqual({ statuses: [], messages: [] });
  });

  it("checks the X-Hub-Signature-256 header against the app secret", () => {
    const raw = '{"entry":[]}';
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("hex");
    expect(verifySignature("s3cret", raw, sig)).toBe(true);
    expect(verifySignature("other", raw, sig)).toBe(false);
    expect(verifySignature("s3cret", raw + " ", sig)).toBe(false);
    expect(verifySignature("s3cret", raw, null)).toBe(false);
    expect(verifySignature("s3cret", raw, "sha256=zz")).toBe(false);
  });
});
