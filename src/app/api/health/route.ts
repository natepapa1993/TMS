import { sqlClient } from "@/db/client";

export const dynamic = "force-dynamic";

/** Liveness for Railway plus two counts an operator can read at a glance. No tenant data leaves. */
export async function GET() {
  try {
    const [row] = await sqlClient`select (select count(*)::int from tenants) as tenants, (select count(*)::int from orders) as orders`;
    return Response.json({ ok: true, db: "up", version: process.env.npm_package_version ?? "0.1.0", tenants: row.tenants, orders: row.orders });
  } catch (e) {
    return Response.json({ ok: false, db: "down", error: (e as Error).message }, { status: 503 });
  }
}
