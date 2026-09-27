import { sqlClient } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await sqlClient`select 1`;
    return Response.json({ ok: true, db: "up", version: process.env.npm_package_version ?? "0.1.0" });
  } catch (e) {
    return Response.json({ ok: false, db: "down", error: (e as Error).message }, { status: 503 });
  }
}
