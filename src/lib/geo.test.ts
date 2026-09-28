// Features: F-5.14 road distance
import { describe, it, expect } from "vitest";
import { haversineMiles, roadMiles, coords } from "./geo";

describe("geo", () => {
  it("Monterrey → Laredo is about 140 straight miles, ~175 by road; bad coordinates are null", () => {
    const mty = { lat: 25.6866, lng: -100.3161 };
    const lrd = { lat: 27.5064, lng: -99.5075 };
    expect(Math.round(haversineMiles(mty, lrd))).toBeGreaterThan(130);
    expect(Math.round(haversineMiles(mty, lrd))).toBeLessThan(150);
    expect(roadMiles(mty, lrd)).toBeCloseTo(haversineMiles(mty, lrd) * 1.25, 6);
    expect(haversineMiles(mty, mty)).toBe(0);
    expect(coords("25.6866", "-100.3161")).toEqual({ lat: 25.6866, lng: -100.3161 });
    expect(coords("", "-100")).toBeNull();
    expect(coords("abc", "-100")).toBeNull();
    expect(coords("95", "0")).toBeNull();
    expect(coords(null, null)).toBeNull();
  });
});
