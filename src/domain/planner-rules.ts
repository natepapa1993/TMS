import { roadMiles } from "@/lib/geo";

/**
 * Can this truck make this pickup? (M5) Pure rules the planner and the assign popup share.
 *
 * A truck is ready for a load only if it can get to the pickup before the appointment closes: it
 * leaves when it comes free, drives the empty miles at an average road speed, and needs a little time to
 * hook, fuel and check in. When the ELD reports the driver's hours, a driver who runs out of drive time
 * (or of the 14-hour window) on the way takes a 10-hour break first. A pickup that has already passed is
 * a problem with the load, not with any truck, and is said so.
 */

/** Average speed for empty miles, door to door (traffic, fuel, the border towns): a sensible 50 mph. */
export const DEADHEAD_MPH = 50;
/** Hook up, fuel, check in at the shipper. */
export const BUFFER_MIN = 30;
/** The break a driver out of hours has to take before driving on. */
export const RESET_MIN = 10 * 60;
/** Hours from the ELD older than this are not trusted for the plan. */
export const HOS_FRESH_MS = 12 * 3600_000;

export type Reach = {
  status: "ok" | "late" | "past" | "unknown";
  /** when the truck would be at the pickup */
  arriveAt: Date | null;
  /** the pickup's deadline: the window's close, or its start when there is no close */
  pickupBy: Date | null;
  /** hours of the drive the driver has not got (a 10-hour break is in the arrival) */
  needsBreak: boolean;
  message: string | null;
};

export type ReachInput = {
  now: Date;
  /** when the truck comes free (null = now) */
  freeAt: Date | null;
  /** road miles from where it comes free to the pickup (null = unknown) */
  deadheadMi: number | null;
  pickupStart: Date | null;
  pickupEnd: Date | null;
  /** the pickup stop's time zone, for the message */
  zone: string;
  /** drive and on-duty window minutes left, from the ELD */
  hos?: { driveMin: number | null; shiftMin: number | null; at: Date | null } | null;
};

/** "Tue 3 PM" / "Tue 3:30 PM" on the stop's clock; "today" and "tomorrow" for the next two days. */
export function spokenTime(d: Date, zone: string, now = new Date()) {
  const fmt = (o: Intl.DateTimeFormatOptions) => {
    try {
      return d.toLocaleString("en-US", { ...o, timeZone: zone });
    } catch {
      return d.toLocaleString("en-US", { ...o, timeZone: "America/Chicago" });
    }
  };
  const dayKey = (x: Date) => {
    try {
      return x.toLocaleDateString("en-CA", { timeZone: zone });
    } catch {
      return x.toISOString().slice(0, 10);
    }
  };
  const mins = Number(fmt({ minute: "2-digit" }));
  const time = fmt({ hour: "numeric", ...(mins ? { minute: "2-digit" } : {}) });
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86400_000));
  const day = dayKey(d) === today ? "today" : dayKey(d) === tomorrow ? "tomorrow" : fmt({ weekday: "short" });
  return `${day} ${time}`;
}

export function reachability(i: ReachInput): Reach {
  const pickupBy = i.pickupEnd ?? i.pickupStart ?? null;
  if (!pickupBy) return { status: "unknown", arriveAt: null, pickupBy: null, needsBreak: false, message: null };
  if (pickupBy.getTime() < i.now.getTime()) return { status: "past", arriveAt: null, pickupBy, needsBreak: false, message: `Pickup time passed (${spokenTime(pickupBy, i.zone, i.now)}) — move the appointment` };
  if (i.deadheadMi == null) return { status: "unknown", arriveAt: null, pickupBy, needsBreak: false, message: null };
  const start = Math.max(i.now.getTime(), i.freeAt?.getTime() ?? i.now.getTime());
  const driveMin = (i.deadheadMi / DEADHEAD_MPH) * 60;
  let needsBreak = false;
  const hos = i.hos && i.hos.at && i.now.getTime() - i.hos.at.getTime() < HOS_FRESH_MS ? i.hos : null;
  if (hos) {
    // hours left count from the ELD reading; a truck that is busy until later gets no fresh hours from us
    const drive = hos.driveMin ?? Infinity;
    const shift = hos.shiftMin ?? Infinity;
    if (driveMin + BUFFER_MIN > Math.min(drive, shift)) needsBreak = true;
  }
  const arrive = new Date(start + (driveMin + BUFFER_MIN + (needsBreak ? RESET_MIN : 0)) * 60_000);
  if (arrive.getTime() > pickupBy.getTime()) {
    const pu = i.pickupStart && i.pickupEnd && i.pickupEnd.getTime() !== i.pickupStart.getTime() ? `pickup by ${spokenTime(pickupBy, i.zone, i.now)}` : `pickup ${spokenTime(pickupBy, i.zone, i.now)}`;
    return { status: "late", arriveAt: arrive, pickupBy, needsBreak, message: `Can't make it — arrives ~${spokenTime(arrive, i.zone, i.now)}, ${pu}${needsBreak ? " (needs a 10-h break on the way)" : ""}` };
  }
  return { status: "ok", arriveAt: arrive, pickupBy, needsBreak, message: needsBreak ? `Makes it with a 10-h break — arrives ~${spokenTime(arrive, i.zone, i.now)}` : null };
}

/** Where a late or past truck ranks: after every truck that can make it, before the ones that need an override. */
export const REACH_PENALTY = { ok: 0, unknown: 0, late: 300, past: 0 } as const;

// ---------- availability as time windows (dispatch N3) ----------

export type Pt = { lat: number; lng: number };

/** One load a truck (or driver) is booked on, as its timeline sees it. */
export type Booking = {
  legId: string;
  orderNumber: string;
  legType: string;
  state: string;
  /** rolling to the pickup or further: running now */
  moving: boolean;
  /** the pickup: window start (or planned start); estimated back from the delivery when the pickup has no time */
  start: Date | null;
  /** the pickup's deadline: the window's close, else its start */
  startBy: Date | null;
  /** the delivery: window close, else start, else planned end */
  end: Date | null;
  from: Pt | null;
  to: Pt | null;
  fromPlace: string;
  toPlace: string;
  fromZone: string;
  toZone: string;
};

/** A gap shorter than this before the next booked load is not "free": the truck is as good as heading there. */
export const MIN_GAP_MIN = 120;
const SENT = ["dispatched", "accepted"];

/** Minutes to drive empty from a to b and check in, at the planning speed; null when either place is unknown. */
export function driveMinutes(a: Pt | null, b: Pt | null): number | null {
  if (!a || !b) return null;
  return (roadMiles(a, b) / DEADHEAD_MPH) * 60 + BUFFER_MIN;
}

export type Availability = {
  /** the load it is running now, or is sent on and due to start, or must leave for within MIN_GAP */
  busyNow: Booking | null;
  /** when it is next free (now when it is free now); null when a running load has no end time */
  freeFrom: Date | null;
  freeAt: Pt | null;
  freePlace: string | null;
  freeZone: string | null;
  /** the next booked load after it is free: the end of the gap */
  until: Booking | null;
  /** when it has to leave for `until` (its pickup less the empty drive), when known */
  leaveBy: Date | null;
  /** booked loads after it is free, in pickup order */
  upcoming: Booking[];
};

/**
 * When is this truck free, and until when (N3)? Not "after its last booked load": a truck is free now if nothing
 * is running and its next booked pickup (less the drive there) is more than a couple of hours away; then it is
 * "free now until Wed 8 AM (26-00048)". Loads back to back chain into one busy stretch. Pure.
 */
export function availability(bookings: Booking[], now: Date, here: { pt: Pt | null; place: string | null; zone: string | null }): Availability {
  const key = (b: Booking) => (b.start ?? b.end ?? now).getTime();
  const sorted = [...bookings].sort((p, q) => key(p) - key(q));
  // running now: rolling, or sent with a pickup that is due (or has no time at all)
  const running = sorted.filter((b) => b.moving || (SENT.includes(b.state) && (!b.start || b.start.getTime() <= now.getTime())));
  const st = { busyNow: running[0] ?? null, freeFrom: now as Date | null, freeAt: here.pt, freePlace: here.place, freeZone: here.zone };
  const taken = new Set<Booking>();
  const take = (b: Booking) => {
    taken.add(b);
    st.freeFrom = b.end && st.freeFrom ? new Date(Math.max(b.end.getTime(), st.freeFrom.getTime())) : null;
    st.freeAt = b.to ?? st.freeAt;
    st.freePlace = b.toPlace || st.freePlace;
    st.freeZone = b.toZone || st.freeZone;
  };
  for (const b of [...running].sort((p, q) => (p.end?.getTime() ?? Infinity) - (q.end?.getTime() ?? Infinity))) take(b);
  // a next load it has to leave for within the gap threshold is part of the busy stretch
  let until: Booking | null = null;
  let leaveBy: Date | null = null;
  for (const b of sorted.filter((x) => !taken.has(x) && x.start)) {
    if (!st.freeFrom) break;
    const known = driveMinutes(st.freeAt, b.from);
    const leave = new Date(b.start!.getTime() - (known ?? BUFFER_MIN) * 60_000);
    if ((leave.getTime() - st.freeFrom.getTime()) / 60_000 < MIN_GAP_MIN) {
      if (!st.busyNow && st.freeFrom.getTime() <= now.getTime()) st.busyNow = b;
      take(b);
      continue;
    }
    until = b;
    leaveBy = known != null ? leave : null;
    break;
  }
  const upcoming = sorted.filter((b) => !taken.has(b));
  return { busyNow: st.busyNow, freeFrom: st.freeFrom, freeAt: st.freeAt, freePlace: st.freePlace, freeZone: st.freeZone, until, leaveBy, upcoming };
}

export type Gap = {
  /** the booked load that ends before this one starts: the truck comes free there */
  before: Booking | null;
  /** the next booked load after this one */
  after: Booking | null;
  freeFrom: Date;
  freeAt: Pt | null;
  freePlace: string | null;
  freeZone: string | null;
  /** can it deliver this load and still make the next one's pickup? null when there is no next or no times */
  makesNext: boolean | null;
  /** when it would get to the next pickup after this delivery */
  nextArriveAt: Date | null;
};

/**
 * The gap in a truck's bookings that a new load falls in (N3, M5): it comes free where the load before ends, and
 * it must still make the pickup of the load after — deliver this one, drive empty to the next, check in. Pure.
 */
export function gapFor(bookings: Booking[], target: { legId?: string; start: Date | null; end: Date | null; to: Pt | null }, now: Date, here: { pt: Pt | null; place: string | null; zone: string | null }): Gap {
  const others = bookings.filter((b) => b.legId !== target.legId);
  const tStart = (target.start ?? now).getTime();
  const runs = (b: Booking) => b.moving || (SENT.includes(b.state) && (!b.start || b.start.getTime() <= now.getTime()));
  // before: everything that starts before this pickup (or is running now); the latest to end is where it comes free
  const earlier = others.filter((b) => runs(b) || (b.start ? b.start.getTime() < tStart : false));
  const before = earlier.sort((p, q) => (q.end?.getTime() ?? Infinity) - (p.end?.getTime() ?? Infinity))[0] ?? null;
  const after = others.filter((b) => !earlier.includes(b) && b.start).sort((p, q) => p.start!.getTime() - q.start!.getTime())[0] ?? null;
  const freeFrom = new Date(Math.max(now.getTime(), before?.end?.getTime() ?? now.getTime()));
  let makesNext: boolean | null = null;
  let nextArriveAt: Date | null = null;
  if (after && target.end) {
    const drive = driveMinutes(target.to, after.from) ?? BUFFER_MIN;
    nextArriveAt = new Date(target.end.getTime() + drive * 60_000);
    makesNext = nextArriveAt.getTime() <= (after.startBy ?? after.start)!.getTime();
  }
  return { before, after, freeFrom, freeAt: before?.to ?? here.pt, freePlace: before ? before.toPlace : here.place, freeZone: before ? before.toZone : here.zone, makesNext, nextArriveAt };
}

/**
 * The order trucks are offered for a load (M5): those that can make the window — and still make their next booked
 * load — first, nearest empty first (a truck with no known location after the ones we can place), then who is free
 * soonest; the ones that can't make it after; then the ones that need an override; blocked last.
 */
export function rankTier(c: { hardBlocked: boolean; ok: boolean; reach: Reach["status"] | null; makesNext: boolean | null }) {
  if (c.hardBlocked) return 3;
  if (!c.ok) return 2;
  if (c.reach === "late" || c.makesNext === false) return 1;
  return 0;
}
export function compareRanked<T extends { hardBlocked: boolean; ok: boolean; reach: Reach["status"] | null; makesNext: boolean | null; deadheadMi: number | null; freeFrom: number; unitNumber: string }>(p: T, q: T) {
  return rankTier(p) - rankTier(q) || (p.deadheadMi ?? 1e9) - (q.deadheadMi ?? 1e9) || p.freeFrom - q.freeFrom || p.unitNumber.localeCompare(q.unitNumber, "en-US", { numeric: true });
}
