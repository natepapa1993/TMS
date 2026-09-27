import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Business (Meta Cloud API). Per-tenant credentials live in the integrations table
 * (Settings → Integrations), never in code. Outside the 24-hour customer-service window Meta only
 * delivers approved templates, so each message kind can name a template; plain text is used otherwise.
 * Docs: POST https://graph.facebook.com/v21.0/{phone-number-id}/messages
 */

export type WaConfig = { phoneNumberId: string; accessToken: string; verifyToken?: string; appSecret?: string; webhookToken?: string; templateLanguage?: string; tenderTemplate?: string; packetTemplate?: string; trackingTemplate?: string; generalTemplate?: string };

export const GRAPH = "https://graph.facebook.com/v21.0";

/** Digits only, with the US country code added to a bare 10-digit number. Mexican numbers keep their 52. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10) d = `1${d}`;
  if (d.length === 11 && d.startsWith("1")) return d;
  if (d.length === 12 && d.startsWith("52")) return d;
  if (d.length === 13 && d.startsWith("521")) return `52${d.slice(3)}`; // legacy mobile prefix
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export type Template = { name: string; language?: string; params: string[] };

export function messagePayload(to: string, text: string, template?: Template | null, defaultLanguage = "en_US") {
  if (template?.name) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: template.name, language: { code: template.language ?? defaultLanguage }, components: template.params.length ? [{ type: "body", parameters: template.params.map((p) => ({ type: "text", text: p.replace(/[\n\t]+/g, " ").slice(0, 1024) })) }] : [] },
    };
  }
  return { messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body: text.slice(0, 4096) } };
}

export async function sendWhatsApp(cfg: WaConfig, to: string, text: string, template?: Template | null, fetchImpl: typeof fetch = fetch): Promise<{ id: string }> {
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`"${to}" is not a phone number WhatsApp can reach`);
  const res = await fetchImpl(`${GRAPH}/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(messagePayload(phone, text, template, cfg.templateLanguage || "en_US")),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
  if (!res.ok || !json.messages?.[0]?.id) throw new Error(`whatsapp ${res.status}: ${json.error?.message ?? "no message id"}`);
  return { id: json.messages[0].id };
}

/** X-Hub-Signature-256 check on the raw webhook body. */
export function verifySignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export type WebhookStatus = { providerId: string; status: "sent" | "delivered" | "read" | "failed"; at: Date; error: string | null };
export type WebhookMessage = { providerId: string; from: string; name: string | null; at: Date; text: string; type: string };

/** Pure: the statuses and inbound messages in a webhook body. Unknown shapes are skipped, never thrown. */
export function parseWebhook(body: unknown): { statuses: WebhookStatus[]; messages: WebhookMessage[] } {
  const out = { statuses: [] as WebhookStatus[], messages: [] as WebhookMessage[] };
  const entries = (body as { entry?: { changes?: { value?: Record<string, unknown> }[] }[] })?.entry ?? [];
  for (const e of entries)
    for (const c of e.changes ?? []) {
      const v = c.value ?? {};
      const contacts = (v.contacts as { wa_id?: string; profile?: { name?: string } }[] | undefined) ?? [];
      for (const st of (v.statuses as { id?: string; status?: string; timestamp?: string; errors?: { title?: string; message?: string }[] }[] | undefined) ?? []) {
        if (!st.id || !st.status) continue;
        const status = st.status === "sent" || st.status === "delivered" || st.status === "read" || st.status === "failed" ? st.status : null;
        if (!status) continue;
        out.statuses.push({ providerId: st.id, status, at: new Date(Number(st.timestamp ?? 0) * 1000 || Date.now()), error: st.errors?.[0]?.message ?? st.errors?.[0]?.title ?? null });
      }
      for (const m of (v.messages as { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }; location?: { latitude?: number; longitude?: number } }[] | undefined) ?? []) {
        if (!m.id || !m.from) continue;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? (m.location ? `location ${m.location.latitude},${m.location.longitude}` : `[${m.type ?? "message"}]`);
        out.messages.push({ providerId: m.id, from: m.from, name: contacts.find((x) => x.wa_id === m.from)?.profile?.name ?? null, at: new Date(Number(m.timestamp ?? 0) * 1000 || Date.now()), text, type: m.type ?? "text" });
      }
    }
  return out;
}
