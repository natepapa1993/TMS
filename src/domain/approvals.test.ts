// Features: F-32.22 F-30.3 F-6.6 owner approval queue for overrides (owner #18)
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { users, legs, flags, outbox, orders, complianceOverrides, overrideRequests } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { Ctx, Role } from "@/lib/context";
import { toError } from "@/lib/action";
import { createOrder, planLeg } from "./orders";
import { acceptRateConMismatch } from "./billing";
import { overrideDispatch } from "./compliance";
import { approvalsQueue, approveOverride, rejectOverride, setOverrideApproval, overridesNeedOwner, ApprovalRequestedError } from "./approvals";

const future = new Date(Date.now() + 365 * 86400_000);
const H = 3600_000;
let a: Awaited<ReturnType<typeof makeTenant>>;
let disp: Ctx;
let f: { cust: string; t1: string; mateo: string };

async function person(role: Role, name: string): Promise<Ctx> {
  const id = newId();
  await db.insert(users).values({ id, tenantId: a.tenantId, email: `${role}-${id}@test.local`, name, role });
  return { tenantId: a.tenantId, userId: id, role };
}

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Approvals Carrier");
  disp = await person("dispatcher", "Maria Dispatch");
  const cust = await create(a, "customer", { name: "Sierra Madre", kind: "customer" });
  const t1 = await create(a, "truck", { unitNumber: "213", usPlate: "TX213", usPlateExpires: future });
  const mateo = await create(a, "driver", { name: "Mateo Ruiz", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t1.id });
  f = { cust: cust.id, t1: t1.id, mateo: mateo.id };
});

const load = (pickupInHours: number) =>
  createOrder(a, {
    customerId: f.cust,
    rateCents: 180000,
    book: true,
    stops: [
      { type: "pickup", name: "Shipper Laredo", country: "US", address: { city: "Laredo", state: "TX" }, windowStart: new Date(Date.now() + pickupInHours * H) },
      { type: "delivery", name: "DC Dallas", country: "US", address: { city: "Dallas", state: "TX" }, windowStart: new Date(Date.now() + (pickupInHours + 9) * H) },
    ],
  });

/** Two loads on the same truck at the same time: the second is a double booking the dispatcher may override. */
async function doubleBooking() {
  const o1 = await load(24);
  const o2 = await load(26);
  await planLeg(a, o1.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo });
  return o2;
}
const mails = async (to: string) => db.select().from(outbox).where(and(eq(outbox.tenantId, a.tenantId), eq(outbox.to, to)));
const emailOf = async (c: Ctx) => (await db.select({ e: users.email }).from(users).where(eq(users.id, c.userId!)))[0].e;

describe("default: the override takes effect and waits for the owner's review", () => {
  it("a dispatcher's double-booking override is done at once and listed for the owner; reject reopens it with a red flag and tells them", async () => {
    const o2 = await doubleBooking();
    await planLeg(disp, o2.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo }, { override: true, reason: "back to back, customer OK'd a late pickup" });
    const [leg] = await db.select().from(legs).where(eq(legs.id, o2.legs[0].id));
    expect(leg.truckId).toBe(f.t1);

    expect(await approvalsQueue(disp)).toEqual([]); // the owner's list only
    const q = await approvalsQueue(a);
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ state: "applied", kind: "schedule", kindLabel: "Schedule", who: "Maria Dispatch", reason: "back to back, customer OK'd a late pickup", href: `/orders/${o2.order.id}` });
    expect(q[0].title).toContain(o2.order.orderNumber);

    await expect(rejectOverride(disp, q[0].id, "no")).rejects.toThrow(/owner/);
    await expect(rejectOverride(a, q[0].id, "")).rejects.toThrow(/why/);
    const r = await rejectOverride(a, q[0].id, "Mateo needs his rest, give it to 214");
    expect(r.reopened).toMatch(/red flag/);
    const [flag] = await db.select().from(flags).where(and(eq(flags.orderId, o2.order.id), eq(flags.code, "override_rejected")));
    expect(flag.level).toBe("red");
    expect(flag.detail).toContain("Mateo needs his rest");
    const [mail] = await mails(await emailOf(disp));
    expect(mail.subject).toMatch(/^Not approved/);
    expect(mail.body).toContain("Mateo needs his rest");
    expect(await approvalsQueue(a)).toEqual([]);
  });

  it("the owner's own overrides need no approval; approving a done one just marks it reviewed", async () => {
    const o2 = await doubleBooking();
    await planLeg(a, o2.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo }, { override: true, reason: "my call" });
    expect(await approvalsQueue(a)).toEqual([]);
    const billing = await person("billing", "Bea Billing");
    await acceptRateConMismatch(billing, o2.order.id, "fuel per tariff");
    const [row] = await approvalsQueue(a);
    expect(row.kind).toBe("rate_con");
    const r = await approveOverride(a, row.id);
    expect(r.carriedOut).toBe(false);
    const [saved] = await db.select().from(overrideRequests).where(eq(overrideRequests.id, row.id));
    expect(saved.state).toBe("approved");
  });

  it("rejecting a paperwork override ends it: the block is back", async () => {
    const safety = await person("compliance", "Sam Safety");
    await overrideDispatch(safety, "driver", f.mateo, "medical card renewal in the mail");
    const [row] = await approvalsQueue(a);
    expect(row).toMatchObject({ kind: "paperwork", title: expect.stringContaining("Mateo Ruiz") });
    await rejectOverride(a, row.id, "not without the card");
    const [ov] = await db.select().from(complianceOverrides).where(eq(complianceOverrides.subjectId, f.mateo));
    expect(ov.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("rejecting a rate-con override puts the mismatch back in billing", async () => {
    const o = await load(24);
    const billing = await person("billing", "Bea Billing");
    await acceptRateConMismatch(billing, o.order.id, "detention by email");
    const [row] = await approvalsQueue(a);
    await rejectOverride(a, row.id, "get it in writing");
    const [ord] = await db.select().from(orders).where(eq(orders.id, o.order.id));
    expect((ord.custom as Record<string, unknown>).rateConMismatchAccepted).toBeUndefined();
  });
});

describe("\"Overrides need the owner's approval first\"", () => {
  it("only the owner turns it on; then an override is only a request until the owner approves it", async () => {
    await expect(setOverrideApproval(disp, true)).rejects.toThrow(/owner/);
    await setOverrideApproval(a, true);
    expect(await overridesNeedOwner(a.tenantId)).toBe(true);

    const o2 = await doubleBooking();
    const err = await planLeg(disp, o2.legs[0].id, { kind: "truck", truckId: f.t1, driverId: f.mateo }, { override: true, reason: "back to back" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequestedError);
    expect(toError(err)).toMatchObject({ ok: false, code: "approval_requested", error: expect.stringContaining("owner") });
    const [before] = await db.select().from(legs).where(eq(legs.id, o2.legs[0].id));
    expect(before.truckId).toBeNull(); // nothing changed
    const ownerMail = await mails(a.email);
    expect(ownerMail[0].subject).toContain("Maria Dispatch");

    const [row] = await approvalsQueue(a);
    expect(row.state).toBe("pending");
    const r = await approveOverride(a, row.id);
    expect(r.carriedOut).toBe(true);
    const [after] = await db.select().from(legs).where(eq(legs.id, o2.legs[0].id));
    expect(after.truckId).toBe(f.t1);
    expect(after.driverId).toBe(f.mateo);
    const [mail] = await mails(await emailOf(disp));
    expect(mail.subject).toMatch(/^Approved/);
    expect(await approvalsQueue(a)).toEqual([]);
  });

  it("a rejected request changes nothing and tells the person", async () => {
    await setOverrideApproval(a, true);
    const o = await load(24);
    const billing = await person("billing", "Bea Billing");
    await expect(acceptRateConMismatch(billing, o.order.id, "detention by email")).rejects.toBeInstanceOf(ApprovalRequestedError);
    const [row] = await approvalsQueue(a);
    const r = await rejectOverride(a, row.id, "no");
    expect(r.reopened).toBeNull();
    const [ord] = await db.select().from(orders).where(eq(orders.id, o.order.id));
    expect((ord.custom as Record<string, unknown>).rateConMismatchAccepted).toBeUndefined();
    const [mail] = await mails(await emailOf(billing));
    expect(mail.subject).toMatch(/^Not approved/);
  });
});
