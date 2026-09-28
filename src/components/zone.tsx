"use client";

import { createContext, useContext } from "react";
import { fmtIn, fmtWhen, fmtWindow, stopZone, type WhenOptions } from "@/lib/time";

/**
 * The company's time zone, provided once for the office app (the (app) layout) and for every public page. Times
 * tied to a stop are printed on the stop's clock (stopZone), everything else (sent at, notes, history) on this one.
 * Never the viewer's browser zone: server render and hydrate must print the same text.
 */
const ZoneContext = createContext("America/Detroit");
export const ZoneProvider = ZoneContext.Provider;
export const useZone = () => useContext(ZoneContext);
/** A formatter bound to the page's zone; call it at the top of a component. */
export function useWhen(opts: Intl.DateTimeFormatOptions = {}) {
  const zone = useZone();
  return (d: string | Date | null | undefined) => fmtIn(d, zone, opts);
}

type StopLike = { country?: string | null; name?: string | null; address?: { state?: string | null; city?: string | null } | null; state?: string | null; city?: string | null };

/** fmtWhen bound to the company zone, with a helper for a stop's own clock. */
export function useClock() {
  const zone = useZone();
  return {
    zone,
    /** not tied to a stop: company zone, labelled */
    at: (d: string | Date | null | undefined, opts: WhenOptions = {}) => fmtWhen(d, zone, opts),
    /** a stop's time on the stop's clock, labelled */
    stop: (d: string | Date | null | undefined, st: StopLike | null | undefined, opts: WhenOptions = {}) => fmtWhen(d, st ? stopZone(st, zone) : zone, opts),
    window: (st: StopLike & { windowStart?: string | Date | null; windowEnd?: string | Date | null }, opts: Omit<WhenOptions, "style"> & { short?: boolean } = {}) => fmtWindow(st.windowStart, st.windowEnd, stopZone(st, zone), opts),
    zoneOf: (st: StopLike | null | undefined) => (st ? stopZone(st, zone) : zone),
  };
}
