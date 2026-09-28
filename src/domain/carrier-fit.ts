/**
 * Which partner carriers fit a leg (M2): a Mexican leg is for Mexican carriers, a crossing for transfer
 * (crossing) carriers, a US or Canadian leg for US and Canadian carriers. The rest are one click away
 * ("Show all") — never hidden for good, a dispatcher may know better. Pure: the assign dialog and the tests share it.
 */
export type CarrierLike = { country: string | null | undefined; kind?: string | null };
export type LegLike = { type: string; countries?: string[] };

const K = (k: string | null | undefined) => (k ?? "any").toLowerCase() || "any";
const C = (c: string | null | undefined) => (c ?? "US").toUpperCase();

export function carrierFitsLeg(c: CarrierLike, leg: LegLike): boolean {
  const kind = K(c.kind);
  const country = C(c.country);
  const canada = leg.type === "ca" || (leg.countries ?? []).includes("CA");
  switch (leg.type) {
    case "mx":
      return country === "MX" && (kind === "any" || kind === "mx");
    case "crossing":
      // the Mexican border is a transfer carrier's job; the Canadian one is crossed by the long-haul carriers themselves
      if (canada) return kind === "crossing" || ((country === "US" || country === "CA") && ["any", "us", "ca"].includes(kind));
      return kind === "crossing" || (kind === "any" && country !== "CA");
    case "ca":
      return (country === "CA" || country === "US") && ["any", "ca", "us"].includes(kind);
    default:
      // us / domestic / equipment move
      return (country === "US" || country === "CA") && ["any", "us", "ca"].includes(kind);
  }
}

/** The carriers that fit first (by name), then the rest; `fits` says which is which. */
export function carriersForLeg<T extends CarrierLike & { name: string }>(all: T[], leg: LegLike): { fits: T[]; others: T[] } {
  const fits: T[] = [];
  const others: T[] = [];
  for (const c of all) (carrierFitsLeg(c, leg) ? fits : others).push(c);
  return { fits, others };
}
