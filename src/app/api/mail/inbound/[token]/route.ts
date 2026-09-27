import { integrationByInboundToken, receiveRawEmail } from "@/domain/mail";

export const dynamic = "force-dynamic";

/**
 * The company's inbound email URL: whatever forwards dispatch@ here (Cloudflare Email Routing, a Mailgun
 * route, Postmark or SES inbound) POSTs the raw message. Accepted as the body itself (message/rfc822 or
 * text), as multipart with a `email` / `body-mime` / `message` file or field (Mailgun, SendGrid), or as
 * JSON {"raw": "<mime>"} / {"rawEmail": ...}. The token in the URL picks the company.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/mail/inbound/[token]">) {
  const { token } = await ctx.params;
  const integration = await integrationByInboundToken(token);
  if (!integration) return new Response("unknown", { status: 404 });
  const type = req.headers.get("content-type") ?? "";
  let raw: Buffer | null = null;
  try {
    if (type.startsWith("multipart/form-data")) {
      const form = await req.formData();
      for (const key of ["email", "body-mime", "message", "raw", "rawEmail"]) {
        const v = form.get(key);
        if (v instanceof File) raw = Buffer.from(await v.arrayBuffer());
        else if (typeof v === "string" && v.length) raw = Buffer.from(v);
        if (raw) break;
      }
    } else if (type.includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      const v = j.raw ?? j.rawEmail ?? j.email ?? j.message;
      if (typeof v === "string") raw = Buffer.from(v);
    } else raw = Buffer.from(await req.arrayBuffer());
  } catch (e) {
    return new Response(`could not read the message: ${(e as Error).message}`, { status: 400 });
  }
  if (!raw?.length) return new Response("no message in the request", { status: 400 });
  if (raw.length > 30 * 1024 * 1024) return new Response("message over 30 MB", { status: 413 });
  try {
    const r = await receiveRawEmail(integration.tenantId, raw, "http");
    return Response.json({ id: r.id, duplicate: r.duplicate, kind: "kind" in r ? r.kind : undefined });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
