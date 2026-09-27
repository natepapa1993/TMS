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

/** EDI / broker time-zone codes and US-MX states → IANA zones, for wall-clock times that arrive without an offset. */
const CODE_ZONE: Record<string, string> = { ET: "America/New_York", ED: "America/New_York", ES: "America/New_York", CT: "America/Chicago", CD: "America/Chicago", CS: "America/Chicago", MT: "America/Denver", MD: "America/Denver", MS: "America/Phoenix", PT: "America/Los_Angeles", PD: "America/Los_Angeles", PS: "America/Los_Angeles", UT: "UTC", GM: "UTC" };
const STATE_ZONE: Record<string, string> = {
  // US (whole-state approximations; split states take their larger part)
  CT: "America/New_York", DE: "America/New_York", FL: "America/New_York", GA: "America/New_York", IN: "America/New_York", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York", OH: "America/New_York", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York", VA: "America/New_York", WV: "America/New_York", KY: "America/New_York", DC: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago", KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Denver", MT: "America/Denver", NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles", AK: "America/Anchorage", HI: "Pacific/Honolulu",
  // Mexico (no DST since 2022; the border strip follows US time)
  NL: "America/Monterrey", COAH: "America/Monterrey", CO_MX: "America/Monterrey", TAMS: "America/Matamoros", TAM: "America/Matamoros", CHIH: "America/Ciudad_Juarez", CH: "America/Ciudad_Juarez", BC: "America/Tijuana", BCN: "America/Tijuana", SON: "America/Hermosillo", SIN: "America/Mazatlan", BCS: "America/Mazatlan", NAY: "America/Mazatlan", QROO: "America/Cancun", QR: "America/Cancun",
  AGS: "America/Mexico_City", CAMP: "America/Mexico_City", CDMX: "America/Mexico_City", DF: "America/Mexico_City", COL: "America/Mexico_City", DGO: "America/Mexico_City", GTO: "America/Mexico_City", GRO: "America/Mexico_City", HGO: "America/Mexico_City", JAL: "America/Mexico_City", MEX: "America/Mexico_City", MICH: "America/Mexico_City", MOR: "America/Mexico_City", OAX: "America/Mexico_City", PUE: "America/Mexico_City", QRO: "America/Mexico_City", SLP: "America/Mexico_City", TAB: "America/Mexico_City", TLAX: "America/Mexico_City", VER: "America/Mexico_City", YUC: "America/Mexico_City", ZAC: "America/Mexico_City", CHIS: "America/Mexico_City",
};

/** Zone for a wall-clock time: an explicit code wins, then the stop's state, then the company's zone. */
export function zoneFor(p: { code?: string | null; state?: string | null; country?: string | null }, fallback: string) {
  if (p.code && CODE_ZONE[p.code.toUpperCase()]) return CODE_ZONE[p.code.toUpperCase()];
  const st = (p.state ?? "").toUpperCase().replace(/[^A-Z_]/g, "");
  if (st && STATE_ZONE[st]) return STATE_ZONE[st];
  if (p.country === "MX") return "America/Mexico_City";
  return fallback;
}

/** The instant for a wall-clock date + HHMM in a zone. */
export function localToInstant(date: string, hhmm: string, timeZone: string) {
  const midnight = zonedMidnight(date, timeZone);
  const h = Number(hhmm.slice(0, 2)) || 0;
  const m = Number(hhmm.slice(2, 4)) || 0;
  return new Date(midnight.getTime() + (h * 60 + m) * 60_000);
}

/** A time in the company's zone with its abbreviation ("Sep 27, 8:24 AM EDT"): what a customer, carrier or driver reads on a public page. */
export function fmtIn(d: Date | string | null | undefined, zone: string, opts: Intl.DateTimeFormatOptions = {}): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", ...opts, timeZone: zone });
  } catch {
    return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", ...opts, timeZone: "America/Chicago" });
  }
}

/** The zone's short name today ("EDT", "CST") for a footer line. */
export function zoneAbbrev(zone: string, at = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}
