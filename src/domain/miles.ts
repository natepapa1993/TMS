import { coords, haversineMiles } from "@/lib/geo";
import { fold } from "@/lib/fold";

/**
 * Estimated miles (M15). When nobody typed the miles on a leg, the leg still gets a number: road miles
 * between its stops' coordinates, or — when a stop has none yet — between the centers of the cities
 * named on the stops, from a small built-in list of the freight cities this business runs. No outside
 * service is called. An estimate is always shown as "est." next to the number, and a typed number wins.
 */

/**
 * Road miles over straight-line miles on the interstates and cuotas freight runs (I-35, I-75, the
 * Monterrey–Laredo cuota, the 401): Laredo → Dallas is 396 mi as the crow flies and ~430 by road.
 */
export const EST_ROAD_FACTOR = 1.1;

type Place = { city: string; state: string; country: "US" | "MX" | "CA"; lat: number; lng: number; aka?: string[] };

export const GAZETTEER: Place[] = [
  // Mexico: the border and the industrial north and Bajío
  { city: "Nuevo Laredo", state: "TAM", country: "MX", lat: 27.4779, lng: -99.5496 },
  { city: "Monterrey", state: "NL", country: "MX", lat: 25.6866, lng: -100.3161 },
  { city: "Apodaca", state: "NL", country: "MX", lat: 25.7818, lng: -100.1886 },
  { city: "San Nicolás de los Garza", state: "NL", country: "MX", lat: 25.7417, lng: -100.3022, aka: ["San Nicolas"] },
  { city: "Guadalupe", state: "NL", country: "MX", lat: 25.6775, lng: -100.2597 },
  { city: "General Escobedo", state: "NL", country: "MX", lat: 25.7969, lng: -100.3136, aka: ["Escobedo"] },
  { city: "Santa Catarina", state: "NL", country: "MX", lat: 25.6732, lng: -100.4585 },
  { city: "Salinas Victoria", state: "NL", country: "MX", lat: 25.9636, lng: -100.2925 },
  { city: "Ciénega de Flores", state: "NL", country: "MX", lat: 25.9533, lng: -100.1692 },
  { city: "Colombia", state: "NL", country: "MX", lat: 27.7003, lng: -99.7686 },
  { city: "Saltillo", state: "COAH", country: "MX", lat: 25.4232, lng: -101.0053 },
  { city: "Ramos Arizpe", state: "COAH", country: "MX", lat: 25.5392, lng: -100.9476 },
  { city: "Derramadero", state: "COAH", country: "MX", lat: 25.2833, lng: -101.2500 },
  { city: "Torreón", state: "COAH", country: "MX", lat: 25.5428, lng: -103.4068 },
  { city: "Piedras Negras", state: "COAH", country: "MX", lat: 28.7, lng: -100.5231 },
  { city: "Ciudad Acuña", state: "COAH", country: "MX", lat: 29.3232, lng: -100.9522, aka: ["Acuna"] },
  { city: "Reynosa", state: "TAM", country: "MX", lat: 26.0508, lng: -98.2979 },
  { city: "Matamoros", state: "TAM", country: "MX", lat: 25.869, lng: -97.5027 },
  { city: "San Luis Potosí", state: "SLP", country: "MX", lat: 22.1565, lng: -100.9855 },
  { city: "Querétaro", state: "QRO", country: "MX", lat: 20.5888, lng: -100.3899, aka: ["Santiago de Queretaro"] },
  { city: "Aguascalientes", state: "AGS", country: "MX", lat: 21.8853, lng: -102.2916 },
  { city: "León", state: "GTO", country: "MX", lat: 21.125, lng: -101.686 },
  { city: "Silao", state: "GTO", country: "MX", lat: 20.9436, lng: -101.427 },
  { city: "Celaya", state: "GTO", country: "MX", lat: 20.5235, lng: -100.8157 },
  { city: "Irapuato", state: "GTO", country: "MX", lat: 20.6767, lng: -101.3563 },
  { city: "Guadalajara", state: "JAL", country: "MX", lat: 20.6597, lng: -103.3496 },
  { city: "Ciudad de México", state: "CDMX", country: "MX", lat: 19.4326, lng: -99.1332, aka: ["Mexico City", "CDMX"] },
  { city: "Toluca", state: "MEX", country: "MX", lat: 19.2826, lng: -99.6557 },
  { city: "Puebla", state: "PUE", country: "MX", lat: 19.0414, lng: -98.2063 },
  { city: "Chihuahua", state: "CHIH", country: "MX", lat: 28.632, lng: -106.0691 },
  { city: "Ciudad Juárez", state: "CHIH", country: "MX", lat: 31.6904, lng: -106.4245, aka: ["Juarez"] },
  { city: "Hermosillo", state: "SON", country: "MX", lat: 29.073, lng: -110.9559 },
  { city: "Nogales", state: "SON", country: "MX", lat: 31.3086, lng: -110.9422 },
  { city: "Tijuana", state: "BC", country: "MX", lat: 32.5149, lng: -117.0382 },
  // United States: Texas border and the lanes north
  { city: "Laredo", state: "TX", country: "US", lat: 27.5306, lng: -99.4803 },
  { city: "San Antonio", state: "TX", country: "US", lat: 29.4241, lng: -98.4936 },
  { city: "Dallas", state: "TX", country: "US", lat: 32.7767, lng: -96.797 },
  { city: "Fort Worth", state: "TX", country: "US", lat: 32.7555, lng: -97.3308 },
  { city: "Lancaster", state: "TX", country: "US", lat: 32.5921, lng: -96.7561 },
  { city: "Houston", state: "TX", country: "US", lat: 29.7604, lng: -95.3698 },
  { city: "Austin", state: "TX", country: "US", lat: 30.2672, lng: -97.7431 },
  { city: "Corpus Christi", state: "TX", country: "US", lat: 27.8006, lng: -97.3964 },
  { city: "McAllen", state: "TX", country: "US", lat: 26.2034, lng: -98.23 },
  { city: "Pharr", state: "TX", country: "US", lat: 26.1948, lng: -98.1836 },
  { city: "Brownsville", state: "TX", country: "US", lat: 25.9017, lng: -97.4975 },
  { city: "Eagle Pass", state: "TX", country: "US", lat: 28.7091, lng: -100.4995 },
  { city: "Del Rio", state: "TX", country: "US", lat: 29.3709, lng: -100.8959 },
  { city: "El Paso", state: "TX", country: "US", lat: 31.7619, lng: -106.485 },
  { city: "Oklahoma City", state: "OK", country: "US", lat: 35.4676, lng: -97.5164 },
  { city: "Kansas City", state: "MO", country: "US", lat: 39.0997, lng: -94.5786 },
  { city: "St. Louis", state: "MO", country: "US", lat: 38.627, lng: -90.1994, aka: ["Saint Louis", "St Louis"] },
  { city: "Memphis", state: "TN", country: "US", lat: 35.1495, lng: -90.049 },
  { city: "Nashville", state: "TN", country: "US", lat: 36.1627, lng: -86.7816 },
  { city: "Smyrna", state: "TN", country: "US", lat: 35.9828, lng: -86.5186 },
  { city: "Chattanooga", state: "TN", country: "US", lat: 35.0456, lng: -85.3097 },
  { city: "Atlanta", state: "GA", country: "US", lat: 33.749, lng: -84.388 },
  { city: "Charlotte", state: "NC", country: "US", lat: 35.2271, lng: -80.8431 },
  { city: "Spartanburg", state: "SC", country: "US", lat: 34.9496, lng: -81.932 },
  { city: "Greenville", state: "SC", country: "US", lat: 34.8526, lng: -82.394 },
  { city: "Louisville", state: "KY", country: "US", lat: 38.2527, lng: -85.7585 },
  { city: "Indianapolis", state: "IN", country: "US", lat: 39.7684, lng: -86.1581 },
  { city: "Joliet", state: "IL", country: "US", lat: 41.525, lng: -88.0817 },
  { city: "Chicago", state: "IL", country: "US", lat: 41.8781, lng: -87.6298 },
  { city: "Columbus", state: "OH", country: "US", lat: 39.9612, lng: -82.9988 },
  { city: "Cincinnati", state: "OH", country: "US", lat: 39.1031, lng: -84.512 },
  { city: "Cleveland", state: "OH", country: "US", lat: 41.4993, lng: -81.6944 },
  { city: "Toledo", state: "OH", country: "US", lat: 41.6528, lng: -83.5379 },
  { city: "Pittsburgh", state: "PA", country: "US", lat: 40.4406, lng: -79.9959 },
  { city: "Buffalo", state: "NY", country: "US", lat: 42.8864, lng: -78.8784 },
  { city: "Detroit", state: "MI", country: "US", lat: 42.3314, lng: -83.0458 },
  { city: "Canton", state: "MI", country: "US", lat: 42.3087, lng: -83.4822 },
  { city: "Romulus", state: "MI", country: "US", lat: 42.2223, lng: -83.3966 },
  { city: "Dearborn", state: "MI", country: "US", lat: 42.3223, lng: -83.1763 },
  { city: "Warren", state: "MI", country: "US", lat: 42.5145, lng: -83.0147 },
  { city: "Flint", state: "MI", country: "US", lat: 43.0125, lng: -83.6875 },
  { city: "Lansing", state: "MI", country: "US", lat: 42.7325, lng: -84.5555 },
  { city: "Grand Rapids", state: "MI", country: "US", lat: 42.9634, lng: -85.6681 },
  { city: "Port Huron", state: "MI", country: "US", lat: 42.9709, lng: -82.4249 },
  { city: "Phoenix", state: "AZ", country: "US", lat: 33.4484, lng: -112.074 },
  { city: "Los Angeles", state: "CA", country: "US", lat: 34.0522, lng: -118.2437 },
  // Canada: Ontario and Quebec
  { city: "Windsor", state: "ON", country: "CA", lat: 42.3149, lng: -83.0364 },
  { city: "Sarnia", state: "ON", country: "CA", lat: 42.9745, lng: -82.4066 },
  { city: "London", state: "ON", country: "CA", lat: 42.9849, lng: -81.2453 },
  { city: "Toronto", state: "ON", country: "CA", lat: 43.6532, lng: -79.3832 },
  { city: "Mississauga", state: "ON", country: "CA", lat: 43.589, lng: -79.6441 },
  { city: "Brampton", state: "ON", country: "CA", lat: 43.7315, lng: -79.7624 },
  { city: "Milton", state: "ON", country: "CA", lat: 43.5183, lng: -79.8774 },
  { city: "Cambridge", state: "ON", country: "CA", lat: 43.3616, lng: -80.3144 },
  { city: "Kitchener", state: "ON", country: "CA", lat: 43.4516, lng: -80.4925 },
  { city: "Hamilton", state: "ON", country: "CA", lat: 43.2557, lng: -79.8711 },
  { city: "Montréal", state: "QC", country: "CA", lat: 45.5017, lng: -73.5673, aka: ["Montreal"] },
];

const key = (s: string) => fold(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const NAMES: { k: string; p: Place }[] = GAZETTEER.flatMap((p) => [p.city, ...(p.aka ?? [])].map((n) => ({ k: key(n), p }))).sort((a, b) => b.k.length - a.k.length);

/** The built-in city for a name ("Querétaro", "queretaro", "Nuevo Laredo"), or null. State and country break ties. */
export function lookupCity(city: string | null | undefined, state?: string | null, country?: string | null): Place | null {
  const k = key(city ?? "");
  if (!k) return null;
  const hits = NAMES.filter((n) => n.k === k).map((n) => n.p);
  if (!hits.length) return null;
  const st = key(state ?? "").toUpperCase();
  return hits.find((p) => st && key(p.state).toUpperCase() === st) ?? hits.find((p) => country && p.country === country) ?? hits[0];
}

/** A built-in city named anywhere in a free-text stop name ("Patio Nuevo Laredo" → Nuevo Laredo), longest name first. */
export function cityInText(text: string | null | undefined): Place | null {
  const t = ` ${key(text ?? "")} `;
  if (t.trim() === "") return null;
  const hit = NAMES.find((n) => t.includes(` ${n.k} `));
  return hit?.p ?? null;
}

export type StopForMiles = { name?: string | null; lat?: string | number | null; lng?: string | number | null; country?: string | null; address?: { city?: string | null; state?: string | null } | null };

/** Where a stop is, as best we know: its own coordinates, else the city on its address, else a city in its name. */
export function placeOf(st: StopForMiles | null | undefined): { lat: number; lng: number; exact: boolean } | null {
  if (!st) return null;
  const c = coords(st.lat ?? null, st.lng ?? null);
  if (c) return { ...c, exact: true };
  const p = lookupCity(st.address?.city, st.address?.state, st.country) ?? cityInText(st.address?.city) ?? cityInText(st.name);
  return p ? { lat: p.lat, lng: p.lng, exact: false } : null;
}

/** Estimated road miles between two stops, or null when either place is unknown or they are the same spot. */
export function estimateMiles(a: StopForMiles | null | undefined, b: StopForMiles | null | undefined): number | null {
  const pa = placeOf(a);
  const pb = placeOf(b);
  if (!pa || !pb) return null;
  const mi = Math.round(haversineMiles(pa, pb) * EST_ROAD_FACTOR);
  return mi >= 1 ? mi : null;
}

/** The miles to use for a leg: what was typed, else the estimate — and whether it is an estimate. */
export function legMiles(l: { plannedMiles: number | null; estMiles?: number | null }): { miles: number; est: boolean } | null {
  if (l.plannedMiles != null) return { miles: l.plannedMiles, est: false };
  if (l.estMiles != null) return { miles: l.estMiles, est: true };
  return null;
}

/** Total miles over legs, with "est." when any part is estimated; null when none are known. */
export function sumMiles(legs: { plannedMiles: number | null; estMiles?: number | null }[]): { miles: number; est: boolean } | null {
  const parts = legs.map(legMiles).filter((x): x is { miles: number; est: boolean } => !!x);
  if (!parts.length) return null;
  return { miles: parts.reduce((a, p) => a + p.miles, 0), est: parts.some((p) => p.est) || parts.length < legs.length };
}

/** "430 mi" or "430 mi est." */
export const milesLabel = (m: { miles: number; est: boolean } | null) => (m ? `${m.miles.toLocaleString("en-US")} mi${m.est ? " est." : ""}` : "—");
