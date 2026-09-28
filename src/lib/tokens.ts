import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { accessTokens, type TokenKind } from "@/db/schema";
import { assertCtx, systemCtx, type Ctx } from "./context";
import { randomBytes } from "node:crypto";

/**
 * Login-free links (spec §5.2 driver app, §5.4 tracking link, §4.2 carrier portal).
 * A token is long, random, revocable, and resolves to exactly one tenant + subject.
 */
export const newToken = () => randomBytes(24).toString("base64url");

export async function issueToken(ctx: Ctx, kind: TokenKind, subjectId: string, opts: { label?: string; expiresAt?: Date | null; reuse?: boolean } = {}, tx: Tx | typeof db = db) {
  assertCtx(ctx);
  if (opts.reuse !== false) {
    const [existing] = await tx
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.tenantId, ctx.tenantId), eq(accessTokens.kind, kind), eq(accessTokens.subjectId, subjectId), isNull(accessTokens.revokedAt), sql`(${accessTokens.expiresAt} is null or ${accessTokens.expiresAt} > now())`))
      .limit(1);
    if (existing) return existing;
  }
  const [row] = await tx
    .insert(accessTokens)
    .values({ id: newToken().slice(0, 16), tenantId: ctx.tenantId, kind, subjectId, token: newToken(), label: opts.label, expiresAt: opts.expiresAt ?? null, createdBy: ctx.userId })
    .returning();
  return row;
}

export async function revokeToken(ctx: Ctx, tokenId: string) {
  assertCtx(ctx);
  await db.update(accessTokens).set({ revokedAt: new Date() }).where(and(eq(accessTokens.tenantId, ctx.tenantId), eq(accessTokens.id, tokenId)));
}

export async function revokeTokensFor(ctx: Ctx, kind: TokenKind, subjectId: string) {
  assertCtx(ctx);
  await db.update(accessTokens).set({ revokedAt: new Date() }).where(and(eq(accessTokens.tenantId, ctx.tenantId), eq(accessTokens.kind, kind), eq(accessTokens.subjectId, subjectId), isNull(accessTokens.revokedAt)));
}

/** Resolve a public token to its tenant + subject, or null. Counts the use. */
export async function resolveToken(token: string, kind?: TokenKind): Promise<{ ctx: Ctx; kind: TokenKind; subjectId: string; id: string } | null> {
  if (!token || token.length < 16) return null;
  const [row] = await db.select().from(accessTokens).where(eq(accessTokens.token, token)).limit(1);
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < Date.now())) return null;
  if (kind && row.kind !== kind) return null;
  await db.update(accessTokens).set({ lastUsedAt: new Date(), uses: sql`${accessTokens.uses} + 1` }).where(eq(accessTokens.id, row.id));
  return { ctx: systemCtx(row.tenantId), kind: row.kind, subjectId: row.subjectId, id: row.id };
}

export function publicUrl(path: string) {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}${path}`;
}
