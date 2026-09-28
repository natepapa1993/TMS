import { receiveInterchange, partnerByToken } from "@/domain/edi";
import { db } from "@/db/client";
import { ediMessages } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * The partner (or their VAN / AS2 gateway) POSTs an X12 interchange here. The token in the URL is the only
 * authorization and identifies the partner; the ISA sender must still match. The 997 comes back in the body.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/edi/inbound/[token]">) {
  const { token } = await ctx.params;
  const partner = await partnerByToken(token);
  if (!partner) return new Response("unknown partner", { status: 404 });
  const text = await req.text();
  if (!text.trim()) return new Response("empty body", { status: 400 });
  try {
    const r = await receiveInterchange(partner.id, text, { via: "http" });
    const ack = r.ackId ? (await db.select({ content: ediMessages.content }).from(ediMessages).where(eq(ediMessages.id, r.ackId)).limit(1))[0]?.content : null;
    const ok = r.sets.every((x) => x.ok);
    return new Response(ack ?? JSON.stringify(r.sets), { status: ok ? 200 : 202, headers: { "content-type": ack ? "application/edi-x12" : "application/json", "x-edi-result": r.sets.map((x) => `${x.type}:${x.ok ? "A" : "R"}`).join(",") } });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}

export async function GET() {
  return new Response("POST an X12 interchange to this URL", { status: 405 });
}
