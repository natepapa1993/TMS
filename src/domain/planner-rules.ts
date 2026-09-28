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
