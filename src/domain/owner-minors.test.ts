// Features: F-32.25 owner minors: honest customer-portal status (owner #17)
import { describe, it, expect } from "vitest";
import { portalStateKey } from "./customer-portal";

describe("customer portal status (owner #17)", () => {
  it("'Driver assigned' only once someone has the load; a tender out reads 'assigning'", () => {
    expect(portalStateKey("dispatched", { state: "dispatched", assigneeKind: "carrier" })).toBe("assigning");
    expect(portalStateKey("dispatched", { state: "planned", assigneeKind: "truck" })).toBe("assigning");
    expect(portalStateKey("dispatched", { state: "declined", assigneeKind: "carrier" })).toBe("assigning");
    expect(portalStateKey("dispatched", { state: "accepted", assigneeKind: "carrier" })).toBe("dispatched");
    expect(portalStateKey("dispatched", { state: "dispatched", assigneeKind: "truck" })).toBe("dispatched"); // sent to our own driver
    expect(portalStateKey("in_transit", { state: "en_route", assigneeKind: "truck" })).toBe("in_transit");
    expect(portalStateKey("booked", null)).toBe("booked");
  });
});
