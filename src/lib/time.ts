/** Time-zone helpers: the company's zone decides what "today" and "this week" mean, not the server's. */

/** Calendar parts of an instant in a zone. */
export function zonedParts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** YYYY-MM-DD of an instant in a zone. */
export function zonedDate(d: Date, timeZone: string) {
  const { y, m, d: day } = zonedParts(d, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant at local midnight of a YYYY-MM-DD date in a zone (DST-safe: solves for the offset). */
export function zonedMidnight(date: string, timeZone: string) {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, 0, 0);
    const diff = asUtc - guess; // how far the zone's clock is ahead of UTC at this instant
    const want = Date.UTC(y, m - 1, d);
    if (asUtc === want) break;
    guess = want - diff;
  }
  return new Date(guess);
}

/** Sunday-to-Saturday week containing `d`, in the company's zone. */
export function weekOfZoned(d: Date, timeZone: string) {
  const p = zonedParts(d, timeZone);
  const sunday = new Date(Date.UTC(p.y, p.m - 1, p.d - p.weekday));
  const start = zonedMidnight(sunday.toISOString().slice(0, 10), timeZone);
  const endDate = new Date(sunday.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  return { start, end: zonedMidnight(endDate, timeZone), startDate: sunday.toISOString().slice(0, 10) };
}
