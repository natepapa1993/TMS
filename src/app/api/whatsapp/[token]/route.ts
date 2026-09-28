import { integrationByWebhookToken, verifyChallenge, receiveWhatsAppWebhook } from "@/domain/messaging";

export const dynamic = "force-dynamic";

/** Meta's webhook for one company: the token in the URL picks the company; the verify token and app secret are on its integration. */
export async function GET(req: Request, ctx: RouteContext<"/api/whatsapp/[token]">) {
  const { token } = await ctx.params;
  const integration = await integrationByWebhookToken(token);
  if (!integration) return new Response("unknown", { status: 404 });
  const challenge = verifyChallenge(integration.config, new URL(req.url).searchParams);
  return challenge ? new Response(challenge, { headers: { "content-type": "text/plain" } }) : new Response("verify token mismatch", { status: 403 });
}

export async function POST(req: Request, ctx: RouteContext<"/api/whatsapp/[token]">) {
  const { token } = await ctx.params;
  const integration = await integrationByWebhookToken(token);
  if (!integration) return new Response("unknown", { status: 404 });
  const raw = await req.text();
  try {
    const r = await receiveWhatsAppWebhook(integration, raw, req.headers.get("x-hub-signature-256"));
    return Response.json(r);
  } catch (e) {
    const msg = (e as Error).message;
    return new Response(msg, { status: msg === "bad signature" ? 401 : 400 });
  }
}
