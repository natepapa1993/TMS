// Features: F-1.6 sign-in: eight wrong passwords lock the email for fifteen minutes; a right one clears it
import { describe, it, expect, beforeEach } from "vitest";
import { throttled, failed, succeeded, resetThrottle, safeNext, LIMIT, LOCK_MS, WINDOW_MS } from "./throttle";

describe("sign-in throttle", () => {
  beforeEach(() => resetThrottle());
  it("locks after the limit inside the window, unlocks after the lock, forgets old failures", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LIMIT - 1; i++) failed("a@x", t0 + i);
    expect(throttled("a@x", t0 + LIMIT)).toBeNull();
    failed("a@x", t0 + LIMIT);
    expect(throttled("a@x", t0 + LIMIT + 1)).toBe(15);
    expect(throttled("a@x", t0 + LIMIT + LOCK_MS + 1)).toBeNull();
    // slow failures spread over more than the window never lock
    resetThrottle();
    for (let i = 0; i < LIMIT * 2; i++) failed("b@x", t0 + i * (WINDOW_MS / 2));
    expect(throttled("b@x", t0 + LIMIT * 2 * (WINDOW_MS / 2))).toBeNull();
    // a success clears
    for (let i = 0; i < LIMIT; i++) failed("c@x", t0);
    expect(throttled("c@x", t0)).toBe(15);
    succeeded("c@x");
    expect(throttled("c@x", t0)).toBeNull();
  });

  it("the post-login redirect stays on this site", () => {
    expect(safeNext("/orders/abc")).toBe("/orders/abc");
    expect(safeNext("//evil.com/x")).toBe("/dispatch");
    expect(safeNext("/\\evil.com")).toBe("/dispatch");
    expect(safeNext("https://evil.com")).toBe("/dispatch");
    expect(safeNext("")).toBe("/dispatch");
  });
});
