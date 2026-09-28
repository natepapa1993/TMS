/** Distances on the road: great-circle miles times a corridor factor, which is what a truck actually drives. */

export const EARTH_MI = 3958.8;
/** Road miles over straight-line miles on the US–Mexico corridors (I-35, Monterrey–Laredo, the interior). */
export const ROAD_FACTOR = 1.25;

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function roadMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return haversineMiles(a, b) * ROAD_FACTOR;
}

export function coords(lat: string | number | null | undefined, lng: string | number | null | undefined): { lat: number; lng: number } | null {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lng: b };
}
