/**
 * A server action that throws (the request never made it: too big, offline, server restarting) would take
 * the whole page down to the error screen. Wrapped, it becomes an ordinary "not ok" the form can show.
 */
export async function call<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | { ok: false; error: string; field?: string }> {
  try {
    return await fn();
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/413|too large|body exceeded|Body exceeded/i.test(m)) return { ok: false, error: "That file is too big. 25 MB is the most one upload can carry.", field: "file" };
    if (/fetch|network|Failed to fetch|ECONN/i.test(m)) return { ok: false, error: "Could not reach the server. Check the connection and try again." };
    return { ok: false, error: "Something went wrong on the way to the server. Nothing was saved; try again." };
  }
}
