// Features: F-32.25 record history in plain words (owner N9): names, addresses and labels, not ids and JSON
import { describe, it, expect } from "vitest";
import { changeLines } from "./history";
import { FIELDS } from "./fields";

describe("record history", () => {
  it("a broker by its name, an address as an address, a choice by its label", () => {
    const brokerField = FIELDS.customer.find((f) => f.type === "ref" && f.ref === "customsBroker")!;
    const lines = changeLines(
      {
        [brokerField.name]: { from: null, to: "qf6n94ack7f5jzxa" },
        remitTo: { from: null, to: { line1: "1 Main St", city: "Canton", state: "MI", postalCode: "48187", country: "US" } },
        kind: { from: "customer", to: "broker" },
      },
      [...FIELDS.customer, { name: "remitTo", label: "Remit-to address", type: "text" } as never],
      new Map([["qf6n94ack7f5jzxa", "Agencia Aduanal Treviño"]]),
    );
    expect(lines).toEqual([`${brokerField.label}: — → Agencia Aduanal Treviño`, "Remit-to address: — → 1 Main St, Canton, MI 48187, US", "Type: Customer (shipper) → Broker / 3PL"]);
  });
  it("a record since removed says so instead of printing its id", () => {
    const f = FIELDS.customer.find((x) => x.type === "ref")!;
    expect(changeLines({ [f.name]: { from: "abc", to: null } }, FIELDS.customer, new Map())).toEqual([`${f.label}: (removed record) → —`]);
  });
});
