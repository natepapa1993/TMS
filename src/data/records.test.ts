// Features: F-1.2 F-1.3 F-1.4 F-1.5 F-15 F-16
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get, list, update, archive, restore, history, findByUniqueKey, NotFoundError, ArchiveBlockedError, ConflictError, sameValue } from "./records";
import { coerce } from "./fields";
import { PermissionError, TenantContextError } from "@/lib/context";
import { db } from "@/db/client";
import { orders, legs } from "@/db/schema";
import { newId } from "@/lib/ids";

// F-1.2 record screen behaviors, F-15 tenant isolation (spec §10.4: a cross-tenant read test fails closed)

let a: Awaited<ReturnType<typeof makeTenant>>;
let b: Awaited<ReturnType<typeof makeTenant>>;

beforeAll(async () => {
  await truncateAll();
});
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Tenant A");
  b = await makeTenant("Tenant B");
});

describe("tenant isolation (F-15)", () => {
  it("a record created in tenant A is invisible to tenant B by id and by list", async () => {
    const truck = await create(a, "truck", { unitNumber: "2117", mxPlateClass: "brown" });
    await expect(get(b, "truck", truck.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await list(b, "truck")).length).toBe(0);
    expect((await list(a, "truck")).length).toBe(1);
  });

  it("tenant B cannot update or archive tenant A's record", async () => {
    const truck = await create(a, "truck", { unitNumber: "2117" });
    await expect(update(b, "truck", truck.id, { note: "hacked" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(archive(b, "truck", truck.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await get(a, "truck", truck.id)).note).toBeNull();
  });

  it("the same unit number can exist in both tenants", async () => {
    await create(a, "truck", { unitNumber: "2117" });
    await create(b, "truck", { unitNumber: "2117" });
    expect((await list(a, "truck")).length).toBe(1);
    expect((await list(b, "truck")).length).toBe(1);
  });

  it("refuses to run without a tenant context", async () => {
    await expect(list({ tenantId: "", userId: null, role: "system" }, "truck")).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("permissions (F-1.5 Role)", () => {
  it("a driver role cannot read master data", async () => {
    const d = await makeTenant("Tenant D", "driver");
    await expect(list(d, "truck")).rejects.toBeInstanceOf(PermissionError);
  });
  it("a dispatcher can create but not archive", async () => {
    const d = await makeTenant("Tenant E", "dispatcher");
    const t = await create(d, "truck", { unitNumber: "1" });
    await expect(archive(d, "truck", t.id)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("record lifecycle (F-1.2)", () => {
  it("create → update → archive → restore, with an audit row for each", async () => {
    const drv = await create(a, "driver", { name: "B. Xochihua", driverType: "B1" });
    await update(a, "driver", drv.id, { driverType: "DUAL" });
    await archive(a, "driver", drv.id);
    expect((await list(a, "driver")).length).toBe(0);
    expect((await list(a, "driver", { archived: "archived" })).length).toBe(1);
    await restore(a, "driver", drv.id);
    expect((await list(a, "driver")).length).toBe(1);
    const h = await history(a, "driver", drv.id);
    expect(h.map((x) => x.action)).toEqual(["restore", "archive", "update", "create"]);
    const upd = h.find((x) => x.action === "update")!;
    expect(upd.changes).toEqual({ driverType: { from: "B1", to: "DUAL" } });
    expect(upd.userId).toBe(a.userId);
  });

  it("archived records are read-only", async () => {
    const c = await create(a, "customer", { name: "RXO", kind: "broker" });
    await archive(a, "customer", c.id);
    await expect(update(a, "customer", c.id, { name: "x" })).rejects.toThrow(/read-only/);
  });

  it("detects a concurrent edit (F-1.7 two users edit the same record)", async () => {
    const c = await create(a, "customer", { name: "Ford" });
    const opened = c.updatedAt as Date;
    await update(a, "customer", c.id, { termsDays: 45 });
    await expect(update(a, "customer", c.id, { termsDays: 60 }, opened)).rejects.toBeInstanceOf(ConflictError);
  });

  it("cannot overwrite id or tenant through update", async () => {
    const c = await create(a, "customer", { name: "Magna" });
    await update(a, "customer", c.id, { id: "evil", tenantId: b.tenantId, name: "Magna Intl" });
    const again = await get(a, "customer", c.id);
    expect(again.tenantId).toBe(a.tenantId);
    expect(again.name).toBe("Magna Intl");
  });
});

describe("archive blockers (F-1.4)", () => {
  it("a truck on an open leg cannot be archived; after the leg completes it can", async () => {
    const truck = await create(a, "truck", { unitNumber: "2104" });
    const orderId = newId();
    await db.insert(orders).values({ id: orderId, tenantId: a.tenantId, orderNumber: "26-00001", state: "dispatched" });
    const legId = newId();
    await db.insert(legs).values({ id: legId, tenantId: a.tenantId, orderId, seq: 1, type: "us", state: "en_route", assigneeKind: "truck", truckId: truck.id });
    const err = await archive(a, "truck", truck.id).catch((e) => e);
    expect(err).toBeInstanceOf(ArchiveBlockedError);
    expect((err as ArchiveBlockedError).blockers[0].label).toContain("26-00001");
    await db.update(legs).set({ state: "completed" }).where(eq(legs.id, legId));
    await archive(a, "truck", truck.id);
  });

  it("a customer with an open order cannot be archived", async () => {
    const cust = await create(a, "customer", { name: "Rivian" });
    await db.insert(orders).values({ id: newId(), tenantId: a.tenantId, orderNumber: "26-00002", state: "booked", customerId: cust.id });
    await expect(archive(a, "customer", cust.id)).rejects.toBeInstanceOf(ArchiveBlockedError);
  });
});

describe("Safety's fields don't stop dispatch saving the rest (dispatch N2)", () => {
  it("a dispatcher saves a driver's phone with the whole form sent back: unchanged dates are not changes", async () => {
    // stored the way imports and the driver app store them: midnight Central, not noon UTC
    const d = await create(a, "driver", { name: "Carlos", licenseNumber: "TX1", licenseExpires: new Date("2027-03-15T05:00:00Z"), medicalExpires: new Date("2026-11-02T00:00:00Z"), commercialZoneOnly: false });
    const dispatcher = { ...a, role: "dispatcher" as const };
    const row = await get(a, "driver", d.id);
    const ymd = (v: unknown) => (v ? new Date(v as Date).toISOString().slice(0, 10) : "");
    // what the record screen sends: every field, dates as YYYY-MM-DD, the guarded ones untouched
    const { values, ok } = coerce("driver", { name: "Carlos", phone: "+1 956 555 0177", licenseNumber: "TX1", licenseExpires: ymd(row.licenseExpires), medicalExpires: ymd(row.medicalExpires), mxLicenseExpires: "", fastExpires: "", commercialZoneOnly: "", elpAttestedAt: "", licenseClass: "" }, { partial: true });
    expect(ok).toBe(true);
    const saved = await update(dispatcher, "driver", d.id, values);
    expect(saved.phone).toBe("+1 956 555 0177");
    // the stored instants were kept, not rewritten to noon
    expect((saved.licenseExpires as Date).toISOString()).toBe("2027-03-15T05:00:00.000Z");
    // an actual change of a Safety date is still refused
    await expect(update(dispatcher, "driver", d.id, coerce("driver", { licenseExpires: "2031-03-15" }, { partial: true }).values)).rejects.toThrow(/kept by Safety/);
    await expect(update(dispatcher, "driver", d.id, coerce("driver", { medicalExpires: "" }, { partial: true }).values)).rejects.toThrow(/kept by Safety/);
  });
  it("sameValue: dates by the day, blanks alike, checkboxes by truth", () => {
    expect(sameValue("date", new Date("2027-03-15T12:00:00Z"), new Date("2027-03-15T05:00:00Z"))).toBe(true);
    expect(sameValue("date", new Date("2027-03-16T12:00:00Z"), new Date("2027-03-15T05:00:00Z"))).toBe(false);
    expect(sameValue("date", null, new Date("2027-03-15T05:00:00Z"))).toBe(false);
    expect(sameValue("text", "", null)).toBe(true);
    expect(sameValue("text", " A ", "A")).toBe(true);
    expect(sameValue("boolean", false, null)).toBe(true);
    expect(sameValue("boolean", true, false)).toBe(false);
  });
});

describe("import de-duplication (F-1.3)", () => {
  it("finds a truck by unit number and a carrier by MC or RFC", async () => {
    await create(a, "truck", { unitNumber: "2121" });
    expect(await findByUniqueKey(a, "truck", { unitNumber: "2121" })).not.toBeNull();
    expect(await findByUniqueKey(a, "truck", { unitNumber: "9999" })).toBeNull();
    await create(a, "carrier", { name: "Transportes Garza", country: "MX", rfc: "TGA010203AB1" });
    expect(await findByUniqueKey(a, "carrier", { rfc: "TGA010203AB1" })).not.toBeNull();
    expect(await findByUniqueKey(b, "carrier", { rfc: "TGA010203AB1" })).toBeNull();
  });
});

import { eq } from "drizzle-orm";
