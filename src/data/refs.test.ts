// Features: F-32.25 broker pickers per country and a Canadian customs broker on the customer (owner N10)
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create, get } from "./records";
import { loadRefs } from "./refs";

let a: Awaited<ReturnType<typeof makeTenant>>;
beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("Refs Carrier");
});

describe("customs broker pickers", () => {
  it("each side's picker lists that country's brokers; the customer keeps a Canadian broker", async () => {
    const mx = await create(a, "customsBroker", { name: "Agencia Treviño", country: "MX", patente: "3456" });
    const us = await create(a, "customsBroker", { name: "Laredo Customs Inc", country: "US" });
    const ca = await create(a, "customsBroker", { name: "Livingston Windsor", country: "CA" });
    const { options } = await loadRefs(a, "customer");
    expect(options["customsBroker"].length).toBe(3);
    expect(options["customsBroker@MX"].map((o) => o.label)).toEqual(["Agencia Treviño"]);
    expect(options["customsBroker@US"].map((o) => o.label)).toEqual(["Laredo Customs Inc"]);
    expect(options["customsBroker@CA"].map((o) => o.label)).toEqual(["Livingston Windsor"]);
    const c = await create(a, "customer", { name: "Linamar", kind: "customer", country: "CA", caBrokerId: ca.id, mxBrokerId: mx.id, usBrokerId: us.id });
    expect((await get(a, "customer", c.id)).caBrokerId).toBe(ca.id);
  });
});
