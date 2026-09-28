import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, requirePermission, type Ctx } from "@/lib/context";
import { writeAudit } from "@/lib/audit";
import { openSftp, validateMailbox, isInterchangeFile, type BoxOpener } from "@/integrations/edi/mailbox";
import { receiveInterchange } from "./edi";
import { NotFoundError, ValidationError } from "./orders";

/**
 * VAN mailbox polling (spec Phase 3 "EDI VAN"): pull every interchange the partner dropped in the inbox and
 * run it through the same path as an HTTP POST (997 back, 204 → draft order, 990), then push everything we
 * generated that has not left yet (214, 210, 997, 990) into the outbox. Files we read move to inbox/done or
 * inbox/failed so nothing is read twice; the interchange control number is the second guard.
 */

const DONE = "done";
const FAILED = "failed";
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

/** Save the mailbox on a partner. Blank password / key keep what is stored (the form never shows them back). */
export async function saveMailbox(ctx: Ctx, partnerId: string, input: Partial<s.EdiMailbox> & { enabled: boolean }) {
  assertCtx(ctx);
  requirePermission(ctx, "settings.edit");
  const [p] = await db.select().from(s.ediPartners).where(and(eq(s.ediPartners.tenantId, ctx.tenantId), eq(s.ediPartners.id, partnerId))).limit(1);
  if (!p) throw new NotFoundError("EDI partner", partnerId);
  const prev = p.mailbox ?? null;
  const next: s.EdiMailbox = {
    enabled: input.enabled,
    host: (input.host ?? prev?.host ?? "").trim(),
    port: Number(input.port ?? prev?.port ?? 22) || 22,
    username: (input.username ?? prev?.username ?? "").trim(),
    password: input.password?.trim() ? input.password.trim() : (prev?.password ?? null),
    privateKey: input.privateKey?.trim() ? input.privateKey.trim() : (prev?.privateKey ?? null),
    inbox: (input.inbox ?? prev?.inbox ?? "").trim(),
    outbox: (input.outbox ?? prev?.outbox ?? "").trim(),
    extension: (input.extension ?? prev?.extension ?? ".edi") || ".edi",
    lastPollAt: prev?.lastPollAt ?? null,
    lastError: prev?.lastError ?? null,
    lastPulled: prev?.lastPulled ?? 0,
    lastPushed: prev?.lastPushed ?? 0,
  };
  if (next.enabled) {
    const problem = validateMailbox(next);
    if (problem) throw new ValidationError(problem, problem.split(" ")[0]);
  }
  await db.update(s.ediPartners).set({ mailbox: next, updatedAt: new Date(), updatedBy: ctx.userId }).where(eq(s.ediPartners.id, partnerId));
  await writeAudit(db, ctx, "ediPartner", partnerId, "update", { mailbox: { from: prev ? `${prev.username}@${prev.host}${prev.enabled ? "" : " (off)"}` : null, to: `${next.username}@${next.host}${next.enabled ? "" : " (off)"}` } });
  return publicMailbox(next);
}

/** The mailbox as the screen may see it: secrets replaced by whether they are set. */
export function publicMailbox(m: s.EdiMailbox | null | undefined) {
  if (!m) return null;
  const { password, privateKey, ...rest } = m;
  return { ...rest, hasPassword: !!password, hasPrivateKey: !!privateKey };
}

/** Connect and list the inbox: proves host, credentials and the directory in one go. */
export async function testMailbox(ctx: Ctx, partnerId: string, open: BoxOpener = openSftp) {
  assertCtx(ctx);
  requirePermission(ctx, "settings.edit");
  const [p] = await db.select().from(s.ediPartners).where(and(eq(s.ediPartners.tenantId, ctx.tenantId), eq(s.ediPartners.id, partnerId))).limit(1);
  if (!p?.mailbox) throw new ValidationError("save the mailbox first");
  const problem = validateMailbox(p.mailbox);
  if (problem) throw new ValidationError(problem);
  const box = await open(p.mailbox);
  try {
    const files = (await box.list(p.mailbox.inbox)).filter((f) => !f.isDir && isInterchangeFile(f.name, f.size));
    return { ok: true, waiting: files.length, sample: files.slice(0, 5).map((f) => f.name) };
  } finally {
    await box.end().catch(() => null);
  }
}

export type PollResult = { partnerId: string; pulled: number; failed: number; pushed: number; errors: string[] };

/** One partner: pull, then push. Never throws for a bad file; a bad connection is recorded on the mailbox and rethrown. */
export async function pollMailbox(partnerId: string, open: BoxOpener = openSftp, now = new Date()): Promise<PollResult> {
  const [p] = await db.select().from(s.ediPartners).where(eq(s.ediPartners.id, partnerId)).limit(1);
  if (!p || !p.enabled || p.archivedAt) throw new NotFoundError("EDI partner", partnerId);
  const m = p.mailbox;
  if (!m?.enabled) throw new ValidationError("the mailbox is not enabled on this partner");
  const problem = validateMailbox(m);
  if (problem) throw new ValidationError(problem);
  const result: PollResult = { partnerId, pulled: 0, failed: 0, pushed: 0, errors: [] };
  let box;
  try {
    box = await open(m);
  } catch (e) {
    await db.update(s.ediPartners).set({ mailbox: { ...m, lastPollAt: now.toISOString(), lastError: `connect: ${(e as Error).message}` } }).where(eq(s.ediPartners.id, p.id));
    throw e;
  }
  try {
    // ---- pull
    const files = (await box.list(m.inbox)).filter((f) => !f.isDir && isInterchangeFile(f.name, f.size)).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length) {
      await box.mkdir(join(m.inbox, DONE)).catch(() => null);
      await box.mkdir(join(m.inbox, FAILED)).catch(() => null);
    }
    for (const f of files) {
      const path = join(m.inbox, f.name);
      let text: string;
      try {
        text = await box.get(path);
      } catch (e) {
        result.errors.push(`${f.name}: ${(e as Error).message}`);
        continue;
      }
      try {
        await receiveInterchange(p.id, text, { via: "sftp" });
        result.pulled++;
        await box.rename(path, join(join(m.inbox, DONE), f.name)).catch((e) => result.errors.push(`${f.name}: read, but could not move to ${DONE}/: ${(e as Error).message}`));
      } catch (e) {
        result.failed++;
        result.errors.push(`${f.name}: ${(e as Error).message}`);
        await box.rename(path, join(join(m.inbox, FAILED), f.name)).catch(() => null);
      }
    }
    // ---- push: everything generated for this partner that has not left (incl. the 997s the pull just made)
    if (p.delivery === "sftp") {
      const pending = await db
        .select()
        .from(s.ediMessages)
        .where(and(eq(s.ediMessages.partnerId, p.id), eq(s.ediMessages.direction, "out"), inArray(s.ediMessages.state, ["logged", "queued"])))
        .orderBy(s.ediMessages.createdAt)
        .limit(500);
      for (const msg of pending) {
        const name = `${msg.type}_${p.ourId}_${msg.controlNumber ?? msg.id}${m.extension ?? ".edi"}`;
        const final = join(m.outbox, name);
        const tmp = join(m.outbox, `.${name}.part`);
        try {
          await box.put(tmp, msg.content);
          await box.rename(tmp, final); // the VAN never sees a half-written file
          await db.update(s.ediMessages).set({ state: "sent", error: null }).where(eq(s.ediMessages.id, msg.id));
          result.pushed++;
        } catch (e) {
          result.errors.push(`${name}: ${(e as Error).message}`);
          await db.update(s.ediMessages).set({ error: `sftp: ${(e as Error).message}` }).where(eq(s.ediMessages.id, msg.id));
        }
      }
    }
  } finally {
    await box.end().catch(() => null);
  }
  await db
    .update(s.ediPartners)
    .set({ mailbox: { ...m, lastPollAt: now.toISOString(), lastError: result.errors.length ? result.errors.slice(0, 3).join(" · ") : null, lastPulled: result.pulled, lastPushed: result.pushed }, ...(result.pushed ? { lastOutboundAt: now } : {}) })
    .where(eq(s.ediPartners.id, p.id));
  return result;
}

/** Job: every partner with a mailbox switched on, all tenants. One bad partner never stops the others. */
export async function pollMailboxes(open: BoxOpener = openSftp, now = new Date()) {
  const partners = await db
    .select({ id: s.ediPartners.id })
    .from(s.ediPartners)
    .where(and(eq(s.ediPartners.enabled, true), sql`${s.ediPartners.archivedAt} is null`, sql`(${s.ediPartners.mailbox} ->> 'enabled')::boolean = true`));
  const out: (PollResult | { partnerId: string; error: string })[] = [];
  for (const p of partners) {
    try {
      out.push(await pollMailbox(p.id, open, now));
    } catch (e) {
      out.push({ partnerId: p.id, error: (e as Error).message });
    }
  }
  return out;
}
