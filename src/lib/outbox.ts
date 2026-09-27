import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { outbox, integrations } from "@/db/schema";
import { newId } from "./ids";
import type { Ctx } from "./context";

/**
 * Every outbound message is a row first (spec §4.2, §9.3): queued → sent | failed | logged.
 * Email goes through Resend when a key is configured (tenant integration or RESEND_API_KEY);
 * without one it is "logged" so the flow still works end to end in dev and tests.
 */

export type OutboundMessage = { channel: "email" | "whatsapp" | "sms"; to: string; subject?: string; body: string; html?: string; subjectKind?: string; subjectId?: string };

export async function enqueue(ctx: Ctx, m: OutboundMessage, tx: Tx | typeof db = db) {
  const [row] = await tx
    .insert(outbox)
    .values({ id: newId(), tenantId: ctx.tenantId, channel: m.channel, to: m.to, subject: m.subject, body: m.body, html: m.html, subjectKind: m.subjectKind, subjectId: m.subjectId, createdBy: ctx.userId })
    .returning();
  return row;
}

type Provider = { send(m: { to: string; subject: string; text: string; html?: string; from: string }): Promise<{ id: string }> };

async function resendFor(tenantId: string): Promise<{ provider: Provider; from: string } | null> {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.tenantId, tenantId), eq(integrations.provider, "resend"))).limit(1);
  const key = row?.enabled ? row.config.apiKey : process.env.RESEND_API_KEY;
  const from = row?.config.from || process.env.EMAIL_FROM || "";
  if (!key || !from) return null;
  return {
    from,
    provider: {
      async send(m) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        });
        if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return (await res.json()) as { id: string };
      },
    },
  };
}

/** Deliver up to `limit` queued messages. Called by the job ticker and right after enqueue. */
export async function deliverQueued(limit = 25) {
  const rows = await db.select().from(outbox).where(and(eq(outbox.state, "queued"), lt(outbox.attempts, 5))).orderBy(outbox.createdAt).limit(limit);
  let sent = 0;
  let logged = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      if (m.channel !== "email") throw new Error(`${m.channel} is not wired yet`);
      const r = await resendFor(m.tenantId);
      if (!r) {
        console.log(`[outbox:logged] to=${m.to} subject=${m.subject}\n${m.body}`);
        await db.update(outbox).set({ state: "logged", sentAt: new Date(), attempts: sql`${outbox.attempts} + 1` }).where(eq(outbox.id, m.id));
        logged++;
        continue;
      }
      const { id } = await r.provider.send({ to: m.to, subject: m.subject ?? "", text: m.body, html: m.html ?? undefined, from: r.from });
      await db.update(outbox).set({ state: "sent", providerId: id, sentAt: new Date(), attempts: sql`${outbox.attempts} + 1` }).where(eq(outbox.id, m.id));
      sent++;
    } catch (e) {
      await db.update(outbox).set({ state: m.attempts + 1 >= 5 ? "failed" : "queued", error: (e as Error).message.slice(0, 500), attempts: sql`${outbox.attempts} + 1` }).where(eq(outbox.id, m.id));
      failed++;
    }
  }
  return { sent, logged, failed };
}
