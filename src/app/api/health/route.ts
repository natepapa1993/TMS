import { sqlClient } from "@/db/client";

export const dynamic = "force-dynamic";

/** Liveness for Railway. Public, so it says only whether the app and its database answer. */
export async function GET() {
  try {
    await sqlClient`select 1`;
    return Response.json({ ok: true, db: "up", version: process.env.npm_package_version ?? "0.1.0" });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
