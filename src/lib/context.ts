/**
 * Every data operation runs inside a Context that names the tenant and the acting user.
 * Repositories refuse to run without one — this is the tenant-isolation rule (spec §15, §10.4).
 */
export type Role = "owner" | "dispatcher" | "billing" | "compliance" | "mx_office" | "driver" | "carrier" | "customer";

export type Ctx = {
  tenantId: string;
  userId: string | null; // null only for system jobs
  role: Role | "system";
};

export class TenantContextError extends Error {
  constructor(msg = "operation attempted without a tenant context") {
    super(msg);
    this.name = "TenantContextError";
  }
}

export function assertCtx(ctx: Ctx | undefined | null): asserts ctx is Ctx {
  if (!ctx || !ctx.tenantId) throw new TenantContextError();
}

export const systemCtx = (tenantId: string): Ctx => ({ tenantId, userId: null, role: "system" });

/** Permission model (spec §1.5 Role). Kept small on purpose; grows with the modules. */
export type Permission =
  | "records.view"
  | "records.create"
  | "records.edit"
  | "records.archive"
  | "records.delete"
  | "orders.view"
  | "orders.create"
  | "orders.edit"
  | "orders.cancel"
  | "dispatch.plan"
  | "dispatch.dispatch"
  | "dispatch.override"
  | "billing.view"
  | "billing.issue"
  | "billing.void"
  | "compliance.override"
  | "compliance.view"
  | "compliance.edit"
  /** drug & alcohol records: confidential (49 CFR 40.321), owner and Safety only */
  | "safety.confidential"
  | "settings.edit";

const ALL: Permission[] = [
  "records.view",
  "records.create",
  "records.edit",
  "records.archive",
  "records.delete",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.cancel",
  "dispatch.plan",
  "dispatch.dispatch",
  "dispatch.override",
  "billing.view",
  "billing.issue",
  "billing.void",
  "compliance.view",
  "compliance.edit",
  "compliance.override",
  "safety.confidential",
  "settings.edit",
];

export const ROLE_PERMISSIONS: Record<Role | "system", Permission[]> = {
  system: ALL,
  owner: ALL,
  // dispatch.override: schedule calls (a double booking, time off). Paperwork blocks need compliance.override (Safety / owner).
  dispatcher: ["records.view", "records.create", "records.edit", "orders.view", "orders.create", "orders.edit", "orders.cancel", "dispatch.plan", "dispatch.dispatch", "dispatch.override", "compliance.view", "billing.view"],
  billing: ["records.view", "records.create", "records.edit", "orders.view", "orders.edit", "billing.view", "billing.issue", "compliance.view"],
  compliance: ["records.view", "records.create", "records.edit", "records.archive", "orders.view", "compliance.view", "compliance.edit", "compliance.override", "safety.confidential"],
  mx_office: ["records.view", "records.create", "records.edit", "orders.view", "orders.edit", "compliance.view"],
  driver: [],
  carrier: [],
  customer: [],
};

export class PermissionError extends Error {
  constructor(public permission: Permission, public role: string) {
    super(`role ${role} lacks permission ${permission}`);
    this.name = "PermissionError";
  }
}

export function can(ctx: Ctx, permission: Permission): boolean {
  return ROLE_PERMISSIONS[ctx.role]?.includes(permission) ?? false;
}

export function requirePermission(ctx: Ctx, permission: Permission): void {
  assertCtx(ctx);
  if (!can(ctx, permission)) throw new PermissionError(permission, ctx.role);
}
