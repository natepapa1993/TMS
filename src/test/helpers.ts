import { db, sqlClient } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { Ctx, Role } from "@/lib/context";

/** Wipe every tenant-owned table between test files. Cheap and deterministic. */
export async function truncateAll() {
  await sqlClient`
    do $$ declare r record;
    begin
      for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
        execute 'truncate table ' || quote_ident(r.tablename) || ' cascade';
      end loop;
    end $$;`;
}

export async function makeTenant(name = "Test Carrier", role: Role = "owner"): Promise<Ctx & { email: string }> {
  const tenantId = newId();
  const userId = newId();
  const email = `${userId}@test.local`;
  await db.insert(tenants).values({ id: tenantId, name, slug: `t-${tenantId}` });
  await db.insert(users).values({ id: userId, tenantId, email, name: `${role} user`, role });
  return { tenantId, userId, role, email };
}

export async function closeDb() {
  await sqlClient.end({ timeout: 2 });
}
