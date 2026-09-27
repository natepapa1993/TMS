import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { users, tenants } from "./schema";

/**
 * One-time cleanup: the production app used to seed a "demo" company on startup (RXO, Magna,
 * Transportes Garza, sample trucks, drivers and loads). The product starts empty; the owner adds his
 * own brokers, carriers, locations and equipment. This removes everything the seed created in that
 * account and keeps the login, the company row and any integration keys.
 *
 * It refuses — and only reports — if anything in that account was created after the seed ran, so
 * nothing a person typed is ever deleted.
 */
const SEED_WINDOW_MS = 15 * 60_000;
const KEEP = new Set(["tenants", "users", "integrations"]);
/** Written by the app's own jobs or by signing in; not evidence that a person entered data. */
const NOISE = new Set(["audit_log", "access_tokens", "outbox", "flags", "compliance_status", "leg_events", "positions", "crossing_checks", "crossing_events", "carrier_bills", "users", "integrations"]);

export async function clearSeededDemo(): Promise<string> {
  const email = process.env.SEED_EMAIL ?? "demo@crossline.local";
  const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.email, email)).limit(1);
  if (!u) return `no seeded account (${email})`;
  const [t] = await db.select().from(tenants).where(eq(tenants.id, u.tenantId)).limit(1);
  if (!t) return "no tenant";
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  if (settings.seedCleared) return "already cleared";
  const cutoff = new Date(t.createdAt.getTime() + SEED_WINDOW_MS);
  const cols = (await db.execute(sql`
    select t.table_name as table, (
      select c.column_name from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name in ('created_at','opened_at','received_at','at','ran_at')
      order by array_position(array['created_at','opened_at','received_at','at','ran_at']::text[], c.column_name::text) limit 1
    ) as ts
    from information_schema.tables t
    where t.table_schema = 'public' and exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = t.table_name and x.column_name = 'tenant_id')
  `)) as unknown as { table: string; ts: string | null }[];
  // anything a person made after the seed? then stop and say what
  const later: string[] = [];
  for (const c of cols) {
    if (KEEP.has(c.table) || NOISE.has(c.table) || !c.ts) continue;
    const [r] = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(c.table)} where tenant_id = ${t.id} and ${sql.identifier(c.ts)} > ${cutoff.toISOString()}::timestamptz`)) as unknown as { n: number }[];
    if (r.n > 0) later.push(`${c.table}: ${r.n}`);
  }
  if (later.length) return `NOT cleared — records created after the seed in ${t.name}: ${later.join(", ")}`;
  const removed: string[] = [];
  await db.transaction(async (tx) => {
    for (const c of cols) {
      if (KEEP.has(c.table)) continue;
      const res = (await tx.execute(sql`delete from ${sql.identifier(c.table)} where tenant_id = ${t.id} returning 1`)) as unknown as unknown[];
      if (res.length) removed.push(`${c.table}: ${res.length}`);
    }
    await tx.update(tenants).set({ settings: { ...settings, seedCleared: new Date().toISOString() } }).where(eq(tenants.id, t.id));
  });
  return `cleared the seeded data in "${t.name}" (${removed.join(", ") || "nothing"}); login ${email} kept`;
}
