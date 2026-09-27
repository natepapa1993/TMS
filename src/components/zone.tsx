"use client";

import { createContext, useContext } from "react";
import { fmtIn } from "@/lib/time";

/** The company's time zone for a public page: every time a customer, carrier or driver reads is in it. */
const ZoneContext = createContext("America/Detroit");
export const ZoneProvider = ZoneContext.Provider;
export const useZone = () => useContext(ZoneContext);
/** A formatter bound to the page's zone; call it at the top of a component. */
export function useWhen(opts: Intl.DateTimeFormatOptions = {}) {
  const zone = useZone();
  return (d: string | Date | null | undefined) => fmtIn(d, zone, opts);
}
