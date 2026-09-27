"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { integrations } from "@/db/schema";
import { newId } from "@/lib/ids";
import { act } from "@/lib/action";
import { requirePermission } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { pollMotive } from "@/integrations/motive";

const PROVIDERS = ["motive", "resend", "whatsapp", "extractor", "mailbox"] as const;
type Provider = (typeof PROVIDERS)[number];

export async function saveIntegrationAction(provider: Provider, enabled: boolean, config: Record<string, string>) {
  const r = await act(async (ctx) => {
    requirePermission(ctx, "settings.edit");
    if (!PROVIDERS.includes(provider)) throw Object.assign(new Error("unknown provider"), { name: "ValidationError" });
    const [existing] = await db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider))).limit(1);
    // blank secret fields keep the stored value (the form never shows secrets back)
    const merged: Record<string, string> = { ...(existing?.config ?? {}) };
    for (const [k, v] of Object.entries(config)) if (v.trim() !== "") merged[k] = v.trim();
    if (provider === "whatsapp" && !merged.webhookToken) merged.webhookToken = (await import("@/lib/tokens")).newToken(); // the webhook URL for this company, minted once
    if (provider === "whatsapp" && !merged.verifyToken) merged.verifyToken = (await import("@/lib/tokens")).newToken().slice(0, 16);
    if (provider === "mailbox" && !merged.inboundToken) merged.inboundToken = (await import("@/lib/tokens")).newToken(); // the inbound URL for this company, minted once
    if (provider === "mailbox" && merged.host) {
      const mail = await import("@/integrations/mail");
      const check: (c: Partial<import("@/integrations/mail").ImapConfig>) => void = mail.validateImap;
      check({ host: merged.host, user: merged.user, password: merged.password, port: merged.port ? Number(merged.port) : undefined });
    }
    if (existing) await db.update(integrations).set({ enabled, config: merged, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(integrations.id, existing.id));
    else await db.insert(integrations).values({ id: newId(), tenantId: ctx.tenantId, provider, enabled, config: merged, createdBy: ctx.userId, updatedBy: ctx.userId });
    await writeAudit(db, ctx, "integration", provider, existing ? "update" : "create", { enabled: { from: existing?.enabled ?? null, to: enabled }, keys: { from: Object.keys(existing?.config ?? {}), to: Object.keys(merged) } });
    return { ok: true };
  });
  if (r.ok) revalidatePath("/settings/integrations");
  return r;
}

export async function testMotiveAction() {
  return act(async (ctx) => {
    requirePermission(ctx, "settings.edit");
    const [row] = await db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, "motive"))).limit(1);
    if (!row?.config.apiKey) throw Object.assign(new Error("Save a Motive API key first"), { name: "ValidationError" });
    const r = await pollMotive(ctx.tenantId, row.config.apiKey);
    await db.update(integrations).set({ lastRunAt: new Date(), lastError: null, lastResult: JSON.stringify(r) }).where(eq(integrations.id, row.id));
    return r;
  });
}

export async function testWhatsAppAction(to: string) {
  return act(async (ctx) => {
    requirePermission(ctx, "settings.edit");
    const [row] = await db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, "whatsapp"))).limit(1);
    if (!row?.config.phoneNumberId || !row.config.accessToken) throw Object.assign(new Error("Save the phone number id and access token first"), { name: "ValidationError" });
    const { sendWhatsApp } = await import("@/integrations/whatsapp");
    const { templateFor } = await import("@/lib/outbox");
    const cfg = row.config as unknown as import("@/integrations/whatsapp").WaConfig;
    try {
      const r = await sendWhatsApp(cfg, to, "Crossline test message — your WhatsApp Business connection works.", templateFor(cfg, { kind: "general", template: { name: "", params: ["Crossline test message"] } }));
      await db.update(integrations).set({ lastRunAt: new Date(), lastError: null, lastResult: `test to ${to}: ${r.id}` }).where(eq(integrations.id, row.id));
      return r;
    } catch (e) {
      await db.update(integrations).set({ lastRunAt: new Date(), lastError: (e as Error).message }).where(eq(integrations.id, row.id));
      throw e;
    }
  });
}

/** Pull the IMAP mailbox now: proves the app password works and shows what came in. */
export async function pollMailboxNowAction() {
  const r = await act(async (ctx) => {
    requirePermission(ctx, "settings.edit");
    const { pollMail } = await import("@/domain/mail");
    const out = await pollMail(ctx.tenantId);
    if ("skipped" in out) throw Object.assign(new Error(out.reason ? "There is no IMAP host to pull from — this mailbox receives through the inbound URL" : "Save the mailbox with host, user and app password, and enable it"), { name: "ValidationError" });
    return out;
  });
  if (r.ok) {
    revalidatePath("/settings/integrations");
    revalidatePath("/messages");
  }
  return r;
}
