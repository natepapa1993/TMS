/** Time-zone helpers: the company's zone decides what "today" and "this week" mean, not the server's. */

/** Calendar parts of an instant in a zone. */
export function zonedParts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
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
  NL: "America/Monterrey", COAH: "America/Monterrey", CO_MX: "America/Monterrey", TAMS: "America/Monterrey", TAM: "America/Monterrey", TAMPS: "America/Monterrey", CHIH: "America/Chihuahua", CH: "America/Chihuahua", CHH: "America/Chihuahua", BC: "America/Tijuana", BCN: "America/Tijuana", SON: "America/Hermosillo", SIN: "America/Mazatlan", BCS: "America/Mazatlan", NAY: "America/Mazatlan", QROO: "America/Cancun", QR: "America/Cancun",
  NUEVOLEON: "America/Monterrey", COAHUILA: "America/Monterrey", TAMAULIPAS: "America/Monterrey", CHIHUAHUA: "America/Chihuahua", SONORA: "America/Hermosillo", BAJACALIFORNIA: "America/Tijuana", JALISCO: "America/Mexico_City", GUANAJUATO: "America/Mexico_City", QUERETARO: "America/Mexico_City", SANLUISPOTOSI: "America/Mexico_City", AGUASCALIENTES: "America/Mexico_City", ESTADODEMEXICO: "America/Mexico_City", PUEBLA: "America/Mexico_City", NLE: "America/Monterrey", COA: "America/Monterrey",
  AGS: "America/Mexico_City", CAMP: "America/Mexico_City", CDMX: "America/Mexico_City", DF: "America/Mexico_City", COL: "America/Mexico_City", DGO: "America/Mexico_City", GTO: "America/Mexico_City", GRO: "America/Mexico_City", HGO: "America/Mexico_City", JAL: "America/Mexico_City", MEX: "America/Mexico_City", MICH: "America/Mexico_City", MOR: "America/Mexico_City", OAX: "America/Mexico_City", PUE: "America/Mexico_City", QRO: "America/Mexico_City", SLP: "America/Mexico_City", TAB: "America/Mexico_City", TLAX: "America/Mexico_City", VER: "America/Mexico_City", YUC: "America/Mexico_City", ZAC: "America/Mexico_City", CHIS: "America/Mexico_City",
};

/** Canadian provinces and territories by their postal abbreviation. */
const PROVINCE_ZONE: Record<string, string> = { ON: "America/Toronto", QC: "America/Toronto", NB: "America/Moncton", NS: "America/Halifax", PE: "America/Halifax", NL: "America/St_Johns", MB: "America/Winnipeg", SK: "America/Regina", AB: "America/Edmonton", BC: "America/Vancouver", YT: "America/Whitehorse", NT: "America/Yellowknife", NU: "America/Iqaluit" };

/**
 * Cities whose clock differs from the rest of their state or province. Mexico dropped daylight saving time in 2022
 * except its northern border strip, which keeps the US clock: Nuevo Laredo, Reynosa, Matamoros, Piedras Negras and
 * Acuña run on US Central (America/Matamoros: CST in winter, CDT in summer), Juárez on US Mountain, Ojinaga on US
 * Central, while Monterrey, Saltillo, Ramos Arizpe and interior Tamaulipas stay on CST all year. On the US side, El
 * Paso is on Mountain time though Texas is Central. Matched on the stop's city, else its name ("Patio Nuevo Laredo").
 */
const CITY_ZONE: { country: string; state?: string[]; city: RegExp; zone: string }[] = [
  { country: "MX", state: ["TAMS", "TAM", "TAMPS", "TAMAULIPAS"], city: /\b(nuevo laredo|reynosa|matamoros|rio bravo|valle hermoso|miguel aleman|camargo|diaz ordaz|mier|nuevo progreso|nuevo guerrero)\b/, zone: "America/Matamoros" },
  { country: "MX", state: ["COAH", "CO_MX", "COA", "COAHUILA"], city: /\b(piedras negras|acuna|ciudad acuna|nava|allende|zaragoza|jimenez|guerrero|hidalgo|morelos|villa union|ocampo)\b/, zone: "America/Matamoros" },
  { country: "MX", state: ["NL", "NLE", "NUEVO LEON"], city: /\b(anahuac|colombia)\b/, zone: "America/Matamoros" },
  { country: "MX", state: ["CHIH", "CH", "CHH", "CHIHUAHUA"], city: /\b(juarez|ciudad juarez|ascension|janos|praxedis|guadalupe)\b/, zone: "America/Ciudad_Juarez" },
  { country: "MX", state: ["CHIH", "CH", "CHH", "CHIHUAHUA"], city: /\b(ojinaga|coyame|manuel benavides)\b/, zone: "America/Ojinaga" },
  { country: "US", state: ["TX"], city: /\b(el paso|anthony|horizon city|socorro|clint|canutillo|fabens|van horn)\b/, zone: "America/Denver" },
  { country: "US", state: ["TN"], city: /\b(knoxville|chattanooga|johnson city|kingsport|bristol|cleveland|morristown)\b/, zone: "America/New_York" },
  { country: "US", state: ["KY"], city: /\b(bowling green|paducah|owensboro|hopkinsville)\b/, zone: "America/Chicago" },
  { country: "US", state: ["FL"], city: /\b(pensacola|panama city|fort walton beach|destin)\b/, zone: "America/Chicago" },
  { country: "US", state: ["IN"], city: /\b(gary|hammond|merrillville|valparaiso|evansville|east chicago|michigan city)\b/, zone: "America/Chicago" },
  { country: "US", state: ["MI"], city: /\b(menominee|iron mountain|ironwood)\b/, zone: "America/Menominee" },
  { country: "US", state: ["ID"], city: /\b(coeur d.?alene|lewiston|moscow|sandpoint)\b/, zone: "America/Los_Angeles" },
  { country: "US", state: ["OR"], city: /\bontario\b/, zone: "America/Boise" },
  { country: "US", state: ["SD"], city: /\b(rapid city|spearfish|sturgis)\b/, zone: "America/Denver" },
  { country: "CA", state: ["ON"], city: /\b(kenora|dryden)\b/, zone: "America/Winnipeg" },
  { country: "CA", state: ["BC"], city: /\b(cranbrook|fernie|golden)\b/, zone: "America/Edmonton" },
];
const plain = (v: string | null | undefined) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();

/** Zone for a wall-clock time: an explicit code wins, then a city with its own clock, then the stop's state, then the company's zone. */
export function zoneFor(p: { code?: string | null; state?: string | null; country?: string | null; city?: string | null; name?: string | null }, fallback: string) {
  if (p.code && CODE_ZONE[p.code.toUpperCase()]) return CODE_ZONE[p.code.toUpperCase()];
  const st = (p.state ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z_ ]/g, "").trim();
  const country = (p.country ?? "").toUpperCase() || "US";
  const city = plain(p.city);
  const name = plain(p.name);
  for (const c of CITY_ZONE) {
    if (c.country !== country) continue;
    if (st && c.state && !c.state.includes(st)) continue;
    if (!st && country === "US") continue; // a US city name alone is not enough (there is an Ontario in California)
    if ((city && c.city.test(city)) || (!city && name && c.city.test(name))) return c.zone;
  }
  const code = st.replace(/ /g, "");
  if (country === "CA" && code && PROVINCE_ZONE[code]) return PROVINCE_ZONE[code];
  if (code && STATE_ZONE[code] && country !== "CA") return STATE_ZONE[code];
  if (country === "CA") return "America/Toronto";
  if (country === "MX") return "America/Mexico_City";
  return safeZone(fallback);
}

/** A zone that Intl accepts, else Central (where most of our freight is). */
export function safeZone(zone: string | null | undefined): string {
  if (!zone) return "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "America/Chicago";
  }
}

/** The instant for a wall-clock date + HHMM in a zone. */
export function localToInstant(date: string, hhmm: string, timeZone: string) {
  const midnight = zonedMidnight(date, timeZone);
  const h = Number(hhmm.slice(0, 2)) || 0;
  const m = Number(hhmm.slice(2, 4)) || 0;
  return new Date(midnight.getTime() + (h * 60 + m) * 60_000);
}

/** A time in a zone with its abbreviation ("Sep 27, 8:24 AM EDT"). Prefer fmtWhen for new code. */
export function fmtIn(d: Date | string | null | undefined, zone: string, opts: Intl.DateTimeFormatOptions = {}): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const z = safeZone(zone);
  const { timeZoneName, ...rest } = { timeZoneName: "short" as Intl.DateTimeFormatOptions["timeZoneName"], ...opts };
  const text = cleanSpaces(date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...rest, timeZone: z }));
  return timeZoneName ? `${text} ${zoneLabel(z, date)}` : text;
}

/** ICU puts narrow no-break spaces before AM/PM in some versions and not others; a server and a browser must agree. */
const cleanSpaces = (t: string) => t.replace(/[\u202f\u00a0\u2009]/g, " ");

/** The zone's offset from UTC in minutes at an instant (Central Daylight = -300). */
export function zoneOffset(zone: string, at: Date = new Date()): number {
  const z = safeZone(zone);
  const t = Math.floor(at.getTime() / 60_000) * 60_000;
  const p = zonedParts(new Date(t), z);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t) / 60_000);
}

const STD_NAME: Record<number, [string, string]> = { [-600]: ["HST", "HDT"], [-540]: ["AKST", "AKDT"], [-480]: ["PST", "PDT"], [-420]: ["MST", "MDT"], [-360]: ["CST", "CDT"], [-300]: ["EST", "EDT"], [-240]: ["AST", "ADT"], [-210]: ["NST", "NDT"], [0]: ["UTC", "UTC"] };

/**
 * The zone's short name at an instant ("CDT", "CST", "EDT"), worked out from the offset so it is the same on the
 * server, in every browser and in a PDF: Monterrey reads "CST" all year, Nuevo Laredo "CDT" in summer.
 */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const z = safeZone(zone);
  if (z === "UTC" || z === "Etc/UTC") return "UTC";
  const off = zoneOffset(z, at);
  const y = zonedParts(at, z).y;
  const jan = zoneOffset(z, new Date(Date.UTC(y, 0, 15, 12)));
  const jul = zoneOffset(z, new Date(Date.UTC(y, 6, 15, 12)));
  const std = Math.min(jan, jul);
  const dst = off > std;
  const names = STD_NAME[std];
  if (names) return dst ? names[1] : names[0];
  const h = Math.trunc(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${off < 0 ? "-" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How a time reads:
 *  full  "Tue Sep 29, 8:00 AM CST"   (the default: a stop time, an appointment, an ETA)
 *  short "Sep 29, 8:00 AM CST"       (dense tables)
 *  time  "8:00 AM CST"
 *  day   "Tue Sep 29"
 *  date  "Sep 29, 2026"
 */
export type WhenStyle = "full" | "short" | "time" | "day" | "date";
export type WhenOptions = {
  style?: WhenStyle;
  /** give "Today 8:00 AM CST" / "Tomorrow …" / "Yesterday …" relative to this instant, on the zone's calendar */
  now?: Date | string | number | null;
  /** add the year ("Tue Sep 29, 2026, 8:00 AM CST"); by default only when it is not the year of `now` */
  year?: boolean;
  /** leave the zone name off (only when the zone is printed right next to it) */
  label?: boolean;
};

type Instant = Date | string | number | null | undefined;
const toDate = (d: Instant) => {
  if (d == null || d === "") return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};
const clock = (h: number, min: number) => `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;

/**
 * THE way to print an instant in this app: in an explicit zone (the stop's for anything tied to a stop, the
 * company's for everything else), with the zone's name, built from numbers so the server's render and the
 * browser's hydrate are byte for byte the same whatever zone the viewer's computer is in.
 */
export function fmtWhen(d: Instant, zone: string, opts: WhenOptions = {}): string | null {
  const at = toDate(d);
  if (!at) return null;
  const z = safeZone(zone);
  const style = opts.style ?? "full";
  const p = zonedParts(at, z);
  const lbl = opts.label === false ? "" : ` ${zoneLabel(z, at)}`;
  const now = toDate(opts.now ?? null);
  const withYear = opts.year ?? (now ? zonedParts(now, z).y !== p.y : false);
  const md = `${MONTH[p.m - 1]} ${p.d}`;
  let day = `${WEEKDAY[p.weekday]} ${md}${withYear ? `, ${p.y}` : ""}`;
  if (now && style !== "date") {
    const q = zonedParts(now, z);
    const diff = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(q.y, q.m - 1, q.d)) / 86_400_000);
    if (diff === 0) day = "Today";
    else if (diff === 1) day = "Tomorrow";
    else if (diff === -1) day = "Yesterday";
  }
  switch (style) {
    case "time":
      return `${clock(p.h, p.min)}${lbl}`;
    case "day":
      return day;
    case "date":
      return `${md}, ${p.y}`;
    case "short":
      return /^(Today|Tomorrow|Yesterday)$/.test(day) ? `${day} ${clock(p.h, p.min)}${lbl}` : `${md}${withYear ? `, ${p.y}` : ""}, ${clock(p.h, p.min)}${lbl}`;
    default:
      return `${day}${/^(Today|Tomorrow|Yesterday)$/.test(day) ? "" : ","} ${clock(p.h, p.min)}${lbl}`;
  }
}

/**
 * An appointment or window in the stop's zone: "Tue Sep 29, 8:00 AM – 12:00 PM CST", across midnight
 * "Tue Sep 29, 10:00 PM – Wed Sep 30, 2:00 AM CST", only a close "by Tue Sep 29, 12:00 PM CST".
 */
export function fmtWindow(start: Instant, end: Instant, zone: string, opts: Omit<WhenOptions, "style"> & { short?: boolean } = {}): string | null {
  const a = toDate(start);
  const b = toDate(end);
  const style: WhenStyle = opts.short ? "short" : "full";
  if (!a && !b) return null;
  if (a && (!b || b.getTime() === a.getTime())) return fmtWhen(a, zone, { ...opts, style });
  if (!a) return `by ${fmtWhen(b, zone, { ...opts, style })}`;
  const z = safeZone(zone);
  const la = zoneLabel(z, a);
  const lb = zoneLabel(z, b!);
  const sameDay = zonedDate(a, z) === zonedDate(b!, z);
  const first = fmtWhen(a, z, { ...opts, style, label: la !== lb && opts.label !== false });
  const second = sameDay ? fmtWhen(b, z, { ...opts, style: "time" }) : fmtWhen(b, z, { ...opts, style });
  return `${first} – ${second}`;
}

/** A stop's window in the stop's own zone. */
export function fmtStopWindow(st: { windowStart?: Instant; windowEnd?: Instant; country?: string | null; name?: string | null; address?: { state?: string | null; city?: string | null } | null; state?: string | null; city?: string | null }, companyZone: string, opts: Omit<WhenOptions, "style"> & { short?: boolean } = {}) {
  return fmtWindow(st.windowStart, st.windowEnd, stopZone(st, companyZone), opts);
}

/** The zone's short name today ("EDT", "CST") for a footer line. */
export function zoneAbbrev(zone: string, at = new Date()) {
  return zoneLabel(zone, at);
}

/** An instant as a datetime-local input value on a zone's wall clock ("2026-09-28T08:00"). */
export function toZoneInput(d: Date | string | null | undefined, zone: string): string {
  if (!d) return "";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  const p = zonedParts(x, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

/** A datetime-local value read on a zone's wall clock ("8:00 at the stop") → the instant. */
export function fromZoneInput(v: string | null | undefined, zone: string): Date | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return localToInstant(m[1], `${m[2]}${m[3]}`, zone);
}

/** A stop's zone: a border city's own clock, else its state or province, else its country, else the company's. */
export function stopZone(st: { country?: string | null; name?: string | null; address?: { state?: string | null; city?: string | null } | null; state?: string | null; city?: string | null }, fallback: string) {
  // a stop row carries its address; the slim shapes pages send carry city and state flat
  return zoneFor({ state: st.address?.state ?? st.state ?? null, city: st.address?.city ?? st.city ?? null, name: st.name ?? null, country: st.country ?? null }, fallback);
}

/** YYYY-MM-DD on the viewer's own calendar, n days from today (a date input's default: after 8 pm in Michigan the UTC date is already tomorrow). */
export function localDay(offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A calendar date the way people read it: "Sep 27, 2026". */
export function shortDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
