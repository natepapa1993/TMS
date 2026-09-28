import { and, eq, isNull, isNotNull, sql, desc, count, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertCtx, requirePermission, can, PermissionError, type Ctx } from "@/lib/context";
import { writeAudit, diff } from "@/lib/audit";
import { FIELDS } from "./fields";
import { syncDocumentTypeLevel } from "@/domain/compliance-rules";

/**
 * Generic master-data repository (spec §1.1–1.4). One registry entry per record type:
 * table, unique key for import de-duplication, human label, and the "open reference" check
 * that blocks archiving (spec §1.4).
 */

export type RecordKind =
  | "billingEntity"
  | "user"
  | "location"
  | "port"
  | "customer"
  | "customsBroker"
  | "carrier"
  | "carrierRate"
  | "customerRate"
  | "truck"
  | "trailer"
  | "driver"
  | "documentType"
  | "ediPartner";

type AnyTable = PgTable & { id: unknown; tenantId: unknown; archivedAt: unknown; updatedAt: unknown; updatedBy: unknown; createdBy: unknown };

type Registry = {
  table: AnyTable;
  label: string;
  uniqueKey: string[]; // fields that identify a duplicate on import
  labelField: string;
  blockers?: (ctx: Ctx, id: string) => Promise<{ kind: string; id: string; label: string }[]>;
};

const openOrderStates = ["draft", "booked", "dispatched", "in_transit", "exception"] as const;

async function openLegsFor(ctx: Ctx, column: "truck_id" | "driver_id" | "carrier_id" | "trailer_id", id: string) {
  const rows = await db
    .select({ id: s.legs.id, orderId: s.legs.orderId, state: s.legs.state, orderNumber: s.orders.orderNumber })
    .from(s.legs)
    .innerJoin(s.orders, eq(s.orders.id, s.legs.orderId))
    .where(and(eq(s.legs.tenantId, ctx.tenantId), sql`${sql.identifier(column)} = ${id}`, sql`${s.legs.state} not in ('completed','cancelled')`))
    .limit(20);
  return rows.map((r) => ({ kind: "leg", id: r.id, label: `${r.orderNumber} (${r.state})` }));
}

async function openOrdersFor(ctx: Ctx, column: "customer_id" | "broker_id" | "billing_entity_id", id: string) {
  const rows = await db
    .select({ id: s.orders.id, orderNumber: s.orders.orderNumber, state: s.orders.state })
    .from(s.orders)
    .where(and(eq(s.orders.tenantId, ctx.tenantId), sql`${sql.identifier(column)} = ${id}`, sql`${s.orders.state} in (${sql.join(openOrderStates.map((x) => sql`${x}`), sql`, `)})`))
    .limit(20);
  return rows.map((r) => ({ kind: "order", id: r.id, label: `${r.orderNumber} (${r.state})` }));
}

export const REGISTRY: Record<RecordKind, Registry> = {
  billingEntity: { table: s.billingEntities as AnyTable, label: "Billing entity", uniqueKey: ["taxId"], labelField: "legalName", blockers: (ctx, id) => openOrdersFor(ctx, "billing_entity_id", id) },
  user: { table: s.users as AnyTable, label: "User", uniqueKey: ["email"], labelField: "name" },
  location: { table: s.locations as AnyTable, label: "Location", uniqueKey: ["name"], labelField: "name" },
  port: { table: s.ports as AnyTable, label: "Port of entry", uniqueKey: ["name"], labelField: "name" },
  customer: { table: s.customers as AnyTable, label: "Customer", uniqueKey: ["name", "country"], labelField: "name", blockers: async (ctx, id) => [...(await openOrdersFor(ctx, "customer_id", id)), ...(await openOrdersFor(ctx, "broker_id", id))] },
  customsBroker: { table: s.customsBrokers as AnyTable, label: "Customs broker", uniqueKey: ["name", "country"], labelField: "name" },
  carrier: { table: s.carriers as AnyTable, label: "Carrier", uniqueKey: ["mcNumber", "rfc"], labelField: "name", blockers: (ctx, id) => openLegsFor(ctx, "carrier_id", id) },
  carrierRate: { table: s.carrierRates as AnyTable, label: "Carrier rate", uniqueKey: ["carrierId", "originZone", "destinationZone", "equipment"], labelField: "id" },
  customerRate: { table: s.customerRates as AnyTable, label: "Customer rate", uniqueKey: ["customerId", "originZone", "destinationZone", "equipment"], labelField: "id" },
  truck: { table: s.trucks as AnyTable, label: "Truck", uniqueKey: ["unitNumber"], labelField: "unitNumber", blockers: (ctx, id) => openLegsFor(ctx, "truck_id", id) },
  trailer: { table: s.trailers as AnyTable, label: "Trailer", uniqueKey: ["unitNumber"], labelField: "unitNumber", blockers: (ctx, id) => openLegsFor(ctx, "trailer_id", id) },
  driver: { table: s.drivers as AnyTable, label: "Driver", uniqueKey: ["licenseNumber"], labelField: "name", blockers: (ctx, id) => openLegsFor(ctx, "driver_id", id) },
  documentType: { table: s.documentTypes as AnyTable, label: "Document type", uniqueKey: ["name", "appliesTo"], labelField: "name" },
  ediPartner: { table: s.ediPartners as AnyTable, label: "EDI partner", uniqueKey: ["customerId"], labelField: "theirId" },
};

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class ArchiveBlockedError extends Error {
  constructor(public blockers: { kind: string; id: string; label: string }[]) {
    super(`cannot archive: referenced by ${blockers.length} open record(s)`);
    this.name = "ArchiveBlockedError";
  }
}

export class ConflictError extends Error {
  constructor(msg = "record was changed by someone else since you opened it") {
    super(msg);
    this.name = "ConflictError";
  }
}

type Row = Record<string, unknown> & { id: string; archivedAt: Date | null; updatedAt: Date };

export async function list(ctx: Ctx, kind: RecordKind, opts: { archived?: "active" | "archived" | "all"; limit?: number } = {}): Promise<Row[]> {
  assertCtx(ctx);
  requirePermission(ctx, "records.view");
  const { table } = REGISTRY[kind];
  const scope = opts.archived === "archived" ? isNotNull(table.archivedAt as never) : opts.archived === "all" ? undefined : isNull(table.archivedAt as never);
  const rows = await db
    .select()
    .from(table)
    .where(scope ? and(eq(table.tenantId as never, ctx.tenantId), scope) : eq(table.tenantId as never, ctx.tenantId))
    .orderBy(desc(table.updatedAt as never))
    .limit(opts.limit ?? 500);
  return rows.map(strip) as Row[];
}

/** Secrets never leave the data layer (the user record's password hash is only ever compared in auth). */
function strip<T extends Record<string, unknown>>(row: T): T {
  if ("passwordHash" in row) {
    const { passwordHash: _omit, ...rest } = row;
    void _omit;
    return rest as T;
  }
  return row;
}

export async function get(ctx: Ctx, kind: RecordKind, id: string): Promise<Row> {
  assertCtx(ctx);
  requirePermission(ctx, "records.view");
  const { table } = REGISTRY[kind];
  const [row] = await db.select().from(table).where(and(eq(table.tenantId as never, ctx.tenantId), eq(table.id as never, id))).limit(1);
  if (!row) throw new NotFoundError(kind, id);
  return strip(row as Record<string, unknown>) as Row;
}

/**
 * Guarded fields (licence and medical dates, inspections, permits) and the document rules are Safety's:
 * someone without compliance.edit can't set or change them — a dispatcher can't make a driver
 * dispatchable by typing a new expiry date.
 */
async function assertGuarded(ctx: Ctx, kind: RecordKind, values: Record<string, unknown>, before?: Record<string, unknown>) {
  if (can(ctx, "compliance.edit")) return;
  if (kind === "documentType") throw new PermissionError("compliance.edit", ctx.role);
  const { GUARDED, FIELDS } = await import("./fields");
  const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? new Date(a as Date).getTime() === new Date(b as Date).getTime() : (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? ""));
  for (const k of GUARDED[kind] ?? []) {
    if (!(k in values)) continue;
    const v = values[k];
    if (before ? same(v, before[k]) : v == null || v === "" || v === false) continue;
    const label = FIELDS[kind].find((f) => f.name === k)?.label ?? k;
    throw Object.assign(new PermissionError("compliance.edit", ctx.role), { message: `${label} is kept by Safety — ask Safety or the owner to change it` });
  }
}

/**
 * Rules a record must meet whatever screen saved it. A billing entity with a factoring company needs the
 * factor's remit-to address: factored invoices print it as where to pay, and there is no safe fallback.
 */
export function recordProblem(kind: RecordKind, merged: Record<string, unknown>): { field: string; message: string } | null {
  if (kind === "billingEntity") {
    const name = String(merged.factorName ?? "").trim();
    const a = (merged.factorRemitTo ?? null) as { line1?: string; city?: string } | null;
    if (name && !(a?.line1?.trim() && a?.city?.trim())) return { field: "factorRemitTo", message: `${name} needs a remit-to address (street and city): factored invoices tell your customers to pay there` };
  }
  return null;
}

function assertRecord(kind: RecordKind, merged: Record<string, unknown>) {
  const p = recordProblem(kind, merged);
  if (p) throw Object.assign(new Error(p.message), { name: "ValidationError", field: p.field });
}

/** Digits only, for comparing phone numbers typed different ways ("+1 956 555 0159" = "9565550159" once the country code is known). */
export const phoneKey = (p: unknown) => {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length === 10 ? `1${d}` : d;
};

/**
 * Rules a record must keep beyond its field types. A driver's phone is theirs alone in the company:
 * WhatsApp replies are matched to the driver by number, so two drivers on one number would read each
 * other's messages (M23). Only checked when the number is set or changed.
 */
export async function validateRecord(ctx: Ctx, kind: RecordKind, values: Record<string, unknown>, id?: string) {
  if (kind !== "driver" || !("phone" in values)) return;
  const key = phoneKey(values.phone);
  if (key.length < 7) return;
  const others = await db.select({ id: s.drivers.id, name: s.drivers.name, phone: s.drivers.phone }).from(s.drivers).where(and(eq(s.drivers.tenantId, ctx.tenantId), isNull(s.drivers.archivedAt)));
  const clash = others.find((o) => o.id !== id && o.phone && phoneKey(o.phone) === key);
  if (clash) throw Object.assign(new Error(`${clash.name} already has ${String(values.phone)} — each driver needs their own phone number (WhatsApp messages are matched by number)`), { name: "ValidationError", field: "phone" });
}

export async function create(ctx: Ctx, kind: RecordKind, values: Record<string, unknown>): Promise<Row> {
  assertCtx(ctx);
  requirePermission(ctx, "records.create");
  await assertGuarded(ctx, kind, values);
  assertRecord(kind, values);
  if (kind === "documentType") values = syncDocumentTypeLevel(values);
  await validateRecord(ctx, kind, values);
  const { table } = REGISTRY[kind];
  const id = (values.id as string) ?? newId();
  const row = { ...values, id, tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId };
  return db.transaction(async (tx) => {
    const [inserted] = await tx.insert(table).values(row as never).returning();
    await writeAudit(tx, ctx, kind, id, "create", diff(null, values));
    return inserted as Row;
  });
}

/** Optimistic concurrency: pass the updatedAt you loaded; a newer one on disk = ConflictError (spec §1.2). */
export async function update(ctx: Ctx, kind: RecordKind, id: string, values: Record<string, unknown>, expectedUpdatedAt?: Date): Promise<Row> {
  assertCtx(ctx);
  requirePermission(ctx, "records.edit");
  const { table } = REGISTRY[kind];
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(table).where(and(eq(table.tenantId as never, ctx.tenantId), eq(table.id as never, id))).limit(1);
    if (!before) throw new NotFoundError(kind, id);
    const b = before as Row;
    if (expectedUpdatedAt && b.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new ConflictError();
    if (b.archivedAt) throw new Error("archived records are read-only; restore first");
    await assertGuarded(ctx, kind, values, b as Record<string, unknown>);
    assertRecord(kind, { ...b, ...values });
    if (kind === "documentType") values = syncDocumentTypeLevel(values);
    values = sameDayDates(kind, values, b);
    if (kind === "driver" && "phone" in values && phoneKey(values.phone) !== phoneKey(b.phone)) await validateRecord(ctx, kind, values, id);
    const { id: _id, tenantId: _t, createdAt: _c, createdBy: _cb, ...safe } = values as Record<string, unknown>;
    void _id; void _t; void _c; void _cb;
    const [after] = await tx
      .update(table)
      .set({ ...safe, updatedAt: new Date(), updatedBy: ctx.userId } as never)
      .where(and(eq(table.tenantId as never, ctx.tenantId), eq(table.id as never, id)))
      .returning();
    await writeAudit(tx, ctx, kind, id, "update", diff(b, after as Row));
    return after as Row;
  });
}

/**
 * A date field saved with the same calendar day it already has is not a change: the form sends every date
 * back as noon UTC, and rewriting 14:23 as 12:00 would log "hireDate: 2025-08-24 → 2025-08-24".
 */
function sameDayDates(kind: RecordKind, values: Record<string, unknown>, before: Record<string, unknown>) {
  const dateFields = new Set(FIELDS[kind].filter((f) => f.type === "date").map((f) => f.name));
  const out = { ...values };
  for (const [k, v] of Object.entries(values)) {
    const was = before[k];
    if (dateFields.has(k) && v instanceof Date && was instanceof Date && v.toISOString().slice(0, 10) === was.toISOString().slice(0, 10)) delete out[k];
  }
  return out;
}

export async function archiveBlockers(ctx: Ctx, kind: RecordKind, id: string) {
  const reg = REGISTRY[kind];
  return reg.blockers ? reg.blockers(ctx, id) : [];
}

export async function archive(ctx: Ctx, kind: RecordKind, id: string): Promise<void> {
  assertCtx(ctx);
  requirePermission(ctx, "records.archive");
  const blockers = await archiveBlockers(ctx, kind, id);
  if (blockers.length) throw new ArchiveBlockedError(blockers);
  const { table } = REGISTRY[kind];
  await db.transaction(async (tx) => {
    const res = await tx
      .update(table)
      .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.userId } as never)
      .where(and(eq(table.tenantId as never, ctx.tenantId), eq(table.id as never, id), isNull(table.archivedAt as never)))
      .returning();
    if (!res.length) throw new NotFoundError(kind, id);
    await writeAudit(tx, ctx, kind, id, "archive");
  });
}

export async function restore(ctx: Ctx, kind: RecordKind, id: string): Promise<void> {
  assertCtx(ctx);
  requirePermission(ctx, "records.archive");
  const { table } = REGISTRY[kind];
  await db.transaction(async (tx) => {
    const res = await tx
      .update(table)
      .set({ archivedAt: null, updatedAt: new Date(), updatedBy: ctx.userId } as never)
      .where(and(eq(table.tenantId as never, ctx.tenantId), eq(table.id as never, id), isNotNull(table.archivedAt as never)))
      .returning();
    if (!res.length) throw new NotFoundError(kind, id);
    await writeAudit(tx, ctx, kind, id, "restore");
  });
}

export async function history(ctx: Ctx, kind: RecordKind, id: string) {
  assertCtx(ctx);
  return db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.tenantId, ctx.tenantId), eq(s.auditLog.entity, kind), eq(s.auditLog.entityId, id)))
    .orderBy(desc(s.auditLog.at))
    .limit(200);
}

export async function counts(ctx: Ctx): Promise<Record<RecordKind, number>> {
  assertCtx(ctx);
  const out = {} as Record<RecordKind, number>;
  for (const kind of Object.keys(REGISTRY) as RecordKind[]) {
    const { table } = REGISTRY[kind];
    const [r] = await db.select({ n: count() }).from(table).where(and(eq(table.tenantId as never, ctx.tenantId), isNull(table.archivedAt as never)));
    out[kind] = Number(r?.n ?? 0);
  }
  return out;
}

/** Find an existing row by the kind's unique key (import de-duplication). */
export async function findByUniqueKey(ctx: Ctx, kind: RecordKind, values: Record<string, unknown>): Promise<Row | null> {
  const { table, uniqueKey } = REGISTRY[kind];
  const cols = uniqueKey.filter((k) => values[k] !== undefined && values[k] !== null && values[k] !== "");
  if (!cols.length) return null;
  const conds = cols.map((k) => eq((table as unknown as Record<string, never>)[k], values[k] as never));
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.tenantId as never, ctx.tenantId), kind === "carrier" ? or(...conds) : and(...conds)))
    .limit(1);
  return (row as Row) ?? null;
}

/** The field a duplicate-key error most likely refers to (for the form to highlight). */
export function ValidationErrorLike(kind: RecordKind): string | null {
  return REGISTRY[kind].uniqueKey[0] ?? null;
}
