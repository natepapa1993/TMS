import { packetByToken, readBlob } from "@/domain/crossing";

export const dynamic = "force-dynamic";

/** The driver's packet PDF. Opening it is the acknowledgement. */
export async function GET(_req: Request, { params }: RouteContext<"/p/[token]">) {
  const { token } = await params;
  const p = await packetByToken(token);
  if (!p) return new Response("This packet link is not valid.", { status: 404 });
  const blob = await readBlob(p.ctx, p.crossing.packetStorageKey!);
  return new Response(new Uint8Array(blob.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="packet.pdf"`, "Cache-Control": "private, no-store" } });
}
