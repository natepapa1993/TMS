/**
 * Sign-in throttle: too many failures for one email (or from one address) and the next attempts wait,
 * whatever the password. In memory: one app instance is what runs today, and a restart forgiving the
 * count is fine. Tests use the exported window/limit.
 */
const attempts = new Map<string, { n: number; first: number; until: number }>();
export const LIMIT = 8; // failures
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;

export function throttled(key: string, now = Date.now()): number | null {
  const a = attempts.get(key);
  if (!a) return null;
  if (a.until > now) return Math.ceil((a.until - now) / 60_000);
  if (now - a.first > WINDOW_MS) attempts.delete(key);
  return null;
}

export function failed(key: string, now = Date.now(), limit = LIMIT) {
  const a = attempts.get(key);
  if (!a || now - a.first > WINDOW_MS) {
    attempts.set(key, { n: 1, first: now, until: 0 });
    return;
  }
  a.n++;
  if (a.n >= limit) a.until = now + LOCK_MS;
}

export function succeeded(key: string) {
  attempts.delete(key);
}

export function resetThrottle() {
  attempts.clear();
}

/** Only paths on this site: "//evil.com" and "https://…" never become a redirect target after sign-in. */
export function safeNext(next: string | null | undefined) {
  return next && /^\/(?![/\\])/.test(next) ? next : "/dispatch";
}
